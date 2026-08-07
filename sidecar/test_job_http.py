#!/usr/bin/env python3
"""Plain-assert self-test for whisper_server.py's make_job_http_handler
— the :8766 job API's HTTP dispatch layer — no pytest, no network, no
real model, no server start, no socket. Mirrors test_download.py/
test_ingest_url.py's existing style/harness.

Run:
    sidecar/.venv/bin/python sidecar/test_job_http.py
    (or plain `python3 sidecar/test_job_http.py` — needs nothing beyond
    numpy + websockets + the stdlib, same as every other file here:
    importing whisper_server pulls those two in at module scope, but no
    heavy model backend is ever touched — the JobManager itself is
    replaced by a hand-built fake below, so faster_whisper/
    huggingface_hub/pyannote never load.)

Why this file exists: every pure helper the handler leans on is already
covered elsewhere (validate_ingest_url/ingest_origin_allowed in
test_ingest_url.py, validate_download_model/download_conflict_response/
request_cancel_download in test_download.py, health_payload in
test_whisper_protocol.py) — but until now "do_POST/do_GET/do_PUT are
exercised by inspection, not a real socket" (test_download.py's own
words) meant the HANDLER's dispatch had no test at all: nothing pinned
that the origin gate fires BEFORE the body is read, that a
start_job()->None refusal actually deletes the just-written upload, or
that each helper's verdict maps to the coded status. This file drives
real JobHTTPHandler instances — built via `Handler.__new__(Handler)`
with `path`/`headers`/`rfile` set by hand and send_response/
send_header/end_headers replaced by recorders — so do_GET/do_PUT/
do_POST/do_OPTIONS run their actual code against a BytesIO instead of
a socket, closed over a FakeJobManager exposing exactly the attributes
the handler touches (model_name, jobs, lock, diarization_probe,
list_recent, get, start_job, start_download_job,
request_cancel_download, start_url_job — every call recorded).
shutil.which is faked via whisper_server's own module attribute for
the /ingest-url yt-dlp/ffmpeg prechecks, both directions, so the
verdicts don't depend on what this machine has installed.

Covers:
  - _cors/do_OPTIONS: blanket "*" (the job API's accepted local-tool
    trust model — contrast agent_server's echo-only CORS), PUT in the
    advertised methods, 204 preflight with an empty body
  - do_GET: /health wired through diarization_probe + health_payload
    (payload equality against the same pure function), /jobs ->
    list_recent(20) verbatim under the "jobs" key, /jobs/{id} found ->
    200 job dict / unknown -> 404, anything else -> 404
  - do_PUT /transcribe: route 404; empty/absent Content-Length -> 400;
    > MAX_UPLOAD_BYTES -> 413 from the header alone (body never
    buffered — the whole point of the pre-read gate); exactly
    MAX_UPLOAD_BYTES is NOT rejected (boundary is >, not >=); happy
    path -> 202 {job_id} with the body bytes actually landing in the
    tmp file start_job received (suffix from filename=, query params
    language/diarize/hf_token/initial_prompt threaded through, diarize
    "1"/"0" -> True/False, absent -> None, language absent -> None —
    the JobManager owns the default, the handler must NOT resolve it);
    start_job -> None (parakeet slot busy, FB4) -> 409
    parakeet_busy_response AND the already-written upload file removed
    by the handler itself
  - do_POST /download-model: empty body 400; malformed JSON 400;
    non-dict payload / unknown model -> 400 via validate_download_model
    ("未知模型：..."); valid -> 202 {job_id}; single-flight conflict ->
    409 download_conflict_response(active_job_id) naming the in-flight
    job (parakeet busy is NOT reachable here — start_download_job has
    no slot gate; its only refusal is the single-flight 409)
  - do_POST /jobs/{id}/cancel: "ok" -> 202 {job_id}; "terminal" ->
    409 任务已结束，无法取消; "not_found" -> 404 — the three-way
    request_cancel_download verdict's full status mapping (the thin
    assertion test_download.py deliberately left to a handler test)
  - do_POST /ingest-url: third-party Origin -> 403 BEFORE the body is
    read and without touching the JobManager; NO Origin is ALLOWED
    (ingest_origin_allowed's curl-is-legitimate posture — opposite of
    the agent sidecar's gate); oversize 413; malformed JSON 400;
    missing url / non-http(s) scheme -> 400 via validate_ingest_url;
    yt-dlp missing / ffmpeg missing -> 400 naming the missing tool
    (checked in that order); MAX_ACTIVE_URL_JOBS queued/running
    url-kind jobs -> 429 without starting one more; terminal url jobs
    do NOT count toward the cap; happy path -> 202 with url/language/
    diarize (bool-coerced)/hf_token/initial_prompt threaded through;
    start_url_job -> None -> 409 parakeet_busy_response
  - do_POST unknown path -> 404
"""

from __future__ import annotations

import io
import json
import os
import sys
import threading
from http import HTTPStatus
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import whisper_server as ws  # noqa: E402 - module import, for monkeypatching below
from whisper_server import (  # noqa: E402
    MAX_ACTIVE_URL_JOBS,
    MAX_UPLOAD_BYTES,
    download_conflict_response,
    health_payload,
    make_job_http_handler,
    parakeet_busy_response,
)

FAILURES: list[str] = []
CHECK_COUNT = 0


def check(label: str, cond: bool) -> None:
    global CHECK_COUNT
    CHECK_COUNT += 1
    if not cond:
        FAILURES.append(label)
        print(f"FAIL: {label}")
    else:
        print(f"ok:   {label}")


# =================================================================
# Fixtures / fakes
# =================================================================


class FakeJobManager:
    """Minimal stand-in exposing EXACTLY the surface JobHTTPHandler
    touches (enumerated in the module docstring) — every call recorded
    onto `calls` so the tests can assert both the arguments the handler
    threaded through AND that a rejected request never reached the
    manager at all. Return values are plain attributes each section
    sets up front, mirroring how test_whisper_protocol.py's FakeWs
    keeps its own recording dumb and assertion-driven."""

    def __init__(self) -> None:
        self.model_name = "large-v3-turbo"
        self.jobs: dict[str, dict[str, Any]] = {}
        self.lock = threading.Lock()
        self.calls: list[tuple[Any, ...]] = []
        self.probe_result: tuple[bool, bool, Optional[str]] = (
            True,
            False,
            "未配置 HF Token / no HF token available",
        )
        self.recent: list[dict[str, Any]] = []
        self.job_store: dict[str, dict[str, Any]] = {}
        self.start_job_result: Optional[str] = "job-upload-1"
        self.start_download_result: tuple[Optional[str], Optional[str]] = ("job-dl-1", None)
        self.cancel_result = "ok"
        self.start_url_result: Optional[str] = "job-url-1"
        self.uploaded_bytes: Optional[bytes] = None

    def diarization_probe(self) -> tuple[bool, bool, Optional[str]]:
        self.calls.append(("diarization_probe",))
        return self.probe_result

    def list_recent(self, limit: int = 20) -> list[dict[str, Any]]:
        self.calls.append(("list_recent", limit))
        return self.recent

    def get(self, job_id: str) -> Optional[dict[str, Any]]:
        self.calls.append(("get", job_id))
        return self.job_store.get(job_id)

    def start_job(
        self,
        file_path: str,
        language: Optional[str],
        diarize: Optional[bool] = None,
        hf_token: Optional[str] = None,
        initial_prompt: Optional[str] = None,
    ) -> Optional[str]:
        # Capture what the handler actually wrote to disk BEFORE
        # returning — on the None (busy) path the handler deletes the
        # file right after this returns, and the real JobManager is
        # equally the last thing to see the bytes.
        with open(file_path, "rb") as f:
            self.uploaded_bytes = f.read()
        self.calls.append(("start_job", file_path, language, diarize, hf_token, initial_prompt))
        return self.start_job_result

    def start_download_job(self, model: str) -> tuple[Optional[str], Optional[str]]:
        self.calls.append(("start_download_job", model))
        return self.start_download_result

    def request_cancel_download(self, job_id: str) -> str:
        self.calls.append(("request_cancel_download", job_id))
        return self.cancel_result

    def start_url_job(
        self,
        url: str,
        language: Optional[str],
        diarize: Optional[bool] = None,
        hf_token: Optional[str] = None,
        initial_prompt: Optional[str] = None,
    ) -> Optional[str]:
        self.calls.append(("start_url_job", url, language, diarize, hf_token, initial_prompt))
        return self.start_url_result


class FakeShutil:
    """Swapped in for whisper_server's module-level `shutil` reference
    around the /ingest-url sections, so the yt-dlp/ffmpeg
    shutil.which() prechecks are deterministic regardless of what this
    machine has installed. Only `which` is exposed — the handler path
    under test calls nothing else on shutil."""

    def __init__(self, present: set[str]) -> None:
        self.present = present

    def which(self, name: str) -> Optional[str]:
        return f"/usr/bin/{name}" if name in self.present else None


class Recorder:
    def __init__(self) -> None:
        self.status: Optional[int] = None
        self.headers: list[tuple[str, str]] = []
        self.ended = False


def make_request(
    handler_cls: type,
    path: str,
    headers: Optional[dict[str, str]] = None,
    body: bytes = b"",
) -> tuple[Any, Recorder]:
    """Build a real JobHTTPHandler instance with NO socket — __new__
    skips BaseHTTPRequestHandler.__init__ (which would demand a live
    connection); `path`/`headers`/`rfile` are set by hand and the
    response machinery replaced with recorders, so the do_* methods run
    their actual code and _send_json's body lands in a BytesIO."""
    h = handler_cls.__new__(handler_cls)
    h.path = path
    h.headers = dict(headers or {})  # handler only ever calls .get()
    h.rfile = io.BytesIO(body)
    h.wfile = io.BytesIO()
    rec = Recorder()

    def _send_response(status: Any, message: Any = None) -> None:
        rec.status = int(status)

    def _send_header(name: str, value: Any) -> None:
        rec.headers.append((name, str(value)))

    def _end_headers() -> None:
        rec.ended = True

    h.send_response = _send_response
    h.send_header = _send_header
    h.end_headers = _end_headers
    return h, rec


def response_json(h: Any) -> Any:
    return json.loads(h.wfile.getvalue().decode("utf-8"))


def header_value(rec: Recorder, name: str) -> Optional[str]:
    matches = [v for n, v in rec.headers if n.lower() == name.lower()]
    return matches[-1] if matches else None


def json_body(payload: Any) -> tuple[dict[str, str], bytes]:
    raw = json.dumps(payload).encode("utf-8")
    return {"Content-Length": str(len(raw))}, raw


manager = FakeJobManager()
Handler = make_job_http_handler(manager, "zh")


# =================================================================
# _cors / do_OPTIONS — blanket "*" (the job API's local-tool trust
# model; the SSRF-shaped /ingest-url gets its own Origin gate instead)
# =================================================================

h, rec = make_request(Handler, "/transcribe")
h.do_OPTIONS()
check(
    "do_OPTIONS: 204 No Content, headers ended, empty body, Content-Length 0",
    rec.status == int(HTTPStatus.NO_CONTENT)
    and rec.ended
    and h.wfile.getvalue() == b""
    and header_value(rec, "Content-Length") == "0",
)
check(
    "do_OPTIONS: CORS is the blanket '*' with PUT included in the methods "
    "(the upload endpoint is a PUT — dropping it would break the browser preflight)",
    header_value(rec, "Access-Control-Allow-Origin") == "*"
    and header_value(rec, "Access-Control-Allow-Methods") == "PUT, POST, GET, OPTIONS",
)

# =================================================================
# do_GET — /health, /jobs, /jobs/{id}, 404
# =================================================================

h, rec = make_request(Handler, "/health")
h.do_GET()
check(
    "GET /health: 200 with health_payload(model_name, *diarization_probe()) "
    "verbatim — the handler adds/renames nothing",
    rec.status == int(HTTPStatus.OK)
    and response_json(h)
    == health_payload("large-v3-turbo", True, False, "未配置 HF Token / no HF token available"),
)
check(
    "GET /health: the probe was actually consulted (not a cached/static payload)",
    manager.calls[-1] == ("diarization_probe",),
)
check(
    "GET /health: response carries the blanket '*' CORS header too "
    "(every _send_json response does)",
    header_value(rec, "Access-Control-Allow-Origin") == "*"
    and header_value(rec, "Content-Type") == "application/json",
)

manager.recent = [{"id": "job-b", "status": "running"}, {"id": "job-a", "status": "done"}]
h, rec = make_request(Handler, "/jobs")
h.do_GET()
check(
    "GET /jobs: 200 with list_recent's result verbatim under the 'jobs' key",
    rec.status == int(HTTPStatus.OK) and response_json(h) == {"jobs": manager.recent},
)
check(
    "GET /jobs: list_recent was asked for exactly 20 (the coded page size)",
    manager.calls[-1] == ("list_recent", 20),
)

manager.job_store = {"job-a": {"id": "job-a", "status": "done", "segments": []}}
h, rec = make_request(Handler, "/jobs/job-a")
h.do_GET()
check(
    "GET /jobs/{id}: a known id -> 200 with the job dict itself",
    rec.status == int(HTTPStatus.OK)
    and response_json(h) == {"id": "job-a", "status": "done", "segments": []}
    and manager.calls[-1] == ("get", "job-a"),
)

h, rec = make_request(Handler, "/jobs/nope")
h.do_GET()
check(
    "GET /jobs/{id}: an unknown id -> 404 {'error': 'job not found'}",
    rec.status == int(HTTPStatus.NOT_FOUND)
    and response_json(h) == {"error": "job not found"},
)

h, rec = make_request(Handler, "/definitely/not/here")
h.do_GET()
check(
    "GET unknown path -> 404 {'error': 'not found'}",
    rec.status == int(HTTPStatus.NOT_FOUND) and response_json(h) == {"error": "not found"},
)

# =================================================================
# do_PUT /transcribe — upload dispatch
# =================================================================

h, rec = make_request(Handler, "/upload", {"Content-Length": "4"}, b"data")
h.do_PUT()
check(
    "PUT on a non-/transcribe path -> 404 (route checked before anything else)",
    rec.status == int(HTTPStatus.NOT_FOUND) and response_json(h) == {"error": "not found"},
)

h, rec = make_request(Handler, "/transcribe", {}, b"")
h.do_PUT()
check(
    "PUT /transcribe: absent Content-Length -> 400 empty request body",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h) == {"error": "empty request body"},
)

h, rec = make_request(
    Handler, "/transcribe", {"Content-Length": str(MAX_UPLOAD_BYTES + 1)}, b"tiny"
)
h.do_PUT()
check(
    "PUT /transcribe: Content-Length > MAX_UPLOAD_BYTES -> 413 文件过大, decided "
    "from the header alone — the body was never read/buffered (the whole point "
    "of gating before the mkstemp/copy loop)",
    rec.status == int(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
    and "文件过大" in response_json(h)["error"]
    and h.rfile.tell() == 0,
)

_UPLOAD_BODY = b"RIFF-fake-wav-bytes-for-upload"
manager.start_job_result = "job-upload-1"
h, rec = make_request(
    Handler,
    "/transcribe?filename=meet.wav&language=en&diarize=1&hf_token=hf_tok1&initial_prompt=Acme%20glossary",
    {"Content-Length": str(len(_UPLOAD_BODY))},
    _UPLOAD_BODY,
)
h.do_PUT()
check(
    "PUT /transcribe happy path: 202 {'job_id': ...} from start_job",
    rec.status == int(HTTPStatus.ACCEPTED) and response_json(h) == {"job_id": "job-upload-1"},
)
_start_call = manager.calls[-1]
check(
    "PUT /transcribe happy path: the EXACT body bytes landed in the tmp file "
    "start_job received (read back by the fake before returning)",
    _start_call[0] == "start_job" and manager.uploaded_bytes == _UPLOAD_BODY,
)
check(
    "PUT /transcribe happy path: the tmp file keeps the client filename's "
    "suffix (.wav) so downstream format sniffing still works",
    _start_call[1].endswith(".wav"),
)
check(
    "PUT /transcribe happy path: language/diarize/hf_token/initial_prompt "
    "query params threaded through verbatim (diarize '1' -> True, %20 decoded)",
    _start_call[2:] == ("en", True, "hf_tok1", "Acme glossary"),
)
check(
    "PUT /transcribe happy path: the upload tmp file is NOT deleted by the "
    "handler on success — the job worker owns cleanup (_run_job's finally)",
    os.path.exists(_start_call[1]),
)
os.remove(_start_call[1])  # what the real job worker would have done

h, rec = make_request(
    Handler, "/transcribe", {"Content-Length": str(len(_UPLOAD_BODY))}, _UPLOAD_BODY
)
h.do_PUT()
_start_call = manager.calls[-1]
check(
    "PUT /transcribe with no query params: filename defaults to upload.bin "
    "(-> .bin suffix) and language/diarize/hf_token/initial_prompt are all "
    "None — the handler resolves NO defaults itself (language fallback is the "
    "JobManager's job, so default_language must not leak in here)",
    _start_call[1].endswith(".bin") and _start_call[2:] == (None, None, None, None),
)
os.remove(_start_call[1])

h, rec = make_request(
    Handler,
    "/transcribe?diarize=0",
    {"Content-Length": str(len(_UPLOAD_BODY))},
    _UPLOAD_BODY,
)
h.do_PUT()
check(
    "PUT /transcribe: diarize=0 -> False (explicit off, distinct from the "
    "absent-param None above)",
    manager.calls[-1][3] is False,
)
os.remove(manager.calls[-1][1])

h, rec = make_request(
    Handler,
    "/transcribe",
    {"Content-Length": str(MAX_UPLOAD_BYTES)},
    b"small-actual-body",
)
h.do_PUT()
check(
    "PUT /transcribe: Content-Length of EXACTLY MAX_UPLOAD_BYTES is not "
    "rejected (boundary is >, not >=) — proceeds to start_job/202",
    rec.status == int(HTTPStatus.ACCEPTED),
)
os.remove(manager.calls[-1][1])

manager.start_job_result = None  # FB4: parakeet slot already held
h, rec = make_request(
    Handler, "/transcribe", {"Content-Length": str(len(_UPLOAD_BODY))}, _UPLOAD_BODY
)
h.do_PUT()
check(
    "PUT /transcribe: start_job -> None (parakeet slot busy) -> 409 with "
    "parakeet_busy_response()'s exact type+zh copy",
    rec.status == int(HTTPStatus.CONFLICT) and response_json(h) == parakeet_busy_response(),
)
check(
    "PUT /transcribe busy path: the handler deleted the already-written "
    "upload file itself (start_job created no worker to own cleanup)",
    not os.path.exists(manager.calls[-1][1]),
)
manager.start_job_result = "job-upload-1"

# =================================================================
# do_POST /download-model — S4 model-switch job admission
# =================================================================

h, rec = make_request(Handler, "/download-model", {}, b"")
h.do_POST()
check(
    "POST /download-model: absent Content-Length -> 400 empty request body",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h) == {"error": "empty request body"},
)

h, rec = make_request(Handler, "/download-model", {"Content-Length": "9"}, b"{not json")
h.do_POST()
check(
    "POST /download-model: malformed JSON -> 400 请求体不是合法 JSON",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h)["error"].startswith("请求体不是合法 JSON"),
)

_hdrs, _raw = json_body(["not", "a", "dict"])
h, rec = make_request(Handler, "/download-model", _hdrs, _raw)
h.do_POST()
check(
    "POST /download-model: a valid-JSON non-dict body -> model None -> 400 "
    "via validate_download_model (未知模型：None)",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h) == {"error": "未知模型：None"},
)

_hdrs, _raw = json_body({"model": "huge"})
h, rec = make_request(Handler, "/download-model", _hdrs, _raw)
h.do_POST()
check(
    "POST /download-model: a model outside MODEL_CHOICES -> 400 未知模型：huge, "
    "and start_download_job was never consulted",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h) == {"error": "未知模型：huge"}
    and manager.calls[-1][0] != "start_download_job",
)

manager.start_download_result = ("job-dl-1", None)
_hdrs, _raw = json_body({"model": "large-v3-turbo"})
h, rec = make_request(Handler, "/download-model", _hdrs, _raw)
h.do_POST()
check(
    "POST /download-model: a valid model -> 202 {'job_id': ...} with the model "
    "passed through to start_download_job",
    rec.status == int(HTTPStatus.ACCEPTED)
    and response_json(h) == {"job_id": "job-dl-1"}
    and manager.calls[-1] == ("start_download_job", "large-v3-turbo"),
)

_hdrs, _raw = json_body({"model": ws.PARAKEET_MODEL})
h, rec = make_request(Handler, "/download-model", _hdrs, _raw)
h.do_POST()
check(
    "POST /download-model: the parakeet entry rides the same path (S12a Q1: "
    "'a model under whisper, not a new engine') -> 202",
    rec.status == int(HTTPStatus.ACCEPTED)
    and manager.calls[-1] == ("start_download_job", ws.PARAKEET_MODEL),
)

manager.start_download_result = (None, "job-dl-0")  # single-flight refusal
_hdrs, _raw = json_body({"model": "small"})
h, rec = make_request(Handler, "/download-model", _hdrs, _raw)
h.do_POST()
check(
    "POST /download-model: start_download_job -> (None, active_id) -> 409 with "
    "download_conflict_response naming the in-flight job for polling",
    rec.status == int(HTTPStatus.CONFLICT)
    and response_json(h) == download_conflict_response("job-dl-0"),
)
manager.start_download_result = ("job-dl-1", None)

# =================================================================
# do_POST /jobs/{id}/cancel — the three-way request_cancel_download
# verdict's status mapping (field-test issue 6)
# =================================================================

manager.cancel_result = "ok"
h, rec = make_request(Handler, "/jobs/job-dl-9/cancel")
h.do_POST()
check(
    "POST /jobs/{id}/cancel: 'ok' -> 202 {'job_id': ...} echoing the PATH's id "
    "(202 not 200 — the flag is set, the job stops later at its next checkpoint)",
    rec.status == int(HTTPStatus.ACCEPTED)
    and response_json(h) == {"job_id": "job-dl-9"}
    and manager.calls[-1] == ("request_cancel_download", "job-dl-9"),
)

manager.cancel_result = "terminal"
h, rec = make_request(Handler, "/jobs/job-dl-9/cancel")
h.do_POST()
check(
    "POST /jobs/{id}/cancel: 'terminal' -> 409 任务已结束，无法取消",
    rec.status == int(HTTPStatus.CONFLICT)
    and response_json(h) == {"error": "任务已结束，无法取消"},
)

manager.cancel_result = "not_found"
h, rec = make_request(Handler, "/jobs/ghost/cancel")
h.do_POST()
check(
    "POST /jobs/{id}/cancel: 'not_found' -> 404 job not found",
    rec.status == int(HTTPStatus.NOT_FOUND)
    and response_json(h) == {"error": "job not found"},
)
manager.cancel_result = "ok"

h, rec = make_request(Handler, "/nope", {"Content-Length": "2"}, b"{}")
h.do_POST()
check(
    "POST unknown path -> 404 {'error': 'not found'}",
    rec.status == int(HTTPStatus.NOT_FOUND) and response_json(h) == {"error": "not found"},
)

# =================================================================
# do_POST /ingest-url — SSRF origin gate, validators, tool prechecks,
# concurrency cap, dispatch. shutil.which faked via whisper_server's
# own module attribute (restored at the end of the section).
# =================================================================

_real_shutil = ws.shutil

_hdrs, _raw = json_body({"url": "https://example.com/talk.mp4"})
_calls_before = len(manager.calls)
h, rec = make_request(
    Handler, "/ingest-url", dict(_hdrs, Origin="https://evil.example"), _raw
)
h.do_POST()
check(
    "POST /ingest-url: a third-party Origin -> 403 with the zh SSRF-gate error, "
    "BEFORE the body is read (rfile untouched)",
    rec.status == int(HTTPStatus.FORBIDDEN)
    and response_json(h) == {"error": "仅限本机应用调用（浏览器跨站请求已拒绝）"}
    and h.rfile.tell() == 0,
)
check(
    "POST /ingest-url: the origin-rejected request never touched the JobManager",
    len(manager.calls) == _calls_before,
)

h, rec = make_request(Handler, "/ingest-url", {}, b"")
h.do_POST()
check(
    "POST /ingest-url: NO Origin header is ALLOWED (curl/native launcher — "
    "ingest_origin_allowed's posture, opposite of the agent sidecar's gate): "
    "the request proceeds past the gate to the empty-body 400",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h) == {"error": "empty request body"},
)

h, rec = make_request(
    Handler,
    "/ingest-url",
    {"Origin": "http://localhost:3000", "Content-Length": str(MAX_UPLOAD_BYTES + 1)},
    b"tiny",
)
h.do_POST()
check(
    "POST /ingest-url: a localhost Origin passes the gate; Content-Length > "
    "MAX_UPLOAD_BYTES -> 413 请求体过大 without reading the body",
    rec.status == int(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
    and "请求体过大" in response_json(h)["error"]
    and h.rfile.tell() == 0,
)

h, rec = make_request(Handler, "/ingest-url", {"Content-Length": "9"}, b"{not json")
h.do_POST()
check(
    "POST /ingest-url: malformed JSON -> 400 请求体不是合法 JSON",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h)["error"].startswith("请求体不是合法 JSON"),
)

_hdrs, _raw = json_body({"language": "en"})
h, rec = make_request(Handler, "/ingest-url", _hdrs, _raw)
h.do_POST()
check(
    "POST /ingest-url: missing url -> 400 缺少视频链接 (validate_ingest_url's verdict)",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h) == {"error": "缺少视频链接"},
)

_hdrs, _raw = json_body({"url": "ftp://example.com/file.mp4"})
h, rec = make_request(Handler, "/ingest-url", _hdrs, _raw)
h.do_POST()
check(
    "POST /ingest-url: a non-http(s) scheme -> 400 仅支持 http/https 链接",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h) == {"error": "仅支持 http/https 链接"},
)

_OK_URL = {"url": "https://example.com/talk.mp4"}

ws.shutil = FakeShutil(present=set())  # neither tool on PATH
_hdrs, _raw = json_body(_OK_URL)
h, rec = make_request(Handler, "/ingest-url", _hdrs, _raw)
h.do_POST()
check(
    "POST /ingest-url: yt-dlp missing -> 400 naming yt-dlp (checked before ffmpeg)",
    rec.status == int(HTTPStatus.BAD_REQUEST) and "yt-dlp" in response_json(h)["error"],
)

ws.shutil = FakeShutil(present={"yt-dlp"})
_hdrs, _raw = json_body(_OK_URL)
h, rec = make_request(Handler, "/ingest-url", _hdrs, _raw)
h.do_POST()
check(
    "POST /ingest-url: yt-dlp present but ffmpeg missing -> 400 naming ffmpeg",
    rec.status == int(HTTPStatus.BAD_REQUEST) and "ffmpeg" in response_json(h)["error"],
)

ws.shutil = FakeShutil(present={"yt-dlp", "ffmpeg"})

manager.jobs = {
    f"url-{i}": {"id": f"url-{i}", "kind": "url", "status": "running" if i % 2 else "queued"}
    for i in range(MAX_ACTIVE_URL_JOBS)
}
_calls_before = len(manager.calls)
_hdrs, _raw = json_body(_OK_URL)
h, rec = make_request(Handler, "/ingest-url", _hdrs, _raw)
h.do_POST()
check(
    "POST /ingest-url: MAX_ACTIVE_URL_JOBS queued/running url jobs -> 429 "
    "已有下载任务进行中 (yt-dlp is network-bound for minutes — the cap is the "
    "DoS guard) and start_url_job was never called",
    rec.status == int(HTTPStatus.TOO_MANY_REQUESTS)
    and response_json(h) == {"error": "已有下载任务进行中，请稍后再试"}
    and len(manager.calls) == _calls_before,
)

manager.jobs = {
    "url-done": {"id": "url-done", "kind": "url", "status": "done"},
    "url-err": {"id": "url-err", "kind": "url", "status": "error"},
    "up-run": {"id": "up-run", "kind": "upload", "status": "running"},
}
manager.start_url_result = "job-url-1"
_hdrs, _raw = json_body(
    {
        "url": "https://example.com/talk.mp4",
        "language": "en",
        "diarize": 1,
        "hf_token": "hf_tok2",
        "initial_prompt": "JargonSlayer, KPI",
    }
)
h, rec = make_request(Handler, "/ingest-url", _hdrs, _raw)
h.do_POST()
check(
    "POST /ingest-url happy path: terminal url jobs and non-url jobs don't "
    "count toward the cap -> 202 {'job_id': ...}",
    rec.status == int(HTTPStatus.ACCEPTED) and response_json(h) == {"job_id": "job-url-1"},
)
check(
    "POST /ingest-url happy path: url/language/diarize/hf_token/initial_prompt "
    "threaded through, diarize truthy-1 coerced to bool True",
    manager.calls[-1]
    == ("start_url_job", "https://example.com/talk.mp4", "en", True, "hf_tok2", "JargonSlayer, KPI"),
)

_hdrs, _raw = json_body({"url": "https://example.com/talk.mp4", "language": 42})
h, rec = make_request(Handler, "/ingest-url", _hdrs, _raw)
h.do_POST()
check(
    "POST /ingest-url: absent diarize -> None (JobManager decides the default) "
    "and a non-string language is dropped to None rather than passed through",
    manager.calls[-1] == ("start_url_job", "https://example.com/talk.mp4", None, None, None, None),
)

manager.start_url_result = None  # FB4: parakeet slot already held
_hdrs, _raw = json_body(_OK_URL)
h, rec = make_request(Handler, "/ingest-url", _hdrs, _raw)
h.do_POST()
check(
    "POST /ingest-url: start_url_job -> None (parakeet slot busy) -> 409 with "
    "parakeet_busy_response()'s exact type+zh copy",
    rec.status == int(HTTPStatus.CONFLICT) and response_json(h) == parakeet_busy_response(),
)
manager.start_url_result = "job-url-1"

ws.shutil = _real_shutil


# =================================================================
# summary
# =================================================================

print()
if FAILURES:
    print(f"{len(FAILURES)} of {CHECK_COUNT} check(s) FAILED:")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
else:
    print(f"all {CHECK_COUNT} checks passed")
    sys.exit(0)
