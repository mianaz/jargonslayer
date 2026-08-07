#!/usr/bin/env python3
"""Plain-assert self-test for agent_server.py's make_agent_http_handler
— the HTTP dispatch layer of the subscription-direct sidecar — no
pytest, no network, no model calls, no server start, no socket.
Mirrors test_agent_server.py's existing style/harness.

Run:
    sidecar/.venv/bin/python sidecar/test_agent_http.py
    (or plain `python3 sidecar/test_agent_http.py` — nothing beyond the
    stdlib + this repo's own agent_* modules is imported.)

Why this file exists: test_agent_server.py covers every PURE function
the handler leans on (agent_origin_allowed, token_matches,
ERROR_CODE_STATUS, _extract_profile, ...), but the handler ITSELF —
the ORDER those gates run in, and which status/body each outcome maps
to — had no test at all. Ordering is exactly where the money is here:
the design doc's #1 review item is that the Origin gate must fire
BEFORE any body handling (a rejected drive-by must never get its body
read), and the token gate before JSON parsing; a refactor that keeps
every pure function green could still silently reorder do_POST and
open the "local process rides the subscription" hole. Every check
below drives a real AgentHTTPHandler instance — built via
`Handler.__new__(Handler)` with `path`/`headers`/`rfile` set by hand
and send_response/send_header/end_headers replaced by recorders, so
do_GET/do_POST/do_OPTIONS run their actual code against a BytesIO
instead of a socket. The one thing stubbed at the module level is
call_provider_json (the only escape hatch to a real provider), so a
dispatch bug that fell through a gate would be CAUGHT (the stub
records calls) rather than silently spending someone's subscription.

Covers:
  - GET /agent/health: allowed origin -> 200 with the exact payload
    (provider probes monkeypatched for determinism), env_warnings
    passthrough + the claude-sdk-import-error warn appended WITHOUT
    mutating the closed-over list across requests; empty Origin
    allowed (health's looser gate); third-party origin -> 403; unknown
    GET path -> 404
  - do_POST gate ORDER: route 404 before any gate; origin 403 (empty
    AND third-party) before the token check and before the body is
    read (rfile position asserted untouched); token 403 before body;
    Content-Length 0/absent -> 400; > MAX_BODY_BYTES -> 413 without
    reading the body; exactly MAX_BODY_BYTES is NOT rejected as too
    large (boundary is `>`, not `>=`); malformed JSON -> 400
    "请求体不是合法 JSON"; valid-JSON-non-dict -> 400 "请求参数不合法";
    bad/missing provider -> 400 — and the provider stub records ZERO
    calls across all of the above
  - dispatch: detect happy path (200, post_filter actually applied —
    hallucinated span dropped, confidence clamped), captured
    system/user/model args match build_detect_system_prompt /
    build_detect_user_message / CLAUDE_MODEL_DEFAULT exactly; lang
    "en" picks the en system prompt, junk lang falls back to zh;
    profile spliced through _extract_profile into the user message;
    define happy path (200, returned VERBATIM — no post_filter),
    chatgpt-sub picks the codex model; missing new_text / phrase ->
    400 with code bad_request (never reaches the provider)
  - error mapping: AgentCallError code -> status via ERROR_CODE_STATUS
    (no_key -> 401, rate_limit -> 429, unknown code -> 502 default);
    non-dict provider JSON -> BadOutputError -> 502 code "upstream";
    an unexpected exception PROPAGATES out of do_POST with no response
    written (there is deliberately no catch-all 500 in the handler —
    stdlib socketserver logs and drops the connection; this check
    pins that posture so adding a swallow-into-200 would fail loudly)
  - CORS: _send_json echoes the caller's own Origin back (never "*" —
    this endpoint spends quota), no ACAO header when no Origin was
    sent, allow-headers advertises X-JS-Agent-Token; do_OPTIONS ->
    204 preflight with the same CORS surface
"""

from __future__ import annotations

import io
import json
import sys
from http import HTTPStatus
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import agent_server as s  # noqa: E402
from agent_prompts import (  # noqa: E402
    build_define_system_prompt,
    build_define_user_message,
    build_detect_system_prompt,
    build_detect_user_message,
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
# Harness: build a real AgentHTTPHandler instance with NO socket —
# __new__ skips BaseHTTPRequestHandler.__init__ (which would demand a
# live connection), then every attribute the do_* methods actually
# read is set by hand and the response machinery is replaced with
# recorders. wfile is a BytesIO, so the JSON body _send_json writes is
# directly inspectable.
# =================================================================


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


class ProviderStub:
    """Recording stand-in for agent_server.call_provider_json — the
    single point every successful detect/define dispatch must pass
    through. Monkeypatched in for the WHOLE file (not just the happy-
    path section) so any gate-ordering bug that fell through to a real
    provider call is recorded (and fails the zero-calls check below)
    instead of hitting a real CLI/subscription."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.result: Any = None
        self.exc: Optional[BaseException] = None

    async def __call__(
        self,
        provider: str,
        system_prompt: str,
        user_message: str,
        model: str,
        array_key: Optional[str] = None,
    ) -> Any:
        self.calls.append(
            {
                "provider": provider,
                "system_prompt": system_prompt,
                "user_message": user_message,
                "model": model,
                "array_key": array_key,
            }
        )
        if self.exc is not None:
            raise self.exc
        return self.result


TOKEN = "test-connection-code-123"
ENV_WARNINGS = ["warn-A"]
Handler = s.make_agent_http_handler(TOKEN, ENV_WARNINGS)

provider_stub = ProviderStub()
_real_call_provider_json = s.call_provider_json
s.call_provider_json = provider_stub

LOCAL = "http://localhost:3000"
GOOD_HEADERS = {"Origin": LOCAL, "X-JS-Agent-Token": TOKEN}


def post_detect(headers: dict[str, str], payload: Any = None, body: Optional[bytes] = None):
    """POST /agent/detect with Content-Length derived from the body
    (unless the caller already pinned one in `headers`)."""
    raw = body if body is not None else json.dumps(payload).encode("utf-8")
    merged = dict(headers)
    merged.setdefault("Content-Length", str(len(raw)))
    h, rec = make_request(Handler, "/agent/detect", merged, raw)
    h.do_POST()
    return h, rec


# =================================================================
# GET /agent/health — provider probes monkeypatched so the payload is
# deterministic regardless of what this machine has installed.
# =================================================================

_orig_probes = (
    s._claude_sdk_available,
    s.claude_login_probe,
    s.codex_available,
    s.codex_login_probe,
)
s._claude_sdk_available = lambda: (True, None)
s.claude_login_probe = lambda: True
s.codex_available = lambda: False
s.codex_login_probe = lambda: None

h, rec = make_request(Handler, "/agent/health", {"Origin": LOCAL})
h.do_GET()
check(
    "GET /agent/health: allowed (localhost) origin -> 200",
    rec.status == int(HTTPStatus.OK),
)
check(
    "GET /agent/health: payload carries exactly the five probe fields + warns, "
    "with the factory's env_warnings passed through",
    response_json(h)
    == {
        "ok": True,
        "claude_sdk_available": True,
        "claude_logged_in": True,
        "codex_available": False,
        "codex_logged_in": None,
        "warns": ["warn-A"],
    },
)
check(
    "GET /agent/health: response echoes the caller's own Origin back "
    "(never '*': this sidecar's CORS is deliberately narrower than "
    "whisper_server's blanket wildcard)",
    header_value(rec, "Access-Control-Allow-Origin") == LOCAL,
)
check(
    "GET /agent/health: Content-Type is application/json and Content-Length "
    "matches the bytes actually written",
    header_value(rec, "Content-Type") == "application/json"
    and header_value(rec, "Content-Length") == str(len(h.wfile.getvalue())),
)

h, rec = make_request(Handler, "/agent/health", {})
h.do_GET()
check(
    "GET /agent/health: NO Origin header is allowed (health_origin_allowed's "
    "looser gate — curl/native launcher is a legitimate health caller) -> 200",
    rec.status == int(HTTPStatus.OK),
)
check(
    "GET /agent/health: no Origin sent -> no Access-Control-Allow-Origin "
    "header emitted at all (nothing to echo, never a wildcard)",
    header_value(rec, "Access-Control-Allow-Origin") is None,
)

h, rec = make_request(Handler, "/agent/health", {"Origin": "https://evil.example"})
h.do_GET()
check(
    "GET /agent/health: a third-party origin -> 403 with the zh error",
    rec.status == int(HTTPStatus.FORBIDDEN)
    and response_json(h) == {"error": "仅限本机应用调用"},
)

# claude-sdk import failure -> warn appended AFTER the env warnings,
# and the closed-over env_warnings list must NOT accumulate across
# requests (the handler copies via list(env_warnings) — this is the
# tripwire for someone "simplifying" that copy away).
s._claude_sdk_available = lambda: (False, "ImportError: no module named claude_agent_sdk")
h, rec = make_request(Handler, "/agent/health", {"Origin": LOCAL})
h.do_GET()
check(
    "GET /agent/health: claude-sdk import error appends its warn after the env warns",
    response_json(h)["warns"]
    == ["warn-A", "claude-agent-sdk 不可用：ImportError: no module named claude_agent_sdk"],
)
h, rec = make_request(Handler, "/agent/health", {"Origin": LOCAL})
h.do_GET()
check(
    "GET /agent/health: a SECOND request still has exactly 2 warns — the "
    "closed-over env_warnings list was copied, not mutated/accumulated",
    len(response_json(h)["warns"]) == 2 and ENV_WARNINGS == ["warn-A"],
)

(
    s._claude_sdk_available,
    s.claude_login_probe,
    s.codex_available,
    s.codex_login_probe,
) = _orig_probes

h, rec = make_request(Handler, "/agent/nope", {"Origin": LOCAL})
h.do_GET()
check(
    "GET unknown path -> 404 {'error': 'not found'}",
    rec.status == int(HTTPStatus.NOT_FOUND) and response_json(h) == {"error": "not found"},
)

# =================================================================
# do_OPTIONS (CORS preflight)
# =================================================================

h, rec = make_request(Handler, "/agent/detect", {"Origin": LOCAL})
h.do_OPTIONS()
check(
    "do_OPTIONS: 204 No Content with headers ended and an empty body",
    rec.status == int(HTTPStatus.NO_CONTENT)
    and rec.ended
    and h.wfile.getvalue() == b""
    and header_value(rec, "Content-Length") == "0",
)
check(
    "do_OPTIONS: echoes the caller's Origin and advertises POST/GET/OPTIONS",
    header_value(rec, "Access-Control-Allow-Origin") == LOCAL
    and header_value(rec, "Access-Control-Allow-Methods") == "POST, GET, OPTIONS",
)
check(
    "do_OPTIONS: Access-Control-Allow-Headers advertises the connection-code "
    "header (X-JS-Agent-Token) so the browser's preflight lets it through",
    "X-JS-Agent-Token" in (header_value(rec, "Access-Control-Allow-Headers") or ""),
)

h, rec = make_request(Handler, "/agent/detect", {})
h.do_OPTIONS()
check(
    "do_OPTIONS: no Origin -> no Access-Control-Allow-Origin header",
    header_value(rec, "Access-Control-Allow-Origin") is None,
)

# =================================================================
# do_POST gate ORDER — route, then Origin, then token, then size,
# then JSON. Each rejection must leave the body UNREAD (rfile position
# 0) when it fires before the read, and must never reach the provider
# stub (asserted in bulk at the end of this section).
# =================================================================

h, rec = make_request(
    Handler, "/agent/other", {"Origin": "https://evil.example"}, b"ignored"
)
h.do_POST()
check(
    "POST unknown /agent/* path -> 404 (routing runs before ANY gate: even a "
    "hostile origin gets the 404, not the origin 403)",
    rec.status == int(HTTPStatus.NOT_FOUND) and response_json(h) == {"error": "not found"},
)

h, rec = post_detect({"X-JS-Agent-Token": TOKEN}, payload={"provider": "claude-sub"})
check(
    "POST detect: MISSING Origin -> 403 (the credentialed gate rejects empty "
    "Origin — opposite of whisper_server's ingest gate) with the zh error",
    rec.status == int(HTTPStatus.FORBIDDEN)
    and response_json(h) == {"error": "仅限本机浏览器标签页调用（跨站请求已拒绝）"},
)
check(
    "POST detect: the origin-rejected request's body was never read "
    "(rfile still at position 0)",
    h.rfile.tell() == 0,
)

h, rec = post_detect(
    {"Origin": "https://evil.example", "X-JS-Agent-Token": TOKEN},
    payload={"provider": "claude-sub"},
)
check(
    "POST detect: third-party Origin -> 403 even with a CORRECT token "
    "(origin gate fires first; the token can't rescue a bad origin)",
    rec.status == int(HTTPStatus.FORBIDDEN)
    and response_json(h)["error"] == "仅限本机浏览器标签页调用（跨站请求已拒绝）",
)

h, rec = post_detect({"Origin": LOCAL}, body=b"{not json")
check(
    "POST detect: good origin but MISSING token -> 403 连接码 error "
    "BEFORE body parsing (deliberately-malformed body never mentioned)",
    rec.status == int(HTTPStatus.FORBIDDEN)
    and response_json(h) == {"error": "连接码缺失或不正确"},
)
check(
    "POST detect: the token-rejected request's body was never read",
    h.rfile.tell() == 0,
)

h, rec = post_detect(
    {"Origin": LOCAL, "X-JS-Agent-Token": "wrong-token"},
    payload={"provider": "claude-sub"},
)
check(
    "POST detect: WRONG token -> same 403 连接码 error",
    rec.status == int(HTTPStatus.FORBIDDEN)
    and response_json(h) == {"error": "连接码缺失或不正确"},
)

h, rec = post_detect(dict(GOOD_HEADERS, **{"Content-Length": "0"}), body=b"")
check(
    "POST detect: Content-Length 0 -> 400 empty request body",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h) == {"error": "empty request body"},
)

h, rec = make_request(Handler, "/agent/detect", dict(GOOD_HEADERS), b"")
h.do_POST()
check(
    "POST detect: absent Content-Length header -> same 400 empty request body",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h) == {"error": "empty request body"},
)

h, rec = post_detect(
    dict(GOOD_HEADERS, **{"Content-Length": str(s.MAX_BODY_BYTES + 1)}), body=b"tiny"
)
check(
    "POST detect: Content-Length > MAX_BODY_BYTES -> 413 请求体过大, decided "
    "from the header alone (body never read)",
    rec.status == int(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
    and response_json(h) == {"error": "请求体过大"}
    and h.rfile.tell() == 0,
)

_boundary_body = b'{"provider": "bogus"}' + b" " * (s.MAX_BODY_BYTES - len(b'{"provider": "bogus"}'))
h, rec = post_detect(dict(GOOD_HEADERS), body=_boundary_body)
check(
    "POST detect: a body of EXACTLY MAX_BODY_BYTES is not rejected as too "
    "large (gate is >, not >=) — it proceeds to provider validation instead",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h) == {"error": "provider 必须是 claude-sub 或 chatgpt-sub"},
)

h, rec = post_detect(dict(GOOD_HEADERS), body=b"{not json at all")
check(
    "POST detect: malformed JSON -> 400 with the 请求体不是合法 JSON error",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h)["error"].startswith("请求体不是合法 JSON"),
)

h, rec = post_detect(dict(GOOD_HEADERS), body=b"[1, 2, 3]")
check(
    "POST detect: valid JSON that is not an object -> 400 请求参数不合法",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h) == {"error": "请求参数不合法"},
)

h, rec = post_detect(dict(GOOD_HEADERS), payload={"new_text": "hello"})
check(
    "POST detect: missing provider -> 400 naming the two accepted providers",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h) == {"error": "provider 必须是 claude-sub 或 chatgpt-sub"},
)

h, rec = post_detect(
    dict(GOOD_HEADERS), payload={"provider": "openai", "new_text": "hello"}
)
check(
    "POST detect: an unknown provider value -> same 400",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h)["error"] == "provider 必须是 claude-sub 或 chatgpt-sub",
)

check(
    "gate order: NONE of the rejected requests above ever reached "
    "call_provider_json (zero provider calls recorded)",
    provider_stub.calls == [],
)

# =================================================================
# dispatch: detect — the request must reach call_provider_json with
# exactly the prompt/model args the pure builders produce, and the
# raw provider JSON must come back through post_filter.
# =================================================================

provider_stub.result = {
    "expressions": [
        {"expression": "circle back", "chinese_explanation": "回头再谈", "confidence": 3.5},
        {"expression": "synergy paradigm", "chinese_explanation": "幻觉", "confidence": 0.9},
    ],
    "terms": [{"term": "KPI", "gloss_zh": "关键绩效指标"}],
}
_NEW_TEXT = "Let's circle back on the KPI dashboard next week"
h, rec = post_detect(
    dict(GOOD_HEADERS),
    payload={"provider": "claude-sub", "context": "standup", "new_text": _NEW_TEXT},
)
check(
    "POST detect happy path: 200 OK",
    rec.status == int(HTTPStatus.OK),
)
check(
    "POST detect happy path: post_filter WAS applied — the hallucinated "
    "expression (not present in new_text) is dropped and the surviving "
    "confidence is clamped to 1.0",
    response_json(h)
    == {
        "expressions": [
            {"expression": "circle back", "chinese_explanation": "回头再谈", "confidence": 1.0}
        ],
        "terms": [{"term": "KPI", "gloss_zh": "关键绩效指标"}],
    },
)
check(
    "POST detect happy path: exactly one provider call was made",
    len(provider_stub.calls) == 1,
)
_call = provider_stub.calls[-1]
check(
    "POST detect happy path: provider + model dispatched for claude-sub "
    "(CLAUDE_MODEL_DEFAULT, no array_key)",
    _call["provider"] == "claude-sub"
    and _call["model"] == s.CLAUDE_MODEL_DEFAULT
    and _call["array_key"] is None,
)
check(
    "POST detect happy path: system prompt is build_detect_system_prompt('zh') "
    "(zh is the default when no lang is sent)",
    _call["system_prompt"] == build_detect_system_prompt("zh"),
)
check(
    "POST detect happy path: user message is build_detect_user_message(context, "
    "new_text) with no AUDIENCE splice (no profile sent)",
    _call["user_message"] == build_detect_user_message("standup", _NEW_TEXT),
)

h, rec = post_detect(
    dict(GOOD_HEADERS),
    payload={"provider": "claude-sub", "new_text": _NEW_TEXT, "lang": "en"},
)
check(
    "POST detect: lang 'en' selects the en detect system prompt",
    provider_stub.calls[-1]["system_prompt"] == build_detect_system_prompt("en"),
)

h, rec = post_detect(
    dict(GOOD_HEADERS),
    payload={"provider": "claude-sub", "new_text": _NEW_TEXT, "lang": "fr"},
)
check(
    "POST detect: an unrecognized lang falls back to zh (only 'zh'/'en' pass "
    "the whitelist; anything else is treated as absent)",
    provider_stub.calls[-1]["system_prompt"] == build_detect_system_prompt("zh"),
)

h, rec = post_detect(
    dict(GOOD_HEADERS),
    payload={
        "provider": "claude-sub",
        "new_text": _NEW_TEXT,
        "profile": "  行业：互联网  ",
    },
)
check(
    "POST detect: a profile hint is trimmed via _extract_profile and spliced "
    "into the user message as the AUDIENCE block",
    provider_stub.calls[-1]["user_message"]
    == build_detect_user_message("", _NEW_TEXT, "行业：互联网"),
)

_calls_before = len(provider_stub.calls)
h, rec = post_detect(dict(GOOD_HEADERS), payload={"provider": "claude-sub"})
check(
    "POST detect: missing new_text -> 400 with code bad_request (mapped "
    "through ERROR_CODE_STATUS) and the provider was never called",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h) == {"error": "缺少 new_text", "code": "bad_request"}
    and len(provider_stub.calls) == _calls_before,
)

h, rec = post_detect(
    dict(GOOD_HEADERS), payload={"provider": "claude-sub", "new_text": "   "}
)
check(
    "POST detect: whitespace-only new_text is treated as missing (400 bad_request)",
    rec.status == int(HTTPStatus.BAD_REQUEST) and response_json(h)["code"] == "bad_request",
)

# =================================================================
# dispatch: define — verbatim passthrough (no post_filter), and the
# chatgpt-sub provider picks the codex model.
# =================================================================

provider_stub.result = {
    "kind": "expression",
    "normalized": "circle back",
    "chinese_explanation": "回头再谈",
    "expression": "not-in-any-text (post_filter would have dropped this)",
}
_body = {
    "provider": "chatgpt-sub",
    "phrase": "circle back",
    "context": "let's circle back tomorrow",
    "lang": "en",
}
h, rec = make_request(
    Handler,
    "/agent/define",
    dict(GOOD_HEADERS, **{"Content-Length": str(len(json.dumps(_body).encode()))}),
    json.dumps(_body).encode(),
)
h.do_POST()
check(
    "POST define happy path: 200 with the provider JSON returned VERBATIM "
    "(define has no post_filter pass — a field post_filter would drop survives)",
    rec.status == int(HTTPStatus.OK) and response_json(h) == provider_stub.result,
)
_call = provider_stub.calls[-1]
check(
    "POST define happy path: chatgpt-sub dispatches with the codex model",
    _call["provider"] == "chatgpt-sub" and _call["model"] == "gpt-5.2-codex",
)
check(
    "POST define happy path: system prompt is build_define_system_prompt('en')",
    _call["system_prompt"] == build_define_system_prompt("en"),
)
check(
    "POST define happy path: user message is build_define_user_message(phrase, "
    "context) with no AUDIENCE splice",
    _call["user_message"]
    == build_define_user_message("circle back", "let's circle back tomorrow"),
)

_body = {"provider": "claude-sub", "context": "ctx"}
h, rec = make_request(
    Handler,
    "/agent/define",
    dict(GOOD_HEADERS, **{"Content-Length": str(len(json.dumps(_body).encode()))}),
    json.dumps(_body).encode(),
)
h.do_POST()
check(
    "POST define: missing phrase -> 400 缺少 phrase, code bad_request",
    rec.status == int(HTTPStatus.BAD_REQUEST)
    and response_json(h) == {"error": "缺少 phrase", "code": "bad_request"},
)

# =================================================================
# error mapping: AgentCallError.code -> ERROR_CODE_STATUS, plus the
# BadOutputError -> 502 upstream path and the no-catch-all posture.
# =================================================================

_DETECT_OK = {"provider": "claude-sub", "new_text": "hello world"}

provider_stub.exc = s.AgentCallError("请在终端运行 claude 登录", "no_key")
h, rec = post_detect(dict(GOOD_HEADERS), payload=_DETECT_OK)
check(
    "POST detect: AgentCallError code no_key -> 401 with error + code in the body",
    rec.status == int(HTTPStatus.UNAUTHORIZED)
    and response_json(h) == {"error": "请在终端运行 claude 登录", "code": "no_key"},
)

provider_stub.exc = s.AgentCallError("上游繁忙", "rate_limit")
h, rec = post_detect(dict(GOOD_HEADERS), payload=_DETECT_OK)
check(
    "POST detect: AgentCallError code rate_limit -> 429",
    rec.status == int(HTTPStatus.TOO_MANY_REQUESTS)
    and response_json(h)["code"] == "rate_limit",
)

provider_stub.exc = s.AgentCallError("upstream broke", "upstream")
h, rec = post_detect(dict(GOOD_HEADERS), payload=_DETECT_OK)
check(
    "POST detect: AgentCallError code upstream -> 502",
    rec.status == int(HTTPStatus.BAD_GATEWAY) and response_json(h)["code"] == "upstream",
)

provider_stub.exc = s.AgentCallError("mystery", "some_future_code")
h, rec = post_detect(dict(GOOD_HEADERS), payload=_DETECT_OK)
check(
    "POST detect: an AgentCallError code NOT in ERROR_CODE_STATUS falls back "
    "to 502 BAD_GATEWAY (the .get default), keeping the unknown code in the body",
    rec.status == int(HTTPStatus.BAD_GATEWAY)
    and response_json(h) == {"error": "mystery", "code": "some_future_code"},
)

provider_stub.exc = None
provider_stub.result = ["not", "a", "dict"]
h, rec = post_detect(dict(GOOD_HEADERS), payload=_DETECT_OK)
check(
    "POST detect: provider JSON that is not an object -> BadOutputError -> "
    "502 with code upstream and the 模型输出解析失败 error",
    rec.status == int(HTTPStatus.BAD_GATEWAY)
    and response_json(h)["code"] == "upstream"
    and response_json(h)["error"].startswith("模型输出解析失败"),
)

provider_stub.exc = RuntimeError("totally unexpected")
_propagated = False
_raw = json.dumps(_DETECT_OK).encode()
h, rec = make_request(
    Handler,
    "/agent/detect",
    dict(GOOD_HEADERS, **{"Content-Length": str(len(_raw))}),
    _raw,
)
try:
    h.do_POST()
except RuntimeError:
    _propagated = True
check(
    "POST detect: an UNEXPECTED exception type propagates out of do_POST "
    "(no catch-all-500 exists in the handler — stdlib socketserver's "
    "handle_error logs it and the connection drops) with no response written",
    _propagated and rec.status is None and h.wfile.getvalue() == b"",
)
provider_stub.exc = None

# =================================================================
# CORS on POST responses (error and success alike go through
# _send_json, so one success + one error probe pins both).
# =================================================================

provider_stub.result = {"expressions": [], "terms": []}
h, rec = post_detect(dict(GOOD_HEADERS), payload=_DETECT_OK)
check(
    "POST detect success response: echoes the caller's Origin + advertises "
    "methods and the X-JS-Agent-Token header",
    header_value(rec, "Access-Control-Allow-Origin") == LOCAL
    and header_value(rec, "Access-Control-Allow-Methods") == "POST, GET, OPTIONS"
    and "X-JS-Agent-Token" in (header_value(rec, "Access-Control-Allow-Headers") or ""),
)

h, rec = post_detect({"Origin": LOCAL}, payload=_DETECT_OK)  # missing token -> 403
check(
    "POST detect error response: the 403 still carries the same CORS headers "
    "(so the browser can even READ the error instead of a CORS failure)",
    rec.status == int(HTTPStatus.FORBIDDEN)
    and header_value(rec, "Access-Control-Allow-Origin") == LOCAL
    and header_value(rec, "Access-Control-Allow-Methods") == "POST, GET, OPTIONS",
)

s.call_provider_json = _real_call_provider_json


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
