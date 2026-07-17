#!/usr/bin/env python3
"""Plain-assert self-test for whisper_server.py's S13 hotfix (v0.4.4
field report: "huge python RAM usage even after transcription
finished" — see that file's own "S13 hotfix" module-section docstring,
right above LazyWhisperModel, for the full field-bug/fix rationale).
Mirrors test_whisper_protocol.py/test_parakeet_backend.py's own style/
harness exactly: no pytest, no network, no real faster-whisper model —
`whisper_server.load_model` is monkeypatched to a counting stub
returning a FAKE model object on every test below, never the real
thing. Classic faster-whisper backend ONLY — ParakeetMlxBackend is
untouched by this hotfix and has no coverage here.

Run:
    sidecar/.venv/bin/python sidecar/test_lazy_load.py

Covers (control-flow only — no RSS measurements; whisper_server.py's
own module-section docstring above LazyWhisperModel documents the
LIVE RSS verification this worker actually ran, separately, against a
real cached faster-whisper-medium snapshot):
  - LazyWhisperModel.__init__ never loads (model_name/device/
    compute_type stored, load_model untouched)
  - ensure_loaded()/acquire()/.transcribe() all trigger the lazy load
    on first use, exactly once even across repeated calls (double-
    checked — a second acquire()/transcribe() never reloads)
  - idle-unload: release()-to-0 arms a countdown; once it elapses with
    zero active work, the model is dropped (LazyWhisperModel._model is
    None) and gc.collect() is safe to have run
  - activity resets the countdown: a fresh acquire() arriving mid-
    countdown cancels it outright — the model survives well past the
    ORIGINAL deadline
  - a unit of work (transcribe()) arriving mid-countdown still
    succeeds, against the SAME already-warm model (no spurious reload)
  - unload never fires while at least one unit of work is still
    "active" (acquire() without a matching release() yet) — only after
    release() does the countdown even arm
  - reload after an unload: the NEXT .transcribe() call reloads
    (load_model called a second time) and still succeeds
  - WhisperServer.handle() wiring: a live ws connection loads the model
    on connect and releases it on close (isinstance-gated — self.model
    being a LazyWhisperModel at all is what turns this on; the eager
    path, self.model as a plain object, is unaffected — see
    test_whisper_protocol.py's own full suite, entirely unchanged by
    this hotfix and still green with self.model=None throughout)
  - JobManager._run_job wiring: start_job()'s real background thread
    acquires around the job's whole lifetime and releases in its own
    outermost finally — on both a successful job AND one whose
    transcription raises (mirrors test_parakeet_backend.py's own FB4
    crash-releases-the-slot proof, for this hotfix's own counter)
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import whisper_server  # noqa: E402 - module import, for monkeypatching load_model below
from whisper_server import (  # noqa: E402
    ConnectionState,
    JobManager,
    LazyWhisperModel,
    WhisperServer,
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
# Fixtures / fakes — a FAKE faster-whisper model (never the real
# faster_whisper.WhisperModel/ctranslate2 stack), swapped in via a
# monkeypatched whisper_server.load_model (mirrors test_download.py's
# own whisper_server.download_model_snapshot monkeypatch idiom).
# =================================================================


class FakeSeg:
    def __init__(self, start: float, end: float, text: str) -> None:
        self.start, self.end, self.text = start, end, text


class FakeInfo:
    duration = 2.0


class FakeFasterWhisperModel:
    """Stands in for a REAL faster_whisper.WhisperModel — `.transcribe`
    covers BOTH real call shapes this file's two call sites use
    (WhisperServer._transcribe's `audio` positional + kwargs, and
    JobManager._transcribe_job's `file_path` positional + kwargs) —
    both just land in `*args`/`**kwargs` here, never inspected beyond
    that."""

    def __init__(self, text: str = "hello", fail: bool = False) -> None:
        self.calls: list[tuple[tuple, dict]] = []
        self.text = text
        self.fail = fail

    def transcribe(self, *args: Any, **kwargs: Any):
        self.calls.append((args, kwargs))
        if self.fail:
            raise RuntimeError("boom-transcribe")
        return [FakeSeg(0.0, 1.0, self.text)], FakeInfo()


def patch_load_model():
    """Monkeypatches whisper_server.load_model (the bare module global
    LazyWhisperModel.ensure_loaded calls) to a counting stub that hands
    back a FRESH FakeFasterWhisperModel on every call — so a test can
    assert both "how many times did a real load happen" (call count)
    and "is this the SAME model instance across acquire()s, or a fresh
    one after an unload" (identity). Returns (restore_fn, call_log) —
    call_log is a list of the FakeFasterWhisperModel instances handed
    out, in order."""
    real_load_model = whisper_server.load_model
    call_log: list[FakeFasterWhisperModel] = []

    def fake_load_model(model_name: str, device: str, compute_type: str):
        fake = FakeFasterWhisperModel()
        call_log.append(fake)
        return fake, 0.01

    whisper_server.load_model = fake_load_model  # type: ignore[assignment]

    def restore() -> None:
        whisper_server.load_model = real_load_model  # type: ignore[assignment]

    return restore, call_log


# =================================================================
# LazyWhisperModel: not loaded until first use
# =================================================================


def test_not_loaded_at_construction() -> None:
    restore, call_log = patch_load_model()
    try:
        lm = LazyWhisperModel("small", "cpu", "int8")
        check("construction never loads: _model is None", lm._model is None)
        check("construction never loads: load_model was never called", call_log == [])
    finally:
        restore()


def test_ensure_loaded_triggers_exactly_one_real_load() -> None:
    restore, call_log = patch_load_model()
    try:
        lm = LazyWhisperModel("small", "cpu", "int8")
        lm.ensure_loaded()
        check("ensure_loaded: loads on first call", lm._model is call_log[0])
        check("ensure_loaded: load_model called exactly once", len(call_log) == 1)

        lm.ensure_loaded()
        check(
            "ensure_loaded: a SECOND call is a no-op — already loaded, no reload",
            len(call_log) == 1,
        )
    finally:
        restore()


def test_transcribe_proxies_and_triggers_lazy_load() -> None:
    restore, call_log = patch_load_model()
    try:
        lm = LazyWhisperModel("small", "cpu", "int8")
        check("transcribe: not loaded before the first call", lm._model is None)
        segments, _info = lm.transcribe("fake-audio", language="en", beam_size=1)
        check(
            "transcribe: proxies through to the underlying fake model's own return shape",
            len(segments) == 1 and segments[0].text == "hello",
        )
        check(
            "transcribe: the underlying model received the SAME args/kwargs the caller passed",
            call_log[0].calls == [(("fake-audio",), {"language": "en", "beam_size": 1})],
        )
        check("transcribe: load_model called exactly once", len(call_log) == 1)
    finally:
        restore()


def test_acquire_also_triggers_lazy_load_and_only_once() -> None:
    restore, call_log = patch_load_model()
    try:
        lm = LazyWhisperModel("small", "cpu", "int8")
        lm.acquire()
        check("acquire: loads on first call", len(call_log) == 1)
        lm.acquire()  # a SECOND concurrent unit of work
        check("acquire: a second acquire() never reloads", len(call_log) == 1)
        check("acquire: active_count reflects both units", lm._active_count == 2)
    finally:
        restore()


# =================================================================
# LazyWhisperModel: idle-unload lifecycle
# =================================================================

IDLE_S = 0.05  # tiny idle window for these tests — real callers use IDLE_UNLOAD_MINUTES


def test_idle_timeout_unloads_once_active_work_reaches_zero() -> None:
    restore, call_log = patch_load_model()
    try:
        lm = LazyWhisperModel("small", "cpu", "int8", idle_unload_seconds=IDLE_S)
        lm.acquire()
        lm.release()
        check("idle-unload setup: model is loaded right after release()", lm._model is not None)
        time.sleep(IDLE_S * 4)
        check(
            "idle-unload: the model is released once the countdown elapses with zero active work",
            lm._model is None,
        )
        check("idle-unload: no second load happened on its own", len(call_log) == 1)
    finally:
        restore()


def test_two_concurrent_units_only_unloads_after_both_release() -> None:
    """Distinct from the single-connection tests above (this file's
    own "unload never fires while active" and "activity resets the
    timer" checks each only ever have ONE outstanding acquire() at a
    time) — the classic whisper backend legitimately supports SEVERAL
    concurrent connections/jobs (unlike parakeet's single-slot
    reservation), so releasing the FIRST of two active units must
    never arm the idle countdown while the second is still active."""
    restore, call_log = patch_load_model()
    try:
        lm = LazyWhisperModel("small", "cpu", "int8", idle_unload_seconds=IDLE_S)
        lm.acquire()  # connection A
        lm.acquire()  # connection B (concurrent with A)
        lm.release()  # A finishes — B is STILL active
        time.sleep(IDLE_S * 4)
        check(
            "two concurrent units: releasing only ONE of two active units never arms the idle countdown",
            lm._model is not None,
        )
        check("two concurrent units: no countdown was armed while B is still active", lm._idle_timer is None)

        lm.release()  # B finishes too — NOW it's truly idle
        time.sleep(IDLE_S * 4)
        check("two concurrent units: NOW (after BOTH release) the model unloads", lm._model is None)
        check("two concurrent units: still just the one original load, never reloaded mid-test", len(call_log) == 1)
    finally:
        restore()


def test_on_idle_timeout_belt_rechecks_active_count_directly() -> None:
    """Every OTHER test in this file exercises the countdown through
    the real threading.Timer + acquire()'s own cancel — which means
    the "belt" recheck inside _on_idle_timeout itself (`if self.
    _active_count > 0: return` — see that method's own docstring on
    why it exists ALONGSIDE acquire()'s cancel, not instead of it) is
    never actually the thing that saves those tests: acquire()'s
    cancel already wins the race every time in a single-threaded test.
    Calling _on_idle_timeout() DIRECTLY here — simulating the exact
    narrow race its own docstring describes (a timer callback reaching
    the lock while a unit of work is genuinely active) without needing
    real multi-thread timing — is what actually proves that specific
    line isn't dead code."""
    restore, call_log = patch_load_model()
    try:
        lm = LazyWhisperModel("small", "cpu", "int8", idle_unload_seconds=IDLE_S)
        lm.acquire()  # active_count=1, no release() at all — simulates a still-active unit
        # F7: _on_idle_timeout now takes the timer's own generation —
        # no real timer was ever armed here (only acquire(), no
        # release()), so passing the CURRENT generation is the correct
        # "this callback belongs to whatever's presently armed" shape.
        lm._on_idle_timeout(lm._timer_generation)  # simulates a timer callback racing straight in regardless
        check(
            "_on_idle_timeout belt: a direct call while active_count>0 never unloads",
            lm._model is not None,
        )
        check("_on_idle_timeout belt: no reload was needed (never actually unloaded)", len(call_log) == 1)
    finally:
        restore()


def test_stale_idle_timeout_callback_never_unloads_and_leaves_current_timer_intact() -> None:
    """F7 (Sol, MINOR): reproduces the exact race the fix closes —
    Timer A fires and blocks on `_lock`; meanwhile a fresh burst of
    activity cancels A (too late, it already fired), finishes its own
    work, and installs Timer B via a fresh release(). A then reaches
    the lock with a now-SUPERSEDED generation. Simulated deterministically
    here by calling `_on_idle_timeout` directly with Timer A's captured
    (stale) generation, AFTER Timer B has already been armed — rather
    than racing real threads. Uses a long idle window so the real
    background Timer objects never actually fire mid-test (this test
    only cares about the DIRECT, simulated-stale call)."""
    restore, call_log = patch_load_model()
    try:
        lm = LazyWhisperModel("small", "cpu", "int8", idle_unload_seconds=100.0)
        lm.acquire()
        lm.release()  # arms Timer A
        stale_generation = lm._timer_generation
        timer_a = lm._idle_timer
        check("stale setup: Timer A was armed", timer_a is not None)

        lm.acquire()  # cancels Timer A (well within its 100s window)
        lm.release()  # arms Timer B — a fresh generation
        timer_b = lm._idle_timer
        check("stale setup: Timer B is a different instance than Timer A", timer_b is not timer_a)
        check("stale setup: the generation advanced past A's", lm._timer_generation != stale_generation)

        # Timer A's stale callback finally reaches the lock (simulated
        # directly, per this test's own docstring).
        lm._on_idle_timeout(stale_generation)

        check("stale callback: the model was NOT unloaded on A's behalf", lm._model is not None)
        check("stale callback: Timer B's own reference is left completely intact", lm._idle_timer is timer_b)
        check("stale callback: no reload happened (still the one original load)", len(call_log) == 1)

        timer_b.cancel()  # test hygiene — never let it actually fire
    finally:
        restore()


def test_a_fresh_acquire_mid_countdown_cancels_it() -> None:
    restore, call_log = patch_load_model()
    try:
        lm = LazyWhisperModel("small", "cpu", "int8", idle_unload_seconds=IDLE_S)
        lm.acquire()
        lm.release()  # arms a fresh IDLE_S countdown
        time.sleep(IDLE_S / 2)  # well before it would fire
        lm.acquire()  # a NEW unit of work arrives — must cancel the countdown outright
        # Sleep well PAST the ORIGINAL deadline (measured from the
        # first release() above) — if the countdown had NOT been
        # cancelled, this is exactly when it would have fired.
        time.sleep(IDLE_S * 4)
        check(
            "activity resets the timer: the model is STILL loaded well past the original deadline",
            lm._model is not None,
        )
        check("activity resets the timer: no reload happened (still the first load)", len(call_log) == 1)

        lm.release()  # back to zero active work — arms a FRESH countdown
        time.sleep(IDLE_S * 4)
        check(
            "activity resets the timer: the model IS unloaded once a fresh countdown (started from this release()) elapses",
            lm._model is None,
        )
    finally:
        restore()


def test_work_arriving_mid_countdown_still_succeeds_without_reloading() -> None:
    restore, call_log = patch_load_model()
    try:
        lm = LazyWhisperModel("small", "cpu", "int8", idle_unload_seconds=IDLE_S)
        lm.acquire()
        lm.release()  # arms a countdown
        time.sleep(IDLE_S / 2)  # mid-window — well before it would fire

        # A new job/connection arrives mid-window: acquire() (cancels
        # the pending countdown) then does real work.
        lm.acquire()
        segments, _info = lm.transcribe("fake-audio", language="en")
        check(
            "mid-window job: transcribe() succeeds against the SAME (never-unloaded) model",
            len(segments) == 1 and segments[0].text == "hello",
        )
        check("mid-window job: no reload was ever triggered — still just the one load", len(call_log) == 1)
        lm.release()
    finally:
        restore()


def test_unload_never_fires_while_a_client_is_still_connected() -> None:
    restore, call_log = patch_load_model()
    try:
        lm = LazyWhisperModel("small", "cpu", "int8", idle_unload_seconds=IDLE_S)
        lm.acquire()  # simulates one still-open ws connection — never released yet
        time.sleep(IDLE_S * 4)  # well past what would otherwise be the idle window
        check(
            "unload never fires while active: the model is still loaded (no release() has ever happened)",
            lm._model is not None,
        )
        check("unload never fires while active: no countdown was ever even armed", lm._idle_timer is None)

        lm.release()  # the (only) connection finally closes
        time.sleep(IDLE_S * 4)
        check(
            "unload never fires while active: NOW (after release()) the countdown fires and unloads",
            lm._model is None,
        )
    finally:
        restore()


def test_reload_after_an_unload_constructs_a_fresh_model() -> None:
    restore, call_log = patch_load_model()
    try:
        lm = LazyWhisperModel("small", "cpu", "int8", idle_unload_seconds=IDLE_S)
        lm.acquire()
        lm.release()
        time.sleep(IDLE_S * 4)
        check("reload setup: the model was unloaded", lm._model is None)

        segments, _info = lm.transcribe("fake-audio", language="en")
        check("reload: transcribe() after an unload still succeeds", len(segments) == 1 and segments[0].text == "hello")
        check("reload: a SECOND real load happened (fresh model, not reused)", len(call_log) == 2)
        check("reload: the fresh model is a DIFFERENT instance than the first one", lm._model is call_log[1] and call_log[1] is not call_log[0])
    finally:
        restore()


def test_release_without_a_prior_acquire_never_goes_negative() -> None:
    lm = LazyWhisperModel("small", "cpu", "int8", idle_unload_seconds=IDLE_S)
    lm.release()  # defensive: no matching acquire() ever happened
    check("release() is clamped at 0, never negative", lm._active_count == 0)


# =================================================================
# LazyWhisperModel: load-failure wrapping (F8, Sol, MINOR) — a load
# failure must surface with the WIRE CONTRACT prefix "模型加载失败："
# (client-side code matches on this exact literal to tell "the model
# itself failed to load" apart from "couldn't reach the sidecar at
# all", which gets different advice), and must never leave the wrapper
# poisoned — the NEXT attempt retries a fresh load cleanly.
# =================================================================

_LOAD_FAILURE_PREFIX = "模型加载失败："


def test_ensure_loaded_wraps_a_load_failure_with_the_required_prefix() -> None:
    real_load_model = whisper_server.load_model
    call_count = {"n": 0}

    def fake_load_model(model_name: str, device: str, compute_type: str):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise OSError("boom-load: corrupt model file")
        return FakeFasterWhisperModel(), 0.01

    whisper_server.load_model = fake_load_model  # type: ignore[assignment]
    try:
        lm = LazyWhisperModel("small", "cpu", "int8")
        raised = None
        try:
            lm.ensure_loaded()
        except RuntimeError as exc:
            raised = exc
        check("load failure: ensure_loaded raised", raised is not None)
        check(
            "load failure: the message starts with the required WIRE CONTRACT prefix",
            raised is not None and str(raised).startswith(_LOAD_FAILURE_PREFIX),
        )
        check(
            "load failure: the original exception's own message is preserved after the prefix",
            raised is not None and str(raised) == f"{_LOAD_FAILURE_PREFIX}boom-load: corrupt model file",
        )
        check("load failure: _model is left None (not poisoned)", lm._model is None)

        # Retry: the NEXT ensure_loaded() attempts a fresh load — no
        # permanently-poisoned state, and no double-prefixing (a fresh
        # underlying exception would get wrapped fresh, but this retry
        # succeeds outright).
        lm.ensure_loaded()
        check("retry after load failure: a fresh load was attempted", call_count["n"] == 2)
        check("retry after load failure: it succeeded this time", lm._model is not None)
    finally:
        whisper_server.load_model = real_load_model  # type: ignore[assignment]


def test_acquire_on_load_failure_stays_correctly_pairable_with_release() -> None:
    """F8's own counters/timer note: acquire() increments _active_count
    BEFORE attempting the load (see acquire()'s own docstring), so a
    load failure still leaves it correctly incremented — pairable with
    exactly one later release(), exactly like a successful acquire()
    would be. Mirrors how WhisperServer.handle/JobManager._run_job's own
    try/finally already call release() unconditionally regardless of
    whether acquire() raised."""
    real_load_model = whisper_server.load_model

    def fake_load_model_always_fails(model_name: str, device: str, compute_type: str):
        raise RuntimeError("boom-load-always")

    whisper_server.load_model = fake_load_model_always_fails  # type: ignore[assignment]
    try:
        lm = LazyWhisperModel("small", "cpu", "int8", idle_unload_seconds=IDLE_S)
        raised = None
        try:
            lm.acquire()
        except RuntimeError as exc:
            raised = exc
        check("acquire on load failure: it raised, carrying the prefix", raised is not None and str(raised).startswith(_LOAD_FAILURE_PREFIX))
        check("acquire on load failure: active_count was still incremented", lm._active_count == 1)

        # Caller's own finally (mirrors WhisperServer.handle/_run_job) releases unconditionally.
        lm.release()
        check("acquire on load failure: release() brings the counter back to 0 — never stuck", lm._active_count == 0)
        check(
            "acquire on load failure: no idle timer was armed (model never actually loaded)",
            lm._idle_timer is None,
        )
    finally:
        whisper_server.load_model = real_load_model  # type: ignore[assignment]


# =================================================================
# WhisperServer.handle() wiring — isinstance-gated acquire()/release()
# around a live ws connection's whole lifetime.
# =================================================================


class FakeWs:
    """Verbatim copy of test_whisper_protocol.py's own fixture — every
    sidecar test file keeps its own self-contained copy (established
    convention, see test_parakeet_backend.py's identical note)."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.close_calls = 0

    async def send(self, raw: str) -> None:
        import json

        self.sent.append(json.loads(raw))

    async def close(self) -> None:
        self.close_calls += 1
        self.sent.append({"type": "closed"})


class FakeWsEmptyStream(FakeWs):
    """Like FakeWs, but also supports `async for message in ws` as an
    immediately-empty stream — simulates a connection that opens then
    closes without ever sending anything (verbatim copy of test_
    parakeet_backend.py's own fixture of the same name/behavior)."""

    def __aiter__(self) -> "FakeWsEmptyStream":
        return self

    async def __anext__(self):
        raise StopAsyncIteration


async def test_handle_lazy_model_loads_on_connect_and_releases_on_close() -> None:
    restore, call_log = patch_load_model()
    try:
        lm = LazyWhisperModel("small", "cpu", "int8")  # default (15min) idle window — irrelevant here
        server = WhisperServer(
            model=lm,
            default_language="en",
            emit_partials=False,
            save_audio_path=None,
        )
        check("handle setup: the model is not loaded before any connection", lm._model is None)

        ws = FakeWsEmptyStream()
        await server.handle(ws)

        check("handle: connecting loaded the model (isinstance-gated acquire())", lm._model is not None)
        check("handle: load_model was called exactly once", len(call_log) == 1)
        check("handle: closing released the connection's own unit of work", lm._active_count == 0)
    finally:
        restore()


async def test_handle_two_sequential_connections_load_only_once() -> None:
    restore, call_log = patch_load_model()
    try:
        lm = LazyWhisperModel("small", "cpu", "int8")
        server = WhisperServer(model=lm, default_language="en", emit_partials=False, save_audio_path=None)

        await server.handle(FakeWsEmptyStream())
        await server.handle(FakeWsEmptyStream())

        check("two sequential connections: the model is loaded only once (still warm for the second)", len(call_log) == 1)
        check("two sequential connections: both released cleanly", lm._active_count == 0)
    finally:
        restore()


async def test_handle_ws_path_load_failure_carries_prefix_and_releases_cleanly() -> None:
    """F8, ws-path shaped call: WhisperServer.handle's own acquire() (at
    connect time) is what a live ws connection routes a load failure
    through — this is the exact call site whose raised exception must
    carry the WIRE CONTRACT prefix, so verify it there directly rather
    than only at the LazyWhisperModel level. handle() itself doesn't
    catch this exception (only its own finally, which still runs — see
    this test's release()/reload checks below); it propagates to
    handle()'s own caller exactly as WhisperServer.handle's docstring
    describes for the load-failure case."""
    real_load_model = whisper_server.load_model
    call_count = {"n": 0}

    def fake_load_model(model_name: str, device: str, compute_type: str):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise OSError("boom-load-ws-path")
        return FakeFasterWhisperModel(), 0.01

    whisper_server.load_model = fake_load_model  # type: ignore[assignment]
    try:
        lm = LazyWhisperModel("small", "cpu", "int8")
        server = WhisperServer(model=lm, default_language="en", emit_partials=False, save_audio_path=None)

        raised = None
        try:
            await server.handle(FakeWsEmptyStream())
        except RuntimeError as exc:
            raised = exc
        check("ws-path load failure: handle() raised", raised is not None)
        check(
            "ws-path load failure: the message starts with the required WIRE CONTRACT prefix",
            raised is not None and str(raised).startswith(_LOAD_FAILURE_PREFIX),
        )
        check(
            "ws-path load failure: the original exception message follows the prefix",
            raised is not None and str(raised) == f"{_LOAD_FAILURE_PREFIX}boom-load-ws-path",
        )
        check("ws-path load failure: handle()'s own finally still released the connection's unit of work", lm._active_count == 0)
        check("ws-path load failure: no idle timer was armed (model never actually loaded)", lm._idle_timer is None)

        # The NEXT connection retries a fresh load — not poisoned.
        await server.handle(FakeWsEmptyStream())
        check("ws-path retry: the next connection's own load was attempted fresh", call_count["n"] == 2)
        check("ws-path retry: the next connection's own load succeeded (no longer poisoned)", lm._model is not None)
        check("ws-path retry: released cleanly again", lm._active_count == 0)
    finally:
        whisper_server.load_model = real_load_model  # type: ignore[assignment]


# =================================================================
# JobManager._run_job wiring — acquire()/release() around a file job's
# whole (real, background-threaded) lifetime. Mirrors test_parakeet_
# backend.py's own FB4 polling idiom (start_job() spawns a REAL
# threading.Thread; poll jm.get(job_id) to done/error under a deadline
# rather than sleeping a fixed guess).
# =================================================================

_NONEXISTENT_FILE = "/tmp/jargonslayer-test-lazy-load-nonexistent.wav"


def _wait_for_job_done(jm: JobManager, job_id: str, timeout_s: float = 5.0):
    deadline = time.monotonic() + timeout_s
    job = None
    while time.monotonic() < deadline:
        job = jm.get(job_id)
        if job is not None and job.get("status") in ("done", "error"):
            return job
        time.sleep(0.01)
    return job


def test_run_job_acquires_and_releases_around_a_successful_job() -> None:
    restore, call_log = patch_load_model()
    try:
        lm = LazyWhisperModel("small", "cpu", "int8")  # default idle window
        jm = JobManager(model=lm, model_name="small", default_language="en", hf_token=None)

        job_id = jm.start_job(_NONEXISTENT_FILE, "en")
        job = _wait_for_job_done(jm, job_id)

        check("run_job success: the job actually finished (done, not still queued/running)", job is not None and job.get("status") == "done")
        check("run_job success: the classic backend's model got loaded via the job (not eagerly)", len(call_log) == 1)
        check("run_job success: the job's own unit of work was released in the outermost finally", lm._active_count == 0)
        check("run_job success: the model stays warm after the job (default idle window hasn't elapsed)", lm._model is not None)
    finally:
        restore()


def test_run_job_releases_even_when_transcription_raises() -> None:
    real_load_model = whisper_server.load_model
    lm_holder: dict[str, Any] = {}

    def fake_load_model(model_name: str, device: str, compute_type: str):
        fake = FakeFasterWhisperModel(fail=True)
        return fake, 0.01

    whisper_server.load_model = fake_load_model  # type: ignore[assignment]
    try:
        lm = LazyWhisperModel("small", "cpu", "int8")
        lm_holder["lm"] = lm
        jm = JobManager(model=lm, model_name="small", default_language="en", hf_token=None)

        job_id = jm.start_job(_NONEXISTENT_FILE, "en")
        job = _wait_for_job_done(jm, job_id)

        check("run_job crash: the job's own status reflects the transcription failure", job is not None and job.get("status") == "error")
        check(
            "run_job crash: the active-work counter was still released in the outermost finally (never wedged busy)",
            lm._active_count == 0,
        )
    finally:
        whisper_server.load_model = real_load_model  # type: ignore[assignment]


def test_run_job_error_carries_the_load_failure_prefix_then_retries_cleanly() -> None:
    """F8, job-path shaped call: a lazy-load failure must reach
    job["error"] carrying the WIRE CONTRACT prefix, release the
    active-work counter in _run_job's own outermost finally either way,
    and leave the NEXT job free to retry a fresh load successfully."""
    real_load_model = whisper_server.load_model
    call_count = {"n": 0}

    def fake_load_model(model_name: str, device: str, compute_type: str):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise OSError("boom-load-job-path")
        return FakeFasterWhisperModel(), 0.01

    whisper_server.load_model = fake_load_model  # type: ignore[assignment]
    try:
        lm = LazyWhisperModel("small", "cpu", "int8")
        jm = JobManager(model=lm, model_name="small", default_language="en", hf_token=None)

        job_id = jm.start_job(_NONEXISTENT_FILE, "en")
        job = _wait_for_job_done(jm, job_id)

        check("job-path load failure: the job's own status is error", job is not None and job.get("status") == "error")
        check(
            "job-path load failure: job.error carries the required WIRE CONTRACT prefix",
            job is not None and (job.get("error") or "").startswith(_LOAD_FAILURE_PREFIX),
        )
        check(
            "job-path load failure: the original exception message follows the prefix",
            job is not None and job.get("error") == f"{_LOAD_FAILURE_PREFIX}boom-load-job-path",
        )
        check("job-path load failure: the active-work counter was released in the outermost finally", lm._active_count == 0)

        # Next job: a fresh load is attempted and succeeds — not poisoned.
        job_id_2 = jm.start_job(_NONEXISTENT_FILE, "en")
        job2 = _wait_for_job_done(jm, job_id_2)
        check("job-path retry: the next job's own load was attempted fresh", call_count["n"] == 2)
        check("job-path retry: the next job's own load succeeded (no longer poisoned)", job2 is not None and job2.get("status") == "done")
        check("job-path retry: the active-work counter was released again", lm._active_count == 0)
    finally:
        whisper_server.load_model = real_load_model  # type: ignore[assignment]


# =================================================================
# runner
# =================================================================

ASYNC_TESTS = [
    test_handle_lazy_model_loads_on_connect_and_releases_on_close,
    test_handle_two_sequential_connections_load_only_once,
    test_handle_ws_path_load_failure_carries_prefix_and_releases_cleanly,
]


async def run_async_tests() -> None:
    for test in ASYNC_TESTS:
        try:
            await asyncio.wait_for(test(), timeout=5.0)
        except Exception as exc:  # noqa: BLE001 - a hard crash/timeout is itself a FAIL signal
            check(f"{test.__name__} did not raise/hang ({exc!r})", False)


test_not_loaded_at_construction()
test_ensure_loaded_triggers_exactly_one_real_load()
test_transcribe_proxies_and_triggers_lazy_load()
test_acquire_also_triggers_lazy_load_and_only_once()
test_idle_timeout_unloads_once_active_work_reaches_zero()
test_two_concurrent_units_only_unloads_after_both_release()
test_on_idle_timeout_belt_rechecks_active_count_directly()
test_stale_idle_timeout_callback_never_unloads_and_leaves_current_timer_intact()
test_a_fresh_acquire_mid_countdown_cancels_it()
test_work_arriving_mid_countdown_still_succeeds_without_reloading()
test_unload_never_fires_while_a_client_is_still_connected()
test_reload_after_an_unload_constructs_a_fresh_model()
test_release_without_a_prior_acquire_never_goes_negative()
test_ensure_loaded_wraps_a_load_failure_with_the_required_prefix()
test_acquire_on_load_failure_stays_correctly_pairable_with_release()
test_run_job_acquires_and_releases_around_a_successful_job()
test_run_job_releases_even_when_transcription_raises()
test_run_job_error_carries_the_load_failure_prefix_then_retries_cleanly()
asyncio.run(run_async_tests())


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
