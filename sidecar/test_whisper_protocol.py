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
  - stop -> tail-final (if any) THEN stopped, in that exact order
  - stop with nothing pending sends only stopped, no final
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
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from whisper_server import (  # noqa: E402
    FRAME_SAMPLES,
    ConnectionState,
    FinalizeJob,
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
# Fixtures / fakes
# =================================================================


class FakeWs:
    """Records every JSON frame sent — see module docstring. No real
    socket, no ConnectionClosed simulation: none of the tests below
    need it (that swallow-on-close behavior is untouched by protocol
    v2, and is already exercised implicitly by every send() call
    succeeding against this fake)."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, raw: str) -> None:
        self.sent.append(json.loads(raw))


def make_server(emit_partials: bool = False, stub_text: str = "text") -> WhisperServer:
    """A WhisperServer with no real faster-whisper model — `_transcribe`
    is monkey-patched on the INSTANCE (bypasses the descriptor
    protocol, so the replacement is called with exactly (audio,
    language), no implicit self) to a deterministic stub, per this
    task's spec: 'stubbed _transcribe, no model download'."""
    server = WhisperServer(
        model=None,
        default_language="en",
        emit_partials=emit_partials,
        save_audio_path=None,
    )
    server._transcribe = lambda audio, language: stub_text  # type: ignore[method-assign]
    return server


def speech_frame() -> np.ndarray:
    return np.zeros(FRAME_SAMPLES, dtype=np.float32)


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
            "stop: client sees the tail final THEN stopped, in that exact order",
            [m["type"] for m in ws.sent] == ["final", "stopped"],
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
            "stop with nothing pending: only 'stopped' is sent, no final",
            [m["type"] for m in ws.sent] == ["stopped"],
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
# partial single-flight + finals-priority
# =================================================================


async def test_partial_single_flight_skip() -> None:
    calls: list[int] = []

    def stub(audio: np.ndarray, language: str) -> str:
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

    def stub(audio: np.ndarray, language: str) -> str:
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

    def stub(audio: np.ndarray, language: str) -> str:
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

    def stub(audio: np.ndarray, language: str) -> str:
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
# runner
# =================================================================

ASYNC_TESTS = [
    test_stop_drains_tail_final_then_stopped,
    test_stop_with_no_pending_speech_sends_only_stopped,
    test_flush_finalizes_without_ack_and_stays_alive,
    test_config_message_sets_partials_override,
    test_partial_single_flight_skip,
    test_partial_skipped_while_finalize_queue_nonempty,
    test_seg_id_monotonic_with_empty_gap,
    test_finalize_queue_preserves_send_order,
]


async def run_async_tests() -> None:
    for test in ASYNC_TESTS:
        try:
            await asyncio.wait_for(test(), timeout=5.0)
        except Exception as exc:  # noqa: BLE001 - a hard crash/timeout is itself a FAIL signal
            check(f"{test.__name__} did not raise/hang ({exc!r})", False)


test_partials_override_both_directions()
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
