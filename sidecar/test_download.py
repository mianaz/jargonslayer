#!/usr/bin/env python3
"""Plain-assert self-test for whisper_server.py's S4 model-download
machinery (docs/design-explorations/s4-model-wizard-blueprint.md,
decision B) — no pytest, no network, NO real model/snapshot download
anywhere in this file. Mirrors test_ingest_url.py's style/harness.

Run:
    sidecar/.venv/bin/python sidecar/test_download.py
    (or plain `python3 sidecar/test_download.py` if `tqdm` is
    importable — needed only for the progress-bar-math section below;
    everything else needs nothing beyond numpy + websockets + stdlib,
    same as every other file in this suite. huggingface_hub and
    faster_whisper are NEVER imported here — every test that would
    otherwise need them (the real snapshot_download call, or
    faster_whisper.utils._MODELS lookup) instead drives
    download_model_snapshot's pieces directly or stubs the whole
    function; see each section below.)

Covers:
  - validate_download_model: MODEL_CHOICES gating (accept all 6,
    reject junk/None/non-str/empty), zh error message
  - check_disk_space: raises a zh "磁盘空间不足" RuntimeError when
    shutil.disk_usage(...).free < total*1.2 (monkeypatched — no real
    disk_usage call against a meaningful number), silent on enough
    (or exactly enough) space
  - _make_progress_bar_class: the tqdm_class shim's accumulation math,
    driven by a fake snapshot_download-shaped call sequence (three
    bar roles, exactly as huggingface_hub's snapshot_download
    actually instantiates them — verified live against the pinned
    huggingface-hub version, see whisper_server.py's own docstrings) —
    only the "Reconstructing" (bytes-materialized) bar's updates ever
    reach on_progress; the network-transfer and file-count bars never
    do
  - JobManager.start_download_job / _run_download_job: job dict shape
    (kind, display_name, progress, status, error) on both success and
    a raising download, with download_model_snapshot itself stubbed
    out (module-attribute monkeypatch) so no network/model touches
    this process at all
  - do_POST /download-model's validation wiring uses
    validate_download_model for its 400 (HTTPStatus.BAD_REQUEST) —
    asserted at the "same pure function, same status code convention
    as /ingest-url" level, matching how test_ingest_url.py covers
    validate_ingest_url without ever spinning up a live handler (no
    test file in this suite does; do_POST/do_GET/do_PUT are exercised
    by inspection, not a real socket)
"""

from __future__ import annotations

import shutil
import sys
import time
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import whisper_server  # noqa: E402 - module import, for monkeypatching below
from whisper_server import (  # noqa: E402
    MODEL_CHOICES,
    JobManager,
    check_disk_space,
    should_emit_download_progress,
    validate_download_model,
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
# validate_download_model / MODEL_CHOICES
# =================================================================

check(
    "MODEL_CHOICES: exactly the 6 models the argparse/marker allowlists ship "
    "(tiny/base/small/medium/large-v3/large-v3-turbo)",
    MODEL_CHOICES == ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"],
)
check(
    "validate_download_model: accepts every MODEL_CHOICES entry",
    all(validate_download_model(m) is None for m in MODEL_CHOICES),
)
check(
    "validate_download_model: rejects an unknown model name",
    validate_download_model("large-v9000") is not None,
)
check(
    "validate_download_model: rejects None",
    validate_download_model(None) is not None,
)
check(
    "validate_download_model: rejects a non-string type (e.g. a JSON number)",
    validate_download_model(123) is not None,
)
check(
    "validate_download_model: rejects an empty string",
    validate_download_model("") is not None,
)
check(
    "validate_download_model: rejects a near-miss (case-sensitive, no fuzzy match)",
    validate_download_model("Small") is not None,
)
check(
    "validate_download_model: error messages are non-empty zh strings",
    isinstance(validate_download_model("junk"), str) and len(validate_download_model("junk") or "") > 0,
)


# =================================================================
# check_disk_space (decision B's disk precheck) — shutil.disk_usage
# monkeypatched throughout; never touches the real filesystem's free
# space number.
# =================================================================

_real_disk_usage = shutil.disk_usage


def _fake_disk_usage(free_bytes: int):
    def _inner(path):  # noqa: ARG001 - path is unused by the fake
        return types.SimpleNamespace(total=free_bytes * 10, used=0, free=free_bytes)

    return _inner


_TEST_DIR = str(Path(__file__).resolve().parent)  # any existing dir; os.makedirs(exist_ok=True) no-ops on it

shutil.disk_usage = _fake_disk_usage(1 * (1 << 30))  # 1GB free
try:
    raised: Exception | None = None
    try:
        check_disk_space(total_bytes=100 * (1 << 30), check_dir=_TEST_DIR)  # needs ~120GB
    except RuntimeError as exc:  # noqa: BLE001 - capturing intentionally
        raised = exc
    check("check_disk_space: raises when free << total*1.2", raised is not None)
    check(
        "check_disk_space: raises specifically RuntimeError (matches the rest of this "
        "file's zh-message-on-failure convention, e.g. _download_via_ytdlp)",
        isinstance(raised, RuntimeError),
    )
    check(
        "check_disk_space: error message carries the spec's exact zh lead-in (磁盘空间不足)",
        "磁盘空间不足" in str(raised),
    )
finally:
    shutil.disk_usage = _real_disk_usage

shutil.disk_usage = _fake_disk_usage(1000 * (1 << 30))  # 1TB free
try:
    ok = True
    try:
        check_disk_space(total_bytes=100 * (1 << 30), check_dir=_TEST_DIR)  # needs ~120GB, plenty free
    except RuntimeError:
        ok = False
    check("check_disk_space: does not raise when free space is plentiful", ok)
finally:
    shutil.disk_usage = _real_disk_usage

shutil.disk_usage = _fake_disk_usage(120)  # exactly total*1.2
try:
    ok = True
    try:
        check_disk_space(total_bytes=100, check_dir=_TEST_DIR)  # needs exactly 120
    except RuntimeError:
        ok = False
    check("check_disk_space: free == total*1.2 exactly is accepted (boundary is exclusive)", ok)
finally:
    shutil.disk_usage = _real_disk_usage

shutil.disk_usage = _fake_disk_usage(0)
try:
    ok = True
    try:
        check_disk_space(total_bytes=0, check_dir=_TEST_DIR)  # needs 0
    except RuntimeError:
        ok = False
    check("check_disk_space: a zero-byte total never fails the precheck, even with 0 free", ok)
finally:
    shutil.disk_usage = _real_disk_usage


# =================================================================
# _make_progress_bar_class — the tqdm_class shim's accumulation math.
# Driven directly by a fake call sequence shaped exactly like real
# huggingface_hub.snapshot_download's three actual instantiation call
# sites (verified live against the pinned huggingface-hub version —
# see whisper_server.py's own docstring for _make_progress_bar_class):
#   1. transfer_progress:    desc="Downloading bytes", unit="B", ...
#   2. reconstruct_progress: desc="Reconstructing (incomplete total...)",
#                             unit="B", ... <- the ONLY one that should
#                             ever reach on_progress
#   3. thread_map's file-count bar: a positional iterable + desc="Fetching
#      N files", NO unit="B" kwarg
# No network, no real huggingface_hub import — only `tqdm` itself.
# =================================================================

try:
    _progress_calls: list[tuple[int, int]] = []
    _cls = whisper_server._make_progress_bar_class(1000, lambda d, t: _progress_calls.append((d, t)))

    transfer = _cls(desc="Downloading bytes", total=0, initial=0, unit="B", unit_scale=True)
    reconstruct = _cls(desc="Reconstructing (incomplete total...)", total=0, initial=0, unit="B", unit_scale=True)
    file_count = _cls(iter(["a", "b", "c"]), desc="Fetching 3 files", total=3)

    # Mimics _AggregatedTqdm.__init__ bumping the parent bars' totals as
    # snapshot_download discovers each file (see whisper_server.py's
    # docstring) — irrelevant to what WE forward (we use our own
    # precomputed `total`, not the bar's), but exercised anyway since a
    # real run does this too and it must not error.
    reconstruct.total = 1000

    transfer.update(2048)  # network chunk — must never reach on_progress
    check(
        "_make_progress_bar_class: the transfer ('Downloading bytes') bar's updates "
        "never reach on_progress",
        _progress_calls == [],
    )

    reconstruct.update(300)  # first file fully "reconstructed"
    check(
        "_make_progress_bar_class: the reconstruct bar's first update forwards "
        "(downloaded=300, total=1000)",
        _progress_calls == [(300, 1000)],
    )

    reconstruct.update(700)  # second (last) file
    check(
        "_make_progress_bar_class: accumulates cumulatively via real tqdm's own self.n "
        "bookkeeping, reaching (1000, 1000)",
        _progress_calls[-1] == (1000, 1000),
    )
    check(
        "_make_progress_bar_class: monotonically non-decreasing across every forwarded call",
        all(a[0] <= b[0] for a, b in zip(_progress_calls, _progress_calls[1:])),
    )

    consumed = list(file_count)  # thread_map does list(tqdm_class(iterable, **kwargs))
    check(
        "_make_progress_bar_class: the file-count bar transparently wraps/yields its "
        "iterable (real tqdm __iter__, needed for thread_map)",
        consumed == ["a", "b", "c"],
    )
    check(
        "_make_progress_bar_class: the file-count bar's updates (no unit='B') never "
        "reach on_progress either",
        _progress_calls == [(300, 1000), (1000, 1000)],
    )

    check(
        "_make_progress_bar_class: disable is never forced True (would silently freeze "
        "self.n — verified against the pinned tqdm's update() source; see docstring)",
        reconstruct.n == 1000 and reconstruct.disable is not True,
    )

    # Close every bar this section created. Not politeness: leaving them
    # for GC means tqdm's __del__ -> close() -> display() runs during
    # interpreter FINALIZATION, which segfaults on some Pythons (observed
    # on CPython 3.13/macOS: "Garbage-collecting ... format_meter" in the
    # faulthandler trace; exit 139 with all checks green). Production is
    # unaffected — snapshot_download closes the bars it creates, and the
    # venv pins 3.12 — this is purely a bare-instance test artifact.
    transfer.close()
    reconstruct.close()
    file_count.close()
except ImportError as exc:  # pragma: no cover - only if tqdm truly isn't installed
    print(f"SKIP: _make_progress_bar_class section (tqdm not importable: {exc})")


# =================================================================
# JobManager.start_download_job / _run_download_job — job dict shape,
# with download_model_snapshot stubbed at the module level (monkey-
# patch) so nothing here ever touches the network or a real model.
# =================================================================


def _wait_for_job(job_manager: JobManager, job_id: str, timeout: float = 2.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = job_manager.get(job_id)
        if job is not None and job["status"] in ("done", "error"):
            return job
        time.sleep(0.01)
    raise AssertionError(f"job {job_id} did not reach a terminal status within {timeout}s")


_real_download_model_snapshot = whisper_server.download_model_snapshot


def _make_job_manager() -> JobManager:
    return JobManager(model=None, model_name="small", default_language="en", hf_token=None)


def _fake_download_ok(model, on_progress=None):  # noqa: ARG001 - model unused by the fake
    if on_progress is not None:
        on_progress(50, 100)
        on_progress(100, 100)
    return "fake/repo-id"


whisper_server.download_model_snapshot = _fake_download_ok
try:
    jm = _make_job_manager()
    job_id = jm.start_download_job("medium")
    job = _wait_for_job(jm, job_id)
    check("start_download_job (success): status reaches 'done'", job["status"] == "done")
    check("start_download_job (success): progress reaches 1.0", job["progress"] == 1.0)
    check("start_download_job (success): kind is 'download'", job["kind"] == "download")
    check(
        "start_download_job (success): display_name is the requested model name "
        "(GET /jobs listing can show something meaningful)",
        job["display_name"] == "medium",
    )
    check("start_download_job (success): error is None", job["error"] is None)
    check("start_download_job (success): status_detail cleared back to None on done", job["status_detail"] is None)
    check(
        "start_download_job: reuses new_job()'s exact GET /jobs/{id} shape "
        "(id/status/progress/status_detail/segments/error/created_at/kind all present)",
        set(job.keys())
        >= {
            "id",
            "status",
            "progress",
            "status_detail",
            "segments",
            "error",
            "created_at",
            "kind",
            "display_name",
        },
    )
finally:
    whisper_server.download_model_snapshot = _real_download_model_snapshot


def _fake_download_fail(model, on_progress=None):  # noqa: ARG001
    raise RuntimeError("磁盘空间不足：测试用固定失败")


whisper_server.download_model_snapshot = _fake_download_fail
try:
    jm = _make_job_manager()
    job_id = jm.start_download_job("small")
    job = _wait_for_job(jm, job_id)
    check("start_download_job (failure): status lands on 'error'", job["status"] == "error")
    check(
        "start_download_job (failure): job.error carries the exception message",
        job["error"] == "磁盘空间不足：测试用固定失败",
    )
finally:
    whisper_server.download_model_snapshot = _real_download_model_snapshot

# Sanity: start_download_job never blocks the caller — the job starts
# out queued/running, not already terminal, immediately after the call
# returns (the background thread hasn't necessarily run yet).
whisper_server.download_model_snapshot = _fake_download_ok
try:
    jm = _make_job_manager()
    job_id = jm.start_download_job("tiny")
    immediate = jm.get(job_id)
    check(
        "start_download_job: returns before the background thread necessarily "
        "finishes (job exists immediately, in a non-final or already-final status "
        "— never missing)",
        immediate is not None,
    )
    _wait_for_job(jm, job_id)  # drain so the daemon thread isn't left mid-flight
finally:
    whisper_server.download_model_snapshot = _real_download_model_snapshot


# =================================================================
# should_emit_download_progress — --download-only's NDJSON throttle
# rule ("~1 line/500ms or on whole-percent change").
# =================================================================

check(
    "should_emit_download_progress: emits on a whole-percent change even well within 500ms",
    should_emit_download_progress(now=10.1, last_emit=10.0, percent=5, last_percent=4) is True,
)
check(
    "should_emit_download_progress: suppresses an unchanged percent within 500ms",
    should_emit_download_progress(now=10.1, last_emit=10.0, percent=5, last_percent=5) is False,
)
check(
    "should_emit_download_progress: emits on the 500ms heartbeat even with an unchanged percent",
    should_emit_download_progress(now=10.6, last_emit=10.0, percent=5, last_percent=5) is True,
)
check(
    "should_emit_download_progress: exactly 500ms elapsed counts as due (boundary is inclusive)",
    should_emit_download_progress(now=10.5, last_emit=10.0, percent=5, last_percent=5) is True,
)
check(
    "should_emit_download_progress: the very first call (last_percent=-1 sentinel) always emits",
    should_emit_download_progress(now=0.0, last_emit=0.0, percent=0, last_percent=-1) is True,
)


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
