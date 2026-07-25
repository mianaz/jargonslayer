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
    faster_whisper are NEVER really imported here — every test that
    would otherwise need them (the real snapshot_download call, or
    faster_whisper.utils._MODELS lookup) instead drives
    download_model_snapshot's pieces directly or stubs the whole
    function, EXCEPT the F3 cancel-checkpoint section near the end,
    which fakes just enough of huggingface_hub via sys.modules — never
    a real import — to drive the real download_model_snapshot
    end-to-end, mirroring test_model_registry.py's own idiom; see each
    section below.)

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
  - active_download_job_id / start_download_job's single-flight guard
    (S4 review finding, HIGH: unbounded parallel POST /download-model
    could each individually pass their own disk precheck and still
    collectively fill disk) — a second call while one download job is
    still queued/running is refused (returns (None, active_job_id))
    regardless of whether it names the same or a different model; a
    new call is accepted again once that job reaches either terminal
    status, "done" OR "error"
  - do_POST /download-model's validation wiring uses
    validate_download_model for its 400 (HTTPStatus.BAD_REQUEST) —
    asserted at the "same pure function, same status code convention
    as /ingest-url" level, matching how test_ingest_url.py covers
    validate_ingest_url without ever spinning up a live handler (no
    test file in this suite does; do_POST/do_GET/do_PUT are exercised
    by inspection, not a real socket). Its 409 (HTTPStatus.CONFLICT)
    counterpart for the single-flight guard is covered the same way,
    via download_conflict_response's own shape (a thin handler
    assertion — see that section below for why a live handler isn't
    constructed here either)
  - S12a (v0.4.4, MLX local-STT lane, docs/design-explorations/
    s12-mlx-blueprint.md §C R1/Q6): MODEL_CHOICES/validate_download_
    model accept the new parakeet-tdt-0.6b-v3 entry; JobManager._run_
    download_job and run_download_only both thread their hf_token
    (--hf-token/$HF_TOKEN) into download_model_snapshot, which
    previously received no token at all — download_model_snapshot
    itself stubbed to CAPTURE the hf_token kwarg, same no-network
    posture as every other section here. The model->(repo_id, allow_
    patterns) registry itself (parakeet vs. every faster-whisper
    model, byte-identical) and the HF cache-root invariant are covered
    in test_model_registry.py instead — they need a fake huggingface_
    hub/faster_whisper import surface this file deliberately never
    touches (see its own module docstring).
  - Field-test issue 6 (cancellable model downloads): _make_progress_
    bar_class's new cancel_event param — a real (not stubbed) tqdm bar
    raises DownloadCancelled on update() once the event is set, never
    before, never at all when cancel_event=None; JobManager.
    _run_download_job catches DownloadCancelled and lands the job on
    "cancelled" (never "error" — job.error stays None); JobManager.
    request_cancel_download's three-way result ("not_found" for an
    unknown/non-download-kind job, "terminal" for one already done/
    error/cancelled, "ok" — and the job actually reaching "cancelled"
    once its own fake download loop observes the flag, driven end-to-
    end through start_download_job exactly like the single-flight
    section above, not a bare unit call). do_POST /jobs/{id}/cancel's
    HTTPStatus mapping (404/409/202) is a thin handler assertion only
    (same posture as validate_download_model/download_conflict_
    response above — no live handler constructed here either).
  - F4 (review-round fix, Sol LOW #17): start_download_job's
    thread.start() itself failing (threading.Thread.start monkeypatched
    to raise, deterministically) after the job/cancel_event are already
    recorded — the job must land on "error" immediately (not stay
    "queued" forever) and the single-flight slot must be freed right
    away for the next call.
  - F3 (review-round fix, Sol MEDIUM #8, live-verified ~12s latency):
    download_model_snapshot's three explicit cancel_event checkpoints
    (before HfApi().model_info(), before snapshot_download(), and
    after snapshot_download() returns) — the two gaps a pure tqdm-
    update() checkpoint could never observe. Driven against the REAL
    download_model_snapshot with just enough of huggingface_hub faked
    via sys.modules (see this module docstring's own top-level note);
    the last checkpoint is additionally driven end-to-end through
    JobManager.start_download_job/request_cancel_download (the real
    public cancel API, not a back-door into internals) to prove the
    202-then-done race actually lands the job on "cancelled", not
    "done".
"""

from __future__ import annotations

import shutil
import sys
import threading
import time
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import whisper_server  # noqa: E402 - module import, for monkeypatching below
from whisper_server import (  # noqa: E402
    MODEL_CHOICES,
    DownloadCancelled,
    JobManager,
    active_download_job_id,
    check_disk_space,
    download_conflict_response,
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
    "MODEL_CHOICES: exactly the 7 models the argparse/marker allowlists ship "
    "(tiny/base/small/medium/large-v3/large-v3-turbo/parakeet-tdt-0.6b-v3 — S12a "
    "adds parakeet last, every faster-whisper entry byte-identical)",
    MODEL_CHOICES
    == [
        "tiny",
        "base",
        "small",
        "medium",
        "large-v3",
        "large-v3-turbo",
        "parakeet-tdt-0.6b-v3",
    ],
)
check(
    "validate_download_model: accepts every MODEL_CHOICES entry (incl. parakeet)",
    all(validate_download_model(m) is None for m in MODEL_CHOICES),
)
check(
    "validate_download_model: accepts the parakeet model id explicitly",
    validate_download_model("parakeet-tdt-0.6b-v3") is None,
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
# active_download_job_id (single-flight gate, S4 review finding HIGH)
# — pure, no JobManager/threads involved. Mirrors test_ingest_url.py's
# own count_active_url_jobs section (same "pre-release review finding"
# style/shape).
# =================================================================

check(
    "active_download_job_id: an empty jobs dict has no active download",
    active_download_job_id({}) is None,
)
check(
    "active_download_job_id: a queued download job is active",
    active_download_job_id({"a": {"id": "a", "kind": "download", "status": "queued"}}) == "a",
)
check(
    "active_download_job_id: a running download job is active",
    active_download_job_id({"a": {"id": "a", "kind": "download", "status": "running"}}) == "a",
)
check(
    "active_download_job_id: a done download job is NOT active (terminal)",
    active_download_job_id({"a": {"id": "a", "kind": "download", "status": "done"}}) is None,
)
check(
    "active_download_job_id: an error download job is NOT active (terminal)",
    active_download_job_id({"a": {"id": "a", "kind": "download", "status": "error"}}) is None,
)
check(
    "active_download_job_id: a cancelled download job is NOT active (terminal) "
    "(field-test issue 6 — a cancel must free up the single-flight slot, or it "
    "would permanently wedge every future download attempt)",
    active_download_job_id({"a": {"id": "a", "kind": "download", "status": "cancelled"}}) is None,
)
check(
    "active_download_job_id: ignores non-download kinds (upload/url), however active",
    active_download_job_id(
        {
            "a": {"id": "a", "kind": "upload", "status": "running"},
            "b": {"id": "b", "kind": "url", "status": "queued"},
        }
    )
    is None,
)
check(
    "active_download_job_id: a mixed dict of many kinds/statuses finds exactly the active download one",
    active_download_job_id(
        {
            "a": {"id": "a", "kind": "download", "status": "done"},
            "b": {"id": "b", "kind": "url", "status": "running"},
            "c": {"id": "c", "kind": "download", "status": "running"},
            "d": {"id": "d", "kind": "upload", "status": "queued"},
        }
    )
    == "c",
)


# =================================================================
# download_conflict_response — the do_POST /download-model 409 body
# shape (thin handler assertion; see module docstring's own note on
# why no test file in this suite constructs a live handler).
# =================================================================

check(
    "download_conflict_response: names the in-flight job as active_job_id",
    download_conflict_response("job-123")["active_job_id"] == "job-123",
)
check(
    "download_conflict_response: carries a non-empty zh error message",
    isinstance(download_conflict_response("job-123")["error"], str)
    and len(download_conflict_response("job-123")["error"]) > 0,
)


# =================================================================
# JobManager.start_download_job / _run_download_job — job dict shape,
# with download_model_snapshot stubbed at the module level (monkey-
# patch) so nothing here ever touches the network or a real model.
# =================================================================


def _wait_for_job(job_manager: JobManager, job_id: str, timeout: float = 2.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = job_manager.get(job_id)
        # "cancelled" (field-test issue 6) joins "done"/"error" as a
        # third terminal status this helper waits for.
        if job is not None and job["status"] in ("done", "error", "cancelled"):
            return job
        time.sleep(0.01)
    raise AssertionError(f"job {job_id} did not reach a terminal status within {timeout}s")


_real_download_model_snapshot = whisper_server.download_model_snapshot


def _make_job_manager() -> JobManager:
    return JobManager(model=None, model_name="small", default_language="en", hf_token=None)


def _fake_download_ok(model, on_progress=None, hf_token=None, cancel_event=None):  # noqa: ARG001 - model/hf_token/cancel_event unused by the fake
    if on_progress is not None:
        on_progress(50, 100)
        on_progress(100, 100)
    return "fake/repo-id"


whisper_server.download_model_snapshot = _fake_download_ok
try:
    jm = _make_job_manager()
    job_id, active_job_id = jm.start_download_job("medium")
    check("start_download_job (success): job_id is set", job_id is not None)
    check("start_download_job (success): active_job_id is None (nothing else in flight)", active_job_id is None)
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


def _fake_download_fail(model, on_progress=None, hf_token=None, cancel_event=None):  # noqa: ARG001
    raise RuntimeError("磁盘空间不足：测试用固定失败")


whisper_server.download_model_snapshot = _fake_download_fail
try:
    jm = _make_job_manager()
    job_id, active_job_id = jm.start_download_job("small")
    check("start_download_job (failure): job_id is set", job_id is not None)
    check("start_download_job (failure): active_job_id is None (nothing else in flight)", active_job_id is None)
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
    job_id, active_job_id = jm.start_download_job("tiny")
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
# F4 (review-round fix, Sol LOW #17): thread.start() itself failing —
# the job + cancel_event are already recorded (self.jobs/self.
# _cancel_events) by the time start() is attempted, so a start()
# failure must not leave the job stuck "queued" forever (which would
# wedge the single-flight slot permanently, since active_download_
# job_id treats queued/running as still active). threading.Thread.
# start is monkeypatched at the class level to raise deterministically
# — no real OS thread-exhaustion needed, and this is restored in every
# finally below so it never leaks into a later section.
# =================================================================

_real_thread_start = threading.Thread.start


def _raising_thread_start(self):  # noqa: ANN001 - mirrors threading.Thread.start's own signature
    raise RuntimeError("simulated: can't start new thread")


threading.Thread.start = _raising_thread_start
try:
    jm = _make_job_manager()
    job_id, active_job_id = jm.start_download_job("small")
    check(
        "start_download_job (thread.start() failure): still returns a job_id "
        "(the job WAS recorded before start() was ever attempted), and no "
        "active_job_id (this call itself was the one accepted)",
        job_id is not None and active_job_id is None,
    )
    job = jm.get(job_id)
    check(
        "start_download_job (thread.start() failure): the job lands on 'error' "
        "immediately — no background thread ever ran to do it, so it must not "
        "stay 'queued' forever",
        job is not None and job["status"] == "error",
    )
    check(
        "start_download_job (thread.start() failure): job.error carries the "
        "start() failure message",
        job is not None and job["error"] == "simulated: can't start new thread",
    )
    check(
        "start_download_job (thread.start() failure): the now-orphaned cancel "
        "event is dropped too — no thread is left to ever observe it",
        job_id not in jm._cancel_events,
    )
finally:
    threading.Thread.start = _real_thread_start

# The single-flight slot itself must not be wedged by a start() failure
# — active_download_job_id excludes "error" as terminal, so a fresh
# call right after must be accepted immediately, same as the ordinary
# done/error/cancelled sections elsewhere in this file.
whisper_server.download_model_snapshot = _fake_download_ok
try:
    jm = _make_job_manager()
    threading.Thread.start = _raising_thread_start
    try:
        jm.start_download_job("small")
    finally:
        threading.Thread.start = _real_thread_start

    unblocked_id, unblocked_active = jm.start_download_job("medium")
    check(
        "start_download_job (thread.start() failure): the single-flight slot is "
        "freed immediately — a new call right after is accepted, not refused",
        unblocked_id is not None and unblocked_active is None,
    )
    _wait_for_job(jm, unblocked_id)
finally:
    whisper_server.download_model_snapshot = _real_download_model_snapshot
    threading.Thread.start = _real_thread_start


# =================================================================
# start_download_job's single-flight guard (S4 review finding, HIGH):
# a second call while a download job is still queued/running is
# refused — same model OR a different one — and names the in-flight
# job; a new call is accepted again once that job reaches EITHER
# terminal status ("done" or "error"). Uses a threading.Event to hold
# the fake download open exactly long enough to make the "still in
# flight" window deterministic, rather than racing real timing.
# =================================================================

_release_download = threading.Event()


def _fake_download_blocks_until_released(model, on_progress=None, hf_token=None, cancel_event=None):  # noqa: ARG001
    if not _release_download.wait(timeout=5.0):
        raise AssertionError("test bug: _release_download was never set")
    return "fake/repo-id"


whisper_server.download_model_snapshot = _fake_download_blocks_until_released
try:
    _release_download.clear()
    jm = _make_job_manager()
    job_id_1, active_1 = jm.start_download_job("medium")
    check("single-flight: the first call is accepted", job_id_1 is not None and active_1 is None)

    # Second call arrives while the first is still queued/running
    # (new_job() itself starts a job out at status=="queued", inside
    # the SAME locked section start_download_job's single-flight check
    # runs in — see its docstring — so this is deterministic
    # regardless of whether the background thread has already flipped
    # it to "running").
    job_id_2, active_2 = jm.start_download_job("small")  # deliberately a DIFFERENT model
    check(
        "single-flight: a second call while the first is still in flight is refused "
        "(job_id is None), even for a different model",
        job_id_2 is None,
    )
    check(
        "single-flight: the refusal names the in-flight job as active_job_id",
        active_2 == job_id_1,
    )

    _release_download.set()  # let the first job finish
    job_1 = _wait_for_job(jm, job_id_1)
    check("single-flight: the first job reaches 'done' once released", job_1["status"] == "done")

    job_id_3, active_3 = jm.start_download_job("tiny")
    check(
        "single-flight: a new call is accepted once the prior job reaches 'done'",
        job_id_3 is not None and active_3 is None,
    )
    _wait_for_job(jm, job_id_3)
finally:
    whisper_server.download_model_snapshot = _real_download_model_snapshot
    _release_download.set()

whisper_server.download_model_snapshot = _fake_download_fail
try:
    jm = _make_job_manager()
    job_id_1, active_1 = jm.start_download_job("small")
    job_1 = _wait_for_job(jm, job_id_1)
    check("single-flight (error path): the first job lands on 'error'", job_1["status"] == "error")

    job_id_2, active_2 = jm.start_download_job("medium")
    check(
        "single-flight: an 'error' terminal job also unblocks a new call "
        "(not just 'done')",
        job_id_2 is not None and active_2 is None,
    )
    _wait_for_job(jm, job_id_2)
finally:
    whisper_server.download_model_snapshot = _real_download_model_snapshot


# =================================================================
# hf_token threading (S12a Q6/F11, s12-mlx-blueprint.md §C R1) —
# previously NEITHER JobManager._run_download_job NOR run_download_
# only passed a token to download_model_snapshot at all (verified live
# against this exact pre-S12a source before this chunk landed); both
# now thread their own --hf-token/$HF_TOKEN through. download_model_
# snapshot itself is stubbed (module-attribute monkeypatch, same as
# every section above) purely to CAPTURE the hf_token kwarg it was
# called with — no network/model touches this process.
# =================================================================

_captured_hf_token: list[object] = []


def _fake_download_captures_token(model, on_progress=None, hf_token=None, cancel_event=None):  # noqa: ARG001
    _captured_hf_token.append(hf_token)
    return "fake/repo-id"


whisper_server.download_model_snapshot = _fake_download_captures_token
try:
    _captured_hf_token.clear()
    jm = JobManager(model=None, model_name="small", default_language="en", hf_token="jm-token-abc")
    job_id, _ = jm.start_download_job("medium")
    _wait_for_job(jm, job_id)
    check(
        "JobManager._run_download_job: threads self.hf_token (the SAME CLI/env "
        "token diarization already falls back to) into download_model_snapshot",
        _captured_hf_token == ["jm-token-abc"],
    )
finally:
    whisper_server.download_model_snapshot = _real_download_model_snapshot

whisper_server.download_model_snapshot = _fake_download_captures_token
try:
    _captured_hf_token.clear()
    jm = JobManager(model=None, model_name="small", default_language="en", hf_token=None)
    job_id, _ = jm.start_download_job("small")
    _wait_for_job(jm, job_id)
    check(
        "JobManager._run_download_job: an unset self.hf_token (None) still reaches "
        "download_model_snapshot explicitly as None, not silently omitted",
        _captured_hf_token == [None],
    )
finally:
    whisper_server.download_model_snapshot = _real_download_model_snapshot

whisper_server.download_model_snapshot = _fake_download_captures_token
try:
    _captured_hf_token.clear()
    # run_download_only prints real NDJSON progress/done lines to real
    # stdout here (download_model_snapshot is stubbed, but the NDJSON
    # emission around it isn't) — harmless noise in this suite's own
    # plain-script output, not asserted on; only the hf_token threading
    # and the True/False return matter to this section.
    ok = whisper_server.run_download_only("small", hf_token="dl-only-token")
    check("run_download_only: threads hf_token into download_model_snapshot", _captured_hf_token == ["dl-only-token"])
    check("run_download_only: returns True on a successful download", ok is True)
finally:
    whisper_server.download_model_snapshot = _real_download_model_snapshot

whisper_server.download_model_snapshot = _fake_download_fail
try:
    ok = whisper_server.run_download_only("small", hf_token=None)
    check("run_download_only: returns False when download_model_snapshot raises", ok is False)
finally:
    whisper_server.download_model_snapshot = _real_download_model_snapshot


# =================================================================
# Field-test issue 6 (cancellable model downloads): DownloadCancelled +
# _make_progress_bar_class's new cancel_event param — a REAL tqdm bar
# (no huggingface_hub/network involved, same as the progress-bar-math
# section above), driven directly.
# =================================================================

try:
    _cancel_event = threading.Event()
    _cancel_cls = whisper_server._make_progress_bar_class(
        1000, lambda d, t: None, cancel_event=_cancel_event
    )
    _cancel_bar = _cancel_cls(desc="Reconstructing (incomplete total...)", total=0, initial=0, unit="B", unit_scale=True)

    raised_before_set = False
    try:
        _cancel_bar.update(100)
    except DownloadCancelled:
        raised_before_set = True
    check(
        "_make_progress_bar_class: update() does not raise DownloadCancelled before cancel_event is set",
        not raised_before_set,
    )

    _cancel_event.set()
    raised_after_set = False
    try:
        _cancel_bar.update(100)
    except DownloadCancelled:
        raised_after_set = True
    check(
        "_make_progress_bar_class: update() raises DownloadCancelled once cancel_event is set",
        raised_after_set,
    )
    _cancel_bar.close()

    # cancel_event=None (the default — every pre-field-test-6 caller,
    # e.g. run_download_only's own --download-only path, which is
    # cancelled at the OS-process level by Rust's cancel_prewarm
    # instead, never via this mechanism) must never raise.
    _no_cancel_cls = whisper_server._make_progress_bar_class(1000, lambda d, t: None)
    _no_cancel_bar = _no_cancel_cls(desc="Reconstructing (incomplete total...)", total=0, initial=0, unit="B", unit_scale=True)
    raised_with_no_event = False
    try:
        _no_cancel_bar.update(100)
    except DownloadCancelled:
        raised_with_no_event = True
    check(
        "_make_progress_bar_class: cancel_event=None (default) never raises DownloadCancelled",
        not raised_with_no_event,
    )
    _no_cancel_bar.close()
except ImportError as exc:  # pragma: no cover - only if tqdm truly isn't installed
    print(f"SKIP: DownloadCancelled/_make_progress_bar_class cancel_event section (tqdm not importable: {exc})")


# =================================================================
# JobManager._run_download_job: DownloadCancelled -> status "cancelled"
# (never "error"; job.error stays None) — same stub-download-at-the-
# module-level posture as the success/failure sections above.
# =================================================================


def _fake_download_cancelled(model, on_progress=None, hf_token=None, cancel_event=None):  # noqa: ARG001
    raise DownloadCancelled("download cancelled")


whisper_server.download_model_snapshot = _fake_download_cancelled
try:
    jm = _make_job_manager()
    job_id, active_job_id = jm.start_download_job("small")
    check("start_download_job (cancelled): job_id is set", job_id is not None)
    check("start_download_job (cancelled): active_job_id is None (nothing else in flight)", active_job_id is None)
    job = _wait_for_job(jm, job_id)
    check("start_download_job (cancelled): status lands on 'cancelled'", job["status"] == "cancelled")
    check("start_download_job (cancelled): error stays None — a cancel is not an error", job["error"] is None)
    check(
        "start_download_job (cancelled): a NEW download call is accepted right away "
        "(single-flight slot freed, mirrors the done/error sections above)",
        jm.start_download_job("medium")[0] is not None,
    )
finally:
    whisper_server.download_model_snapshot = _real_download_model_snapshot


# =================================================================
# JobManager.request_cancel_download — the three-way result do_POST
# /jobs/{id}/cancel maps to 404/409/202 (thin handler assertion only,
# same posture as validate_download_model/download_conflict_response's
# own 400/409 coverage above — no live handler constructed here).
# =================================================================

check(
    "request_cancel_download: an unknown job id returns 'not_found'",
    _make_job_manager().request_cancel_download("no-such-job-id") == "not_found",
)

_jm_wrong_kind = _make_job_manager()
_jm_wrong_kind.jobs["fake-upload-id"] = {"id": "fake-upload-id", "kind": "upload", "status": "running"}
check(
    "request_cancel_download: a job that isn't kind=='download' (e.g. an upload/url "
    "job) returns 'not_found' — no cancel mechanism exists for those",
    _jm_wrong_kind.request_cancel_download("fake-upload-id") == "not_found",
)

whisper_server.download_model_snapshot = _fake_download_ok
try:
    _jm_done = _make_job_manager()
    _done_id, _ = _jm_done.start_download_job("small")
    _wait_for_job(_jm_done, _done_id)
    check(
        "request_cancel_download: a job that already reached 'done' returns 'terminal'",
        _jm_done.request_cancel_download(_done_id) == "terminal",
    )
finally:
    whisper_server.download_model_snapshot = _real_download_model_snapshot


# End-to-end (within this file's own no-network posture): a fake
# download that actually LOOPS checking cancel_event — mirrors the real
# download_model_snapshot's own contract (cancel_event checked at each
# tqdm update()/loop boundary, see DownloadCancelled's own doc comment)
# — proves request_cancel_download's "ok" result is actually OBSERVED
# by the job's background thread, not just that the flag gets set.
def _fake_download_checks_cancel(model, on_progress=None, hf_token=None, cancel_event=None):  # noqa: ARG001
    for _ in range(500):  # up to ~5s at 10ms/iteration — _wait_for_job's own 2s default times out first on a bug
        if cancel_event is not None and cancel_event.is_set():
            raise DownloadCancelled("download cancelled")
        time.sleep(0.01)
    return "fake/repo-id"  # only reached if this test is broken (never actually cancelled)


whisper_server.download_model_snapshot = _fake_download_checks_cancel
try:
    jm = _make_job_manager()
    job_id, _ = jm.start_download_job("medium")
    result = jm.request_cancel_download(job_id)
    check("request_cancel_download: a queued/running download job returns 'ok'", result == "ok")
    job = _wait_for_job(jm, job_id)
    check(
        "request_cancel_download: 'ok' is actually OBSERVED by the job's own background "
        "thread — status reaches 'cancelled' end-to-end, not just the flag being set",
        job["status"] == "cancelled",
    )
    check(
        "request_cancel_download: calling it again on an already-cancelled job returns "
        "'terminal', not 'ok' — idempotent, matches the 404/409 route-convention doc comment",
        jm.request_cancel_download(job_id) == "terminal",
    )
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
# F3 (review-round fix, Sol MEDIUM #8, live-verified ~12s latency):
# download_model_snapshot's three explicit cancel_event checkpoints
# (see whisper_server.py's own _raise_if_cancelled/download_model_
# snapshot doc comments) — the pre-fix code only ever observed
# cancel_event inside _ProgressBar.update(), unobservable during
# HfApi().model_info()'s own metadata round trip, or in the gap
# between snapshot_download's LAST update() call and the moment it
# actually returns (a 202-then-done race: POST /jobs/{id}/cancel
# already answered 202, but the job still finished "done"). Exercising
# the three checkpoints needs a REAL download_model_snapshot call —
# they live strictly between its two huggingface_hub calls — so this
# section fakes JUST enough of huggingface_hub (sys.modules, mirroring
# test_model_registry.py's own idiom) to control exactly when
# cancel_event flips relative to each checkpoint, with zero real
# network/model I/O. See this module's own top-level docstring for why
# this is a deliberate, scoped exception to the "never import
# huggingface_hub" posture everywhere else in this file.
# =================================================================

_UNSET = object()


def _set_fake_huggingface_hub(model_info_fn, snapshot_download_fn) -> dict[str, object]:
    saved: dict[str, object] = {
        name: sys.modules.get(name, _UNSET) for name in ("huggingface_hub", "huggingface_hub.constants")
    }

    class _FakeHfApi:
        def model_info(self, repo_id, *, files_metadata=False, token=None):
            return model_info_fn(repo_id, files_metadata=files_metadata, token=token)

    fake_hub = types.ModuleType("huggingface_hub")
    fake_hub.HfApi = _FakeHfApi  # type: ignore[attr-defined]
    fake_constants = types.ModuleType("huggingface_hub.constants")
    fake_constants.HF_HUB_CACHE = _TEST_DIR  # type: ignore[attr-defined] - a real, existing dir; plenty of free space for the tiny totals below
    fake_hub.constants = fake_constants  # type: ignore[attr-defined]
    fake_hub.snapshot_download = snapshot_download_fn  # type: ignore[attr-defined]
    sys.modules["huggingface_hub"] = fake_hub
    sys.modules["huggingface_hub.constants"] = fake_constants
    return saved


def _restore_huggingface_hub(saved: dict[str, object]) -> None:
    for name, prev in saved.items():
        if prev is _UNSET:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = prev  # type: ignore[assignment]


def _fake_model_info_result(total_bytes: int):
    # "config.json" matches "small"'s own MODEL_DOWNLOAD_ALLOW_PATTERNS,
    # so download_model_snapshot's fnmatch-filtered `total` comes out to
    # exactly total_bytes — no need to fake a whole realistic sibling list.
    sibling = types.SimpleNamespace(rfilename="config.json", size=total_bytes)
    return types.SimpleNamespace(siblings=[sibling])


_SMALL_REPO_ID = "Systran/faster-whisper-small"  # WHISPER_REPO_IDS["small"]
_f3_model_info_calls: list[str] = []
_f3_snapshot_calls: list[str] = []


def _f3_model_info(repo_id, *, files_metadata=False, token=None):  # noqa: ARG001
    _f3_model_info_calls.append(repo_id)
    return _fake_model_info_result(1024)


def _f3_snapshot_download(repo_id, *, allow_patterns=None, token=None, tqdm_class=None, **kwargs):  # noqa: ARG001
    _f3_snapshot_calls.append(repo_id)
    return f"/fake/cache/{repo_id}"


# ---- checkpoint (a): already cancelled before model_info is ever called ----

_cancel_a = threading.Event()
_cancel_a.set()
_f3_model_info_calls.clear()
_f3_snapshot_calls.clear()
_saved_hub_a = _set_fake_huggingface_hub(_f3_model_info, _f3_snapshot_download)
try:
    raised_a: Exception | None = None
    try:
        whisper_server.download_model_snapshot("small", cancel_event=_cancel_a)
    except DownloadCancelled as exc:  # noqa: BLE001 - capturing intentionally
        raised_a = exc
    check(
        "download_model_snapshot checkpoint (a): an already-set cancel_event "
        "raises DownloadCancelled before ever calling HfApi().model_info()",
        isinstance(raised_a, DownloadCancelled),
    )
    check(
        "download_model_snapshot checkpoint (a): model_info is never reached",
        _f3_model_info_calls == [],
    )
    check(
        "download_model_snapshot checkpoint (a): snapshot_download is never reached either",
        _f3_snapshot_calls == [],
    )
finally:
    _restore_huggingface_hub(_saved_hub_a)


# ---- checkpoint (b) ("pre-download checkpoint"): cancel observed right
# after metadata resolves, before the actual transfer starts ----

_cancel_b = threading.Event()


def _f3_model_info_then_cancel(repo_id, *, files_metadata=False, token=None):  # noqa: ARG001
    _f3_model_info_calls.append(repo_id)
    _cancel_b.set()  # simulates a cancel arriving during/right after the metadata call
    return _fake_model_info_result(1024)


_f3_model_info_calls.clear()
_f3_snapshot_calls.clear()
_saved_hub_b = _set_fake_huggingface_hub(_f3_model_info_then_cancel, _f3_snapshot_download)
try:
    raised_b: Exception | None = None
    try:
        whisper_server.download_model_snapshot("small", cancel_event=_cancel_b)
    except DownloadCancelled as exc:  # noqa: BLE001
        raised_b = exc
    check(
        "download_model_snapshot checkpoint (b): model_info DOES run first "
        "(checkpoint (a) correctly did not fire before the event was set)",
        _f3_model_info_calls == [_SMALL_REPO_ID],
    )
    check(
        "download_model_snapshot checkpoint (b) ('pre-download checkpoint'): a "
        "cancel observed right after metadata resolves raises DownloadCancelled "
        "before snapshot_download is ever called — the actual transfer never starts",
        isinstance(raised_b, DownloadCancelled) and _f3_snapshot_calls == [],
    )
finally:
    _restore_huggingface_hub(_saved_hub_b)


# ---- checkpoint (c) ("post-download checkpoint"): cancel observed only
# after snapshot_download has already fully returned — the 202-then-done
# race a pure tqdm-callback checkpoint could never catch ----

_cancel_c = threading.Event()


def _f3_snapshot_then_cancel(repo_id, *, allow_patterns=None, token=None, tqdm_class=None, **kwargs):  # noqa: ARG001
    _f3_snapshot_calls.append(repo_id)
    # The last real tqdm update() callback already happened normally (this
    # fake never touches tqdm_class at all) — cancel_event only flips in the
    # gap between that last callback and this call actually returning.
    _cancel_c.set()
    return f"/fake/cache/{repo_id}"


_f3_model_info_calls.clear()
_f3_snapshot_calls.clear()
_saved_hub_c = _set_fake_huggingface_hub(_f3_model_info, _f3_snapshot_then_cancel)
try:
    raised_c: Exception | None = None
    try:
        whisper_server.download_model_snapshot("small", cancel_event=_cancel_c)
    except DownloadCancelled as exc:  # noqa: BLE001
        raised_c = exc
    check(
        "download_model_snapshot checkpoint (c): both model_info and "
        "snapshot_download DID run — the transfer itself genuinely completed",
        _f3_model_info_calls == [_SMALL_REPO_ID] and _f3_snapshot_calls == [_SMALL_REPO_ID],
    )
    check(
        "download_model_snapshot checkpoint (c) ('post-download checkpoint'): a "
        "cancel observed only after snapshot_download returns still raises "
        "DownloadCancelled instead of returning repo_id",
        isinstance(raised_c, DownloadCancelled),
    )
finally:
    _restore_huggingface_hub(_saved_hub_c)


# ---- checkpoint (c), end-to-end through JobManager: "event set after the
# last progress callback -> job ends cancelled not done". Uses the REAL
# public cancel API (request_cancel_download), not a back-door into
# JobManager internals — a threading.Event handshake (mirrors this file's
# own _fake_download_blocks_until_released idiom) makes the timing
# deterministic against the real race between start_download_job's caller
# and its background thread. ----

_job_id_box: list[str] = []
_job_id_ready = threading.Event()


def _f3_snapshot_then_request_cancel(repo_id, *, allow_patterns=None, token=None, tqdm_class=None, **kwargs):  # noqa: ARG001
    _f3_snapshot_calls.append(repo_id)
    if not _job_id_ready.wait(timeout=5.0):
        raise AssertionError("test bug: job_id was never published")
    jm_e2e.request_cancel_download(_job_id_box[0])
    return f"/fake/cache/{repo_id}"


_f3_model_info_calls.clear()
_f3_snapshot_calls.clear()
_job_id_box.clear()
_job_id_ready.clear()
jm_e2e = _make_job_manager()
_saved_hub_e2e = _set_fake_huggingface_hub(_f3_model_info, _f3_snapshot_then_request_cancel)
try:
    job_id_e2e, active_e2e = jm_e2e.start_download_job("small")
    check(
        "download_model_snapshot checkpoint (c) end-to-end: start_download_job "
        "itself is accepted normally",
        job_id_e2e is not None and active_e2e is None,
    )
    _job_id_box.append(job_id_e2e)
    _job_id_ready.set()
    job_e2e = _wait_for_job(jm_e2e, job_id_e2e)
    check(
        "download_model_snapshot checkpoint (c) end-to-end: a cancel landing "
        "after snapshot_download has already fully run (event set after the last "
        "progress callback) still lands the job on 'cancelled', never 'done' — "
        "the 202-then-done race",
        job_e2e["status"] == "cancelled",
    )
    check(
        "download_model_snapshot checkpoint (c) end-to-end: error stays None — "
        "a cancel is not an error",
        job_e2e["error"] is None,
    )
finally:
    _restore_huggingface_hub(_saved_hub_e2e)


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
