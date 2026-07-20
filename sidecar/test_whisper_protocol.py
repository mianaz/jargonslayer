#!/usr/bin/env python3
"""Plain-assert self-test for whisper_server.py's protocol v2 finalize-
queue / partial / stop-drain / flush / partials-override / diar-ready
machinery — no pytest, no network, no real model (a `_transcribe` stub
replaces the model call on every WhisperServer instance these tests
construct), no server start (module import is side-effect free;
servers only start under `if __name__ == "__main__":`). Mirrors
test_realtime_diar.py/test_ingest_url.py's existing style/harness: this
repo's sidecar tests run as plain scripts (`python3 test_whisper_
protocol.py`), not pytest/unittest — test_realtime_diar.py's own
module-level `sys.exit(0)`/`sys.exit(1)` is NOT pytest-collectable
(confirmed live: pytest raises an INTERNALERROR importing that file),
so this file follows the same plain-script convention. `handle()`
itself (the fake-ws-driven websocket loop) is deliberately NOT
exercised here — these tests call the same async handler methods
`handle()` calls (`_handle_text`/`_handle_binary`/`_finalize_segment`/
`_consume_finalize_queue`) directly against a hand-built
ConnectionState + FakeWs, which is enough to cover every protocol-level
behavior below without needing a real/fake TCP socket.

Run:
    sidecar/.venv/bin/python sidecar/test_whisper_protocol.py
    (or plain `python3 sidecar/test_whisper_protocol.py` — this file
    needs nothing beyond numpy + the stdlib; faster-whisper is never
    imported, since every test stubs `_transcribe` directly.)

Covers (protocol v2, see whisper_server.py's own module docstring):
  - stop -> tail-final (if any) THEN stopped THEN the connection
    closes, in that exact order
  - stop with nothing pending sends only stopped (then closes), no final
  - flush finalizes without any ack, and the connection stays usable
    for a later segment afterward (seg_id keeps advancing, not reset)
  - config.partials overrides the server-wide --partials default, both
    directions, and an absent key on a later config leaves a prior
    override untouched
  - partial single-flight: an overlapping tick is skipped, not queued
  - finals-priority: a partial tick is skipped entirely while the
    finalize queue is non-empty
  - seg_id is assigned at enqueue time and stays monotonic even when a
    transcription in between comes back empty (an intentional gap)
  - the finalize queue's single sequential consumer preserves send
    order across several enqueued segments
  - post-stop diarization linger (_finalize_diar_then_close): armed +
    buffered audio runs one final pass (order: final, stopped,
    speaker_update, closed); not armed, or armed with nothing ever
    buffered, closes right after stopped with no pass; an already-
    in-flight periodic pass is awaited before the final pass itself
    runs (never overlapped/skipped)
  - diarization_probe (S5 decision C): import-first ordering; the
    three orthogonal (installed, ready, error) facts for not-installed
    vs installed-no-token vs installed-with-token, pyannote faked via
    sys.modules (never a real pyannote install — see that section for
    why); health_payload's /health shape, including the new
    diarization_installed field and the unchanged-on-purpose
    diarization_ready/diarization_error back-compat semantics
  - _SharedDiarizePipeline.get() (S5 review pair Finding 1): a failed
    load (missing module, or Pipeline.from_pretrained itself raising —
    e.g. an unaccepted-license/bad-token 403) is NOT latched — the next
    get() call on the SAME instance retries the whole load rather than
    staying "unavailable" forever; a SUCCEEDED load stays cached
    exactly as before (the loader runs exactly once across repeated
    get() calls)
  - lag_ms (S10 field-fix #5): both partial and final messages carry
    the _transcribe call's own wall-time in milliseconds
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
import types
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from whisper_server import (  # noqa: E402
    FRAME_SAMPLES,
    ConnectionState,
    FinalizeJob,
    JobManager,
    WhisperServer,
    _SharedDiarizePipeline,
    health_payload,
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


class FakeWs:
    """Records every JSON frame sent — see module docstring. No real
    socket, no ConnectionClosed simulation: none of the tests below
    need it (that swallow-on-close behavior is untouched by protocol
    v2, and is already exercised implicitly by every send() call
    succeeding against this fake). close() is recorded onto the SAME
    `sent` list (as a synthetic {"type": "closed"} entry, close_calls
    counts separately) so a test can assert send/close ORDERING with
    the exact same `[m["type"] for m in ws.sent] == [...]` idiom used
    for real frames below — see the post-stop diarization tests."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.close_calls = 0

    async def send(self, raw: str) -> None:
        self.sent.append(json.loads(raw))

    async def close(self) -> None:
        self.close_calls += 1
        self.sent.append({"type": "closed"})


def make_server(emit_partials: bool = False, stub_text: str = "text") -> WhisperServer:
    """A WhisperServer with no real faster-whisper model — `_transcribe`
    is monkey-patched on the INSTANCE (bypasses the descriptor
    protocol, so the replacement is called with exactly (audio,
    language, initial_prompt), no implicit self) to a deterministic
    stub, per this task's spec: 'stubbed _transcribe, no model
    download'. `initial_prompt` (v0.4.7 Lane B) defaults to None so
    every call site that omits it (state.initial_prompt unset) still
    calls this stub validly."""
    server = WhisperServer(
        model=None,
        default_language="en",
        emit_partials=emit_partials,
        save_audio_path=None,
    )
    server._transcribe = lambda audio, language, initial_prompt=None: stub_text  # type: ignore[method-assign]
    return server


def speech_frame() -> np.ndarray:
    return np.zeros(FRAME_SAMPLES, dtype=np.float32)


def loud_pcm_bytes(n_frames: int = 1) -> bytes:
    """Real int16 PCM bytes, loud enough to clear the VAD threshold —
    for feeding _handle_binary itself (unlike speech_frame() above,
    which is a float32 VAD-bypass fixture for injecting directly into
    ConnectionState.speech_buf)."""
    samples = np.full(FRAME_SAMPLES * n_frames, 16000, dtype=np.int16)
    return samples.tobytes()


def mark_pending_speech(
    state: ConnectionState, started_at: float = 0.0, speech_ms: float = 400.0
) -> None:
    """Simulate 'VAD already detected an in-progress speech segment'.
    These tests exercise the finalize-queue/stop/flush/partials
    machinery, not VAD frame classification itself (unchanged by this
    protocol version) — setting this directly is the minimal, correct
    fixture; speech_ms=400 clears MIN_SPEECH_MS=350 so the segment
    actually enqueues."""
    state.in_speech = True
    state.speech_buf = [speech_frame()]
    state.speech_started_at = started_at
    state.speech_ms = speech_ms


async def start_consumer(server: WhisperServer, ws: FakeWs, state: ConnectionState) -> "asyncio.Task[None]":
    return asyncio.create_task(server._consume_finalize_queue(ws, state))


async def stop_consumer(task: "asyncio.Task[None]") -> None:
    if task.done():
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


async def wait_until(predicate, timeout: float = 2.0, interval: float = 0.01) -> bool:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(interval)
    return predicate()


# =================================================================
# stop -> tail-final then stopped
# =================================================================


async def test_stop_drains_tail_final_then_stopped() -> None:
    server = make_server(stub_text="final tail text")
    ws = FakeWs()
    state = ConnectionState(language="en")
    consumer = await start_consumer(server, ws, state)
    try:
        mark_pending_speech(state)
        await server._handle_text(ws, state, json.dumps({"type": "stop"}))
        await asyncio.wait_for(consumer, timeout=2.0)

        check(
            "stop: client sees the tail final THEN stopped THEN the connection closes, in that exact order",
            [m["type"] for m in ws.sent] == ["final", "stopped", "closed"],
        )
        check("stop: the tail final carries seg_id 0", ws.sent[0].get("seg_id") == 0)
        check("stop: the tail final's text is the transcribed text", ws.sent[0].get("text") == "final tail text")
    finally:
        await stop_consumer(consumer)


async def test_stop_with_no_pending_speech_sends_only_stopped() -> None:
    server = make_server(stub_text="unused")
    ws = FakeWs()
    state = ConnectionState(language="en")
    consumer = await start_consumer(server, ws, state)
    try:
        # No in-progress speech at all — stop's force-finalize is a no-op.
        await server._handle_text(ws, state, json.dumps({"type": "stop"}))
        await asyncio.wait_for(consumer, timeout=2.0)
        check(
            "stop with nothing pending: only 'stopped' is sent (then closed), no final",
            [m["type"] for m in ws.sent] == ["stopped", "closed"],
        )
    finally:
        await stop_consumer(consumer)


# =================================================================
# stop_accepted (codex v2 review finding F1): once "stop" lands,
# every later binary frame and config/flush message is ignored, and a
# second "stop" is idempotent (never enqueues a second sentinel).
# =================================================================


async def test_binary_after_stop_accepted_is_ignored() -> None:
    server = make_server()
    ws = FakeWs()
    state = ConnectionState(language="en")
    state.stop_accepted = True

    await server._handle_binary(ws, state, loud_pcm_bytes())

    check(
        "binary after stop_accepted: VAD never runs — in_speech stays False",
        state.in_speech is False,
    )
    check(
        "binary after stop_accepted: no leftover bytes buffered either — a true no-op",
        state.leftover == b"",
    )


async def test_double_stop_enqueues_only_one_sentinel() -> None:
    server = make_server()
    ws = FakeWs()
    state = ConnectionState(language="en")

    await server._handle_text(ws, state, json.dumps({"type": "stop"}))
    await server._handle_text(ws, state, json.dumps({"type": "stop"}))

    check("double stop: stop_accepted latches True", state.stop_accepted is True)
    check(
        "double stop: exactly one job (the sentinel) was ever enqueued",
        state.finalize_queue.qsize() == 1,
    )

    consumer = await start_consumer(server, ws, state)
    try:
        await asyncio.wait_for(consumer, timeout=2.0)
        check(
            "double stop: exactly one 'stopped' ack is ever sent, the connection closes once, and the consumer exits cleanly",
            [m["type"] for m in ws.sent] == ["stopped", "closed"],
        )
    finally:
        await stop_consumer(consumer)


async def test_config_and_flush_after_stop_accepted_are_ignored() -> None:
    server = make_server(stub_text="should never be sent")
    ws = FakeWs()
    state = ConnectionState(language="en")

    await server._handle_text(ws, state, json.dumps({"type": "stop"}))

    # A flush after stop: no extra job, even with pending speech to force-finalize.
    mark_pending_speech(state)
    await server._handle_text(ws, state, json.dumps({"type": "flush"}))
    check(
        "flush after stop_accepted: ignored — still just the one stop sentinel enqueued",
        state.finalize_queue.qsize() == 1,
    )

    # A config after stop: ignored — no override applied.
    await server._handle_text(ws, state, json.dumps({"type": "config", "language": "fr"}))
    check(
        "config after stop_accepted: ignored — language override never applied",
        state.language == "en",
    )


# =================================================================
# post-stop diarization linger (_finalize_diar_then_close): after
# "stopped", one more diarization pass runs (bypassing DIAR_INTERVAL_S)
# if armed + buffered, then the server closes the connection itself.
# run_realtime_diar is stubbed on the SERVER INSTANCE (same "bypasses
# the descriptor protocol" trick make_server() already uses for
# _transcribe — see its own doc comment) so these tests exercise only
# the NEW orchestration in _finalize_diar_then_close/
# _maybe_trigger_realtime_diar, not the (unchanged, pyannote-dependent)
# internals of run_realtime_diar itself.
# =================================================================


async def test_stop_with_diar_armed_runs_final_pass_then_closes() -> None:
    server = make_server(stub_text="final tail text")
    ws = FakeWs()
    state = ConnectionState(language="en")
    state.diar_armed = True
    state.diar_audio_buf = bytearray(b"\x00\x00")  # any buffered audio at all
    # Keep this test focused on JUST the post-stop pass: without this,
    # the tail final below would ALSO trip _maybe_trigger_realtime_diar
    # (last_diar_at defaults to -inf, i.e. "never run", so the very
    # first final always fires one) — that periodic-vs-post-stop
    # interaction is covered on its own by
    # test_stop_waits_for_an_in_flight_pass_before_running_the_final_one.
    state.last_diar_at = state.elapsed()

    calls: list[int] = []

    async def fake_run_realtime_diar(ws_arg: object, state_arg: ConnectionState) -> None:
        calls.append(1)
        await server._safe_send(
            ws_arg,
            state_arg,
            {"type": "speaker_update", "gen": 1, "assignments": [], "speakers": []},
        )

    server.run_realtime_diar = fake_run_realtime_diar  # type: ignore[method-assign]

    consumer = await start_consumer(server, ws, state)
    try:
        mark_pending_speech(state)
        await server._handle_text(ws, state, json.dumps({"type": "stop"}))
        await asyncio.wait_for(consumer, timeout=2.0)

        check(
            "post-stop diar (armed + buffered): order is tail final, stopped, speaker_update, closed",
            [m["type"] for m in ws.sent] == ["final", "stopped", "speaker_update", "closed"],
        )
        check("post-stop diar (armed + buffered): the final pass ran exactly once", calls == [1])
    finally:
        await stop_consumer(consumer)


async def test_stop_with_diar_not_armed_closes_without_a_pass() -> None:
    server = make_server()
    ws = FakeWs()
    state = ConnectionState(language="en")
    # diar_armed stays False (default) even though audio was buffered —
    # an unarmed connection must never attempt a pass.
    state.diar_audio_buf = bytearray(b"\x00\x00")

    calls: list[int] = []

    async def fake_run_realtime_diar(ws_arg: object, state_arg: ConnectionState) -> None:
        calls.append(1)

    server.run_realtime_diar = fake_run_realtime_diar  # type: ignore[method-assign]

    consumer = await start_consumer(server, ws, state)
    try:
        await server._handle_text(ws, state, json.dumps({"type": "stop"}))
        await asyncio.wait_for(consumer, timeout=2.0)

        check(
            "post-stop diar (not armed): only stopped then closed — no speaker_update",
            [m["type"] for m in ws.sent] == ["stopped", "closed"],
        )
        check("post-stop diar (not armed): the final pass never runs", calls == [])
    finally:
        await stop_consumer(consumer)


async def test_stop_with_diar_armed_but_no_buffered_audio_closes_without_a_pass() -> None:
    server = make_server()
    ws = FakeWs()
    state = ConnectionState(language="en")
    state.diar_armed = True
    # diar_audio_buf stays at its default empty bytearray — e.g. armed
    # then stopped before any binary frame ever arrived.

    calls: list[int] = []

    async def fake_run_realtime_diar(ws_arg: object, state_arg: ConnectionState) -> None:
        calls.append(1)

    server.run_realtime_diar = fake_run_realtime_diar  # type: ignore[method-assign]

    consumer = await start_consumer(server, ws, state)
    try:
        await server._handle_text(ws, state, json.dumps({"type": "stop"}))
        await asyncio.wait_for(consumer, timeout=2.0)

        check(
            "post-stop diar (armed, nothing buffered): only stopped then closed",
            [m["type"] for m in ws.sent] == ["stopped", "closed"],
        )
        check(
            "post-stop diar (armed, nothing buffered): the final pass never runs",
            calls == [],
        )
    finally:
        await stop_consumer(consumer)


async def test_stop_waits_for_an_in_flight_pass_before_running_the_final_one() -> None:
    server = make_server()
    ws = FakeWs()
    state = ConnectionState(language="en")
    state.diar_armed = True
    state.diar_audio_buf = bytearray(b"\x00\x00")

    order: list[str] = []
    call_count = 0
    in_flight_may_finish = asyncio.Event()

    async def fake_run_realtime_diar(ws_arg: object, state_arg: ConnectionState) -> None:
        nonlocal call_count
        call_count += 1
        this_call = call_count
        order.append(f"start-{this_call}")
        if this_call == 1:
            # The already-in-flight (periodic) pass — blocks until the
            # test explicitly lets it finish, so the assertions below
            # can prove the final pass hasn't started yet.
            await in_flight_may_finish.wait()
        order.append(f"end-{this_call}")

    server.run_realtime_diar = fake_run_realtime_diar  # type: ignore[method-assign]

    # Simulate a periodic pass already in flight when "stop" arrives —
    # exactly what _maybe_trigger_realtime_diar sets up.
    state.diar_in_flight = True
    state.diar_task = asyncio.create_task(server.run_realtime_diar(ws, state))
    await asyncio.sleep(0)  # let it actually start and reach the .wait()
    check("in-flight setup: the periodic pass has started", order == ["start-1"])

    consumer = await start_consumer(server, ws, state)
    try:
        await server._handle_text(ws, state, json.dumps({"type": "stop"}))
        # Give the post-stop path a moment to reach (and block on) the
        # in-flight task — the final pass must NOT have started yet.
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        check(
            "post-stop diar: the final pass has not started while the in-flight one is still running",
            order == ["start-1"],
        )

        in_flight_may_finish.set()
        await asyncio.wait_for(consumer, timeout=2.0)

        check(
            "post-stop diar: the in-flight pass fully finishes before the final pass starts",
            order == ["start-1", "end-1", "start-2", "end-2"],
        )
        check(
            "post-stop diar: exactly 2 passes ran (the in-flight one, then the final one)",
            call_count == 2,
        )
        check(
            "post-stop diar: 'stopped' is sent before the final pass's own speaker_update timing"
            " point (this stub sends none), and the connection still closes afterward",
            [m["type"] for m in ws.sent] == ["stopped", "closed"],
        )
    finally:
        await stop_consumer(consumer)


# =================================================================
# flush
# =================================================================


async def test_flush_finalizes_without_ack_and_stays_alive() -> None:
    server = make_server(stub_text="flushed text")
    ws = FakeWs()
    state = ConnectionState(language="en")
    consumer = await start_consumer(server, ws, state)
    try:
        mark_pending_speech(state)
        await server._handle_text(ws, state, json.dumps({"type": "flush"}))
        await asyncio.wait_for(state.finalize_queue.join(), timeout=2.0)

        check(
            "flush: exactly one final, no 'stopped' or any other ack",
            [m["type"] for m in ws.sent] == ["final"],
        )

        # Connection keeps living — a later segment still finalizes
        # normally on the SAME consumer/queue, no reconnect involved.
        mark_pending_speech(state, started_at=1.0)
        await server._finalize_segment(ws, state, force=True)
        await asyncio.wait_for(state.finalize_queue.join(), timeout=2.0)
        check(
            "flush: connection stays usable afterward — a later segment still finalizes",
            [m["type"] for m in ws.sent] == ["final", "final"],
        )
        check(
            "flush: seg_id kept advancing across the flush (1, not reset to 0)",
            ws.sent[1]["seg_id"] == 1,
        )
    finally:
        await stop_consumer(consumer)


# =================================================================
# per-connection partials override
# =================================================================


def test_partials_override_both_directions() -> None:
    state = ConnectionState(language="en")
    server_off = make_server(emit_partials=False)
    server_on = make_server(emit_partials=True)

    check(
        "partials: no override falls back to the server default (off)",
        server_off._partials_enabled(state) is False,
    )
    check(
        "partials: no override falls back to the server default (on)",
        server_on._partials_enabled(state) is True,
    )

    state.partials_override = True
    check(
        "partials: per-connection override True wins over a server default of off",
        server_off._partials_enabled(state) is True,
    )
    state.partials_override = False
    check(
        "partials: per-connection override False wins over a server default of on",
        server_on._partials_enabled(state) is False,
    )


async def test_config_message_sets_partials_override() -> None:
    server = make_server()
    ws = FakeWs()
    state = ConnectionState(language="en")
    check("partials_override starts unset (None)", state.partials_override is None)

    await server._handle_text(ws, state, json.dumps({"type": "config", "partials": True}))
    check("config partials:true sets the override", state.partials_override is True)

    await server._handle_text(ws, state, json.dumps({"type": "config", "partials": False}))
    check("config partials:false sets the override", state.partials_override is False)

    await server._handle_text(ws, state, json.dumps({"type": "config"}))
    check(
        "config with no partials key leaves a prior override untouched",
        state.partials_override is False,
    )


# =================================================================
# initial_prompt (v0.4.7 Lane B, glossary -> recognizer bias):
# config.initial_prompt sets a per-connection biasing hint threaded
# into every faster-whisper transcribe() call on this connection (both
# partial and final) — mirrors config.partials's own override wiring
# above, plus a second test proving the value actually reaches
# self.model.transcribe() (not just ConnectionState).
# =================================================================


async def test_config_message_sets_initial_prompt() -> None:
    server = make_server()
    ws = FakeWs()
    state = ConnectionState(language="en")
    check("initial_prompt starts unset (None)", state.initial_prompt is None)

    await server._handle_text(
        ws, state, json.dumps({"type": "config", "initial_prompt": "scRNA-seq, UMAP"})
    )
    check("config initial_prompt sets state.initial_prompt", state.initial_prompt == "scRNA-seq, UMAP")

    await server._handle_text(ws, state, json.dumps({"type": "config"}))
    check(
        "config with no initial_prompt key leaves a prior value untouched",
        state.initial_prompt == "scRNA-seq, UMAP",
    )

    await server._handle_text(ws, state, json.dumps({"type": "config", "initial_prompt": ""}))
    check(
        "config initial_prompt: an empty string does not clear a prior value (mirrors language's own isinstance+truthy gate)",
        state.initial_prompt == "scRNA-seq, UMAP",
    )


class _FakeTranscribeModel:
    """Records the kwargs of every transcribe() call — unlike
    make_server()'s own `_transcribe` stub (which replaces the whole
    method), this fakes the underlying MODEL itself so _transcribe's
    real body (this test's actual subject) still runs, proving
    initial_prompt reaches self.model.transcribe(...) rather than just
    landing on ConnectionState."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def transcribe(self, audio, **kwargs):
        self.calls.append(kwargs)

        class _Seg:
            text = "stubbed"

        class _Info:
            pass

        return [_Seg()], _Info()


def test_transcribe_forwards_initial_prompt_to_the_model() -> None:
    model = _FakeTranscribeModel()
    server = WhisperServer(model=model, default_language="en", emit_partials=False, save_audio_path=None)

    server._transcribe(speech_frame(), "en", initial_prompt="scRNA-seq, UMAP")
    check(
        "_transcribe forwards a provided initial_prompt to model.transcribe()",
        model.calls[-1].get("initial_prompt") == "scRNA-seq, UMAP",
    )

    server._transcribe(speech_frame(), "en")
    check(
        "_transcribe defaults initial_prompt to None when the caller omits it (no connection ever set one)",
        model.calls[-1].get("initial_prompt") is None,
    )


# =================================================================
# partial single-flight + finals-priority
# =================================================================


async def test_partial_single_flight_skip() -> None:
    calls: list[int] = []

    def stub(audio: np.ndarray, language: str, initial_prompt: Optional[str] = None) -> str:
        calls.append(1)
        return "partial text"

    server = make_server()
    server._transcribe = stub  # type: ignore[method-assign]
    ws = FakeWs()
    state = ConnectionState(language="en")
    state.speech_buf = [speech_frame()]

    server._emit_partial(ws, state)
    check("partial: first tick flips the in-flight flag", state.partial_in_flight is True)

    server._emit_partial(ws, state)  # overlapping tick — must be skipped, not queued
    await wait_until(lambda: not state.partial_in_flight)

    check("partial single-flight: only ONE transcription actually ran", len(calls) == 1)
    check("partial: in-flight flag resets once the (single) pass completes", state.partial_in_flight is False)
    check("partial single-flight: exactly one 'partial' message was sent", len(ws.sent) == 1)


async def test_partial_skipped_while_finalize_queue_nonempty() -> None:
    calls: list[int] = []

    def stub(audio: np.ndarray, language: str, initial_prompt: Optional[str] = None) -> str:
        calls.append(1)
        return "partial text"

    server = make_server()
    server._transcribe = stub  # type: ignore[method-assign]
    ws = FakeWs()
    state = ConnectionState(language="en")
    state.speech_buf = [speech_frame()]
    # A pending final job with no consumer running to drain it — the
    # queue simply stays non-empty for the whole test.
    await state.finalize_queue.put(
        FinalizeJob(audio=speech_frame(), t0=0.0, t1=1.0, seg_id=0, speech_ms=400.0)
    )

    server._emit_partial(ws, state)
    check(
        "partial finals-priority: never flips in-flight while the finalize queue is non-empty",
        state.partial_in_flight is False,
    )
    await asyncio.sleep(0.05)
    check("partial finals-priority: no transcription ran while a final was pending", calls == [])


# =================================================================
# seg_id monotonicity + queue ordering
# =================================================================


async def test_seg_id_monotonic_with_empty_gap() -> None:
    texts = iter(["hello", "", "world"])  # the 2nd segment transcribes to empty

    def stub(audio: np.ndarray, language: str, initial_prompt: Optional[str] = None) -> str:
        return next(texts)

    server = make_server()
    server._transcribe = stub  # type: ignore[method-assign]
    ws = FakeWs()
    state = ConnectionState(language="en")
    consumer = await start_consumer(server, ws, state)
    try:
        for i in range(3):
            mark_pending_speech(state, started_at=float(i))
            await server._finalize_segment(ws, state, force=True)
        await asyncio.wait_for(state.finalize_queue.join(), timeout=2.0)

        finals = [m for m in ws.sent if m["type"] == "final"]
        check("seg_id gap: only 2 finals sent — the empty-text one is skipped", len(finals) == 2)
        check("seg_id gap: first final keeps seg_id 0", finals[0]["seg_id"] == 0)
        check(
            "seg_id gap: second final is seg_id 2 — seg_id 1 (empty transcription) is an intentional gap",
            finals[1]["seg_id"] == 2,
        )
        check(
            "seg_id gap: the connection's next_seg_id advanced past the gap too",
            state.next_seg_id == 3,
        )
    finally:
        await stop_consumer(consumer)


async def test_finalize_queue_preserves_send_order() -> None:
    texts = [f"seg-{i}" for i in range(5)]
    remaining = iter(texts)

    def stub(audio: np.ndarray, language: str, initial_prompt: Optional[str] = None) -> str:
        return next(remaining)

    server = make_server()
    server._transcribe = stub  # type: ignore[method-assign]
    ws = FakeWs()
    state = ConnectionState(language="en")
    consumer = await start_consumer(server, ws, state)
    try:
        for i in range(5):
            mark_pending_speech(state, started_at=float(i))
            await server._finalize_segment(ws, state, force=True)
        await asyncio.wait_for(state.finalize_queue.join(), timeout=2.0)

        finals = [m for m in ws.sent if m["type"] == "final"]
        check(
            "queue ordering: all 5 finals arrive in enqueue (seg_id) order",
            [m["seg_id"] for m in finals] == [0, 1, 2, 3, 4],
        )
        check(
            "queue ordering: text payloads line up with enqueue order too",
            [m["text"] for m in finals] == texts,
        )
    finally:
        await stop_consumer(consumer)


# =================================================================
# lag_ms (S10 field-fix #5): both partial and final messages carry the
# _transcribe call's own wall-time in ms — wraps the SAME
# asyncio.to_thread(self._transcribe, ...) call every other test above
# already exercises, not a separate code path. Stub sleeps a small,
# deterministic amount (in the to_thread worker thread, so it never
# blocks the event loop) so lag_ms is asserted against a real lower
# bound rather than just "some number".
# =================================================================


async def test_partial_carries_lag_ms() -> None:
    def slow_stub(audio: np.ndarray, language: str, initial_prompt: Optional[str] = None) -> str:
        time.sleep(0.02)
        return "partial text"

    server = make_server()
    server._transcribe = slow_stub  # type: ignore[method-assign]
    ws = FakeWs()
    state = ConnectionState(language="en")
    state.speech_buf = [speech_frame()]

    server._emit_partial(ws, state)
    await wait_until(lambda: not state.partial_in_flight)

    check("partial lag_ms: exactly one partial sent", len(ws.sent) == 1)
    lag_ms = ws.sent[0].get("lag_ms")
    check("partial lag_ms: present and numeric", isinstance(lag_ms, (int, float)))
    check(
        f"partial lag_ms ({lag_ms!r}): reflects the stub's own ~20ms delay",
        isinstance(lag_ms, (int, float)) and lag_ms >= 15,
    )


async def test_final_carries_lag_ms() -> None:
    def slow_stub(audio: np.ndarray, language: str, initial_prompt: Optional[str] = None) -> str:
        time.sleep(0.02)
        return "final text"

    server = make_server()
    server._transcribe = slow_stub  # type: ignore[method-assign]
    ws = FakeWs()
    state = ConnectionState(language="en")
    consumer = await start_consumer(server, ws, state)
    try:
        mark_pending_speech(state)
        await server._finalize_segment(ws, state, force=True)
        await asyncio.wait_for(state.finalize_queue.join(), timeout=2.0)

        finals = [m for m in ws.sent if m["type"] == "final"]
        check("final lag_ms: exactly one final sent", len(finals) == 1)
        lag_ms = finals[0].get("lag_ms")
        check("final lag_ms: present and numeric", isinstance(lag_ms, (int, float)))
        check(
            f"final lag_ms ({lag_ms!r}): reflects the stub's own ~20ms delay",
            isinstance(lag_ms, (int, float)) and lag_ms >= 15,
        )
    finally:
        await stop_consumer(consumer)


# =================================================================
# diarization_probe (S5 decision C) — import-first ordering, three
# orthogonal (installed, ready, error) facts. pyannote's presence is
# faked via sys.modules — NEVER a real pyannote install: this dev
# machine's ambient `python3` may have a real pyannote.audio on a base
# conda env entirely outside the sidecar venv, so merely leaving
# pyannote "not installed" here would not reliably exercise the
# not-installed path on every machine this file runs on;
# sys.modules["pyannote.audio"] = None is the documented idiom to force
# ImportError regardless of what's really reachable on sys.path.
# =================================================================

_UNSET = object()


def _set_pyannote_importable(available: bool) -> dict[str, object]:
    """Stubs sys.modules so `import pyannote.audio` (as
    diarization_probe does it) deterministically succeeds
    (available=True — harmless fake modules for both `pyannote` and
    `pyannote.audio`; a dotted import needs the PARENT key present
    too, confirmed live: stubbing only the child still raises
    ModuleNotFoundError for the parent in a clean interpreter) or fails
    (available=False — the `= None` force-ImportError idiom). Returns
    the previous sys.modules entries (or _UNSET if there was none) for
    restoration via _restore_pyannote_importable — mirrors
    test_download.py's shutil.disk_usage save/restore idiom."""
    saved: dict[str, object] = {
        name: sys.modules.get(name, _UNSET) for name in ("pyannote", "pyannote.audio")
    }
    if available:
        sys.modules["pyannote"] = types.ModuleType("pyannote")
        sys.modules["pyannote.audio"] = types.ModuleType("pyannote.audio")
    else:
        sys.modules.pop("pyannote", None)
        sys.modules["pyannote.audio"] = None  # type: ignore[assignment]
    return saved


def _restore_pyannote_importable(saved: dict[str, object]) -> None:
    for name, prev in saved.items():
        if prev is _UNSET:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = prev  # type: ignore[assignment]


def test_diarization_probe_not_installed() -> None:
    server = JobManager(model=None, model_name="small", default_language="en", hf_token="a-token")
    saved = _set_pyannote_importable(False)
    try:
        installed, ready, error = server.diarization_probe()
        check("diarization_probe not-installed: installed is False", installed is False)
        check("diarization_probe not-installed: ready is False", ready is False)
        check(
            "diarization_probe not-installed: error mentions 未安装/pyannote — distinguishable from the token case",
            error is not None and "未安装" in error and "pyannote" in error,
        )
    finally:
        _restore_pyannote_importable(saved)


def test_diarization_probe_installed_no_token() -> None:
    server = JobManager(model=None, model_name="small", default_language="en", hf_token=None)
    saved = _set_pyannote_importable(True)
    try:
        installed, ready, error = server.diarization_probe()
        check("diarization_probe installed+no-token: installed is True", installed is True)
        check("diarization_probe installed+no-token: ready is False", ready is False)
        check(
            "diarization_probe installed+no-token: error mentions the token, not an install problem",
            error is not None and "Token" in error and "未安装" not in error,
        )
    finally:
        _restore_pyannote_importable(saved)


def test_diarization_probe_installed_with_token() -> None:
    server = JobManager(model=None, model_name="small", default_language="en", hf_token="a-token")
    saved = _set_pyannote_importable(True)
    try:
        installed, ready, error = server.diarization_probe()
        check("diarization_probe installed+token: installed is True", installed is True)
        check("diarization_probe installed+token: ready is True", ready is True)
        check("diarization_probe installed+token: error is None", error is None)
    finally:
        _restore_pyannote_importable(saved)


# =================================================================
# _SharedDiarizePipeline.get() — failure-latched cache fix (S5 review
# pair Finding 1): a failed load must not permanently latch process-
# wide (see that method's own docstring for the two concrete
# recoveries this enables). pyannote is faked via sys.modules, same
# idiom as diarization_probe's own tests just above, but the stub also
# needs an actual `Pipeline.from_pretrained` attached —
# diarization_probe never imports that symbol (a plain `import
# pyannote.audio`), so _set_pyannote_importable(True)'s bare module
# stub alone isn't enough for get()'s own `from pyannote.audio import
# Pipeline`. Every test below builds its OWN fresh _SharedDiarizePipeline
# instance rather than touching whisper_server's module-level
# `_shared_diarize_pipeline` singleton, so these tests can't leak
# cached state into each other (or into anything else importing this
# module) regardless of run order.
# =================================================================


def _set_pyannote_pipeline_stub(from_pretrained) -> dict[str, object]:
    """Like _set_pyannote_importable(True), but the stubbed
    `pyannote.audio` module also exposes a `Pipeline` object whose
    `from_pretrained` is `from_pretrained` verbatim — reuses
    _restore_pyannote_importable for teardown (same sys.modules keys)."""
    saved: dict[str, object] = {
        name: sys.modules.get(name, _UNSET) for name in ("pyannote", "pyannote.audio")
    }
    sys.modules["pyannote"] = types.ModuleType("pyannote")
    audio_module = types.ModuleType("pyannote.audio")
    audio_module.Pipeline = types.SimpleNamespace(from_pretrained=from_pretrained)  # type: ignore[attr-defined]
    sys.modules["pyannote.audio"] = audio_module
    return saved


def test_shared_diarize_pipeline_retries_after_missing_module() -> None:
    """Recovery 1 (get()'s own docstring): a mid-install import against
    a half-written venv fails now, but completes moments later — the
    NEXT get() call (this connection's next diarization window, or a
    brand-new meeting) must retry the load rather than staying
    permanently "unavailable" on this process."""
    pipeline = _SharedDiarizePipeline()
    saved = _set_pyannote_importable(False)
    try:
        result, error = pipeline.get(None)
        check("missing-module load: pipeline is None", result is None)
        check(
            "missing-module load: error names the ModuleNotFoundError",
            error is not None and "ModuleNotFoundError" in error,
        )
        check("missing-module load: NOT latched — a retry is still possible", pipeline._loaded is False)
    finally:
        _restore_pyannote_importable(saved)

    # "install completes" — pyannote becomes importable and loads fine.
    calls = 0
    sentinel = object()

    def fake_from_pretrained(*args, **kwargs):
        nonlocal calls
        calls += 1
        return sentinel

    saved = _set_pyannote_pipeline_stub(fake_from_pretrained)
    try:
        result, error = pipeline.get(None)
        check("retry after install: the SAME instance recovers, no restart needed", result is sentinel)
        check("retry after install: error is cleared", error is None)
        check("retry after install: the loader ran exactly once for this recovery", calls == 1)
        check("retry after install: now latched", pipeline._loaded is True)
    finally:
        _restore_pyannote_importable(saved)


def test_shared_diarize_pipeline_retries_after_from_pretrained_failure() -> None:
    """Recovery 2 (get()'s own docstring): pyannote imports fine but
    Pipeline.from_pretrained itself fails — the unaccepted-license/
    bad-token 403 case. Once the user accepts the license, the NEXT
    get() call must retry and succeed, still with no sidecar restart."""
    pipeline = _SharedDiarizePipeline()

    def failing_from_pretrained(*args, **kwargs):
        raise RuntimeError("403 Client Error: token lacks access to pyannote/speaker-diarization-3.1")

    saved = _set_pyannote_pipeline_stub(failing_from_pretrained)
    try:
        result, error = pipeline.get("bad-token")
        check("from_pretrained failure: pipeline is None", result is None)
        check("from_pretrained failure: error names the RuntimeError", error is not None and "RuntimeError" in error)
        check("from_pretrained failure: NOT latched — a retry is still possible", pipeline._loaded is False)
    finally:
        _restore_pyannote_importable(saved)

    sentinel = object()

    def working_from_pretrained(*args, **kwargs):
        return sentinel

    saved = _set_pyannote_pipeline_stub(working_from_pretrained)
    try:
        result, error = pipeline.get("good-token")
        check("retry after license accept: the SAME instance recovers", result is sentinel)
        check("retry after license accept: error is cleared", error is None)
    finally:
        _restore_pyannote_importable(saved)


def test_shared_diarize_pipeline_success_is_cached() -> None:
    """A SUCCEEDED load must still behave exactly as before this
    finding: the loader never runs twice — only a FAILED load retries."""
    pipeline = _SharedDiarizePipeline()
    calls = 0
    sentinel = object()

    def fake_from_pretrained(*args, **kwargs):
        nonlocal calls
        calls += 1
        return sentinel

    saved = _set_pyannote_pipeline_stub(fake_from_pretrained)
    try:
        first_result, first_error = pipeline.get(None)
        second_result, second_error = pipeline.get(None)
        check(
            "success caching: both calls return the identical cached pipeline",
            first_result is sentinel and second_result is sentinel,
        )
        check("success caching: both calls report no error", first_error is None and second_error is None)
        check("success caching: the loader ran exactly once across two get()s", calls == 1)
    finally:
        _restore_pyannote_importable(saved)


# =================================================================
# health_payload — GET /health's shape (S5 decision C adds
# diarization_installed). No test in this suite previously asserted
# /health's shape at all (grep confirms: nothing referenced
# diarization_probe/diarization_ready/diarization_error anywhere
# before S5), so this is new coverage, not an update to a pinned
# ordering.
# =================================================================


def test_health_payload_shape() -> None:
    check(
        "health_payload: keys are exactly ok/model/diarization_installed/diarization_ready/diarization_error",
        set(health_payload("small", True, True, None).keys())
        == {"ok", "model", "diarization_installed", "diarization_ready", "diarization_error"},
    )
    check(
        "health_payload: ok is always True, and the model name passes through unchanged",
        health_payload("large-v3", True, True, None)["ok"] is True
        and health_payload("large-v3", True, True, None)["model"] == "large-v3",
    )
    check(
        "health_payload: not-installed case reports diarization_installed False",
        health_payload("small", False, False, "x")["diarization_installed"] is False,
    )
    check(
        "health_payload: installed+no-token case reports diarization_installed True, diarization_ready False",
        health_payload("small", True, False, "x")["diarization_installed"] is True
        and health_payload("small", True, False, "x")["diarization_ready"] is False,
    )
    check(
        "health_payload: diarization_error is suppressed to None whenever ready (unchanged pre-S5 back-compat)",
        health_payload("small", True, True, "should never surface")["diarization_error"] is None,
    )
    check(
        "health_payload: diarization_error carries the message through whenever not ready (unchanged pre-S5 back-compat)",
        health_payload("small", True, False, "未配置 HF Token")["diarization_error"] == "未配置 HF Token",
    )


# =================================================================
# runner
# =================================================================

ASYNC_TESTS = [
    test_stop_drains_tail_final_then_stopped,
    test_stop_with_no_pending_speech_sends_only_stopped,
    test_binary_after_stop_accepted_is_ignored,
    test_double_stop_enqueues_only_one_sentinel,
    test_config_and_flush_after_stop_accepted_are_ignored,
    test_stop_with_diar_armed_runs_final_pass_then_closes,
    test_stop_with_diar_not_armed_closes_without_a_pass,
    test_stop_with_diar_armed_but_no_buffered_audio_closes_without_a_pass,
    test_stop_waits_for_an_in_flight_pass_before_running_the_final_one,
    test_flush_finalizes_without_ack_and_stays_alive,
    test_config_message_sets_partials_override,
    test_config_message_sets_initial_prompt,
    test_partial_single_flight_skip,
    test_partial_skipped_while_finalize_queue_nonempty,
    test_seg_id_monotonic_with_empty_gap,
    test_finalize_queue_preserves_send_order,
    test_partial_carries_lag_ms,
    test_final_carries_lag_ms,
]


async def run_async_tests() -> None:
    for test in ASYNC_TESTS:
        try:
            await asyncio.wait_for(test(), timeout=5.0)
        except Exception as exc:  # noqa: BLE001 - a hard crash/timeout is itself a FAIL signal
            check(f"{test.__name__} did not raise/hang ({exc!r})", False)


test_partials_override_both_directions()
test_transcribe_forwards_initial_prompt_to_the_model()
test_diarization_probe_not_installed()
test_diarization_probe_installed_no_token()
test_diarization_probe_installed_with_token()
test_shared_diarize_pipeline_retries_after_missing_module()
test_shared_diarize_pipeline_retries_after_from_pretrained_failure()
test_shared_diarize_pipeline_success_is_cached()
test_health_payload_shape()
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
