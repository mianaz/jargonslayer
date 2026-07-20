#!/usr/bin/env python3
"""Plain-assert self-test for whisper_server.py's S12b parakeet-mlx
backend (docs/design-explorations/s12-mlx-blueprint.md §C R2/R3/R4 +
§E L5 — the batch-final + streaming-partials HYBRID that supersedes §C
R2's stream-commit-primary design). Mirrors test_whisper_protocol.py's
own style/harness exactly: no pytest, no network, no real model, no
server start — module import is side-effect free.

This file runs under the BASE sidecar venv (sidecar/.venv), which
never has mlx/parakeet_mlx installed (§C R1: those live only in the
separate, hash-locked mlx venv) — every test below either (a) stubs
ParakeetMlxBackend's OWN methods directly on the instance (mirrors
test_whisper_protocol.py's make_server()._transcribe stub idiom), for
ParakeetMlxServer's scheduling/queue/worker tests, or (b) installs a
FAKE parakeet_mlx/parakeet_mlx.audio/mlx/mlx.core module via
sys.modules injection (this repo's established idiom — see that
file's own _set_pyannote_importable), for ParakeetMlxBackend's own
methods that lazily import those real packages, so the exact call
shapes (from_pretrained(repo), transcribe_stream(context_size=,
depth=), mx.core.array(chunk), get_logmel(...)+generate(...)[0],
model.transcribe(path)) are verified against controllable fakes with
zero real mlx/parakeet_mlx install required.

Run:
    sidecar/.venv/bin/python sidecar/test_parakeet_backend.py

Covers:
  - backend_for_model: parakeet id -> "parakeet-mlx", every other
    MODEL_CHOICES id -> "faster-whisper"
  - ParakeetMlxBackend.load(): from_pretrained(PARAKEET_REPO_ID) only
    (NEVER cache_dir= — §C R1/F10), model set, returns a wall-time float
  - ParakeetMlxBackend.try_acquire_stream/release_stream (L2/F4)
  - ParakeetMlxBackend.open_streaming_context: pinned context_size/depth
  - ParakeetMlxBackend.add_audio: wraps the chunk via mlx.core.array
  - ParakeetMlxBackend.batch_final: get_logmel + generate()[0], stripped
  - ParakeetMlxBackend.transcribe_file: ffmpeg-missing zh error (reused
    idiom), AlignedSentence -> job segment shape mapping, empty-sentence
    edge case
  - ParakeetMlxServer: Boundary -> one final with the scheduler's own
    seg_id/t0/t1/lag_ms; queue ordering across several utterances;
    stop-drain (final(s) THEN stopped, strict order); stop with nothing
    pending; empty-final skip preserves the seg_id gap; flush (no ack,
    stays usable); MAX_SEGMENT auto-finalizes mid-stream; the L5
    partial regression guard (suppress empty-text partials once a
    non-empty one has been sent this utterance); partial emission
    throttling; partials-disabled suppresses ALL partial emission AND
    never even enqueues an Audio command (cheapest path); config
    partials-override; stop_accepted idempotency/ignoring; the
    `parakeet-busy` single-active-stream rejection (L2); a connection
    that closes without ever sending "stop" still releases the stream
    slot
  - JobManager._transcribe_job: isinstance-routes to the parakeet arm
    when self.model is a ParakeetMlxBackend, and the faster-whisper
    arm is unaffected by that added branch (regression guard for this
    file's own edit to that method)
"""

from __future__ import annotations

import asyncio
import json
import shutil
import sys
import threading
import time
import types
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import whisper_server  # noqa: E402 - module import, for monkeypatching PARTIAL_INTERVAL_S below
from whisper_server import (  # noqa: E402
    DIARIZE_HOLD_PROGRESS,
    FRAME_SAMPLES,
    MODEL_CHOICES,
    PARAKEET_CONTEXT_SIZE,
    PARAKEET_DEPTH,
    PARAKEET_MODEL,
    PARAKEET_REPO_ID,
    ConnectionState,
    JobManager,
    ParakeetMlxBackend,
    ParakeetMlxServer,
    backend_for_model,
    new_job,
    parakeet_busy_response,
)
from whisper_server import _ParakeetAudio  # noqa: E402 - internal, mirrors FinalizeJob's own import

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
# backend_for_model — pure map, no fakes needed
# =================================================================


def test_backend_for_model_parakeet() -> None:
    check(
        "backend_for_model: the parakeet id resolves to 'parakeet-mlx'",
        backend_for_model(PARAKEET_MODEL) == "parakeet-mlx",
    )


def test_backend_for_model_every_other_model_is_faster_whisper() -> None:
    others = [m for m in MODEL_CHOICES if m != PARAKEET_MODEL]
    check(
        "backend_for_model: every non-parakeet MODEL_CHOICES id resolves to 'faster-whisper'",
        all(backend_for_model(m) == "faster-whisper" for m in others) and len(others) >= 1,
    )


# =================================================================
# ParakeetMlxBackend — sys.modules injection for the real
# parakeet_mlx/mlx.core lazy imports (this repo's established idiom).
# =================================================================

_UNSET = object()
_FAKE_MODULE_NAMES = ("parakeet_mlx", "parakeet_mlx.audio", "mlx", "mlx.core")


class _FakeUpstreamStreamingCtx:
    """Stand-in for parakeet_mlx's own StreamingParakeet — only what
    ParakeetMlxBackend's own methods actually touch."""

    def __init__(self) -> None:
        self.entered = False
        self.exited = False
        self.add_audio_calls: list[object] = []
        self._text = ""

    def __enter__(self) -> "_FakeUpstreamStreamingCtx":
        self.entered = True
        return self

    def __exit__(self, *exc: object) -> None:
        self.exited = True

    def add_audio(self, chunk: object) -> None:
        self.add_audio_calls.append(chunk)

    @property
    def result(self) -> types.SimpleNamespace:
        return types.SimpleNamespace(text=self._text)


class _FakeAlignedSentence:
    def __init__(self, start: float, end: float, text: str) -> None:
        self.start = start
        self.end = end
        self.text = text


class _FakeAlignedResult:
    def __init__(self, sentences: list[_FakeAlignedSentence]) -> None:
        self.sentences = sentences
        self.text = "".join(s.text for s in sentences)


def _install_fake_parakeet_modules():
    """Installs fake parakeet_mlx/parakeet_mlx.audio/mlx/mlx.core into
    sys.modules (dotted imports need the PARENT key present too — same
    idiom test_whisper_protocol.py's _set_pyannote_importable already
    documents for pyannote/pyannote.audio) so ParakeetMlxBackend's own
    lazy `from parakeet_mlx import from_pretrained` / `from mlx.core
    import array` / `from parakeet_mlx.audio import get_logmel` resolve
    to controllable fakes. Returns (saved, model, record); restore via
    _restore_fake_parakeet_modules(saved)."""
    saved = {name: sys.modules.get(name, _UNSET) for name in _FAKE_MODULE_NAMES}

    record: dict[str, list] = {
        "from_pretrained_repo": [],
        "get_logmel_calls": [],
        "array_calls": [],
    }

    model = types.SimpleNamespace()
    model.preprocessor_config = object()
    model._transcribe_stream_calls = []
    model._transcribe_calls = []
    model._generate_calls = []
    model._transcribe_result = _FakeAlignedResult([])
    model._generate_result_text = "generated text"

    def fake_transcribe_stream(context_size, depth):
        model._transcribe_stream_calls.append({"context_size": context_size, "depth": depth})
        return _FakeUpstreamStreamingCtx()

    def fake_transcribe(path):
        model._transcribe_calls.append(path)
        return model._transcribe_result

    def fake_generate(mel):
        model._generate_calls.append(mel)
        return [types.SimpleNamespace(text=model._generate_result_text)]

    model.transcribe_stream = fake_transcribe_stream
    model.transcribe = fake_transcribe
    model.generate = fake_generate

    def fake_from_pretrained(repo):
        # Deliberately single-positional-arg only — a future regression
        # that starts passing cache_dir= would raise TypeError here,
        # which is exactly the point (§C R1/F10's "NEVER pass cache_dir
        # explicitly" invariant).
        record["from_pretrained_repo"].append(repo)
        return model

    parakeet_mlx_mod = types.ModuleType("parakeet_mlx")
    parakeet_mlx_mod.from_pretrained = fake_from_pretrained

    def fake_get_logmel(arr, preprocessor_config):
        record["get_logmel_calls"].append((arr, preprocessor_config))
        return f"mel({id(arr)})"

    audio_mod = types.ModuleType("parakeet_mlx.audio")
    audio_mod.get_logmel = fake_get_logmel

    def fake_array(x):
        record["array_calls"].append(x)
        return ("mx.array", x)

    mlx_mod = types.ModuleType("mlx")
    mlx_core_mod = types.ModuleType("mlx.core")
    mlx_core_mod.array = fake_array
    mlx_mod.core = mlx_core_mod

    sys.modules["parakeet_mlx"] = parakeet_mlx_mod
    sys.modules["parakeet_mlx.audio"] = audio_mod
    sys.modules["mlx"] = mlx_mod
    sys.modules["mlx.core"] = mlx_core_mod

    return saved, model, record


def _restore_fake_parakeet_modules(saved: dict[str, object]) -> None:
    for name, prev in saved.items():
        if prev is _UNSET:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = prev  # type: ignore[assignment]


def test_backend_load_uses_from_pretrained_with_only_the_repo_id() -> None:
    saved, model, record = _install_fake_parakeet_modules()
    try:
        backend = ParakeetMlxBackend(PARAKEET_MODEL)
        load_seconds = backend.load()
        check(
            "backend.load(): calls from_pretrained with exactly PARAKEET_REPO_ID (no cache_dir kwarg)",
            record["from_pretrained_repo"] == [PARAKEET_REPO_ID],
        )
        check("backend.load(): backend.model is the loaded model", backend.model is model)
        check(
            "backend.load(): returns a non-negative wall-time float",
            isinstance(load_seconds, float) and load_seconds >= 0.0,
        )
    finally:
        _restore_fake_parakeet_modules(saved)


async def test_open_and_close_streaming_context_passes_pinned_context_size_and_depth() -> None:
    # open_streaming_context/add_audio/batch_final/close_streaming_context
    # are all async now (G1 live-gate finding — see ParakeetMlxBackend's
    # own class docstring's `_executor` note: every real call must run
    # on the SAME dedicated executor thread that loaded the model, not
    # the caller's own thread/asyncio.to_thread's generic pool).
    saved, model, _record = _install_fake_parakeet_modules()
    try:
        backend = ParakeetMlxBackend(PARAKEET_MODEL)
        backend.model = model
        ctx = await backend.open_streaming_context()
        check(
            "open_streaming_context: transcribe_stream receives the §C R2-pinned context_size/depth",
            model._transcribe_stream_calls == [{"context_size": PARAKEET_CONTEXT_SIZE, "depth": PARAKEET_DEPTH}],
        )
        check(
            "open_streaming_context: returns transcribe_stream's own return value",
            isinstance(ctx, _FakeUpstreamStreamingCtx),
        )
        check("open_streaming_context: __enter__ already ran (fully open on return)", ctx.entered is True)
        check("open_streaming_context: __exit__ has NOT run yet", ctx.exited is False)

        await backend.close_streaming_context(ctx)
        check("close_streaming_context: __exit__ ran", ctx.exited is True)
    finally:
        _restore_fake_parakeet_modules(saved)


async def test_add_audio_wraps_the_chunk_via_mlx_array() -> None:
    saved, model, record = _install_fake_parakeet_modules()
    try:
        backend = ParakeetMlxBackend(PARAKEET_MODEL)
        backend.model = model
        ctx = _FakeUpstreamStreamingCtx()
        chunk = np.zeros(8000, dtype=np.float32)
        await backend.add_audio(ctx, chunk)
        check("add_audio: the raw chunk is passed through mlx.core.array exactly once", record["array_calls"] == [chunk])
        check(
            "add_audio: ctx.add_audio receives the wrapped (mx.array-tagged) value, not the raw numpy chunk",
            ctx.add_audio_calls == [("mx.array", chunk)],
        )
    finally:
        _restore_fake_parakeet_modules(saved)


async def test_batch_final_uses_get_logmel_and_generate_and_strips_text() -> None:
    saved, model, record = _install_fake_parakeet_modules()
    try:
        backend = ParakeetMlxBackend(PARAKEET_MODEL)
        backend.model = model
        model._generate_result_text = "  hello world  "
        pcm = np.zeros(16000, dtype=np.float32)
        text = await backend.batch_final(pcm)
        check("batch_final: returns generate()[0].text stripped", text == "hello world")
        check("batch_final: get_logmel is called exactly once, with the model's own preprocessor_config", (
            len(record["get_logmel_calls"]) == 1
            and record["get_logmel_calls"][0][1] is model.preprocessor_config
        ))
        check("batch_final: generate is called exactly once (one batch call per boundary)", len(model._generate_calls) == 1)
        check("batch_final: the pcm is routed through mlx.core.array before get_logmel", record["array_calls"] == [pcm])
    finally:
        _restore_fake_parakeet_modules(saved)


async def test_backend_calls_all_run_on_the_same_dedicated_executor_thread() -> None:
    """G1 live-gate regression guard: reproduces (with fakes) the exact
    shape of the bug found live — load() + every later call must all
    land on the SAME OS thread, never the caller's own thread nor a
    fresh thread-pool thread per call."""
    import threading

    saved, model, _record = _install_fake_parakeet_modules()
    try:
        backend = ParakeetMlxBackend(PARAKEET_MODEL)
        threads_seen: set[int] = set()

        real_from_pretrained = sys.modules["parakeet_mlx"].from_pretrained

        def recording_from_pretrained(repo):
            threads_seen.add(threading.get_ident())
            return real_from_pretrained(repo)

        sys.modules["parakeet_mlx"].from_pretrained = recording_from_pretrained

        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, backend.load)  # load() itself blocks, run off the test's own thread too

        real_get_logmel = sys.modules["parakeet_mlx.audio"].get_logmel

        def recording_get_logmel(arr, cfg):
            threads_seen.add(threading.get_ident())
            return real_get_logmel(arr, cfg)

        sys.modules["parakeet_mlx.audio"].get_logmel = recording_get_logmel

        await backend.batch_final(np.zeros(16000, dtype=np.float32))
        ctx = await backend.open_streaming_context()
        await backend.add_audio(ctx, np.zeros(512, dtype=np.float32))
        await backend.close_streaming_context(ctx)

        check(
            "executor thread affinity: load() + every add_audio/batch_final call landed on exactly ONE OS thread",
            len(threads_seen) == 1,
        )
        check(
            "executor thread affinity: that thread is NOT this test coroutine's own thread",
            threading.get_ident() not in threads_seen,
        )
    finally:
        _restore_fake_parakeet_modules(saved)


def test_transcribe_file_raises_zh_error_when_ffmpeg_missing() -> None:
    saved, model, _record = _install_fake_parakeet_modules()
    real_which = shutil.which
    shutil.which = lambda name: None  # type: ignore[assignment]
    try:
        backend = ParakeetMlxBackend(PARAKEET_MODEL)
        backend.model = model
        raised = None
        try:
            backend.transcribe_file("/tmp/f.wav", "en")
        except RuntimeError as exc:
            raised = exc
        check("transcribe_file: raises RuntimeError when ffmpeg is missing", raised is not None)
        check(
            "transcribe_file: reuses the EXACT existing 未检测到 ffmpeg error copy (the yt-dlp/ingest-url idiom)",
            raised is not None and str(raised) == "未检测到 ffmpeg，请先安装（brew install ffmpeg）",
        )
        check("transcribe_file: never even calls model.transcribe when ffmpeg is missing", model._transcribe_calls == [])
    finally:
        shutil.which = real_which
        _restore_fake_parakeet_modules(saved)


def test_transcribe_file_maps_aligned_sentences_to_job_segments() -> None:
    saved, model, _record = _install_fake_parakeet_modules()
    real_which = shutil.which
    shutil.which = lambda name: "/usr/bin/ffmpeg"  # type: ignore[assignment]
    try:
        backend = ParakeetMlxBackend(PARAKEET_MODEL)
        backend.model = model
        model._transcribe_result = _FakeAlignedResult(
            [
                _FakeAlignedSentence(0.0, 1.2, "hello "),
                _FakeAlignedSentence(1.2, 3.4, "world "),
            ]
        )
        segments, duration = backend.transcribe_file("/tmp/f.wav", "en")
        check(
            "transcribe_file: AlignedSentence{text,start,end} maps to the existing {start,end,text} job segment shape",
            segments == [
                {"start": 0.0, "end": 1.2, "text": "hello"},
                {"start": 1.2, "end": 3.4, "text": "world"},
            ],
        )
        check("transcribe_file: duration is the last sentence's own end", duration == 3.4)
        check("transcribe_file: model.transcribe is called with the file path only (no language kwarg)", model._transcribe_calls == ["/tmp/f.wav"])
    finally:
        shutil.which = real_which
        _restore_fake_parakeet_modules(saved)


def test_transcribe_file_empty_sentences_returns_empty_segments_and_zero_duration() -> None:
    saved, model, _record = _install_fake_parakeet_modules()
    real_which = shutil.which
    shutil.which = lambda name: "/usr/bin/ffmpeg"  # type: ignore[assignment]
    try:
        backend = ParakeetMlxBackend(PARAKEET_MODEL)
        backend.model = model
        model._transcribe_result = _FakeAlignedResult([])
        segments, duration = backend.transcribe_file("/tmp/silent.wav", "en")
        check("transcribe_file (silence): segments is empty", segments == [])
        check("transcribe_file (silence): duration falls back to 0.0", duration == 0.0)
    finally:
        shutil.which = real_which
        _restore_fake_parakeet_modules(saved)


def test_try_acquire_stream_and_release() -> None:
    backend = ParakeetMlxBackend(PARAKEET_MODEL)
    check("try_acquire_stream: first caller acquires", backend.try_acquire_stream() is True)
    check("try_acquire_stream: a second caller is refused while held", backend.try_acquire_stream() is False)
    backend.release_stream()
    check("try_acquire_stream: acquirable again after release_stream", backend.try_acquire_stream() is True)


# =================================================================
# ParakeetMlxServer — scheduling/queue/worker tests. FakeBackend is a
# test double implementing ONLY ParakeetMlxBackend's public surface
# ParakeetMlxServer actually calls — mirrors test_whisper_protocol.
# py's make_server()._transcribe stub idiom (stub the seam, not the
# real model); no sys.modules faking needed for these.
# =================================================================


class FakeStreamingCtx:
    def __init__(self) -> None:
        self.entered = False
        self.exited = False
        self._text = ""

    def __enter__(self) -> "FakeStreamingCtx":
        self.entered = True
        return self

    def __exit__(self, *exc: object) -> None:
        self.exited = True

    @property
    def result(self) -> types.SimpleNamespace:
        return types.SimpleNamespace(text=self._text)


class FakeBackend:
    def __init__(self) -> None:
        self._busy = False
        self.opened_contexts = 0
        self.add_audio_calls: list[object] = []
        self.batch_final_calls: list[object] = []
        # Consumed in order, one per add_audio/batch_final call; a
        # missing entry defaults to "" (empty result).
        self.partial_texts: list[str] = []
        self.final_texts: list[str] = []
        # FB2 call-order test: one tag per actual method invocation,
        # in call order, across ALL four methods below — lets a test
        # assert the EXACT interleaving (e.g. "close" strictly before
        # "generate"/batch_final).
        self.call_order: list[str] = []
        # FB5 fail-injection: set any of these to an Exception instance
        # to make that operation raise instead of its normal fake
        # behavior — one exception object is consumed exactly once
        # (cleared after raising) so a test can also assert recovery
        # behavior on a LATER, healthy call within the same test.
        self.fail_open: "Exception | None" = None
        self.fail_add_audio: "Exception | None" = None
        self.fail_batch_final: "Exception | None" = None
        self.fail_close: "Exception | None" = None

    def try_acquire_stream(self) -> bool:
        if self._busy:
            return False
        self._busy = True
        return True

    def release_stream(self) -> None:
        self._busy = False

    async def open_streaming_context(self) -> FakeStreamingCtx:
        # Async + already-__enter__ed on return — mirrors ParakeetMlxBackend's
        # own open_streaming_context contract (G1 live-gate fix: every
        # real call routes through a dedicated executor thread; see
        # that class's own docstring).
        self.call_order.append("open")
        if self.fail_open is not None:
            exc, self.fail_open = self.fail_open, None
            raise exc
        self.opened_contexts += 1
        ctx = FakeStreamingCtx()
        ctx.__enter__()
        return ctx

    async def close_streaming_context(self, ctx: FakeStreamingCtx) -> None:
        self.call_order.append("close")
        if self.fail_close is not None:
            exc, self.fail_close = self.fail_close, None
            raise exc
        ctx.__exit__(None, None, None)

    async def add_audio(self, ctx: FakeStreamingCtx, chunk: object) -> None:
        self.call_order.append("add_audio")
        if self.fail_add_audio is not None:
            exc, self.fail_add_audio = self.fail_add_audio, None
            raise exc
        self.add_audio_calls.append(chunk)
        ctx._text = self.partial_texts.pop(0) if self.partial_texts else ""

    async def batch_final(self, pcm: object) -> str:
        self.call_order.append("batch_final")
        if self.fail_batch_final is not None:
            exc, self.fail_batch_final = self.fail_batch_final, None
            raise exc
        self.batch_final_calls.append(pcm)
        return self.final_texts.pop(0) if self.final_texts else ""


class FakeWs:
    """Records every JSON frame sent, plus close() as a synthetic
    {"type": "closed"} entry — verbatim copy of test_whisper_protocol.
    py's own fixture (kept local rather than cross-imported, matching
    every sidecar test file's established self-containment)."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.close_calls = 0

    async def send(self, raw: str) -> None:
        self.sent.append(json.loads(raw))

    async def close(self) -> None:
        self.close_calls += 1
        self.sent.append({"type": "closed"})


class FakeWsEmptyStream(FakeWs):
    """Like FakeWs, but also supports `async for message in ws` as an
    immediately-empty stream — simulates a connection that closes
    without ever sending anything (e.g. a crashed tab), for exercising
    ParakeetMlxServer.handle()'s own connection-lifecycle finally
    block (worker cancel + stream-slot release) end to end."""

    def __aiter__(self) -> "FakeWsEmptyStream":
        return self

    async def __anext__(self):
        raise StopAsyncIteration


class FakeWsController(FakeWs):
    """Like FakeWs, but supports `async for message in ws` as a queue
    of pre-loaded incoming messages, followed by blocking until close()
    is called (by ANYONE — the test OR, for FB5, the worker task
    itself) — mirrors a real websockets connection's receive loop,
    which unblocks with ConnectionClosed once the socket actually
    closes, regardless of which task initiated that close. Used for
    FB5's end-to-end handle() tests (a model-call failure must self-
    close AND let handle()'s own outer finally run to completion)."""

    def __init__(self) -> None:
        super().__init__()
        self._incoming: list[object] = []
        self._closed_event = asyncio.Event()

    def queue_incoming(self, message: object) -> None:
        self._incoming.append(message)

    async def close(self) -> None:
        await super().close()
        self._closed_event.set()

    def __aiter__(self) -> "FakeWsController":
        return self

    async def __anext__(self):
        if self._incoming:
            return self._incoming.pop(0)
        await self._closed_event.wait()
        from websockets.exceptions import ConnectionClosedOK

        raise ConnectionClosedOK(None, None)


def make_parakeet_server(backend: FakeBackend, emit_partials: bool = False) -> ParakeetMlxServer:
    return ParakeetMlxServer(
        backend=backend,  # type: ignore[arg-type]
        default_language="en",
        emit_partials=emit_partials,
        save_audio_path=None,
    )


def speech_frame() -> np.ndarray:
    return np.zeros(FRAME_SAMPLES, dtype=np.float32)


def loud_pcm_bytes(n_frames: int = 1) -> bytes:
    samples = np.full(FRAME_SAMPLES * n_frames, 16000, dtype=np.int16)
    return samples.tobytes()


def mark_pending_speech(state: ConnectionState, started_at: float = 0.0, speech_ms: float = 400.0) -> None:
    state.in_speech = True
    state.speech_buf = [speech_frame()]
    state.speech_started_at = started_at
    state.speech_ms = speech_ms


async def start_worker(server: ParakeetMlxServer, ws: FakeWs, state: ConnectionState, cmd_queue: "asyncio.Queue") -> "asyncio.Task[None]":
    return asyncio.create_task(server._worker(ws, state, cmd_queue))


async def stop_worker(task: "asyncio.Task[None]") -> None:
    if task.done():
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


# =================================================================
# Boundary -> one final; queue ordering; empty-final skip
# =================================================================


async def test_boundary_emits_final_with_scheduler_seg_id_t0_t1() -> None:
    backend = FakeBackend()
    backend.final_texts = ["final tail text"]
    server = make_parakeet_server(backend)
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()
    worker = await start_worker(server, ws, state, cmd_queue)
    try:
        # started_at=0.0 (not an arbitrary later value): _finalize_
        # boundary's own t1 = state.elapsed(), a REAL wall-clock read
        # against state.connected_at (set at ConnectionState() time,
        # a moment ago) — asserting end >= start only holds when start
        # is set the same way real production code sets it
        # (state.elapsed() at speech onset, see _handle_binary), not an
        # unrelated synthetic value like the other fixtures in this
        # file use for seg_id/ordering-focused tests.
        mark_pending_speech(state, started_at=0.0)
        await server._finalize_boundary(state, cmd_queue, force=True)
        await cmd_queue.join()

        finals = [m for m in ws.sent if m["type"] == "final"]
        check("boundary: exactly one final sent", len(finals) == 1)
        check("boundary: seg_id is 0 (first on this connection)", finals[0]["seg_id"] == 0)
        check("boundary: start carries the scheduler's own speech_started_at", finals[0]["start"] == 0.0)
        check(
            "boundary: end is a real elapsed-time float >= start",
            isinstance(finals[0]["end"], float) and finals[0]["end"] >= finals[0]["start"],
        )
        check("boundary: text is backend.batch_final's own result", finals[0]["text"] == "final tail text")
        check(
            "boundary: lag_ms present and numeric (§C R3/F6: boundary-enqueue -> final-send)",
            isinstance(finals[0].get("lag_ms"), (int, float)),
        )
        check(
            "boundary: backend.batch_final received exactly the utterance's own concatenated PCM",
            len(backend.batch_final_calls) == 1 and backend.batch_final_calls[0].shape[0] == FRAME_SAMPLES,
        )
        check("boundary: the streaming context (never opened for this boundary-only test) stays unopened", backend.opened_contexts == 0)
    finally:
        await stop_worker(worker)


async def test_boundary_queue_preserves_send_order() -> None:
    backend = FakeBackend()
    texts = [f"seg-{i}" for i in range(5)]
    backend.final_texts = list(texts)
    server = make_parakeet_server(backend)
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()
    worker = await start_worker(server, ws, state, cmd_queue)
    try:
        for i in range(5):
            mark_pending_speech(state, started_at=float(i))
            await server._finalize_boundary(state, cmd_queue, force=True)
        await cmd_queue.join()

        finals = [m for m in ws.sent if m["type"] == "final"]
        check("queue ordering: all 5 finals arrive in enqueue (seg_id) order", [f["seg_id"] for f in finals] == [0, 1, 2, 3, 4])
        check("queue ordering: text payloads line up with enqueue order too", [f["text"] for f in finals] == texts)
    finally:
        await stop_worker(worker)


async def test_empty_final_is_skipped_seg_id_gap_preserved() -> None:
    backend = FakeBackend()
    backend.final_texts = ["hello", "", "world"]
    server = make_parakeet_server(backend)
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()
    worker = await start_worker(server, ws, state, cmd_queue)
    try:
        for i in range(3):
            mark_pending_speech(state, started_at=float(i))
            await server._finalize_boundary(state, cmd_queue, force=True)
        await cmd_queue.join()

        finals = [m for m in ws.sent if m["type"] == "final"]
        check("empty final skip: only 2 finals sent — the empty-text one is skipped (parity with faster-whisper)", len(finals) == 2)
        check("empty final skip: seg_id gap — first is 0, second is 2", [f["seg_id"] for f in finals] == [0, 2])
        check("empty final skip: the connection's next_seg_id advanced past the gap too", state.next_seg_id == 3)
    finally:
        await stop_worker(worker)


# =================================================================
# stop-drain / stop-with-nothing-pending / flush
# =================================================================


async def test_stop_drains_tail_final_then_stopped() -> None:
    backend = FakeBackend()
    backend.final_texts = ["final tail text"]
    server = make_parakeet_server(backend)
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()
    worker = await start_worker(server, ws, state, cmd_queue)
    try:
        mark_pending_speech(state)
        await server._handle_text(ws, state, cmd_queue, json.dumps({"type": "stop"}))
        await asyncio.wait_for(worker, timeout=2.0)

        check(
            "stop-drain: client sees the tail final THEN stopped THEN the connection closes (FB7 self-close), in that exact order",
            [m["type"] for m in ws.sent] == ["final", "stopped", "closed"],
        )
        check("stop-drain: the tail final carries seg_id 0", ws.sent[0].get("seg_id") == 0)
        check("stop-drain (FB7): the server closed the connection itself exactly once", ws.close_calls == 1)
    finally:
        await stop_worker(worker)


async def test_stop_with_no_pending_speech_sends_only_stopped() -> None:
    backend = FakeBackend()
    server = make_parakeet_server(backend)
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()
    worker = await start_worker(server, ws, state, cmd_queue)
    try:
        await server._handle_text(ws, state, cmd_queue, json.dumps({"type": "stop"}))
        await asyncio.wait_for(worker, timeout=2.0)
        check(
            "stop with nothing pending: 'stopped' then closed (FB7), no final",
            [m["type"] for m in ws.sent] == ["stopped", "closed"],
        )
    finally:
        await stop_worker(worker)


async def test_flush_finalizes_without_ack_and_stays_alive() -> None:
    backend = FakeBackend()
    backend.final_texts = ["flushed text", "second text"]
    server = make_parakeet_server(backend)
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()
    worker = await start_worker(server, ws, state, cmd_queue)
    try:
        mark_pending_speech(state)
        await server._handle_text(ws, state, cmd_queue, json.dumps({"type": "flush"}))
        await cmd_queue.join()
        check("flush: exactly one final, no 'stopped' or any other ack", [m["type"] for m in ws.sent] == ["final"])

        mark_pending_speech(state, started_at=1.0)
        await server._finalize_boundary(state, cmd_queue, force=True)
        await cmd_queue.join()
        check(
            "flush: connection stays usable afterward — a later segment still finalizes",
            [m["type"] for m in ws.sent] == ["final", "final"],
        )
        check("flush: seg_id kept advancing across the flush (1, not reset to 0)", ws.sent[1]["seg_id"] == 1)
    finally:
        await stop_worker(worker)


# =================================================================
# MAX_SEGMENT auto-finalize (VAD/buffering parity)
# =================================================================


async def test_max_segment_force_finalizes_mid_stream() -> None:
    backend = FakeBackend()
    backend.final_texts = ["long utterance text"]
    server = make_parakeet_server(backend)
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()
    worker = await start_worker(server, ws, state, cmd_queue)
    try:
        # 800 frames * 32ms = 25600ms > MAX_SEGMENT_MS(25000) — crosses
        # the threshold mid-loop, with NO VAD silence gap at all.
        await server._handle_binary(ws, state, cmd_queue, loud_pcm_bytes(800))
        await cmd_queue.join()

        finals = [m for m in ws.sent if m["type"] == "final"]
        check("MAX_SEGMENT: at least one final auto-fires mid-stream with no VAD gap needed", len(finals) >= 1)
        check("MAX_SEGMENT: the first auto-final is seg_id 0", finals[0]["seg_id"] == 0)
        check("MAX_SEGMENT: still mid-speech afterward (the trailing tail hasn't hit a boundary yet)", state.in_speech is True)
    finally:
        await stop_worker(worker)


# =================================================================
# L5 partial regression guard + throttling + partials-disabled paths
# =================================================================


async def test_partial_regression_guard_suppresses_empty_after_nonempty() -> None:
    backend = FakeBackend()
    backend.partial_texts = ["hello", "", "hello world"]
    server = make_parakeet_server(backend, emit_partials=True)
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()
    saved_interval = whisper_server.PARTIAL_INTERVAL_S
    whisper_server.PARTIAL_INTERVAL_S = 0.0  # decouple from wall-clock throttling for this test
    worker = await start_worker(server, ws, state, cmd_queue)
    try:
        for _ in range(3):
            await cmd_queue.put(_ParakeetAudio(frame=speech_frame()))
        await cmd_queue.join()

        partials = [m for m in ws.sent if m["type"] == "partial"]
        check(
            "P1 regression guard: exactly 2 partials sent — the empty regression is suppressed, never reaching the client",
            len(partials) == 2,
        )
        check(
            "P1 regression guard: texts are hello then hello world, in order",
            [p["text"] for p in partials] == ["hello", "hello world"],
        )
    finally:
        whisper_server.PARTIAL_INTERVAL_S = saved_interval
        await stop_worker(worker)


async def test_partial_emission_is_throttled() -> None:
    backend = FakeBackend()
    backend.partial_texts = ["a", "ab", "abc"]
    server = make_parakeet_server(backend, emit_partials=True)
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()
    saved_interval = whisper_server.PARTIAL_INTERVAL_S
    whisper_server.PARTIAL_INTERVAL_S = 999.0  # never elapses within this test
    worker = await start_worker(server, ws, state, cmd_queue)
    try:
        for _ in range(3):
            await cmd_queue.put(_ParakeetAudio(frame=speech_frame()))
        await cmd_queue.join()

        partials = [m for m in ws.sent if m["type"] == "partial"]
        check("throttle: only the FIRST tick's partial is emitted within one interval window", len(partials) == 1)
        check("throttle: it carries the first tick's own text", partials[0]["text"] == "a")
        check("throttle: all 3 Audio commands still fed the streaming context (feeding is never throttled, only emission)", len(backend.add_audio_calls) == 3)
    finally:
        whisper_server.PARTIAL_INTERVAL_S = saved_interval
        await stop_worker(worker)


async def test_partials_disabled_suppresses_all_partial_emission() -> None:
    backend = FakeBackend()
    backend.partial_texts = ["a", "b", "c"]
    server = make_parakeet_server(backend, emit_partials=False)
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()
    saved_interval = whisper_server.PARTIAL_INTERVAL_S
    whisper_server.PARTIAL_INTERVAL_S = 0.0
    worker = await start_worker(server, ws, state, cmd_queue)
    try:
        for _ in range(3):
            await cmd_queue.put(_ParakeetAudio(frame=speech_frame()))
        await cmd_queue.join()
        check("partials disabled: zero partial messages sent even with 3 non-empty Audio commands", [m for m in ws.sent if m["type"] == "partial"] == [])
    finally:
        whisper_server.PARTIAL_INTERVAL_S = saved_interval
        await stop_worker(worker)


async def test_partials_disabled_never_enqueues_audio_commands() -> None:
    backend = FakeBackend()
    server = make_parakeet_server(backend, emit_partials=False)
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()
    await server._handle_binary(ws, state, cmd_queue, loud_pcm_bytes(5))
    check("partials disabled: the receive loop never enqueues an Audio command at all (cheapest path, L5)", cmd_queue.qsize() == 0)
    check("partials disabled: VAD/buffering still ran normally (speech was detected)", state.in_speech is True)


async def test_partials_enabled_enqueues_one_audio_command_per_call() -> None:
    backend = FakeBackend()
    server = make_parakeet_server(backend, emit_partials=True)
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()
    await server._handle_binary(ws, state, cmd_queue, loud_pcm_bytes(5))
    check("partials enabled: exactly one Audio command is enqueued (frames from this one call batched together)", cmd_queue.qsize() == 1)
    item = cmd_queue.get_nowait()
    check("partials enabled: the item is an _ParakeetAudio command", isinstance(item, _ParakeetAudio))
    check(
        "partials enabled: its frame is every speech sample fed this call, concatenated",
        item.frame.shape[0] == FRAME_SAMPLES * 5,
    )


# =================================================================
# config partials-override / stop_accepted idempotency (parakeet's OWN
# copy of these — verified independently, not assumed from
# WhisperServer's identical-looking tests)
# =================================================================


async def test_config_message_sets_partials_override_parakeet() -> None:
    backend = FakeBackend()
    server = make_parakeet_server(backend)
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()
    check("parakeet config: partials_override starts unset (None)", state.partials_override is None)

    await server._handle_text(ws, state, cmd_queue, json.dumps({"type": "config", "partials": True}))
    check("parakeet config: partials:true sets the override", state.partials_override is True)

    await server._handle_text(ws, state, cmd_queue, json.dumps({"type": "config", "partials": False}))
    check("parakeet config: partials:false sets the override", state.partials_override is False)

    await server._handle_text(ws, state, cmd_queue, json.dumps({"type": "config"}))
    check("parakeet config: no partials key leaves a prior override untouched", state.partials_override is False)


async def test_binary_after_stop_accepted_is_ignored_parakeet() -> None:
    backend = FakeBackend()
    server = make_parakeet_server(backend)
    ws = FakeWs()
    state = ConnectionState(language="en")
    state.stop_accepted = True
    cmd_queue: "asyncio.Queue" = asyncio.Queue()

    await server._handle_binary(ws, state, cmd_queue, loud_pcm_bytes())

    check("parakeet binary-after-stop: VAD never runs — in_speech stays False", state.in_speech is False)
    check("parakeet binary-after-stop: no leftover bytes buffered either — a true no-op", state.leftover == b"")
    check("parakeet binary-after-stop: nothing was ever enqueued", cmd_queue.qsize() == 0)


async def test_double_stop_enqueues_only_one_sentinel_parakeet() -> None:
    backend = FakeBackend()
    server = make_parakeet_server(backend)
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()

    await server._handle_text(ws, state, cmd_queue, json.dumps({"type": "stop"}))
    await server._handle_text(ws, state, cmd_queue, json.dumps({"type": "stop"}))

    check("parakeet double stop: stop_accepted latches True", state.stop_accepted is True)
    check("parakeet double stop: exactly one command (the sentinel) was ever enqueued", cmd_queue.qsize() == 1)

    worker = await start_worker(server, ws, state, cmd_queue)
    try:
        await asyncio.wait_for(worker, timeout=2.0)
        check(
            "parakeet double stop: exactly one 'stopped' ack is ever sent, then closed (FB7), and the worker exits cleanly",
            [m["type"] for m in ws.sent] == ["stopped", "closed"],
        )
    finally:
        await stop_worker(worker)


# =================================================================
# L2/F4 single-active-stream: parakeet-busy rejection + stream-slot
# release on an ordinary (non-"stop") connection close, both exercised
# through handle() itself (its rejection/lifecycle branches never
# await transcription, so a minimal FakeWs suffices — see module
# docstring's FakeWs/FakeWsEmptyStream).
# =================================================================


async def test_parakeet_busy_rejects_second_session() -> None:
    backend = FakeBackend()
    server = make_parakeet_server(backend)
    check("parakeet-busy setup: the first session acquires the slot directly", backend.try_acquire_stream() is True)

    ws2 = FakeWs()
    await server.handle(ws2)

    check(
        "parakeet-busy: the second session gets exactly one parakeet-busy message then a close, nothing else",
        [m["type"] for m in ws2.sent] == ["parakeet-busy", "closed"],
    )
    check("parakeet-busy: the rejected session's close() was actually called", ws2.close_calls == 1)
    check("parakeet-busy: the first (already-active) session's slot is untouched", backend._busy is True)


async def test_close_without_stop_releases_stream_slot() -> None:
    backend = FakeBackend()
    server = make_parakeet_server(backend)
    ws = FakeWsEmptyStream()

    await server.handle(ws)

    check("crash-close: the stream slot is released even though 'stop' was never sent", backend._busy is False)
    check("crash-close: a later session can now acquire the slot", backend.try_acquire_stream() is True)


# =================================================================
# JobManager._transcribe_job: isinstance-routes to the parakeet arm;
# the faster-whisper arm is unaffected by the added branch.
# =================================================================


def test_transcribe_job_dispatches_to_parakeet_backend() -> None:
    backend = ParakeetMlxBackend(PARAKEET_MODEL)
    calls: list[tuple[str, str]] = []

    def fake_transcribe_file(file_path: str, language: str):
        calls.append((file_path, language))
        return ([{"start": 0.0, "end": 1.2, "text": "hello"}], 1.2)

    backend.transcribe_file = fake_transcribe_file  # type: ignore[method-assign]

    jm = JobManager(model=backend, model_name=PARAKEET_MODEL, default_language="en", hf_token=None)
    job = new_job(False)
    job_id = job["id"]
    jm.jobs[job_id] = job

    jm._transcribe_job(job_id, "/tmp/fake.wav", "en")

    check(
        "transcribe_job parakeet dispatch: isinstance(ParakeetMlxBackend) routes to the parakeet arm",
        calls == [("/tmp/fake.wav", "en")],
    )
    check(
        "transcribe_job parakeet dispatch: segments land on the job unchanged",
        jm.jobs[job_id]["segments"] == [{"start": 0.0, "end": 1.2, "text": "hello"}],
    )
    check(
        "transcribe_job parakeet dispatch: progress jumps straight to the DIARIZE_HOLD_PROGRESS ceiling (batch is already complete)",
        jm.jobs[job_id]["progress"] == DIARIZE_HOLD_PROGRESS,
    )


def test_transcribe_job_faster_whisper_path_unaffected_by_parakeet_branch() -> None:
    class FakeSeg:
        def __init__(self, start: float, end: float, text: str) -> None:
            self.start, self.end, self.text = start, end, text

    class FakeInfo:
        duration = 2.0

    class FakeFasterWhisperModel:
        def __init__(self) -> None:
            self.calls: list[tuple[str, dict]] = []

        def transcribe(self, file_path: str, **kwargs):
            self.calls.append((file_path, kwargs))
            return iter([FakeSeg(0.0, 1.0, "hello"), FakeSeg(1.0, 2.0, "world")]), FakeInfo()

    model = FakeFasterWhisperModel()
    jm = JobManager(model=model, model_name="small", default_language="en", hf_token=None)
    job = new_job(False)
    job_id = job["id"]
    jm.jobs[job_id] = job

    jm._transcribe_job(job_id, "/tmp/f.wav", "en")

    check(
        "transcribe_job faster-whisper path: segments shape unchanged by the added parakeet branch",
        jm.jobs[job_id]["segments"] == [
            {"start": 0.0, "end": 1.0, "text": "hello"},
            {"start": 1.0, "end": 2.0, "text": "world"},
        ],
    )
    check(
        "transcribe_job faster-whisper path: the SAME kwargs (beam_size=1, vad_filter=True, word_timestamps=False) are still passed, plus initial_prompt (v0.4.7 Lane B — defaults None when the caller omits it)",
        model.calls[0][1]
        == {
            "language": "en",
            "beam_size": 1,
            "vad_filter": True,
            "word_timestamps": False,
            "initial_prompt": None,
        },
    )
    check("transcribe_job faster-whisper path: progress reaches the DIARIZE_HOLD_PROGRESS ceiling at the last segment", (
        abs(jm.jobs[job_id]["progress"] - DIARIZE_HOLD_PROGRESS) < 1e-9
    ))


# =================================================================
# initial_prompt (v0.4.7 Lane B, glossary -> recognizer bias): reaches
# the faster-whisper model.transcribe() call; explicit no-op on the
# parakeet arm (ParakeetMlxBackend.transcribe_file has no such param
# at all — never even attempted, not a client-side/JS-side gate).
# =================================================================


def test_transcribe_job_forwards_initial_prompt_to_the_model() -> None:
    class FakeSeg:
        def __init__(self, start: float, end: float, text: str) -> None:
            self.start, self.end, self.text = start, end, text

    class FakeInfo:
        duration = 1.0

    class FakeFasterWhisperModel:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def transcribe(self, file_path: str, **kwargs):
            self.calls.append(kwargs)
            return iter([FakeSeg(0.0, 1.0, "hi")]), FakeInfo()

    model = FakeFasterWhisperModel()
    jm = JobManager(model=model, model_name="small", default_language="en", hf_token=None)
    job = new_job(False)
    job_id = job["id"]
    jm.jobs[job_id] = job

    jm._transcribe_job(job_id, "/tmp/f.wav", "en", initial_prompt="scRNA-seq, UMAP")

    check(
        "transcribe_job: a provided initial_prompt reaches model.transcribe()",
        model.calls[0].get("initial_prompt") == "scRNA-seq, UMAP",
    )


def test_transcribe_job_parakeet_never_receives_initial_prompt() -> None:
    backend = ParakeetMlxBackend(PARAKEET_MODEL)
    calls: list[tuple[str, str]] = []

    def fake_transcribe_file(file_path: str, language: str):
        calls.append((file_path, language))
        return ([{"start": 0.0, "end": 1.0, "text": "hi"}], 1.0)

    backend.transcribe_file = fake_transcribe_file  # type: ignore[method-assign]
    jm = JobManager(model=backend, model_name=PARAKEET_MODEL, default_language="en", hf_token=None)
    job = new_job(False)
    job_id = job["id"]
    jm.jobs[job_id] = job

    jm._transcribe_job(job_id, "/tmp/fake.wav", "en", initial_prompt="scRNA-seq, UMAP")

    check(
        "transcribe_job parakeet dispatch: initial_prompt is silently dropped (transcribe_file's own signature has no such param) — the explicit no-op the doc requires",
        calls == [("/tmp/fake.wav", "en")],
    )


# =================================================================
# S12b fix round B — FB2 (BLOCKER): close-before-batch_final ordering
# =================================================================


async def test_boundary_closes_context_before_batch_final_fb2() -> None:
    """FB2 (BLOCKER, Sol2): the streaming context must be closed/reset
    BEFORE batch_final runs — upstream's __exit__ is what restores full
    ('rel_pos') attention (StreamingParakeet.__exit__); running
    batch_final on a still-open context would run generate() under
    LOCAL attention, silently degrading every final's quality. Feeds
    one Audio command (opens the context) then a Boundary — asserts
    the FakeBackend's own call_order log shows 'close' strictly before
    'batch_final', not just eventually — immediately before, with
    nothing else interleaved."""
    backend = FakeBackend()
    backend.partial_texts = ["partial text"]
    backend.final_texts = ["final text"]
    server = make_parakeet_server(backend, emit_partials=True)
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()
    worker = await start_worker(server, ws, state, cmd_queue)
    try:
        await cmd_queue.put(_ParakeetAudio(frame=speech_frame()))
        await cmd_queue.join()
        mark_pending_speech(state)
        await server._finalize_boundary(state, cmd_queue, force=True)
        await cmd_queue.join()

        check("FB2 setup: the context was actually opened for the Audio command", "open" in backend.call_order)
        check(
            "FB2: call order is exactly open, add_audio, close, batch_final — close strictly before batch_final",
            backend.call_order == ["open", "add_audio", "close", "batch_final"],
        )
        finals = [m for m in ws.sent if m["type"] == "final"]
        check("FB2: the final itself still arrives normally after the reorder", finals and finals[0]["text"] == "final text")
    finally:
        await stop_worker(worker)


# =================================================================
# S12b fix round B — FB4 (HIGH): live x file shared-workload mutual
# exclusion. Uses the REAL ParakeetMlxBackend (not FakeBackend) so
# these tests exercise the actual threading.Lock-backed reservation
# JobManager.start_job/start_url_job and ParakeetMlxServer.handle both
# contend for — the integration itself, not just the abstract shape.
# =================================================================


def test_fb4_job_admission_blocked_by_live_ws_session() -> None:
    backend = ParakeetMlxBackend(PARAKEET_MODEL)
    check(
        "FB4 setup: the (simulated) live ws session acquires the shared workload slot",
        backend.try_acquire_stream() is True,
    )

    jm = JobManager(model=backend, model_name=PARAKEET_MODEL, default_language="en", hf_token=None)
    job_id = jm.start_job("/tmp/jargonslayer-test-fb4-nonexistent.wav", "en")
    check(
        "FB4: start_job refuses admission (returns None) while the slot is held by a live ws session",
        job_id is None,
    )
    check("FB4: no job was ever recorded for the refused admission", jm.jobs == {})


async def test_fb4_ws_session_blocked_by_running_job() -> None:
    backend = ParakeetMlxBackend(PARAKEET_MODEL)
    check(
        "FB4 setup: the (simulated) running parakeet job acquires the shared workload slot",
        backend.try_acquire_stream() is True,
    )

    server = ParakeetMlxServer(backend=backend, default_language="en", emit_partials=False, save_audio_path=None)
    ws = FakeWs()
    await server.handle(ws)
    check(
        "FB4: a ws session gets the EXISTING typed parakeet-busy event while a job holds the slot (no new code path)",
        [m["type"] for m in ws.sent] == ["parakeet-busy", "closed"],
    )


def test_fb4_start_url_job_blocked_too() -> None:
    backend = ParakeetMlxBackend(PARAKEET_MODEL)
    check("FB4 setup: the slot is held", backend.try_acquire_stream() is True)
    jm = JobManager(model=backend, model_name=PARAKEET_MODEL, default_language="en", hf_token=None)
    job_id = jm.start_url_job("https://example.com/video", "en")
    check("FB4: start_url_job is ALSO gated by the same shared slot", job_id is None)
    check("FB4: no URL job was ever recorded for the refused admission", jm.jobs == {})


def test_fb4_faster_whisper_jobs_unaffected() -> None:
    # A non-ParakeetMlxBackend model (here, a bare object() — start_job's
    # isinstance check must exclude it from the shared-slot gate
    # entirely; the job WILL fail once its background thread actually
    # tries to transcribe with no real model, but ADMISSION itself must
    # never be blocked regardless of any parakeet workload state).
    jm = JobManager(model=object(), model_name="small", default_language="en", hf_token=None)
    job_id = jm.start_job("/tmp/jargonslayer-test-fb4-whisper-unaffected.bin", "en")
    check(
        "FB4: a non-parakeet model's start_job is never gated by the shared slot",
        isinstance(job_id, str) and len(job_id) > 0,
    )


def test_fb4_release_on_job_crash() -> None:
    backend = ParakeetMlxBackend(PARAKEET_MODEL)

    def failing_transcribe_file(file_path: str, language: str):
        raise RuntimeError("boom-transcribe-file")

    backend.transcribe_file = failing_transcribe_file  # type: ignore[method-assign]

    jm = JobManager(model=backend, model_name=PARAKEET_MODEL, default_language="en", hf_token=None)
    job_id = jm.start_job("/tmp/jargonslayer-test-fb4-crash.bin", "en")
    check("FB4 crash setup: admission succeeded (the slot was free)", job_id is not None)

    deadline = time.monotonic() + 5.0
    job = None
    while time.monotonic() < deadline:
        job = jm.get(job_id)
        if job is not None and job.get("status") in ("done", "error"):
            break
        time.sleep(0.01)

    check("FB4 crash: the job's background thread actually finished with status=error", job is not None and job.get("status") == "error")
    check(
        "FB4 crash: the shared slot was released in the job's own OUTERMOST finally, not left stuck busy",
        backend.try_acquire_stream() is True,
    )


def test_parakeet_busy_response_shape() -> None:
    body = parakeet_busy_response()
    check(
        "parakeet_busy_response: type discriminator matches the ws wire event's own ('parakeet-busy')",
        body.get("type") == "parakeet-busy",
    )
    check(
        "parakeet_busy_response: carries the exact zh copy the fix round specified",
        body.get("error") == "本机正在实时转录，请结束后再上传",
    )


# =================================================================
# S12b fix round B — FB5 (HIGH): per-command exception containment.
# Each test injects a failure into exactly ONE of the four operations
# (open/add_audio/batch_final/close) via a REAL handle() call (through
# FakeWsController, which models a real ws's receive loop unblocking
# via ConnectionClosed once close() fires from ANY task) and asserts
# the typed error event, the socket close, AND — critically — that the
# shared slot is released so the NEXT connection is accepted.
# =================================================================


async def test_fb5_open_streaming_context_failure_is_contained() -> None:
    backend = FakeBackend()
    backend.fail_open = RuntimeError("boom-open")
    server = make_parakeet_server(backend, emit_partials=True)
    ws = FakeWsController()
    ws.queue_incoming(loud_pcm_bytes(5))
    await asyncio.wait_for(server.handle(ws), timeout=5.0)

    types = [m["type"] for m in ws.sent]
    check("FB5 (open fails): a typed parakeet-error event was sent", "parakeet-error" in types)
    check("FB5 (open fails): the connection was closed", ws.close_calls >= 1)
    check(
        "FB5 (open fails): the shared slot was released — the NEXT connection is accepted",
        backend.try_acquire_stream() is True,
    )


async def test_fb5_add_audio_failure_is_contained() -> None:
    backend = FakeBackend()
    backend.fail_add_audio = RuntimeError("boom-add-audio")
    server = make_parakeet_server(backend, emit_partials=True)
    ws = FakeWsController()
    ws.queue_incoming(loud_pcm_bytes(5))
    await asyncio.wait_for(server.handle(ws), timeout=5.0)

    types = [m["type"] for m in ws.sent]
    check("FB5 (add_audio fails): a typed parakeet-error event was sent", "parakeet-error" in types)
    check("FB5 (add_audio fails): the connection was closed", ws.close_calls >= 1)
    check(
        "FB5 (add_audio fails): the ALREADY-open context was still torn down (teardown attempted despite the failure)",
        "close" in backend.call_order,
    )
    check(
        "FB5 (add_audio fails): the shared slot was released — the NEXT connection is accepted",
        backend.try_acquire_stream() is True,
    )


async def test_fb5_batch_final_failure_is_contained() -> None:
    backend = FakeBackend()
    backend.fail_batch_final = RuntimeError("boom-batch-final")
    server = make_parakeet_server(backend, emit_partials=False)
    ws = FakeWsController()
    ws.queue_incoming(loud_pcm_bytes(20))  # 640ms > MIN_SPEECH_MS(350ms)
    ws.queue_incoming(json.dumps({"type": "stop"}))
    await asyncio.wait_for(server.handle(ws), timeout=5.0)

    types = [m["type"] for m in ws.sent]
    check("FB5 (batch_final fails): a typed parakeet-error event was sent", "parakeet-error" in types)
    check("FB5 (batch_final fails): 'stopped' was NEVER sent — the connection terminated on the error first", "stopped" not in types)
    check("FB5 (batch_final fails): the connection was closed", ws.close_calls >= 1)
    check(
        "FB5 (batch_final fails): the shared slot was released — the NEXT connection is accepted",
        backend.try_acquire_stream() is True,
    )


async def test_fb5_close_streaming_context_failure_is_contained() -> None:
    backend = FakeBackend()
    backend.fail_close = RuntimeError("boom-close")
    server = make_parakeet_server(backend, emit_partials=True)
    ws = FakeWsController()
    ws.queue_incoming(loud_pcm_bytes(20))
    ws.queue_incoming(json.dumps({"type": "stop"}))
    await asyncio.wait_for(server.handle(ws), timeout=5.0)

    types = [m["type"] for m in ws.sent]
    check("FB5 (close fails): a typed parakeet-error event was sent", "parakeet-error" in types)
    check("FB5 (close fails): 'stopped' was never sent", "stopped" not in types)
    check("FB5 (close fails): the connection was closed", ws.close_calls >= 1)
    check(
        "FB5 (close fails): the shared slot was released — the NEXT connection is accepted",
        backend.try_acquire_stream() is True,
    )


# =================================================================
# S12b fix round B — FB7-server (MED): self-close after stopped is
# already covered by the updated stop-drain/stop-with-nothing-pending/
# double-stop tests above (their assertions now include "closed" as
# the trailing event). This section covers the OTHER FB7-server half:
# a one-shot diar_status "unavailable" on a diarize:true config,
# matching the whisper path's own event shape.
# =================================================================


async def test_fb7_diar_status_unavailable_on_diarize_config() -> None:
    server = make_parakeet_server(FakeBackend())
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()

    await server._handle_text(ws, state, cmd_queue, json.dumps({"type": "config", "diarize": True}))
    check(
        "FB7: exactly one diar_status event is sent when diarize:true arrives (honest arming feedback)",
        [m["type"] for m in ws.sent] == ["diar_status"],
    )
    check("FB7: state matches the whisper path's own 'unavailable' shape", ws.sent[0].get("state") == "unavailable")
    check(
        "FB7: detail is a non-empty string",
        isinstance(ws.sent[0].get("detail"), str) and len(ws.sent[0]["detail"]) > 0,
    )
    check("FB7: ConnectionState.diar_status_sent latches True (one-shot, reused field)", state.diar_status_sent is True)

    await server._handle_text(ws, state, cmd_queue, json.dumps({"type": "config", "diarize": True}))
    check("FB7: a second diarize:true config does NOT re-send diar_status (one-shot)", len(ws.sent) == 1)


async def test_fb7_diarize_false_never_sends_diar_status() -> None:
    server = make_parakeet_server(FakeBackend())
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()
    await server._handle_text(ws, state, cmd_queue, json.dumps({"type": "config", "partials": True}))
    check("FB7: a config with no diarize field never sends diar_status", ws.sent == [])


# =================================================================
# S12b fix round B — FB9 (LOW): a discarded (sub-MIN_SPEECH_MS) forced
# boundary must reset/close the streaming context — otherwise the
# still-open, blip-contaminated context gets silently REUSED for the
# next utterance's live partials.
# =================================================================


async def test_fb9_discarded_blip_resets_context_for_next_utterance() -> None:
    backend = FakeBackend()
    backend.partial_texts = ["blip text", "real utterance text"]
    server = make_parakeet_server(backend, emit_partials=True)
    ws = FakeWs()
    state = ConnectionState(language="en")
    cmd_queue: "asyncio.Queue" = asyncio.Queue()
    # Decouple from wall-clock partial throttling (PARTIAL_INTERVAL_S) —
    # the blip's OWN partial already consumes the throttle window (its
    # text is non-empty, so it emits immediately), and the real
    # utterance's Audio command below follows within microseconds in
    # this test; without this, the real partial would be suppressed by
    # the SAME throttle test_partial_emission_is_throttled exercises on
    # purpose elsewhere — an unrelated interaction FB9 isn't about.
    saved_interval = whisper_server.PARTIAL_INTERVAL_S
    whisper_server.PARTIAL_INTERVAL_S = 0.0
    worker = await start_worker(server, ws, state, cmd_queue)
    try:
        # Blip: a few loud frames (96ms, well under MIN_SPEECH_MS=350ms),
        # then an external force (mirrors "flush"/an early "stop")
        # discards it before any natural VAD silence-hang boundary.
        await server._handle_binary(ws, state, cmd_queue, loud_pcm_bytes(3))
        await cmd_queue.join()
        await server._finalize_boundary(state, cmd_queue, force=True)
        await cmd_queue.join()

        check("FB9 setup: the blip's own Audio command opened a context", backend.opened_contexts == 1)
        check("FB9 setup: no final was ever sent for the discarded blip", [m for m in ws.sent if m["type"] == "final"] == [])
        check(
            "FB9: the discarded boundary reset/closed the blip's context (call order: open, add_audio, close)",
            backend.call_order == ["open", "add_audio", "close"],
        )

        # Real utterance: a fresh Audio command must open a NEW context,
        # never reuse the blip's now-closed/contaminated one.
        await server._handle_binary(ws, state, cmd_queue, loud_pcm_bytes(3))
        await cmd_queue.join()

        check(
            "FB9: the next utterance's partial opens a FRESH context (opened_contexts == 2)",
            backend.opened_contexts == 2,
        )
        check(
            "FB9: call order shows a SECOND 'open' after the reset — never reused across the discard",
            backend.call_order == ["open", "add_audio", "close", "open", "add_audio"],
        )
        partials = [m for m in ws.sent if m["type"] == "partial"]
        check(
            "FB9: the real utterance's own partial text reaches the client, uncontaminated by the blip",
            bool(partials) and partials[-1]["text"] == "real utterance text",
        )
    finally:
        whisper_server.PARTIAL_INTERVAL_S = saved_interval
        await stop_worker(worker)


# =================================================================
# runner
# =================================================================

ASYNC_TESTS = [
    test_open_and_close_streaming_context_passes_pinned_context_size_and_depth,
    test_add_audio_wraps_the_chunk_via_mlx_array,
    test_batch_final_uses_get_logmel_and_generate_and_strips_text,
    test_backend_calls_all_run_on_the_same_dedicated_executor_thread,
    test_boundary_emits_final_with_scheduler_seg_id_t0_t1,
    test_boundary_queue_preserves_send_order,
    test_empty_final_is_skipped_seg_id_gap_preserved,
    test_stop_drains_tail_final_then_stopped,
    test_stop_with_no_pending_speech_sends_only_stopped,
    test_flush_finalizes_without_ack_and_stays_alive,
    test_max_segment_force_finalizes_mid_stream,
    test_partial_regression_guard_suppresses_empty_after_nonempty,
    test_partial_emission_is_throttled,
    test_partials_disabled_suppresses_all_partial_emission,
    test_partials_disabled_never_enqueues_audio_commands,
    test_partials_enabled_enqueues_one_audio_command_per_call,
    test_config_message_sets_partials_override_parakeet,
    test_binary_after_stop_accepted_is_ignored_parakeet,
    test_double_stop_enqueues_only_one_sentinel_parakeet,
    test_parakeet_busy_rejects_second_session,
    test_close_without_stop_releases_stream_slot,
    test_boundary_closes_context_before_batch_final_fb2,
    test_fb4_ws_session_blocked_by_running_job,
    test_fb5_open_streaming_context_failure_is_contained,
    test_fb5_add_audio_failure_is_contained,
    test_fb5_batch_final_failure_is_contained,
    test_fb5_close_streaming_context_failure_is_contained,
    test_fb7_diar_status_unavailable_on_diarize_config,
    test_fb7_diarize_false_never_sends_diar_status,
    test_fb9_discarded_blip_resets_context_for_next_utterance,
]


async def run_async_tests() -> None:
    for test in ASYNC_TESTS:
        try:
            await asyncio.wait_for(test(), timeout=5.0)
        except Exception as exc:  # noqa: BLE001 - a hard crash/timeout is itself a FAIL signal
            check(f"{test.__name__} did not raise/hang ({exc!r})", False)


test_backend_for_model_parakeet()
test_backend_for_model_every_other_model_is_faster_whisper()
test_backend_load_uses_from_pretrained_with_only_the_repo_id()
test_transcribe_file_raises_zh_error_when_ffmpeg_missing()
test_transcribe_file_maps_aligned_sentences_to_job_segments()
test_transcribe_file_empty_sentences_returns_empty_segments_and_zero_duration()
test_try_acquire_stream_and_release()
test_transcribe_job_dispatches_to_parakeet_backend()
test_transcribe_job_faster_whisper_path_unaffected_by_parakeet_branch()
test_transcribe_job_forwards_initial_prompt_to_the_model()
test_transcribe_job_parakeet_never_receives_initial_prompt()
test_fb4_job_admission_blocked_by_live_ws_session()
test_fb4_start_url_job_blocked_too()
test_fb4_faster_whisper_jobs_unaffected()
test_fb4_release_on_job_crash()
test_parakeet_busy_response_shape()
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
