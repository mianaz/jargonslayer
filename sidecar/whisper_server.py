#!/usr/bin/env python3
"""JargonSlayer local Whisper sidecar.

Privacy-mode STT server: receives 16kHz mono int16 PCM over a
WebSocket, performs energy-based VAD segmentation, and transcribes
each speech segment with faster-whisper. No audio ever leaves the
machine.

Usage:
    python whisper_server.py --model small --port 8765

Protocol v2 (per connection):
  Client -> Server:
    - text frame: JSON {"type": "config", ...}
        - "language": str, optional override
        - "diarize": bool + "hf_token": str — arm realtime speaker
          diarization (beta), see below
        - "partials": bool, optional — per-connection override of this
          process's --partials default (absent = server default, see
          WhisperServer.emit_partials / _partials_enabled)
        - "initial_prompt": str, optional (v0.4.7 Lane B, glossary ->
          recognizer bias, docs/design-explorations/stt-provider-
          wiring-2026-07.md §3/D3) — a biasing hint threaded into
          every faster-whisper transcribe() call on this connection
          (both partial and final, see WhisperServer._transcribe).
          Ignored (never read) by the parakeet-mlx backend below — an
          explicit no-op, not a client-side gate (ParakeetMlxBackend.
          transcribe_file has no such parameter at all).
    - text frame: JSON {"type": "stop"} — force-finalizes any
      in-progress speech, then drains: once every already-enqueued
      final (including the just-forced tail one, if any) has actually
      been sent, the server sends {"type": "stopped"}. Post-stop
      diarization linger: if realtime diarization is armed and has any
      buffered audio, the server then runs ONE final diarization pass
      over it (bypassing the normal DIAR_INTERVAL_S spacing — see
      "Realtime speaker diarization" below) and sends its
      `speaker_update`; either way, the server then closes the
      connection itself — the client no longer has to be the one to
      close. The client is expected to keep its socket open and
      `onmessage` live at least until it sees "stopped" (or its own
      timeout), and — when diarization is on — a bit longer still (its
      own POST_STOP_LINGER_MS-bounded "linger", only listening for a
      trailing `speaker_update` by then) until the server's own close
      arrives or that linger itself times out — see
      apps/web/src/lib/stt/wsTransport.ts's stop(). Idempotent (a
      second "stop" never enqueues a second sentinel), and once
      accepted every later frame on the connection — binary PCM
      included — is silently ignored (ConnectionState.stop_accepted),
      since the client's own stop-drain wait can still have PCM
      in-flight for up to its own timeout after sending this.
    - text frame: JSON {"type": "flush"} — force-finalizes any
      in-progress speech WITHOUT closing anything and WITHOUT an ack
      (no "stopped" is ever sent for a flush). For a soft pause: the
      client stops sending audio frames but keeps the connection (and
      this server-side state) alive so resume needs no reconnect and
      no fresh seg_id namespace. See TabAudioEngine.pause()/resume().
    - binary frame: 16kHz mono int16 PCM chunks
  Server -> Client:
    - text frame: JSON {"type": "partial", "text": "...",
                         "lag_ms": <int>}      (optional)
    - text frame: JSON {"type": "final", "text": "...",
                         "start": <seconds>, "end": <seconds>,
                         "seg_id": <int>, "lag_ms": <int>}
      "lag_ms" on both (S10 field-fix #5): this ONE inference call's own
      wall-time in milliseconds (time.monotonic() around the
      asyncio.to_thread(self._transcribe, ...) call — see _run_partial/
      _consume_finalize_queue below), for the client's sustained-latency
      indicator. Not a queueing/network delay measurement, just the
      transcribe call itself.
    - text frame: JSON {"type": "stopped"} — drain-ack for a "stop"
      (see above); never sent for any other reason.
    - text frame: JSON {"type": "speaker_update", "gen": <int>,
                         "assignments": [{"seg_id": <int>,
                                           "speaker": "SPEAKER_2"}, ...],
                         "speakers": ["SPEAKER_1", "SPEAKER_2", ...]}
    - text frame: JSON {"type": "diar_status",
                         "state": "unavailable" | "error" | "ready",
                         "detail": "..."}  ("ready"'s detail is always
                         absent — see below)

Finalize scheduling (protocol v2's core fix): each connection owns an
asyncio.Queue of finalize jobs + one background consumer task. The
recv loop (_handle_binary/_handle_text) NEVER awaits transcription —
_finalize_segment does the MIN_SPEECH_MS check, assigns this segment's
seg_id (monotonic per connection, assigned at ENQUEUE time — a job
whose transcription later comes back empty still consumes a seg_id,
leaving an intentional gap; diarization maps purely by seg_id and the
queue's FIFO order guarantees `final`s are sent in that same order
regardless), resets VAD state, and enqueues. Only the consumer task
(_consume_finalize_queue) ever calls the (potentially slow)
_transcribe, off the recv loop entirely — so on a CPU host where
transcription can't keep up with continuous speech, incoming audio
frames are never blocked and MAX_SEGMENT_MS force-finalize keeps
firing on real wall-clock-derived elapsed time, instead of receding
indefinitely (the "fragmented after ~3 min" bug this version fixes).
A `None` job is the stop-drain sentinel (see "stop" above). Partials
(_emit_partial/_run_partial) are transcribed from only the trailing
PARTIAL_TAIL_WINDOW_S of the current segment (not the whole, ever-
growing buffer), fired via asyncio.create_task under a single-flight
flag, and skipped entirely whenever the finalize queue is non-empty —
finals always get CPU priority over a partial preview.

Concurrent sends: the `websockets` library documents `send()`/`recv()`
as needing to be serialized per connection (concurrent calls raise
ConcurrencyError) — since the consumer task, the recv loop's partial
trigger, and a realtime-diarization pass can all send on the same
connection, every outgoing frame goes through _safe_send, which holds
a per-connection asyncio.Lock for the duration of the send.

Realtime speaker diarization (beta): when armed (config.diarize truthy
+ a token available), every ~20s the connection runs the shared
pyannote pipeline over a rolling window of its own buffered audio in a
background thread (asyncio.to_thread) and emits a `speaker_update`
that back-labels already-sent `final` segments by `seg_id`. It never
blocks the transcription/VAD path and degrades to `diar_status` on any
failure — transcription itself is unaffected. The first pass that
successfully loads the pipeline (diarize + token + pyannote all held)
sends `diar_status: "ready"` once — arming itself (the config-time
diar_armed gate) never confirms pyannote is actually importable, only
an attempted load does, which is why this ack fires from the first
background pass rather than at config time.

Post-stop diarization linger: the ~20s periodic cadence above means the
last few seconds of a meeting can still be unlabeled by the time the
user ends it. See "stop" above and _consume_finalize_queue's
stop-sentinel branch (_finalize_diar_then_close): once the drain-ack
("stopped") is sent, if diarization is armed and has any buffered
audio, one MORE pass runs — bypassing DIAR_INTERVAL_S (calling
run_realtime_diar directly, rather than through
_maybe_trigger_realtime_diar, skips that gate entirely) — before the
server closes the connection. If a periodic pass is already in flight
at that point, it's awaited first (its window covers strictly less
audio than what's buffered by now) and this final pass still runs
afterward rather than reusing its result.

Known limits (codex v2 review finding F8): the finalize queue's
FIFO-with-priority-over-partials scheduling (see "Finalize scheduling"
above) is a per-connection admission control only — it guarantees THIS
connection's own finals never queue up behind ITS OWN partials, and
that a stop-drain's tail final gets sent, but an in-flight partial
transcription, a DIFFERENT connection's finalize queue, or an HTTP
upload/import job (see "Upload-a-recording HTTP job API" below) can
all still contend for the one shared model (load_model() below calls
faster-whisper's WhisperModel with no num_workers override, i.e. its
own single-worker default). A heavy concurrent import job in
particular can push a stop-drain past the client's own
STOP_DRAIN_TIMEOUT_MS (wsTransport.ts) bound, in which case the client
gives up waiting and closes without ever seeing "stopped" (harmless —
just an earlier close than ideal). A global cross-connection/cross-job
priority scheduler is future work.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import fnmatch
import gc
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import wave
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse, parse_qs

import asyncio
import numpy as np
import websockets

# Use the top-level, version-stable API (works on both websockets
# 12.x and 13.x — the newer `websockets.asyncio.server` submodule
# only exists from 13.0 onward).
from websockets import WebSocketServerProtocol
from websockets.exceptions import ConnectionClosed

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2  # int16

# ---- VAD tuning (energy-based, per spec) ----
MIN_THRESHOLD = 0.008
NOISE_FLOOR_MULTIPLIER = 2.2
SILENCE_HANG_MS = 550
MIN_SPEECH_MS = 350
MAX_SEGMENT_MS = 25_000
MAX_UPLOAD_BYTES = 500 * (1 << 20)  # job-API upload cap (protects /tmp)
NOISE_EMA_ALPHA = 0.05  # smoothing factor for the noise-floor EMA
PARTIAL_INTERVAL_S = 2.0
# Protocol v2: a partial only ever transcribes this trailing window of
# the current (possibly much longer) in-progress segment — keeps each
# partial's transcription cost roughly constant regardless of how long
# the segment has run, instead of re-transcribing the whole growing
# buffer every tick (the CPU-starves-the-recv-loop bug this version
# fixes; see module docstring).
PARTIAL_TAIL_WINDOW_S = 10.0

# VAD operates on ~32ms analysis frames (512 samples @ 16kHz) — small
# enough for responsive onset/offset detection.
FRAME_SAMPLES = 512

# ---- realtime speaker diarization (beta) tuning ----
DIAR_INTERVAL_S = 20.0  # minimum gap between realtime diarization passes
DIAR_WINDOW_S = 600.0  # max trailing-audio window fed to the pipeline
DIAR_MIN_OVERLAP_S = 2.0  # min overlap to match a new cluster to a registry id
DIAR_MIN_SPEECH_S = 3.0  # min total speech for an unmatched cluster to mint an id
DIAR_MAX_SPEAKERS = 8  # registry cap; beyond this, fold into best-overlap anchor
DIAR_ERROR_BACKOFF_S = 60.0  # cooldown after a pass raises, before retrying


def rms(frame: np.ndarray) -> float:
    """Root-mean-square energy of a float32 [-1, 1] frame."""
    if frame.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(frame))))


# =================================================================
# Pure, unit-testable diarization helpers — no I/O, no pipeline, no
# asyncio. Shared by the realtime ws pass (run_realtime_diar) and
# (for the segment/turn overlap assigner) the upload-a-recording job
# path (JobManager._diarize_job). Covered by test_realtime_diar.py.
# =================================================================

Turn = tuple[float, float]  # (start, end) in absolute seconds


def overlap_seconds(turns_a: list[Turn], turns_b: list[Turn]) -> float:
    """Total overlap (seconds) between two sets of [start, end)
    intervals — sum of every pairwise intersection. Intervals within
    each list may themselves overlap (we don't assume non-overlapping,
    coalesced input); the sum-of-pairwise-intersections definition
    handles that correctly (if slightly redundantly) for our purposes,
    since real speaker turns from one pass rarely self-overlap."""
    total = 0.0
    for a_start, a_end in turns_a:
        for b_start, b_end in turns_b:
            inter = min(a_end, b_end) - max(a_start, b_start)
            if inter > 0:
                total += inter
    return total


def match_clusters(
    new_clusters: dict[str, list[Turn]],
    registry: dict[str, list[Turn]],
    *,
    min_overlap: float = DIAR_MIN_OVERLAP_S,
    min_speech: float = DIAR_MIN_SPEECH_S,
    cap: int = DIAR_MAX_SPEAKERS,
) -> dict[str, str]:
    """Map this pass's local pyannote labels to stable cross-pass
    speaker ids, via turn-overlap matching against the previous pass's
    registry (NOT embeddings).

    Returns {local_label: stable_id} for every local label that got a
    stable id (unmatched short-blip clusters are simply absent from
    the result — caller ignores them). Does not mutate `registry`;
    caller is responsible for replacing matched/minted ids' turns with
    this pass's turns afterward (see module docstring / spec: "a
    speaker absent from this pass keeps their old turns until they age
    out").

    Algorithm: compute every (local_label, stable_id) overlap, greedily
    take the highest-overlap pair first, one-to-one (each side used at
    most once), for every pair meeting `min_overlap`. Remaining
    unmatched local labels with total speech >= `min_speech` mint a
    fresh `SPEAKER_{n+1}` (numbers only ever grow — minted off the
    highest existing numeric suffix in the registry, not len(registry),
    so ids never get reused after a speaker ages out). If registry is
    already at `cap`, any would-be-minted cluster instead folds into
    whichever existing stable_id it overlaps most (even below
    `min_overlap`) — or is dropped if it has zero overlap with every
    existing id. Clusters under `min_speech` are ignored (no id)."""
    pairs: list[tuple[float, str, str]] = []
    for local_label, local_turns in new_clusters.items():
        for stable_id, stable_turns in registry.items():
            ov = overlap_seconds(local_turns, stable_turns)
            if ov > 0:
                pairs.append((ov, local_label, stable_id))
    # Highest overlap first; stable tie-break by (local_label, stable_id)
    # so results are deterministic regardless of dict iteration order.
    pairs.sort(key=lambda p: (-p[0], p[1], p[2]))

    result: dict[str, str] = {}
    used_stable: set[str] = set()
    for ov, local_label, stable_id in pairs:
        if local_label in result or stable_id in used_stable:
            continue
        if ov < min_overlap:
            continue
        result[local_label] = stable_id
        used_stable.add(stable_id)

    # Highest existing numeric suffix, so minted ids only ever grow —
    # even if the registry's most recent id fell out of `new_clusters`
    # (a speaker who briefly stopped talking).
    next_n = 0
    for stable_id in registry:
        try:
            n = int(stable_id.rsplit("_", 1)[-1])
        except ValueError:
            continue
        next_n = max(next_n, n)

    unmatched = [
        label for label in new_clusters if label not in result
    ]
    for local_label in unmatched:
        total_speech = sum(
            end - start for start, end in new_clusters[local_label]
        )
        if total_speech < min_speech:
            continue  # short blip — no id

        if len(registry) >= cap:
            # At capacity: fold into the highest-overlap existing
            # anchor regardless of threshold (ignore if it overlaps
            # nothing at all — nowhere sensible to fold it).
            best_stable: Optional[str] = None
            best_ov = 0.0
            for stable_id, stable_turns in registry.items():
                ov = overlap_seconds(new_clusters[local_label], stable_turns)
                if ov > best_ov:
                    best_ov = ov
                    best_stable = stable_id
            if best_stable is not None:
                result[local_label] = best_stable
            continue

        next_n += 1
        result[local_label] = f"SPEAKER_{next_n}"

    return result


def speaker_for_turns(
    span: Turn,
    turns: list[tuple[float, float, str]],
) -> Optional[str]:
    """Assign the label with maximum time-overlap against `span`
    ([start, end) seconds). Shared pure core of both diarization
    label-assignment paths:
      - JobManager._speaker_for_segment (upload job path): span is a
        whisper segment's (start, end); turns/labels come straight
        from one pyannote pass, mapped through label_map by the caller.
      - the realtime ws path's segment_log back-assignment: span is a
        segment_log entry's (start, end); turns/labels are already the
        stable ids for the current pass.
    Returns None if there's no positive overlap with anything."""
    span_start, span_end = span
    best_label: Optional[str] = None
    best_overlap = 0.0
    for t_start, t_end, label in turns:
        overlap = min(span_end, t_end) - max(span_start, t_start)
        if overlap > best_overlap:
            best_overlap = overlap
            best_label = label
    return best_label


# =================================================================
# Shared diarization-pipeline singleton — one pyannote Pipeline loaded
# lazily and reused by both the upload-a-recording HTTP job path
# (JobManager) and the realtime ws path (WhisperServer). Loading it is
# slow (model download/init) and it's read-only once loaded, so a
# module-level singleton (rather than one per JobManager/WhisperServer
# instance) avoids loading it twice within the same process.
# =================================================================


class _SharedDiarizePipeline:
    """Lazy, cached, process-wide pyannote Pipeline. See
    `_load_diarize_pipeline` for the token precedence / failure-mode
    contract (unchanged from before this was module-level)."""

    def __init__(self) -> None:
        self._loaded = False
        self._pipeline: Any = None
        self._error: Optional[str] = None
        # Load-time lock: the ws event loop (via to_thread) and HTTP job
        # threads can race first touch. Without it a reader could see
        # _loaded=True mid-load with _pipeline still None and falsely
        # degrade to "unavailable" (which permanently disarms realtime
        # diar for that connection).
        self._load_lock = threading.Lock()

    def get(self, hf_token: Optional[str]) -> tuple[Any, Optional[str]]:
        """Returns (pipeline, error_message); error_message is None on
        success. Loading pyannote can fail in more ways than a plain
        ImportError (missing package) — broken/incompatible transitive
        dependencies (seen in practice: pyarrow version mismatches
        raising AttributeError deep inside the import), model download
        failures, etc. Any failure here degrades to "undiarized" per
        spec — it must never take down transcription (job or realtime).

        The pipeline is loaded (and cached) once, with whichever token
        is available on first load — `hf_token` (a caller-supplied
        override) takes precedence over whatever was passed by whoever
        loads it first. A later caller supplying a *different* token
        won't force a reload; that's an accepted edge case for a
        local, single-user sidecar (mirrors the in-memory-only job
        store tradeoff noted on JobManager).

        S5 review pair Finding 1: the cache is latched ONLY on success —
        a failed load hands (None, error) back to every CURRENT caller
        but leaves the instance retry-eligible, so the NEXT get() call
        attempts the whole load again instead of staying permanently
        "unavailable" process-wide until the sidecar is restarted. This
        is what actually makes two real recoveries possible without a
        restart: a mid-install import against a half-written venv (pip
        install finishes moments later — the very next meeting arms
        cleanly) and an unaccepted-license/bad HF token
        (Pipeline.from_pretrained 403s — once the user accepts the
        license, the next meeting just works). The cost is a repeated
        failing attempt per meeting until then — for the missing-module
        case that's one cheap, fast ModuleNotFoundError, well worth
        paying for the retry."""
        if self._loaded:
            return self._pipeline, self._error
        with self._load_lock:
            if self._loaded:  # double-checked: another thread finished the load
                return self._pipeline, self._error
            try:
                from pyannote.audio import Pipeline  # type: ignore[import-not-found]

                # pyannote 4.x renamed use_auth_token= to token=; support both.
                try:
                    self._pipeline = Pipeline.from_pretrained(
                        "pyannote/speaker-diarization-3.1",
                        token=hf_token,
                    )
                except TypeError:
                    self._pipeline = Pipeline.from_pretrained(
                        "pyannote/speaker-diarization-3.1",
                        use_auth_token=hf_token,
                    )
                self._error = None
                # Set the latch LAST so no reader ever observes loaded-
                # but-empty — and ONLY on this success path (S5 review
                # pair Finding 1): a caller that was blocked on
                # _load_lock behind a FAILING load must not inherit a
                # permanent latch it never asked for.
                self._loaded = True
            except Exception as exc:  # noqa: BLE001 - see docstring
                self._pipeline = None
                self._error = f"{type(exc).__name__}: {exc}"
                # Deliberately NOT latched — see this method's own
                # docstring (S5 review pair Finding 1). The NEXT get()
                # (this connection's next diarization window, or a
                # brand-new meeting) retries the load from scratch;
                # `_load_lock` above still serializes it against any
                # other thread's concurrent attempt exactly as before.
            return self._pipeline, self._error


_shared_diarize_pipeline = _SharedDiarizePipeline()

# pyannote pipelines are not documented thread-safe, and the realtime ws
# path (asyncio.to_thread) and HTTP job threads share the one instance —
# serialize inference. Both are heavy CPU jobs anyway, so queueing them
# costs little beyond what core contention would.
_pipeline_call_lock = threading.Lock()


def _run_diar_pipeline_sync(
    pipeline: Any, window_pcm16: bytes, window_offset: float
) -> list[tuple[float, float, str]]:
    """Blocking work for one realtime diarization pass — run entirely
    inside asyncio.to_thread so it never stalls the event loop (and
    thus never blocks incoming audio / VAD / transcription). `window_
    pcm16` is already 16kHz mono int16 (the connection's own buffer),
    so — unlike the upload-a-recording job path — no ffmpeg re-encode
    is needed; we just wrap it in a WAV header via the `wave` module.

    Returns turns as (start, end, local_label) in ABSOLUTE connection-
    elapsed seconds (window_offset already added), so callers never
    have to remember to re-add it."""
    fd, wav_path = tempfile.mkstemp(suffix=".wav", prefix="jargonslayer-rtdiar-")
    os.close(fd)
    try:
        with wave.open(wav_path, "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(BYTES_PER_SAMPLE)
            writer.setframerate(SAMPLE_RATE)
            writer.writeframes(window_pcm16)

        with _pipeline_call_lock:
            result = pipeline(wav_path)
        # pyannote 4.x returns a DiarizeOutput wrapper whose
        # .speaker_diarization is the Annotation; 3.x returns the
        # Annotation directly. Accept both.
        diarization = getattr(result, "speaker_diarization", result)
        return [
            (turn.start + window_offset, turn.end + window_offset, label)
            for turn, _track, label in diarization.itertracks(yield_label=True)
        ]
    finally:
        try:
            os.remove(wav_path)
        except OSError:
            pass


@dataclass
class SegmentLogEntry:
    """One finalized segment's identity + absolute timing, kept per
    connection so a later realtime diarization pass can back-assign a
    stable speaker label to it by seg_id."""

    seg_id: int
    start: float
    end: float


@dataclass
class FinalizeJob:
    """One finalized-segment transcription job (protocol v2): enqueued
    by _finalize_segment (recv loop, never awaits transcription) and
    consumed strictly in order by the connection's one background
    _consume_finalize_queue task (the only place _transcribe is ever
    called for a final) — see module docstring."""

    audio: np.ndarray
    t0: float
    t1: float
    seg_id: int
    speech_ms: float


@dataclass
class ConnectionState:
    """Per-connection VAD + buffering state, kept fully isolated so
    concurrent/sequential clients never share state."""

    language: str
    connected_at: float = field(default_factory=time.monotonic)
    noise_floor: float = MIN_THRESHOLD / NOISE_FLOOR_MULTIPLIER
    in_speech: bool = False
    speech_buf: list[np.ndarray] = field(default_factory=list)
    speech_started_at: Optional[float] = None  # seconds since connection start
    silence_ms: float = 0.0
    speech_ms: float = 0.0
    last_partial_at: float = 0.0
    leftover: bytes = b""  # undersized tail of a binary frame, held for next frame
    wav_writer: Optional[wave.Wave_write] = None
    # Per-connection override of --partials (protocol v2 item e): None
    # (default) falls back to WhisperServer.emit_partials — the server-
    # wide CLI default; a connection's own config.partials (true/false)
    # wins when present. See WhisperServer._partials_enabled.
    partials_override: Optional[bool] = None
    # v0.4.7 Lane B (glossary -> recognizer bias): set from config.
    # initial_prompt (see WhisperServer._handle_text's "config" branch)
    # and forwarded on every _transcribe() call for this connection —
    # see that method below. None = no bias, the wire's own default.
    initial_prompt: Optional[str] = None

    # ---- protocol v2: per-connection finalize queue + send lock ----
    # Unbounded (maxsize=0) — put() on a finalize job never actually
    # blocks the recv loop; the queue only ever provides backpressure
    # against the CONSUMER falling behind, never against ingestion.
    finalize_queue: "asyncio.Queue[Optional[FinalizeJob]]" = field(
        default_factory=asyncio.Queue
    )
    # Guards every outgoing frame on this connection (_safe_send) — the
    # consumer task, the recv loop's partial trigger, and a realtime-
    # diarization pass can all send concurrently otherwise (see module
    # docstring's "Concurrent sends" section).
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # Single-flight guard for _emit_partial/_run_partial — a partial
    # tick is skipped entirely (never queued up) while a previous one
    # is still transcribing.
    partial_in_flight: bool = False
    # Stop-drain race (codex v2 review finding F1): once "stop" has
    # been accepted, every later binary frame and config/flush message
    # on this connection is ignored (checked at the top of
    # _handle_binary/_handle_text) — PCM the client is still mid-flight
    # sending during its own stop-drain wait (wsTransport.ts's stop())
    # would otherwise enqueue behind the sentinel already put() below
    # and either get silently lost or (worse, against an old client
    # that never learned to stop sending) get transcribed as a bogus
    # post-"stopped" final. Also makes "stop" itself idempotent: a
    # second "stop" must never enqueue a second sentinel (the consumer
    # only ever sends one "stopped" and then returns — see
    # _consume_finalize_queue).
    stop_accepted: bool = False

    # ---- realtime speaker diarization (beta) ----
    diar_armed: bool = False  # config.diarize truthy AND a token is available
    diar_hf_token: Optional[str] = None
    diar_audio_buf: bytearray = field(default_factory=bytearray)  # ALL audio, 16k mono int16
    diar_buf_offset_s: float = 0.0  # seconds trimmed off the front of diar_audio_buf so far
    next_seg_id: int = 0
    segment_log: list[SegmentLogEntry] = field(default_factory=list)
    last_diar_at: float = float("-inf")
    diar_in_flight: bool = False
    # The background task for an in-flight periodic pass (see
    # _maybe_trigger_realtime_diar) — stashed so the post-stop final
    # pass (_finalize_diar_then_close) can await it finishing before
    # running its own, rather than racing it. None whenever no
    # periodic pass is currently in flight.
    diar_task: "Optional[asyncio.Task[None]]" = None
    diar_gen: int = 0  # monotonic counter for outgoing speaker_update.gen
    diar_registry: dict[str, list[tuple[float, float]]] = field(default_factory=dict)
    # seg_id -> last speaker label sent to the client, so speaker_update
    # only includes segments whose label actually changed.
    diar_last_sent: dict[int, str] = field(default_factory=dict)
    diar_status_sent: bool = False  # "unavailable"/"error" is sent at most once
    diar_ready_sent: bool = False  # positive "ready" ack is sent at most once

    def elapsed(self) -> float:
        return time.monotonic() - self.connected_at


def open_wav_writer(path: str) -> wave.Wave_write:
    """Open (or create) a mono 16-bit 16kHz WAV file in append mode."""
    p = Path(path)
    mode = "rb" if p.exists() else None
    if mode:
        # Re-open in append: read existing params, then reopen for append.
        with wave.open(str(p), "rb") as existing:
            params = existing.getparams()
        writer = wave.open(str(p), "wb")
        writer.setparams(params)
        # wave module doesn't support true append; simplest correct
        # approach for a meeting-length file is to overwrite fresh
        # unless the caller wants to keep growing an existing file
        # across restarts, which is out of scope for a single run.
        return writer
    writer = wave.open(str(p), "wb")
    writer.setnchannels(1)
    writer.setsampwidth(BYTES_PER_SAMPLE)
    writer.setframerate(SAMPLE_RATE)
    return writer


class WhisperServer:
    """Wraps the loaded faster-whisper model and per-connection VAD."""

    def __init__(
        self,
        model,
        default_language: str,
        emit_partials: bool,
        save_audio_path: Optional[str],
        default_hf_token: Optional[str] = None,
    ) -> None:
        self.model = model
        self.default_language = default_language
        self.emit_partials = emit_partials
        self.save_audio_path = save_audio_path
        # CLI/env --hf-token — the fallback when a connection's config
        # message doesn't carry its own hf_token (mirrors JobManager's
        # hf_token fallback for the upload-a-recording path).
        self.default_hf_token = default_hf_token

    async def handle(self, ws: WebSocketServerProtocol) -> None:
        # S13 hotfix (--lazy-load only; isinstance-gated exactly like
        # JobManager's own pre-existing ParakeetMlxBackend checks
        # elsewhere in this file — see LazyWhisperModel's own module-
        # section docstring): a live ws connection counts as ONE unit
        # of "active work" for as long as it stays open. A no-op, free
        # isinstance check when self.model is the raw faster-whisper
        # model (the --lazy-load-absent, eager path) — this whole
        # method is otherwise byte-identical to before this hotfix.
        # Wrapped in its OWN outer try/finally (rather than folded into
        # the existing one below) so acquire()/release() stay correctly
        # paired even if something before the existing try block itself
        # raises (e.g. open_wav_writer) — see LazyWhisperModel.acquire's
        # own docstring for why it's safe to call unconditionally here.
        lazy_model = self.model if isinstance(self.model, LazyWhisperModel) else None
        try:
            if lazy_model is not None:
                # acquire() can block on the model's FIRST-ever load (a
                # few seconds) — routed through asyncio.to_thread so
                # that blocking never stalls THIS event loop (and thus
                # every OTHER connection's own audio/VAD) while it
                # happens.
                await asyncio.to_thread(lazy_model.acquire)

            state = ConnectionState(language=self.default_language)
            if self.save_audio_path:
                state.wav_writer = open_wav_writer(self.save_audio_path)

            # Protocol v2: one background consumer per connection owns every
            # call to _transcribe for finalized segments — see module
            # docstring's "Finalize scheduling" section.
            consumer_task = asyncio.create_task(self._consume_finalize_queue(ws, state))

            try:
                async for message in ws:
                    if isinstance(message, (bytes, bytearray)):
                        await self._handle_binary(ws, state, bytes(message))
                    else:
                        await self._handle_text(ws, state, message)
            except ConnectionClosed:
                pass
            finally:
                # Flush any in-progress speech before the client goes away
                # (a connection that closes WITHOUT ever sending {"type":
                # "stop"} — e.g. a crashed tab — gets no "stopped" ack, and
                # none is expected), then cancel the consumer cleanly.
                await self._finalize_segment(ws, state, force=True)
                consumer_task.cancel()
                try:
                    await consumer_task
                except asyncio.CancelledError:
                    pass
                if state.wav_writer is not None:
                    state.wav_writer.close()
        finally:
            # release() is cheap (lock + counter + maybe arming a
            # threading.Timer) — no to_thread needed, unlike acquire()
            # above.
            if lazy_model is not None:
                lazy_model.release()

    async def _handle_text(
        self, ws: WebSocketServerProtocol, state: ConnectionState, raw: str
    ) -> None:
        # See ConnectionState.stop_accepted's own doc — a stopped
        # connection ignores every later text message, "stop" included
        # (idempotent: no second sentinel).
        if state.stop_accepted:
            return
        try:
            msg = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return

        msg_type = msg.get("type")
        if msg_type == "config":
            language = msg.get("language")
            if isinstance(language, str) and language:
                state.language = language

            # Per-connection --partials override (protocol v2 item e):
            # absent (no "partials" key, or a non-bool value) leaves
            # partials_override at None, which _partials_enabled falls
            # back to the server-wide default for — today's behavior
            # for any client that never sends the field.
            partials = msg.get("partials")
            if isinstance(partials, bool):
                state.partials_override = partials

            # v0.4.7 Lane B (glossary -> recognizer bias): mirrors
            # language's own isinstance+truthy gate above — an absent
            # key or an empty string leaves a PRIOR value untouched
            # (same "no key = no change" contract partials_override
            # itself does NOT have, but language does; initial_prompt
            # follows language's stricter gate since an empty string is
            # never a meaningful override to send).
            initial_prompt = msg.get("initial_prompt")
            if isinstance(initial_prompt, str) and initial_prompt:
                state.initial_prompt = initial_prompt

            # Realtime speaker diarization (beta) gate: only arms when
            # the client asked for it AND a token is available (config's
            # own hf_token, or this process's --hf-token/$HF_TOKEN
            # default). Per spec, arming itself never fails loudly here
            # — if pyannote turns out to be unavailable, the first
            # background pass reports that once via diar_status.
            diarize = msg.get("diarize")
            hf_token = msg.get("hf_token")
            token = hf_token if isinstance(hf_token, str) and hf_token else self.default_hf_token
            if diarize and token:
                state.diar_armed = True
                state.diar_hf_token = token
        elif msg_type == "stop":
            # Force-finalize enqueues the tail job (if any); the sentinel
            # (None) is what makes the consumer send {"type":"stopped"}
            # once every job ahead of it — including that tail one — has
            # actually been sent. See module docstring.
            state.stop_accepted = True
            await self._finalize_segment(ws, state, force=True)
            await state.finalize_queue.put(None)
        elif msg_type == "flush":
            # Pause support (protocol v2 item d): force-finalize WITHOUT
            # closing anything and WITHOUT an ack — the connection keeps
            # living; a paused client just stops sending audio frames.
            await self._finalize_segment(ws, state, force=True)

    async def _handle_binary(
        self, ws: WebSocketServerProtocol, state: ConnectionState, data: bytes
    ) -> None:
        # See ConnectionState.stop_accepted's own doc.
        if state.stop_accepted:
            return
        if state.wav_writer is not None:
            state.wav_writer.writeframes(data)

        if state.diar_armed:
            # ALL audio (not just VAD-detected speech) — pyannote needs
            # the full stream, silence included, to place turn
            # boundaries correctly. Trimmed to a rolling window inside
            # run_realtime_diar; here we only append.
            state.diar_audio_buf.extend(data)

        buf = state.leftover + data
        usable_len = (len(buf) // (FRAME_SAMPLES * BYTES_PER_SAMPLE)) * (
            FRAME_SAMPLES * BYTES_PER_SAMPLE
        )
        state.leftover = buf[usable_len:]
        if usable_len == 0:
            return

        pcm16 = np.frombuffer(buf[:usable_len], dtype=np.int16)
        samples = pcm16.astype(np.float32) / 32768.0
        frames = samples.reshape(-1, FRAME_SAMPLES)

        frame_ms = (FRAME_SAMPLES / SAMPLE_RATE) * 1000.0

        for frame in frames:
            level = rms(frame)
            threshold = max(MIN_THRESHOLD, NOISE_FLOOR_MULTIPLIER * state.noise_floor)
            is_speech_frame = level > threshold

            if is_speech_frame:
                if not state.in_speech:
                    state.in_speech = True
                    state.speech_started_at = state.elapsed()
                    state.speech_buf = []
                    state.speech_ms = 0.0
                state.speech_buf.append(frame)
                state.speech_ms += frame_ms
                state.silence_ms = 0.0

                if (
                    self._partials_enabled(state)
                    and state.elapsed() - state.last_partial_at >= PARTIAL_INTERVAL_S
                ):
                    self._emit_partial(ws, state)
                    state.last_partial_at = state.elapsed()

                if state.speech_ms >= MAX_SEGMENT_MS:
                    await self._finalize_segment(ws, state, force=True)
            else:
                # Noise floor adapts only during non-speech, per
                # standard energy-VAD practice — otherwise loud speech
                # would drag the floor (and thus the threshold) up.
                state.noise_floor = (
                    NOISE_EMA_ALPHA * level + (1 - NOISE_EMA_ALPHA) * state.noise_floor
                )

                if state.in_speech:
                    state.silence_ms += frame_ms
                    state.speech_buf.append(frame)
                    state.speech_ms += frame_ms
                    if state.silence_ms >= SILENCE_HANG_MS:
                        await self._finalize_segment(ws, state, force=False)

    def _partials_enabled(self, state: ConnectionState) -> bool:
        """Effective partials setting for this connection (protocol v2
        item e): its own config.partials override if it sent one, else
        this process's --partials/emit_partials default."""
        return self.emit_partials if state.partials_override is None else state.partials_override

    def _emit_partial(self, ws: WebSocketServerProtocol, state: ConnectionState) -> None:
        """Trigger one partial transcription pass — called from the
        recv loop, which must never itself await transcription (see
        module docstring). Skips the tick entirely (never queues up a
        backlog) when a partial is already in flight OR the finalize
        queue is non-empty — finals always get CPU priority over a
        partial preview."""
        if not state.speech_buf:
            return
        if state.partial_in_flight or not state.finalize_queue.empty():
            return
        state.partial_in_flight = True
        asyncio.create_task(self._run_partial(ws, state))

    async def _run_partial(self, ws: WebSocketServerProtocol, state: ConnectionState) -> None:
        """Background task body for one partial pass (see
        _emit_partial). Tail-window only (PARTIAL_TAIL_WINDOW_S):
        transcribing the ENTIRE growing speech_buf every tick is what
        let a long continuous-speech segment's partial cost outgrow
        PARTIAL_INTERVAL_S and starve the recv loop — the tail window
        keeps each partial's cost roughly constant regardless of how
        long the current segment has been running."""
        try:
            if not state.speech_buf:
                return  # finalized between task creation and this task running
            audio = np.concatenate(state.speech_buf)
            tail_samples = int(PARTIAL_TAIL_WINDOW_S * SAMPLE_RATE)
            if audio.shape[0] > tail_samples:
                audio = audio[-tail_samples:]
            try:
                t0 = time.monotonic()
                text = await asyncio.to_thread(self._transcribe, audio, state.language, state.initial_prompt)
                lag_ms = round((time.monotonic() - t0) * 1000)
            except Exception as exc:  # noqa: BLE001 - a partial preview is best-effort;
                # never worth tearing down the connection over.
                print(f"[whisper_server] partial transcription failed: {exc}")
                return
            if text:
                await self._safe_send(
                    ws, state, {"type": "partial", "text": text, "lag_ms": lag_ms}
                )
        finally:
            state.partial_in_flight = False

    async def _finalize_segment(
        self, ws: WebSocketServerProtocol, state: ConnectionState, force: bool
    ) -> None:
        """Protocol v2: enqueue-only — never calls _transcribe itself
        (see _consume_finalize_queue, the only caller). Safe to call
        from the recv loop without stalling it: `put()` on the
        connection's unbounded finalize_queue never blocks."""
        if not state.in_speech or not state.speech_buf:
            if force:
                state.in_speech = False
                state.speech_buf = []
                state.silence_ms = 0.0
                state.speech_ms = 0.0
            return

        t0 = state.speech_started_at if state.speech_started_at is not None else state.elapsed()
        t1 = state.elapsed()
        speech_ms = state.speech_ms

        audio = np.concatenate(state.speech_buf)

        # Reset VAD state before enqueuing so incoming frames are never
        # dropped/misattributed while the (now background, but still
        # good practice to reset promptly) transcription eventually runs.
        state.in_speech = False
        state.speech_buf = []
        state.silence_ms = 0.0
        state.speech_ms = 0.0
        state.speech_started_at = None

        if speech_ms < MIN_SPEECH_MS:
            return  # too short — likely a blip, discard; no seg_id consumed

        # seg_id assigned HERE, at enqueue time — monotonic per
        # connection regardless of whether this job's eventual
        # transcription comes back empty (a gap is fine; see module
        # docstring — diarization maps purely by seg_id, and the
        # queue's FIFO order is what keeps `final` send order correct,
        # not the seg_id values themselves).
        seg_id = state.next_seg_id
        state.next_seg_id += 1
        await state.finalize_queue.put(
            FinalizeJob(audio=audio, t0=t0, t1=t1, seg_id=seg_id, speech_ms=speech_ms)
        )

    async def _consume_finalize_queue(
        self, ws: WebSocketServerProtocol, state: ConnectionState
    ) -> None:
        """The ONLY coroutine that ever calls _transcribe for a
        finalized segment — one per connection, started by handle() and
        cancelled in its finally block. Processes FinalizeJob entries
        strictly in enqueue (FIFO) order, so `final` send order always
        matches seg_id order. A `None` entry is the stop-drain sentinel
        (see _handle_text's "stop" branch): reaching it sends
        {"type": "stopped"}, runs the post-stop diarization final pass
        if applicable and closes the connection (see
        _finalize_diar_then_close), then ends the loop — a connection
        that never sends "stop" simply gets cancelled instead, with no
        ack, which is correct (none was promised). Calls task_done()
        for every get() (real job or sentinel alike) — standard Queue
        hygiene, and what lets a caller `await state.finalize_queue.
        join()` to deterministically wait for full drainage (used by
        this file's own tests; a flush has no ack to await otherwise)."""
        while True:
            job = await state.finalize_queue.get()
            if job is None:
                await self._safe_send(ws, state, {"type": "stopped"})
                state.finalize_queue.task_done()
                await self._finalize_diar_then_close(ws, state)
                return
            try:
                t0 = time.monotonic()
                text = await asyncio.to_thread(self._transcribe, job.audio, state.language, state.initial_prompt)
                lag_ms = round((time.monotonic() - t0) * 1000)
            except Exception as exc:  # noqa: BLE001 - one bad segment must never
                # permanently stop every later final on this connection —
                # the whole point of decoupling this consumer from the
                # recv loop is long-meeting robustness (see module
                # docstring). Logged, not surfaced to the client.
                print(f"[whisper_server] transcription failed for seg_id={job.seg_id}: {exc}")
                state.finalize_queue.task_done()
                continue
            if not text:
                state.finalize_queue.task_done()
                continue
            state.segment_log.append(
                SegmentLogEntry(seg_id=job.seg_id, start=job.t0, end=job.t1)
            )
            await self._safe_send(
                ws,
                state,
                {
                    "type": "final",
                    "text": text,
                    "start": job.t0,
                    "end": job.t1,
                    "seg_id": job.seg_id,
                    "lag_ms": lag_ms,
                },
            )
            self._maybe_trigger_realtime_diar(ws, state)
            state.finalize_queue.task_done()

    def _maybe_trigger_realtime_diar(
        self, ws: WebSocketServerProtocol, state: ConnectionState
    ) -> None:
        """After emitting a `final`: if realtime diarization is armed,
        the interval has elapsed, and no pass is already in flight for
        this connection, kick off a background pass. Single-flight per
        connection via `diar_in_flight` — never overlaps a running pass
        with a new one. Fire-and-forget: the task manages its own
        completion/error reporting (see run_realtime_diar). The task is
        stashed on `state.diar_task` so a post-stop final pass
        (_finalize_diar_then_close) can await this one finishing first
        instead of racing it."""
        if not state.diar_armed or state.diar_in_flight:
            return
        if state.elapsed() - state.last_diar_at < DIAR_INTERVAL_S:
            return
        state.diar_in_flight = True
        state.diar_task = asyncio.create_task(self.run_realtime_diar(ws, state))

    async def _finalize_diar_then_close(
        self, ws: WebSocketServerProtocol, state: ConnectionState
    ) -> None:
        """Post-stop diarization linger (server side): called exactly
        once, right after the drain-ack ("stopped") for a "stop" has
        been sent (see _consume_finalize_queue). If realtime
        diarization is armed and has ever buffered any audio, run ONE
        final pass over the current rolling window before closing —
        calling run_realtime_diar directly (never through
        _maybe_trigger_realtime_diar) bypasses DIAR_INTERVAL_S's normal
        spacing gate entirely, since that gate only lives in the
        trigger function, not in run_realtime_diar itself. If a
        periodic pass is already in flight when "stopped" is reached,
        its window covers strictly LESS audio than what's buffered by
        now (it started earlier), so it's awaited first and this final
        pass still runs afterward on top of it, rather than reusing its
        (incomplete) result. Either way the connection is then closed
        server-side — see module docstring's "stop" bullet; the
        client's own post-stop linger (wsTransport.ts's
        POST_STOP_LINGER_MS) exists mainly as a fallback for this close
        never arriving. Not armed, or armed but nothing was ever
        buffered: close right away, no pass, no diar_status."""
        if state.diar_armed and state.diar_audio_buf:
            if state.diar_in_flight and state.diar_task is not None:
                await state.diar_task
            state.diar_in_flight = True
            await self.run_realtime_diar(ws, state)
        await ws.close()

    async def run_realtime_diar(
        self, ws: WebSocketServerProtocol, state: ConnectionState
    ) -> None:
        """One realtime diarization (beta) pass: snapshot the trailing
        audio window, run the shared pyannote pipeline on it in a
        worker thread (never blocking the audio/VAD path), turn-overlap
        match its clusters against the connection's speaker registry,
        back-assign segment_log entries, and send a `speaker_update`
        with only the segments whose label changed. Single-flight per
        connection when triggered periodically (see
        _maybe_trigger_realtime_diar, which never overlaps a running
        pass with a new one via `diar_in_flight`); also called once
        more directly (bypassing DIAR_INTERVAL_S) by the post-stop
        final pass, see _finalize_diar_then_close. On any exception
        sends `diar_status` (state=error) once and backs off 60s —
        never crashes the connection or affects transcription."""
        state.last_diar_at = state.elapsed()
        try:
            pipeline, load_error = _shared_diarize_pipeline.get(state.diar_hf_token)
            if pipeline is None:
                state.diar_armed = False  # stop retrying every interval
                if not state.diar_status_sent:
                    state.diar_status_sent = True
                    await self._safe_send(
                        ws,
                        state,
                        {
                            "type": "diar_status",
                            "state": "unavailable",
                            "detail": load_error or "pyannote unavailable",
                        },
                    )
                return

            # Positive ack (protocol v2 item f): the pipeline is
            # confirmed loaded — diarize + token + pyannote-importable
            # all held — so tell the client arming actually succeeded,
            # once per connection. Fires HERE (not at config time)
            # because pyannote importability is only ever established
            # by actually loading it, which happens lazily on this
            # first background pass — see module docstring.
            if not state.diar_ready_sent:
                state.diar_ready_sent = True
                await self._safe_send(ws, state, {"type": "diar_status", "state": "ready"})

            # Snapshot + trim the rolling window under the connection's
            # own async context (no lock needed — this coroutine and
            # _handle_binary both run on the single event-loop thread;
            # only the pipeline() call itself moves to a worker thread).
            window_bytes, window_offset = self._snapshot_diar_window(state)
            if len(window_bytes) < BYTES_PER_SAMPLE:
                return  # nothing to diarize yet

            turns = await asyncio.to_thread(
                _run_diar_pipeline_sync, pipeline, window_bytes, window_offset
            )

            new_clusters: dict[str, list[Turn]] = {}
            for start, end, local_label in turns:
                new_clusters.setdefault(local_label, []).append((start, end))

            local_to_stable = match_clusters(new_clusters, state.diar_registry)

            # Replace matched/minted stable ids' registry turns with
            # this pass's turns; ids absent from this pass keep their
            # old turns until they age out of every future window.
            for local_label, stable_id in local_to_stable.items():
                state.diar_registry[stable_id] = list(new_clusters[local_label])

            stable_turns = [
                (start, end, local_to_stable[local_label])
                for start, end, local_label in turns
                if local_label in local_to_stable
            ]

            # Prune entries that have aged out of every future window —
            # their labels are final and they'd only be skipped forever.
            # Safe here: this coroutine and _finalize_segment (the only
            # appender) both run on the single event-loop thread.
            if window_offset > 0:
                aged = [e.seg_id for e in state.segment_log if e.end < window_offset]
                if aged:
                    state.segment_log = [
                        e for e in state.segment_log if e.end >= window_offset
                    ]
                    for seg_id in aged:
                        state.diar_last_sent.pop(seg_id, None)

            assignments: list[dict[str, Any]] = []
            for entry in state.segment_log:
                if entry.end < window_offset:
                    continue  # entirely before this window — unaffected
                label = speaker_for_turns((entry.start, entry.end), stable_turns)
                if label is None:
                    continue
                if state.diar_last_sent.get(entry.seg_id) == label:
                    continue  # unchanged — omit per spec
                state.diar_last_sent[entry.seg_id] = label
                assignments.append({"seg_id": entry.seg_id, "speaker": label})

            if assignments:
                state.diar_gen += 1
                await self._safe_send(
                    ws,
                    state,
                    {
                        "type": "speaker_update",
                        "gen": state.diar_gen,
                        "assignments": assignments,
                        "speakers": list(state.diar_registry.keys()),
                    },
                )
        except Exception as exc:  # noqa: BLE001 - realtime diar is best-effort
            state.diar_armed = False  # stop retrying immediately; see backoff below
            if not state.diar_status_sent:
                state.diar_status_sent = True
                await self._safe_send(
                    ws,
                    state,
                    {
                        "type": "diar_status",
                        "state": "error",
                        "detail": str(exc)[:200],
                    },
                )
            # Re-arm after a cooldown rather than permanently — a
            # transient failure (e.g. one bad window) shouldn't
            # permanently disable diarization for the rest of a long
            # meeting. diar_status is still sent at most once (above).
            asyncio.get_event_loop().call_later(
                DIAR_ERROR_BACKOFF_S, self._rearm_after_backoff, state
            )
        finally:
            state.diar_in_flight = False

    @staticmethod
    def _rearm_after_backoff(state: ConnectionState) -> None:
        state.diar_armed = True

    @staticmethod
    def _snapshot_diar_window(state: ConnectionState) -> tuple[bytes, float]:
        """Trim `diar_audio_buf` to at most DIAR_WINDOW_S from the
        front (advancing `diar_buf_offset_s` accordingly) and return a
        snapshot of the (now-bounded) buffer plus its window_offset —
        the absolute connection-elapsed seconds its first sample
        corresponds to, so turns decoded from this window can be
        mapped back to absolute time by adding window_offset."""
        bytes_per_second = SAMPLE_RATE * BYTES_PER_SAMPLE
        max_bytes = int(DIAR_WINDOW_S * bytes_per_second)
        buf = state.diar_audio_buf
        if len(buf) > max_bytes:
            trim = len(buf) - max_bytes
            # Keep trims sample-aligned (int16 = 2 bytes/sample) so we
            # never split a sample across the cut.
            trim -= trim % BYTES_PER_SAMPLE
            if trim > 0:
                del buf[:trim]
                state.diar_buf_offset_s += trim / bytes_per_second
        return bytes(buf), state.diar_buf_offset_s

    def _transcribe(
        self, audio: np.ndarray, language: str, initial_prompt: Optional[str] = None
    ) -> str:
        segments, _info = self.model.transcribe(
            audio,
            language=language,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
            # v0.4.7 Lane B: faster-whisper's own get_prompt() keeps
            # only the LAST (self.max_length // 2 - 1) tokens of this
            # string — verified against the installed faster-whisper
            # source (self.max_length == 448, so the real ceiling is
            # 223 tokens) — the CLIENT is what orders the string so its
            # highest-priority terms survive that truncation (see
            # apps/web/src/lib/stt/lexicon.ts's projectForInitialPrompt).
            initial_prompt=initial_prompt,
        )
        return " ".join(seg.text.strip() for seg in segments).strip()

    @staticmethod
    async def _safe_send(
        ws: WebSocketServerProtocol, state: ConnectionState, payload: dict
    ) -> None:
        """Send one JSON frame, serialized against every other sender on
        this SAME connection (the consumer task, the recv loop's partial
        trigger, and a realtime-diarization pass can all reach this) —
        `websockets` documents concurrent send()/recv() on one
        connection as raising ConcurrencyError; reads and writes may
        overlap each other, but writes must be serialized against
        writes. See module docstring's "Concurrent sends" section."""
        try:
            async with state.send_lock:
                await ws.send(json.dumps(payload))
        except ConnectionClosed:
            pass


# =================================================================
# S12b: parakeet-mlx backend (docs/design-explorations/s12-mlx-
# blueprint.md §C R2/R3/R4 + §E L5 — L5's live-probe outcome (M1)
# SUPERSEDES §C R2's stream-commit-primary design; this implements the
# L5 batch-final + streaming-partials HYBRID, not the R2 original).
# Active only when backend_for_model(model) == "parakeet-mlx" (see
# that pure function, defined alongside PARAKEET_MODEL further down
# this file, in the model-registry section) — main() picks ONE backend
# at process startup (a sidecar process loads exactly one model for
# its whole lifetime) and constructs either (WhisperServer, JobManager
# (raw faster-whisper model)) — byte-unchanged, see above — or
# (ParakeetMlxServer, JobManager(ParakeetMlxBackend)) below. Wire
# shapes (partial/final/stopped/lag_ms) are BYTE-UNCHANGED from
# WhisperServer's own; `parakeet-busy` is the one new event type (see
# ParakeetMlxServer.handle).
#
# `parakeet_mlx`/`mlx.core` are lazily imported inside every method
# that actually needs them — this file's OWN top-level imports must
# stay satisfiable under EITHER venv (the shared base venv OR the
# separate, hash-locked mlx venv, §C R1): neither faster_whisper NOR
# parakeet_mlx/mlx may ever be imported at module scope.
# =================================================================

PARAKEET_CONTEXT_SIZE = (256, 256)  # §C R2 pinned (upstream-validated defaults)
PARAKEET_DEPTH = 1


class ParakeetMlxBackend:
    """Owns the loaded parakeet-mlx model + every actual call into it
    (API usage verified live against a real parakeet-mlx==0.5.2
    install + real audio — see jargonslayer-worktrees/s12b-spike-
    assets/P1-P6_*.py and their .out.txt evidence). L5 hybrid: the
    streaming context (open_streaming_context/add_audio) exists ONLY
    to produce live partials; every wire final instead comes from ONE
    batch inference per boundary (batch_final) over the scheduler's
    own exact, non-overlapping PCM range — so finals are batch-quality
    by construction and the MAX_SEGMENT overlap-dedup machinery §C R2
    specced is out of scope (deleted, L5).

    `_workload_lock` (S12b fix round FB4, HIGH — Sol4=Opus3; supersedes
    the original L2/F4 plain-bool design): ONE shared parakeet workload
    reservation, mutually exclusive between (a) a live ws session
    (ParakeetMlxServer.handle, try_acquire_stream/release_stream held
    for the WHOLE connection's lifetime) and (b) an admitted parakeet
    file/URL job (JobManager.start_job/start_url_job, reserved at
    admission — before any job/background thread is even created, so
    no TOCTOU against a racing ws connection or another job — released
    in the job's own outermost finally, holding through diarization/
    the yt-dlp download phase too). A plain bool (the original design)
    was only ever safe because every toucher ran on the ONE asyncio
    event-loop thread; job admission runs on the HTTP server's own
    thread pool + the job's own background thread, so this is now a
    real threading.Lock, acquired non-blocking (acquire(blocking=
    False) — never blocks the asyncio loop or an HTTP handler thread)
    by whichever caller reaches it first. This is ALSO what closes the
    concurrent-batch-call-under-local-attention gap the original G1-era
    docstring here flagged as unsolved: a live session and a parakeet
    file/URL job can now never run at the same time at all (one always
    blocks the other), so a batch call can never interleave with an
    open streaming context's local-attention window anymore.

    `_executor` (G1 LIVE-GATE FINDING, not surfaced by P1-P6's single-
    threaded probing): a persistent, single-worker (max_workers=1)
    ThreadPoolExecutor that BOTH loads the model AND runs every later
    call into it (add_audio/generate/transcribe). Reproduced live
    2026-07-16: an mlx-0.32.0 model's weight arrays are bound to the
    stream registry of whichever OS thread constructed them via
    from_pretrained() — invoking add_audio/generate from ANY other
    thread (including a plain asyncio.to_thread call, whose default
    pool executor does not guarantee the SAME thread runs a later
    call) raises `RuntimeError: There is no Stream(cpu, N) in current
    thread` on the very first cross-thread call, deterministically.
    Root-caused via jargonslayer-worktrees/s12b-spike-assets/gates/
    (see G1's own run log): loading AND calling the model on the exact
    same persistent thread fixes it completely. Every ws-worker call
    below is therefore async and routes through loop.run_in_executor
    (self._executor, ...); JobManager's transcribe_file (its OWN plain
    background thread, no event loop) blocks on executor.submit(...).
    result() instead — same pattern as load(). This ALSO subsumes the
    "serialize concurrent model access" role a separate lock would
    otherwise need to play: max_workers=1 already guarantees at most
    one call runs at a time, in FIFO submission order, on one thread.
    """

    kind = "parakeet-mlx"

    def __init__(self, model_name: str) -> None:
        self.model_name = model_name
        self.model: Any = None
        self._workload_lock = threading.Lock()
        self._executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="parakeet-mlx"
        )

    def load(self) -> float:
        """Loads the model ON the dedicated executor thread (see class
        docstring's `_executor` note — loading anywhere else binds the
        model's weights to the WRONG thread for every later call) via
        from_pretrained(repo, cache_dir=None) — NEVER pass cache_dir
        explicitly (§C R1/F10; see test_model_registry.py's cache-
        root-invariant section): HF_HOME (set by the Rust launcher,
        S12a) already anchors both a predownload and this load to the
        same derived HF_HUB_CACHE root — an explicit cache_dir here
        would diverge from that and re-trigger a full download. Blocks
        the caller (main(), before the server starts accepting
        connections) until loaded; returns the load wall-time in
        seconds (mirrors this file's own load_model(), used for the
        faster-whisper path)."""
        return self._executor.submit(self._load_sync).result()

    def _load_sync(self) -> float:
        from parakeet_mlx import from_pretrained

        start = time.monotonic()
        self.model = from_pretrained(PARAKEET_REPO_ID)
        return time.monotonic() - start

    def try_acquire_stream(self) -> bool:
        """L2/F4 + FB4: True iff the ONE shared parakeet workload slot
        (§ class docstring's `_workload_lock`) is currently free (and
        this call claims it); False otherwise. Called by BOTH
        ParakeetMlxServer.handle (a live ws session — must reject the
        connection with a typed `parakeet-busy` event and a clean
        close WITHOUT ever touching VAD state or starting a worker
        task on False) and JobManager.start_job/start_url_job (file/
        URL job admission — must return None and let the caller 409
        with parakeet_busy_response() on False)."""
        return self._workload_lock.acquire(blocking=False)

    def release_stream(self) -> None:
        """Idempotent by design (mirrors the original plain-bool's own
        tolerance) — releasing an already-released slot is a silent
        no-op rather than threading.Lock's own RuntimeError, since
        every caller (handle()'s outer finally, FB5; _run_job/
        _run_url_job's outer finally, FB4) must be able to call this
        unconditionally on every exit path without first having to
        prove it actually holds the lock."""
        try:
            self._workload_lock.release()
        except RuntimeError:
            pass

    async def open_streaming_context(self):
        """Opens (and __enter__s) one streaming context on the
        dedicated executor thread — L5: fresh context per utterance,
        reset at every boundary (see close_streaming_context) — no
        overlap re-seed; naive MAX_SEGMENT reset+re-seed was probed
        (P3) to duplicate words at the seam, mooted entirely by L5's
        batch-final-per-boundary invariant, which never reads the
        streaming context for final text at all."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self._open_streaming_context_sync)

    def _open_streaming_context_sync(self):
        ctx = self.model.transcribe_stream(
            context_size=PARAKEET_CONTEXT_SIZE, depth=PARAKEET_DEPTH
        )
        ctx.__enter__()
        return ctx

    async def close_streaming_context(self, ctx) -> None:
        """__exit__s a context opened by open_streaming_context — same
        thread-affinity requirement (class docstring), so this too
        routes through the dedicated executor rather than calling
        ctx.__exit__ directly on the caller's own thread."""
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(self._executor, self._close_streaming_context_sync, ctx)

    @staticmethod
    def _close_streaming_context_sync(ctx) -> None:
        ctx.__exit__(None, None, None)

    async def add_audio(self, ctx, chunk: np.ndarray) -> None:
        """Feed one chunk (float32 mono 16k) into `ctx`, on the
        dedicated executor thread (class docstring's `_executor`
        note) — P1-verified add_audio is itself a plain synchronous/
        blocking call (the MLX forward pass runs on the calling
        thread, no internal thread handoff)."""
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(self._executor, self._add_audio_sync, ctx, chunk)

    @staticmethod
    def _add_audio_sync(ctx, chunk: np.ndarray) -> None:
        from mlx.core import array as mx_array

        ctx.add_audio(mx_array(chunk))

    async def batch_final(self, pcm: np.ndarray) -> str:
        """ONE batch inference over `pcm` (float32 mono 16k), on the
        dedicated executor thread, via the verified ffmpeg-free array
        bypass (P4_batch_array_input.py, s12b-spike-assets/):
        get_logmel(mx.array(pcm), preprocessor_config) + model.
        generate(mel)[0] — byte-identical text to the file path
        (model.transcribe(path)) in that probe, no temp file, no
        ffmpeg shell-out."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self._batch_final_sync, pcm)

    def _batch_final_sync(self, pcm: np.ndarray) -> str:
        from mlx.core import array as mx_array
        from parakeet_mlx.audio import get_logmel

        mel = get_logmel(mx_array(pcm), self.model.preprocessor_config)
        result = self.model.generate(mel)[0]
        return result.text.strip()

    def transcribe_file(self, file_path: str, language: str) -> tuple[list[dict], float]:
        """JobManager's normalized file-job path (§C R4). Synchronous
        — called from JobManager's OWN plain background thread
        (threading.Thread, no event loop; see _run_job/_run_url_job),
        so this blocks that thread on the dedicated executor via
        .result(), same pattern as load() (class docstring's
        `_executor` note — the model must run on the thread that
        loaded it). Parakeet's OWN batch API (model.transcribe(path))
        is path-only and shells out to system ffmpeg
        (P4_batch_array_input.py, verified live) — the SAME ffmpeg
        precondition faster-whisper's upload path already implicitly
        relies on for its own audio decoding, just never explicitly
        preflighted there; this reuses the EXACT "未检测到 ffmpeg"
        error copy/check idiom this file already established for the
        yt-dlp/ingest-url path (see JobManager._download_via_ytdlp)
        rather than inventing new copy for a new risk category.
        `language` is accepted for interface parity with the faster-
        whisper file-job shape but UNUSED — parakeet-tdt-0.6b-v3's
        transcribe() takes no language kwarg (P4-verified signature);
        it is multilingual and auto-detects. Maps AlignedSentence{
        text,start,end} -> the existing job segment shape {"start",
        "end","text"} (identical to faster-whisper's own segment
        dicts, see JobManager._transcribe_job), so downstream
        diarization (_diarize_job/_speaker_for_segment) works
        unchanged regardless of which backend produced them."""
        if shutil.which("ffmpeg") is None:
            raise RuntimeError("未检测到 ffmpeg，请先安装（brew install ffmpeg）")
        return self._executor.submit(self._transcribe_file_sync, file_path).result()

    def _transcribe_file_sync(self, file_path: str) -> tuple[list[dict], float]:
        result = self.model.transcribe(file_path)
        segments = [
            {"start": s.start, "end": s.end, "text": s.text.strip()}
            for s in result.sentences
        ]
        duration = result.sentences[-1].end if result.sentences else 0.0
        return segments, duration


@dataclass
class _ParakeetAudio:
    """One command: feed `frame` (float32 mono 16k, the concatenated
    speech samples accumulated during one _handle_binary call) into the
    connection's currently-open streaming context — for LIVE PARTIALS
    ONLY (L5); never used to produce a final."""

    frame: np.ndarray


@dataclass
class _ParakeetBoundary:
    """One command: a closed utterance's full buffered PCM (float32
    mono 16k, `state.speech_buf` concatenated) plus the scheduler's own
    VAD t0/t1/seg_id — committed via ONE batch inference (L5's batch-
    final invariant), emitted as exactly one wire `final`, after which
    the streaming context is reset (ParakeetMlxServer._worker)."""

    audio: np.ndarray
    t0: float
    t1: float
    seg_id: int
    # time.monotonic() at PUT time (§C R3/F6): lag_ms for parakeet is
    # boundary-enqueue -> final-send wall time, NOT the batch call's
    # own time alone (contrast WhisperServer's faster-whisper lag_ms,
    # deliberately left unredefined — see that class's own docstring).
    enqueued_at: float


class _ParakeetContextReset:
    """One command (S12b fix round FB9, LOW — Opus4): close/reset the
    currently-open streaming context, if any, WITHOUT running
    batch_final or emitting a final. Enqueued by _finalize_boundary
    when a forced boundary is discarded for being under MIN_SPEECH_MS
    — a sub-MIN_SPEECH_MS blip can still have opened the context (if
    partials were enabled and its Audio command(s) already reached the
    worker) even though its own Boundary command is never enqueued;
    without this, that still-open, blip-contaminated context would be
    silently REUSED (not reset) for the next utterance's live
    partials. A dedicated command rather than piggy-backing on
    _ParakeetBoundary(audio=None, ...) — keeps every Boundary command
    a genuine, non-optional batch_final candidate, and keeps this
    queue's isinstance dispatch exhaustive/self-documenting."""


class _ParakeetStopSentinel:
    """Drain sentinel for ParakeetMlxServer's command queue — mirrors
    the FinalizeJob queue's `None` sentinel (see WhisperServer._
    consume_finalize_queue). A dedicated (empty) class rather than
    reusing `None` itself, since this queue's other two members are
    already typed dataclasses and a bare `None` would read ambiguously
    next to them."""


_PARAKEET_STOP = _ParakeetStopSentinel()


class ParakeetMlxServer:
    """S12b L5 hybrid: the parakeet-mlx analog of WhisperServer, active
    only when backend_for_model(model) == "parakeet-mlx" (main() picks
    one or the other per process — never both). Reuses ConnectionState
    for VAD/buffering (§C R3: "VAD/buffering stays where it is") but
    owns a wholly different per-connection scheduling mechanism: a
    serialized asyncio.Queue of ordered Audio/Boundary/Stop commands
    (Flush collapses into Boundary — see _handle_text's "flush" branch
    for why), drained by ONE dedicated worker task that owns the
    streaming context and every actual model call (§C R3, the
    adversarial-review amendment this design implements).

    Deliberately NOT a WhisperServer subclass: the two backends'
    partial/final production strategies diverge enough (re-transcribe-
    a-tail-window vs streaming-context-for-partials-only + batch-
    final-per-boundary) that sharing WhisperServer's _handle_binary/
    _finalize_segment/_consume_finalize_queue via inheritance would
    mean overriding nearly every one of them anyway — this file's OWN
    byte-equivalence requirement for the faster-whisper path (test_
    whisper_protocol.py, asserted unedited) makes a from-scratch VAD
    loop here the lower-risk choice over refactoring WhisperServer's
    tested methods into a shared base. The VAD algorithm/constants
    below are intentionally identical to WhisperServer._handle_binary's
    (same MIN_THRESHOLD/NOISE_FLOOR_MULTIPLIER/SILENCE_HANG_MS/
    MIN_SPEECH_MS/MAX_SEGMENT_MS) — segmentation cadence is backend-
    agnostic; only what happens AT a boundary differs."""

    def __init__(
        self,
        backend: ParakeetMlxBackend,
        default_language: str,
        emit_partials: bool,
        save_audio_path: Optional[str],
    ) -> None:
        self.backend = backend
        self.default_language = default_language
        self.emit_partials = emit_partials
        self.save_audio_path = save_audio_path

    async def handle(self, ws: WebSocketServerProtocol) -> None:
        # L2/F4 (P5b-evidence-backed): exactly one active parakeet
        # session process-wide — checked FIRST, before any VAD state or
        # worker task exists, so a rejected 2nd client never risks a
        # second streaming context (the corruption P5b found is
        # SILENT; never rely on an exception to catch it).
        if not self.backend.try_acquire_stream():
            try:
                await ws.send(
                    json.dumps(
                        {
                            "type": "parakeet-busy",
                            "detail": (
                                "本机同一时间仅支持一个 Apple 芯片本地转录会话 / "
                                "only one local Apple-Silicon transcription "
                                "session is supported at a time on this machine"
                            ),
                        }
                    )
                )
            except ConnectionClosed:
                pass
            await ws.close()
            return

        state = ConnectionState(language=self.default_language)
        if self.save_audio_path:
            state.wav_writer = open_wav_writer(self.save_audio_path)
        cmd_queue: "asyncio.Queue[Any]" = asyncio.Queue()

        worker_task = asyncio.create_task(self._worker(ws, state, cmd_queue))
        try:
            async for message in ws:
                if isinstance(message, (bytes, bytearray)):
                    await self._handle_binary(ws, state, cmd_queue, bytes(message))
                else:
                    await self._handle_text(ws, state, cmd_queue, message)
        except ConnectionClosed:
            pass
        finally:
            # Mirrors WhisperServer.handle's own finally (module
            # docstring): a connection that closes WITHOUT ever sending
            # "stop" (crashed tab) gets no ack — just a clean drain of
            # whatever's pending, then the worker is cancelled.
            #
            # FB5 (S12b fix round, HIGH — Sol5): this used to catch
            # ONLY asyncio.CancelledError around `await worker_task` —
            # a per-command exception the worker's own containment
            # (see _worker) somehow still let escape would propagate
            # OUT of this finally block here, skipping WAV closure AND
            # release_stream() entirely and wedging every future
            # parakeet connection behind a permanently "busy" slot no
            # restart-free path could ever clear. Each cleanup step
            # below is now its OWN best-effort try/except so a failure
            # in one can never skip the next — release_stream() is the
            # last, unguarded line: it ALWAYS runs, regardless of what
            # anything above it raises. _worker's own containment
            # (FB5) should mean the `except Exception` below is never
            # actually reached in practice; it exists as the last line
            # of defense, not the primary fix.
            try:
                await self._finalize_boundary(state, cmd_queue, force=True)
            except Exception:  # noqa: BLE001 - see the block's own docstring above
                pass
            worker_task.cancel()
            try:
                await worker_task
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001 - see the block's own docstring above
                pass
            try:
                if state.wav_writer is not None:
                    state.wav_writer.close()
            except Exception:  # noqa: BLE001 - see the block's own docstring above
                pass
            self.backend.release_stream()

    def _partials_enabled(self, state: ConnectionState) -> bool:
        """Same contract as WhisperServer._partials_enabled (kept as an
        independent copy rather than a shared call — see class
        docstring's "deliberately NOT a subclass" note)."""
        return self.emit_partials if state.partials_override is None else state.partials_override

    async def _handle_text(
        self,
        ws: WebSocketServerProtocol,
        state: ConnectionState,
        cmd_queue: "asyncio.Queue[Any]",
        raw: str,
    ) -> None:
        if state.stop_accepted:
            return
        try:
            msg = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return

        msg_type = msg.get("type")
        if msg_type == "config":
            language = msg.get("language")
            if isinstance(language, str) and language:
                state.language = language
            partials = msg.get("partials")
            if isinstance(partials, bool):
                state.partials_override = partials
            # FB7 (S12b fix round, MED — Sol7=Opus1): realtime speaker
            # diarization is NOT implemented for the parakeet backend
            # — the client can still ARM it (config.diarize truthy,
            # same field the whisper path reads), so silently ignoring
            # it left the client's arming feedback dishonestly blank
            # (armable-looking, silently dead). Reply with the SAME
            # one-shot diar_status "unavailable" shape the whisper path
            # sends on its own unavailable case (run_realtime_diar,
            # {"type":"diar_status","state":"unavailable","detail":
            # ...}) — reusing ConnectionState.diar_status_sent as the
            # one-shot latch (a parakeet connection never arms the
            # whisper-path diar machinery that field otherwise guards,
            # so it's otherwise always False/unused here — safe to
            # reuse rather than adding a new field for the same "sent
            # at most once" contract).
            if msg.get("diarize") and not state.diar_status_sent:
                state.diar_status_sent = True
                await self._safe_send(
                    ws,
                    state,
                    {
                        "type": "diar_status",
                        "state": "unavailable",
                        "detail": (
                            "Apple 芯片本地转录暂不支持实时说话人分离 / speaker "
                            "diarization is not yet supported for the "
                            "Apple-Silicon local backend"
                        ),
                    },
                )
        elif msg_type == "stop":
            state.stop_accepted = True
            await self._finalize_boundary(state, cmd_queue, force=True)
            await cmd_queue.put(_PARAKEET_STOP)
        elif msg_type == "flush":
            # Flush collapses into Boundary: today's protocol already
            # routes "flush" through the identical force-finalize call
            # ("stop"/MAX_SEGMENT/silence-hang all do), and under L5
            # every boundary already resets the streaming context — a
            # flush has no additional effect to express as its own
            # queue-command variant. No ack either way (unchanged wire
            # contract: flush never acks on the faster-whisper path
            # either).
            await self._finalize_boundary(state, cmd_queue, force=True)

    async def _handle_binary(
        self,
        ws: WebSocketServerProtocol,
        state: ConnectionState,
        cmd_queue: "asyncio.Queue[Any]",
        data: bytes,
    ) -> None:
        """VAD/buffering (§C R3: "stays where it is") — same energy-VAD
        algorithm/constants as WhisperServer._handle_binary. The
        receive loop ONLY enqueues here too: Audio commands (the speech
        samples accumulated during THIS call, for live partials) and
        Boundary commands (via _finalize_boundary) — never awaits
        inference."""
        if state.stop_accepted:
            return
        if state.wav_writer is not None:
            state.wav_writer.writeframes(data)

        buf = state.leftover + data
        usable_len = (len(buf) // (FRAME_SAMPLES * BYTES_PER_SAMPLE)) * (
            FRAME_SAMPLES * BYTES_PER_SAMPLE
        )
        state.leftover = buf[usable_len:]
        if usable_len == 0:
            return

        pcm16 = np.frombuffer(buf[:usable_len], dtype=np.int16)
        samples = pcm16.astype(np.float32) / 32768.0
        frames = samples.reshape(-1, FRAME_SAMPLES)
        frame_ms = (FRAME_SAMPLES / SAMPLE_RATE) * 1000.0

        partials_on = self._partials_enabled(state)
        speech_chunk: list[np.ndarray] = []

        async def flush_chunk() -> None:
            nonlocal speech_chunk
            if speech_chunk:
                await cmd_queue.put(_ParakeetAudio(frame=np.concatenate(speech_chunk)))
                speech_chunk = []

        for frame in frames:
            level = rms(frame)
            threshold = max(MIN_THRESHOLD, NOISE_FLOOR_MULTIPLIER * state.noise_floor)
            is_speech_frame = level > threshold

            if is_speech_frame:
                if not state.in_speech:
                    state.in_speech = True
                    state.speech_started_at = state.elapsed()
                    state.speech_buf = []
                    state.speech_ms = 0.0
                state.speech_buf.append(frame)
                state.speech_ms += frame_ms
                state.silence_ms = 0.0
                if partials_on:
                    speech_chunk.append(frame)

                if state.speech_ms >= MAX_SEGMENT_MS:
                    await flush_chunk()
                    await self._finalize_boundary(state, cmd_queue, force=True)
            else:
                state.noise_floor = (
                    NOISE_EMA_ALPHA * level + (1 - NOISE_EMA_ALPHA) * state.noise_floor
                )
                if state.in_speech:
                    state.silence_ms += frame_ms
                    state.speech_buf.append(frame)
                    state.speech_ms += frame_ms
                    if partials_on:
                        speech_chunk.append(frame)
                    if state.silence_ms >= SILENCE_HANG_MS:
                        await flush_chunk()
                        await self._finalize_boundary(state, cmd_queue, force=False)

        await flush_chunk()

    async def _finalize_boundary(
        self, state: ConnectionState, cmd_queue: "asyncio.Queue[Any]", force: bool
    ) -> None:
        """Enqueue-only (mirrors WhisperServer._finalize_segment
        exactly, retargeted at cmd_queue's Boundary command instead of
        finalize_queue's FinalizeJob) — never calls the model itself,
        safe to call from the receive loop without stalling it."""
        if not state.in_speech or not state.speech_buf:
            if force:
                state.in_speech = False
                state.speech_buf = []
                state.silence_ms = 0.0
                state.speech_ms = 0.0
            return

        t0 = state.speech_started_at if state.speech_started_at is not None else state.elapsed()
        t1 = state.elapsed()
        speech_ms = state.speech_ms
        audio = np.concatenate(state.speech_buf)

        state.in_speech = False
        state.speech_buf = []
        state.silence_ms = 0.0
        state.speech_ms = 0.0
        state.speech_started_at = None

        if speech_ms < MIN_SPEECH_MS:
            # FB9: too short — likely a blip, discard; no seg_id
            # consumed. But if partials were enabled, this blip's own
            # Audio command(s) may have ALREADY reached the worker and
            # opened a streaming context for it (see _handle_binary's
            # flush_chunk) — since this Boundary is never enqueued, the
            # worker would otherwise keep that now-orphaned, blip-
            # contaminated context open and silently reuse it for the
            # NEXT utterance's live partials. Always enqueue a reset
            # (cheap no-op on the worker side if no context was ever
            # opened for this blip — e.g. partials were off).
            await cmd_queue.put(_ParakeetContextReset())
            return

        seg_id = state.next_seg_id
        state.next_seg_id += 1
        await cmd_queue.put(
            _ParakeetBoundary(
                audio=audio, t0=t0, t1=t1, seg_id=seg_id, enqueued_at=time.monotonic()
            )
        )

    async def _worker(
        self,
        ws: WebSocketServerProtocol,
        state: ConnectionState,
        cmd_queue: "asyncio.Queue[Any]",
    ) -> None:
        """The ONE task per connection that owns the streaming context
        and ALL model access (§C R3) — drains Audio/Boundary/Stop in
        strict FIFO order, so `stopped` is always sent strictly after
        every final ahead of it in the queue has already gone out (§C
        R3/F6's stop-drain fix). Audio -> feed the (lazily-opened, per-
        utterance) streaming context, emit a throttled partial with the
        L5 regression guard (P1_api_shape.py: draft_tokens/result.text
        observed regressing non-empty -> empty -> recovered mid-
        utterance — once a non-empty partial has gone out for the
        current utterance, further EMPTY-text partials are suppressed
        rather than flickering the client's interim text back to
        blank). Boundary -> FB2 (S12b fix round, BLOCKER — Sol2): close/
        reset the streaming context FIRST (upstream's __exit__ is what
        restores full 'rel_pos' attention — StreamingParakeet.__exit__),
        THEN run ONE batch inference (L5) over the boundary's own exact
        PCM — running batch_final before the close meant generate() ran
        under the STILL-OPEN context's local-attention mode, silently
        degrading every final; this order is what makes L5's "batch-
        quality by construction" invariant actually hold. One wire
        final (skipped if the batch call returns empty text — parity
        with WhisperServer's own empty-final-skip/seg_id-gap
        semantics). ContextReset (FB9) -> close/reset only, no final,
        no seg_id. Stop -> {"type":"stopped"}, self-close (FB7 — mirrors
        WhisperServer's own documented self-close: ends the client's
        post-stop linger early and releases the single-active/shared-
        workload slot promptly), then returns.

        FB5 (S12b fix round, HIGH — Sol5): every command that touches
        the model (Audio/Boundary/ContextReset) is individually
        exception-contained — a model-call failure (context open/
        add_audio/batch_final/close) no longer lets an exception escape
        this task silently. On one: best-effort close/reset whatever
        context might still be open (_teardown_context_best_effort),
        send ONE typed terminal error event + close the socket
        ourselves (_terminate_on_model_error), then return — handle()'s
        own recv loop unwinds via ConnectionClosed into its own
        (FB5-hardened) outer finally, which guarantees release_stream()
        /WAV closure regardless, so the NEXT connection is always
        accepted rather than permanently wedged behind parakeet-busy."""
        ctx = None
        saw_nonempty = False
        last_partial_emit = float("-inf")
        try:
            while True:
                cmd = await cmd_queue.get()
                try:
                    if cmd is _PARAKEET_STOP:
                        await self._safe_send(ws, state, {"type": "stopped"})
                        try:
                            await ws.close()
                        except Exception:  # noqa: BLE001 - best-effort; the
                            # connection is already at its natural end
                            # either way (client-driven or not)
                            pass
                        return

                    if isinstance(cmd, _ParakeetAudio):
                        try:
                            if ctx is None:
                                ctx = await self.backend.open_streaming_context()
                                saw_nonempty = False
                            t0 = time.monotonic()
                            await self.backend.add_audio(ctx, cmd.frame)
                            lag_ms = round((time.monotonic() - t0) * 1000)
                            text = ctx.result.text
                            suppress = (not text) and saw_nonempty
                            if text:
                                saw_nonempty = True
                            now = state.elapsed()
                            if (
                                not suppress
                                and self._partials_enabled(state)
                                and now - last_partial_emit >= PARTIAL_INTERVAL_S
                            ):
                                await self._safe_send(
                                    ws, state, {"type": "partial", "text": text, "lag_ms": lag_ms}
                                )
                                last_partial_emit = now
                        except asyncio.CancelledError:
                            raise
                        except Exception as exc:  # noqa: BLE001 - see class/method docstring's FB5 note
                            ctx = await self._teardown_context_best_effort(ctx)
                            await self._terminate_on_model_error(ws, state, exc)
                            return

                    elif isinstance(cmd, _ParakeetBoundary):
                        try:
                            if ctx is not None:
                                try:
                                    await self.backend.close_streaming_context(ctx)
                                finally:
                                    ctx = None
                            saw_nonempty = False
                            final_text = await self.backend.batch_final(cmd.audio)
                        except asyncio.CancelledError:
                            raise
                        except Exception as exc:  # noqa: BLE001 - see class/method docstring's FB5 note
                            ctx = await self._teardown_context_best_effort(ctx)
                            await self._terminate_on_model_error(ws, state, exc)
                            return
                        if final_text:
                            lag_ms = round((time.monotonic() - cmd.enqueued_at) * 1000)
                            await self._safe_send(
                                ws,
                                state,
                                {
                                    "type": "final",
                                    "text": final_text,
                                    "start": cmd.t0,
                                    "end": cmd.t1,
                                    "seg_id": cmd.seg_id,
                                    "lag_ms": lag_ms,
                                },
                            )

                    elif isinstance(cmd, _ParakeetContextReset):
                        try:
                            if ctx is not None:
                                try:
                                    await self.backend.close_streaming_context(ctx)
                                finally:
                                    ctx = None
                            saw_nonempty = False
                        except asyncio.CancelledError:
                            raise
                        except Exception as exc:  # noqa: BLE001 - see class/method docstring's FB5 note
                            ctx = await self._teardown_context_best_effort(ctx)
                            await self._terminate_on_model_error(ws, state, exc)
                            return
                finally:
                    cmd_queue.task_done()
        finally:
            if ctx is not None:
                try:
                    await self.backend.close_streaming_context(ctx)
                except Exception:  # noqa: BLE001 - best-effort teardown on
                    # task cancellation; the connection is already
                    # tearing down via handle()'s own finally either way
                    pass

    async def _teardown_context_best_effort(self, ctx: Any) -> None:
        """FB5: best-effort context teardown after a worker exception —
        ALWAYS attempt to close/reset whatever streaming context might
        still be open, swallowing any SECOND exception from the close
        itself (the connection is already terminating; a doomed
        context must never be left open, but a failure IN this cleanup
        must never mask/replace the original error already being
        reported to the client). Always returns None — callers
        reassign `ctx = await self._teardown_context_best_effort(ctx)`
        so a doomed context is never referenced again."""
        if ctx is not None:
            try:
                await self.backend.close_streaming_context(ctx)
            except Exception:  # noqa: BLE001 - see docstring
                pass
        return None

    async def _terminate_on_model_error(
        self, ws: WebSocketServerProtocol, state: ConnectionState, exc: Exception
    ) -> None:
        """FB5 (S12b fix round, HIGH — Sol5): a model-call exception
        (context open/add_audio/batch_final/close) must never silently
        kill the worker task leaving the connection's stream/workload
        slot wedged (the pre-fix bug: an uncaught exception here
        propagated out of _worker entirely, and handle()'s own `await
        worker_task` re-raised it PAST release_stream()). Sends ONE
        typed terminal error event, then closes the socket itself —
        handle()'s own recv loop then unwinds via ConnectionClosed
        (its existing `except ConnectionClosed: pass`), reaching its
        own (FB5-hardened) outer finally, which guarantees
        release_stream()/WAV closure regardless — so the NEXT
        connection is always accepted, never permanently wedged."""
        print(f"[whisper_server] parakeet worker error: {exc}")
        await self._safe_send(
            ws,
            state,
            {
                "type": "parakeet-error",
                "detail": (
                    "本地转录出现内部错误，连接已关闭，请重新开始 / a local "
                    "transcription error occurred; the connection has "
                    "been closed — please start again"
                ),
            },
        )
        try:
            await ws.close()
        except Exception:  # noqa: BLE001 - best-effort; the connection is
            # already being torn down either way
            pass

    @staticmethod
    async def _safe_send(
        ws: WebSocketServerProtocol, state: ConnectionState, payload: dict
    ) -> None:
        """Byte-identical contract to WhisperServer._safe_send (see its
        own docstring's "Concurrent sends" rationale) — duplicated, not
        shared, per this class's own "deliberately not a subclass"
        note."""
        try:
            async with state.send_lock:
                await ws.send(json.dumps(payload))
        except ConnectionClosed:
            pass


# =================================================================
# Upload-a-recording HTTP job API (stdlib only: http.server, run in
# a daemon thread alongside the asyncio websocket server above).
# Jobs are tracked in-memory only — a sidecar restart loses all job
# state/history; this is an accepted tradeoff for a local, single-
# user sidecar process, not a persistence layer.
# =================================================================

DIARIZE_HOLD_PROGRESS = 0.9  # progress shown while diarization runs

# ---- URL import (#43 phase 2c, LOCAL TIER ONLY) tuning ----
INGEST_URL_MAX_LEN = 2000
INGEST_DOWNLOAD_MAX_FILESIZE = "500m"  # yt-dlp --max-filesize, mirrors MAX_UPLOAD_BYTES
INGEST_DOWNLOAD_HOLD_PROGRESS = 0.3  # progress shown while the download phase runs
INGEST_ERROR_DETAIL_CHARS = 200  # stderr-line truncation for a failed download


def new_job(
    diarize_requested: bool,
    display_name: Optional[str] = None,
    kind: str = "upload",
) -> dict[str, Any]:
    """Fresh job record — the exact shape returned by GET /jobs/{id}.

    `display_name`: None for the upload path (the client already knows
    file.name upfront and never needs it echoed back). URL-import jobs
    (#43 phase 2c) set it once the video title/URL is known — the
    client has only the URL until then, so it reads this field back
    (rather than a client-supplied filename) for buildSessionFromJob's
    title param.

    `kind`: "upload" (default) or "url" — lets count_active_url_jobs
    cap concurrent yt-dlp downloads (a network-bound, longer-running
    phase an unbounded upload job never has) without touching the
    upload path's own concurrency (unlimited, same as before)."""
    return {
        "id": uuid.uuid4().hex,
        "status": "queued",  # queued | running | done | error | cancelled
        "progress": 0.0,
        "status_detail": None,  # e.g. "diarizing", "下载中" (URL import)
        "segments": [],  # [{"start","end","text","speaker"?}]
        "error": None,
        "diarized": False,
        "diarize_requested": diarize_requested,
        "warning": None,  # non-fatal note (e.g. diarization unavailable)
        "display_name": display_name,
        "created_at": time.time(),
        "kind": kind,
    }


MAX_ACTIVE_URL_JOBS = 2  # concurrent yt-dlp downloads this sidecar will run at once


def count_active_url_jobs(jobs: dict[str, dict[str, Any]]) -> int:
    """Number of URL-import jobs (kind=="url") still queued or running
    — the population start_url_job's caller caps at
    MAX_ACTIVE_URL_JOBS before starting one more. Pure (just counts a
    dict) so it's callable under the same lock start_url_job's caller
    already holds, without any extra I/O."""
    return sum(
        1
        for job in jobs.values()
        if job.get("kind") == "url" and job.get("status") in ("queued", "running")
    )


def active_download_job_id(jobs: dict[str, dict[str, Any]]) -> Optional[str]:
    """Id of the currently queued/running kind=="download" job, if any
    (else None) — start_download_job's single-flight gate (S4 review
    finding, HIGH): each download job's own disk precheck
    (check_disk_space, inside download_model_snapshot) only ever
    accounts for THAT job's own multi-gigabyte snapshot, so N parallel
    /download-model POSTs can each individually pass their own
    precheck and still collectively exhaust disk. Unlike
    count_active_url_jobs's cap — checked, then a job created, as two
    SEPARATE steps in do_POST /ingest-url, leaving a window a racing
    second call could slip through — this is meant to be called and
    acted on inside the SAME critical section as the create (see
    start_download_job), so no such window exists here. Pure (just
    scans a dict) so it's callable under the lock the caller already
    holds, without any extra I/O — mirrors count_active_url_jobs.

    "cancelled" (field-test issue 6: cancellable model downloads) joins
    "done"/"error" as a third terminal status here — a cancelled job
    must free up the single-flight slot exactly like a finished/failed
    one, or a cancel would permanently wedge every FUTURE download
    attempt behind a job that will never move again."""
    for job in jobs.values():
        if job.get("kind") == "download" and job.get("status") not in ("done", "error", "cancelled"):
            return job["id"]
    return None


# =================================================================
# Pure, unit-testable URL-import (#43 phase 2c) helpers — no I/O, no
# subprocess, no network. Covered by test_ingest_url.py.
# =================================================================

# Loopback hostnames a same-origin JargonSlayer browser tab can
# legitimately carry as Origin (localhost:3000 -> this sidecar's
# localhost:8766 IS cross-origin, so the browser always sends one) —
# anything else means some other page's script issued the request.
INGEST_ALLOWED_ORIGIN_HOSTS = {"localhost", "127.0.0.1", "::1"}


def ingest_origin_allowed(origin: Optional[str]) -> bool:
    """SSRF gate for POST /ingest-url: the CORS "*" everywhere else on
    this sidecar is an accepted local-tool trust model, but /ingest-url
    uniquely lets a caller turn this machine into an internal-network
    fetch proxy (yt-dlp resolves attacker-supplied URLs, including
    localhost/LAN targets, then the job's transcript is readable via
    GET /jobs/{id}) — so any THIRD-PARTY WEB PAGE reaching this
    endpoint (not this app, not curl/CLI) must be rejected.

    None/empty Origin -> True: no Origin header at all means the
    caller isn't a browser doing a cross-origin fetch (curl, a native
    launcher, same-origin non-CORS contexts) — the drive-by vector
    this gate defends against is specifically unsolicited cross-origin
    browser JS, which always sends Origin.

    Otherwise: True only if the Origin's hostname is a loopback
    address per INGEST_ALLOWED_ORIGIN_HOSTS — this is what the
    JargonSlayer web app itself sends (dev on localhost:3000, or any
    other localhost port) and what "import a NAS/localhost URL"
    legitimately looks like. Everything else (a real remote origin, or
    a malformed Origin urlparse can't extract a hostname from) is
    rejected — a malformed value is never given the benefit of the
    doubt."""
    if origin is None or origin == "":
        return True
    hostname = urlparse(origin).hostname
    return hostname in INGEST_ALLOWED_ORIGIN_HOSTS


def validate_ingest_url(url: Any) -> Optional[str]:
    """Returns a zh error message if `url` isn't an importable http(s)
    URL, else None. Deliberately permissive beyond scheme/length — the
    real validity check is yt-dlp's own extractor resolution at
    download time, which produces a much more specific error."""
    if not isinstance(url, str) or not url:
        return "缺少视频链接"
    if len(url) > INGEST_URL_MAX_LEN:
        return f"链接过长（上限 {INGEST_URL_MAX_LEN} 字符）"
    scheme = urlparse(url).scheme.lower()
    if scheme not in ("http", "https"):
        return "仅支持 http/https 链接"
    return None


def build_ytdlp_args(url: str, out_dir: str) -> list[str]:
    """Construct the yt-dlp argv for one URL-import download: best
    audio, extracted + re-encoded to 16kHz mono WAV (matching the
    sidecar's own SAMPLE_RATE, so the downstream transcribe/diarize
    path never has to care an import came from a URL rather than an
    upload), filesize-capped, quiet (--print implies --quiet, which is
    also why no --newline percent parsing is attempted — verified via
    `yt-dlp --help`), printing the final filepath then the title after
    the file has been moved to its destination."""
    return [
        "yt-dlp",
        "--no-playlist",
        "-f",
        "bestaudio/best",
        "-x",
        "--audio-format",
        "wav",
        "--postprocessor-args",
        f"ffmpeg:-ac 1 -ar {SAMPLE_RATE}",
        "-o",
        os.path.join(out_dir, "audio.%(ext)s"),
        "--max-filesize",
        INGEST_DOWNLOAD_MAX_FILESIZE,
        "--no-progress",
        "--print",
        "after_move:filepath",
        "--print",
        "after_move:%(title)s",
        url,
    ]


def parse_ytdlp_stdout(stdout: str) -> tuple[Optional[str], Optional[str]]:
    """Parse `build_ytdlp_args`'s two `--print` lines out of a
    completed yt-dlp run's captured stdout: (filepath, title), either
    of which may be None if that line is missing (caller falls back to
    globbing the job's tmpdir for filepath, and to the URL's last path
    segment for title — see ingest_url_display_name). Verified live:
    yt-dlp emits exactly one line per --print, in the order the flags
    were given, with no other stdout noise (--print implies --quiet)."""
    lines = [line for line in stdout.splitlines() if line.strip()]
    filepath = lines[0].strip() if len(lines) >= 1 else None
    title = lines[1].strip() if len(lines) >= 2 else None
    return filepath, title


def ingest_url_display_name(url: str, title: Optional[str]) -> str:
    """Job display name: the captured video title if yt-dlp printed
    one (non-empty, and not its own literal "NA" placeholder for a
    missing field), else the URL's last non-empty path segment, else
    the URL itself."""
    if title and title != "NA":
        return title
    path = urlparse(url).path
    segment = path.rstrip("/").rsplit("/", 1)[-1]
    return segment or url


def truncate_ytdlp_error(stderr: str) -> str:
    """Last non-empty stderr line (yt-dlp's own `ERROR: ...` summary
    lives there — verified live against both a bad-format and an
    unreachable-host failure), truncated to
    INGEST_ERROR_DETAIL_CHARS. Falls back to a generic message if
    stderr was empty."""
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    last = lines[-1] if lines else "未知错误"
    return last[:INGEST_ERROR_DETAIL_CHARS]


class JobManager:
    """In-memory transcription job store + background worker.

    One lock guards the whole `jobs` dict — job payloads are small
    and updates infrequent (per-segment / per-phase), so a single
    coarse lock is simpler and safe against the HTTP server's thread
    pool without needing per-job locks.
    """

    def __init__(
        self,
        model: Any,
        model_name: str,
        default_language: str,
        hf_token: Optional[str],
    ) -> None:
        self.model = model
        self.model_name = model_name
        self.default_language = default_language
        self.hf_token = hf_token  # CLI/env token — the fallback for every job
        # Most recently supplied per-request token (PUT /transcribe's
        # hf_token= query param), tracked only so GET /health can report
        # "a token is available" even when the CLI/env token is unset and
        # the browser is the one carrying it (Settings' HF Token field).
        self.last_request_token: Optional[str] = None
        self.jobs: dict[str, dict[str, Any]] = {}
        self.lock = threading.Lock()
        # Field-test issue 6 (cancellable model downloads): one
        # threading.Event per in-flight download-kind job, keyed by job
        # id — deliberately NOT a field on the job dict itself (self.
        # jobs), since GET /jobs and /jobs/{id} json.dumps() that dict
        # verbatim and an Event isn't JSON-serializable. Guarded by the
        # SAME self.lock as self.jobs (request_cancel_download/
        # start_download_job/_run_download_job's own finally all take it
        # briefly) — the Event object itself is thread-safe once handed
        # out, only the DICT's own membership needs the lock. Entries
        # are removed once their job reaches ANY terminal status (see
        # _run_download_job's finally), so this never grows unbounded
        # across a long-running sidecar process's lifetime.
        self._cancel_events: dict[str, threading.Event] = {}

    def _set(self, job_id: str, **patch: Any) -> None:
        with self.lock:
            job = self.jobs.get(job_id)
            if job is not None:
                job.update(patch)

    def get(self, job_id: str) -> Optional[dict[str, Any]]:
        with self.lock:
            job = self.jobs.get(job_id)
            return dict(job) if job is not None else None

    def list_recent(self, limit: int = 20) -> list[dict[str, Any]]:
        with self.lock:
            jobs = sorted(
                self.jobs.values(), key=lambda j: j["created_at"], reverse=True
            )
            return [dict(j) for j in jobs[:limit]]

    def start_job(
        self,
        file_path: str,
        language: Optional[str],
        diarize: Optional[bool] = None,
        hf_token: Optional[str] = None,
        initial_prompt: Optional[str] = None,
    ) -> Optional[str]:
        """Register a queued job and kick off its background worker
        thread. Returns the job id immediately (non-blocking), or None
        if this JobManager's model is a ParakeetMlxBackend AND the one
        shared parakeet workload slot (S12b fix round FB4: a live ws
        session XOR a running parakeet file/URL job, process-wide) is
        already held by something else — no job/thread is created in
        that case; the caller (do_PUT /transcribe) turns None into a
        409 (parakeet_busy_response()) and is responsible for cleaning
        up the already-written upload file itself. Whisper-model jobs
        are NEVER gated by this (isinstance check below) — reserved at
        THIS admission point specifically to avoid TOCTOU against a
        racing ws connection/another job on a different thread; released
        in _run_job's own outermost finally (holds for the job's WHOLE
        lifetime, diarization included).

        `diarize`: caller's diarize=0|1 query param, or None to fall
        back to the default (on iff any token is available). `hf_token`:
        this job's hf_token= query param — localhost-only transport, so
        passing it per-request (rather than only via --hf-token/HF_TOKEN
        at process start) is fine; it's preferred over the CLI/env token
        for this job when present. `initial_prompt` (v0.4.7 Lane B):
        this job's own initial_prompt= query param — forwarded to
        _transcribe_job below; a no-op for a ParakeetMlxBackend job (see
        that method's own doc)."""
        if isinstance(self.model, ParakeetMlxBackend) and not self.model.try_acquire_stream():
            return None

        effective_token = hf_token or self.hf_token
        if hf_token:
            self.last_request_token = hf_token
        diarize_requested = bool(effective_token) if diarize is None else (diarize and bool(effective_token))
        job = new_job(diarize_requested)
        job_id = job["id"]
        with self.lock:
            self.jobs[job_id] = job

        thread = threading.Thread(
            target=self._run_job,
            args=(job_id, file_path, language or self.default_language, effective_token, initial_prompt),
            daemon=True,
        )
        thread.start()
        return job_id

    def _run_job(
        self,
        job_id: str,
        file_path: str,
        language: str,
        hf_token: Optional[str],
        initial_prompt: Optional[str] = None,
    ) -> None:
        # S13 hotfix (--lazy-load only; isinstance-gated exactly like
        # this method's own ParakeetMlxBackend checks below — see
        # LazyWhisperModel's own module-section docstring): a running/
        # queued classic-whisper file job counts as ONE unit of "active
        # work" for its whole lifetime. Computed once here (not inside
        # the try) so the SAME lazy_model reference reaches this
        # method's own finally below regardless of what raises inside
        # the try. `acquire()` itself is called FROM INSIDE the try
        # (first line) rather than out here — its own load may raise,
        # and this method's existing `except Exception` below is what
        # already reports any job-phase failure to the client; see
        # LazyWhisperModel.acquire's own docstring for why that's safe
        # (the active-work counter is incremented before the load is
        # even attempted, so release() below stays correctly paired
        # regardless of whether the load itself succeeds).
        lazy_model = self.model if isinstance(self.model, LazyWhisperModel) else None
        try:
            if lazy_model is not None:
                lazy_model.acquire()
            self._set(job_id, status="running")
            self._transcribe_job(job_id, file_path, language, initial_prompt=initial_prompt)

            job = self.get(job_id)
            if job is not None and job["diarize_requested"]:
                self._diarize_job(job_id, file_path, hf_token)

            self._set(job_id, status="done", progress=1.0, status_detail=None)
        except Exception as exc:  # noqa: BLE001 - report any failure to the client
            self._set(job_id, status="error", error=str(exc))
        finally:
            # FB4: release the shared parakeet workload slot start_job
            # reserved above — the job's own OUTERMOST finally, so it
            # holds for diarization too, and releases on ANY exit path
            # (success, error, or an unexpected exception this try
            # doesn't even name). No-op for a faster-whisper job (the
            # isinstance check mirrors start_job's own gate exactly, so
            # release only ever fires when acquire actually did).
            if isinstance(self.model, ParakeetMlxBackend):
                self.model.release_stream()
            # S13 hotfix: mirrors the FB4 release just above, for the
            # classic backend's own activity counter (see this method's
            # own lazy_model note above).
            if lazy_model is not None:
                lazy_model.release()
            try:
                os.remove(file_path)
            except OSError:
                pass

    def start_url_job(
        self,
        url: str,
        language: Optional[str],
        diarize: Optional[bool] = None,
        hf_token: Optional[str] = None,
        initial_prompt: Optional[str] = None,
    ) -> Optional[str]:
        """Register a queued URL-import (#43 phase 2c, LOCAL TIER ONLY)
        job and kick off its background worker thread. Returns the job
        id immediately (non-blocking) — mirrors start_job's contract
        exactly, only the acquisition method differs (yt-dlp download
        instead of an already-uploaded file); everything downstream
        (transcribe, diarize, cleanup) reuses _transcribe_job/
        _diarize_job unchanged, called from _run_url_job below instead
        of _run_job. Also mirrors start_job's FB4 shared-slot admission
        gate exactly (None return if a parakeet job's slot can't be
        reserved — "holding through URL download is fine for v1", so
        this reserves BEFORE the yt-dlp download phase even starts, not
        just around transcription). `initial_prompt` (v0.4.7 Lane B):
        same contract as start_job's own."""
        if isinstance(self.model, ParakeetMlxBackend) and not self.model.try_acquire_stream():
            return None

        effective_token = hf_token or self.hf_token
        if hf_token:
            self.last_request_token = hf_token
        diarize_requested = bool(effective_token) if diarize is None else (diarize and bool(effective_token))
        job = new_job(
            diarize_requested,
            display_name=ingest_url_display_name(url, None),
            kind="url",
        )
        job_id = job["id"]
        with self.lock:
            self.jobs[job_id] = job

        thread = threading.Thread(
            target=self._run_url_job,
            args=(job_id, url, language or self.default_language, effective_token, initial_prompt),
            daemon=True,
        )
        thread.start()
        return job_id

    def _run_url_job(
        self,
        job_id: str,
        url: str,
        language: str,
        hf_token: Optional[str],
        initial_prompt: Optional[str] = None,
    ) -> None:
        """Download phase (yt-dlp) followed by the SAME transcribe/
        diarize phases _run_job uses — progress 0-0.3 for the
        download, 0.3-1.0 for transcription (DIARIZE_HOLD_PROGRESS
        still governs the diarization hold within that range, exactly
        as for an uploaded file)."""
        # S13 hotfix: mirrors _run_job's own lazy_model note above —
        # acquired here (holds through the yt-dlp download phase too,
        # same "reserve for the job's whole lifetime" posture FB4's own
        # parakeet release_stream() already takes for this method).
        lazy_model = self.model if isinstance(self.model, LazyWhisperModel) else None
        tmp_dir = tempfile.mkdtemp(prefix="jargonslayer-ingest-")
        try:
            if lazy_model is not None:
                lazy_model.acquire()
            self._set(job_id, status="running", status_detail="下载中")
            file_path, title = self._download_via_ytdlp(job_id, url, tmp_dir)
            self._set(
                job_id,
                progress=INGEST_DOWNLOAD_HOLD_PROGRESS,
                status_detail=None,
                display_name=ingest_url_display_name(url, title),
            )

            self._transcribe_job(
                job_id,
                file_path,
                language,
                progress_floor=INGEST_DOWNLOAD_HOLD_PROGRESS,
                initial_prompt=initial_prompt,
            )

            job = self.get(job_id)
            if job is not None and job["diarize_requested"]:
                self._diarize_job(job_id, file_path, hf_token)

            self._set(job_id, status="done", progress=1.0, status_detail=None)
        except Exception as exc:  # noqa: BLE001 - report any failure to the client
            self._set(job_id, status="error", error=str(exc))
        finally:
            # FB4: mirrors _run_job's own release — the job's OUTERMOST
            # finally, releasing the slot start_url_job reserved above
            # regardless of exit path (including a download-phase
            # failure, well before transcription ever starts).
            if isinstance(self.model, ParakeetMlxBackend):
                self.model.release_stream()
            # S13 hotfix: mirrors the FB4 release just above.
            if lazy_model is not None:
                lazy_model.release()
            shutil.rmtree(tmp_dir, ignore_errors=True)

    def start_download_job(self, model: str) -> tuple[Optional[str], Optional[str]]:
        """Register a queued model-download job and kick off its
        background worker thread — decision B's :8766 model-switch
        path (docs/design-explorations/s4-model-wizard-blueprint.md):
        the server is already healthy/live here (unlike first-run,
        which uses --download-only instead — see run_download_only),
        so this reuses the same job/poll surface as start_job/
        start_url_job. Runs concurrently with the live server (disk-
        only, no port/model conflict) — the caller keeps transcribing
        on the current model until the new one finishes downloading.
        `model` is trusted to already be MODEL_CHOICES-valid (the
        do_POST /download-model handler validates it first, same as
        start_url_job trusts do_POST /ingest-url's own
        validate_ingest_url call).

        Single-flight (S4 review finding, HIGH — see
        active_download_job_id's own docstring for why per-job disk
        prechecks alone don't stop several simultaneous downloads from
        exhausting disk together): refuses to start a second download
        job — same model OR a different one, doesn't matter — while
        any kind=="download" job is still queued/running. A serial
        queue (accept the request, run it once the current one
        finishes) is over-engineered for v1; callers just retry after.

        The check (active_download_job_id) and the create both happen
        inside ONE `with self.lock:` block below, not two, so two
        POSTs racing each other on ThreadingHTTPServer's separate
        per-request threads (see run_http_server) can never both
        observe "none active" before either job is actually recorded.
        This can't lean on WhisperServer-style single-flight flags
        (ConnectionState.diar_in_flight/partial_in_flight) — those are
        plain bools, safe only because everything touching them runs
        on the one asyncio event-loop thread; /download-model POSTs
        arrive on the HTTP server's own thread pool instead, so a real
        threading.Lock is required — `self.lock`, the same one
        _set/get/start_job etc. already use for this dict.

        Returns (job_id, active_job_id): exactly one is not None. A
        non-None active_job_id means no new job was created/started —
        do_POST /download-model turns that into a 409 naming it, so a
        client could poll that job instead of retrying blind."""
        with self.lock:
            active_id = active_download_job_id(self.jobs)
            if active_id is not None:
                return None, active_id

            job = new_job(False, display_name=model, kind="download")
            job_id = job["id"]
            self.jobs[job_id] = job
            # Field-test issue 6: this job's own cancel flag, created
            # inside the SAME locked section as the job itself so
            # request_cancel_download can never observe a "download"-
            # kind job in self.jobs with no matching entry here yet.
            cancel_event = threading.Event()
            self._cancel_events[job_id] = cancel_event

        thread = threading.Thread(
            target=self._run_download_job,
            args=(job_id, model, cancel_event),
            daemon=True,
        )
        try:
            thread.start()
        except Exception as exc:  # noqa: BLE001 - report any failure to the client
            # F4 (review-round fix, Sol LOW #17): the job + cancel_event
            # are already recorded above (self.jobs/self._cancel_events)
            # by the time thread.start() runs — if start() itself fails
            # (e.g. the process is out of OS threads), the worker that
            # would normally set a terminal status never runs at all,
            # leaving this job stuck "queued" forever. active_download_
            # job_id treats queued/running as "still active," so every
            # future /download-model call would 409 against a job that
            # can never move again — wedging the single-flight slot
            # permanently. Land it on "error" right here instead, same
            # terminal-status shape _run_download_job's own except-
            # Exception branch already uses for an in-flight failure,
            # and drop the now-orphaned cancel event exactly like that
            # method's own finally does.
            self._set(job_id, status="error", error=str(exc))
            with self.lock:
                self._cancel_events.pop(job_id, None)
        return job_id, None

    def request_cancel_download(self, job_id: str) -> str:
        """Field-test issue 6 (POST /jobs/{id}/cancel's real work):
        requests cancellation of a queued/running download-kind job.
        Returns one of three strings, which do_POST maps to a status
        code exactly the way validate_download_model/
        download_conflict_response's own return shapes already do
        (see this module's do_POST for the actual HTTPStatus mapping —
        not re-tested at the live-handler level here, same "thin
        handler assertion" posture as those two):
          "not_found" — no such job, or it isn't kind=="download" (an
            upload/url job has no cancel mechanism at all) -> 404.
          "terminal"  — the job already reached done/error/cancelled;
            nothing left to cancel -> 409.
          "ok"        — the cancel flag is now set -> 202. This is
            NOT a promise the job has already stopped: the download's
            own background thread only observes the flag at its next
            tqdm progress-callback/loop boundary (see DownloadCancelled's
            own doc comment for the latency this implies) — a client
            polling GET /jobs/{id} afterward will see status flip to
            "cancelled" once that happens, not immediately.

        Partial files already written to disk are left exactly as-is
        (hf_hub's own resumable-download behavior picks them back up on
        a later retry) — this function itself does no filesystem work
        at all, only sets the flag."""
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None or job.get("kind") != "download":
                return "not_found"
            if job.get("status") in ("done", "error", "cancelled"):
                return "terminal"
            event = self._cancel_events.get(job_id)
        if event is None:
            # Shouldn't happen — start_download_job always creates one
            # in the same locked section as the job itself, removed
            # only once terminal (already excluded above). Defensive
            # fallback rather than a KeyError.
            return "terminal"
        event.set()
        return "ok"

    def _run_download_job(self, job_id: str, model: str, cancel_event: threading.Event) -> None:
        def on_progress(downloaded: int, total: int) -> None:
            progress = min(downloaded / total, 1.0) if total else 0.0
            self._set(job_id, progress=progress)

        try:
            self._set(job_id, status="running", status_detail="下载中")
            # S12a Q6: thread this manager's own CLI/env token (the
            # SAME self.hf_token diarization already falls back to,
            # see __init__) into the download itself — previously NO
            # token reached downloads at all (s12-mlx-blueprint.md §B
            # finding 10/§C R1).
            download_model_snapshot(model, on_progress, hf_token=self.hf_token, cancel_event=cancel_event)
            self._set(job_id, status="done", progress=1.0, status_detail=None)
        except DownloadCancelled:
            # Field-test issue 6: a deliberate cancel is NOT an error —
            # its own terminal status, job.error stays None throughout.
            self._set(job_id, status="cancelled", status_detail=None)
        except Exception as exc:  # noqa: BLE001 - report any failure to the client
            self._set(job_id, status="error", error=str(exc))
        finally:
            # Cleanup mirrors this dict's own doc comment (__init__) —
            # every terminal path (done/cancelled/error alike) removes
            # its own entry so self._cancel_events never grows unbounded
            # across a long-running sidecar process.
            with self.lock:
                self._cancel_events.pop(job_id, None)

    def _download_via_ytdlp(self, job_id: str, url: str, tmp_dir: str) -> tuple[str, Optional[str]]:
        """Run yt-dlp synchronously (this method itself runs inside the
        job's background thread) to fetch+extract 16kHz mono WAV audio
        for `url` into `tmp_dir`. Returns (file_path, title). Raises a
        zh RuntimeError on any failure (missing binaries, non-zero
        exit, unparseable/missing output file) — caught by the
        _run_url_job caller exactly like any other job-phase
        exception."""
        if shutil.which("yt-dlp") is None:
            raise RuntimeError(
                "未检测到 yt-dlp，请先安装（brew install yt-dlp 或 pipx install yt-dlp）"
            )
        if shutil.which("ffmpeg") is None:
            raise RuntimeError("未检测到 ffmpeg，请先安装（brew install ffmpeg）")

        args = build_ytdlp_args(url, tmp_dir)
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=1800,
        )
        if result.returncode != 0:
            raise RuntimeError(f"下载失败：{truncate_ytdlp_error(result.stderr)}")

        file_path, title = parse_ytdlp_stdout(result.stdout)
        if not file_path or not os.path.isfile(file_path):
            # Fallback: --print's stdout line was missing/unparseable —
            # glob the tmpdir for whatever -o's template actually wrote.
            candidates = sorted(Path(tmp_dir).glob("audio.*"))
            if not candidates:
                raise RuntimeError("下载失败：未找到音频文件")
            file_path = str(candidates[0])
        return file_path, title

    def _transcribe_job(
        self,
        job_id: str,
        file_path: str,
        language: str,
        progress_floor: float = 0.0,
        initial_prompt: Optional[str] = None,
    ) -> None:
        """`progress_floor`: for the upload path (default 0.0, the
        only caller until #43 phase 2c) transcription progress maps
        into [0, DIARIZE_HOLD_PROGRESS] exactly as before. The URL-
        import path (_run_url_job) passes INGEST_DOWNLOAD_HOLD_PROGRESS
        so the download phase's own [0, floor] range is never
        overwritten — transcription then maps into
        [floor, floor + (1 - floor) * DIARIZE_HOLD_PROGRESS], still
        reserving its own tail for the diarization-hold phase exactly
        as the plain floor=0.0 case does.

        S12b (§C R4): when this JobManager's model is a
        ParakeetMlxBackend (main() decides which at process startup —
        see backend_for_model), delegates to the normalized
        Backend.transcribe_file() below instead — its batch API
        returns one AlignedResult (not faster-whisper's incremental
        segment generator + info), so there is no per-segment progress
        to stream; the faster-whisper branch below is otherwise BYTE-
        UNCHANGED from before this backend seam existed.

        `initial_prompt` (v0.4.7 Lane B, glossary -> recognizer bias):
        EXPLICIT no-op for the parakeet arm — Backend.transcribe_file()
        below has no such parameter at all, so it is simply never
        passed through on that branch (not a client-side/JS-side
        "is this model parakeet" check; the sidecar itself structurally
        cannot wire it through for that backend)."""
        if isinstance(self.model, ParakeetMlxBackend):
            self._transcribe_job_parakeet(job_id, file_path, progress_floor)
            return

        segments_gen, info = self.model.transcribe(
            file_path,
            language=language,
            beam_size=1,
            vad_filter=True,
            word_timestamps=False,
            initial_prompt=initial_prompt,
        )
        duration = max(info.duration, 1e-6)

        collected: list[dict[str, Any]] = []
        for seg in segments_gen:
            collected.append(
                {"start": seg.start, "end": seg.end, "text": seg.text.strip()}
            )
            progress = min(seg.end / duration, 1.0)
            with self.lock:
                job = self.jobs.get(job_id)
                if job is not None:
                    job["segments"] = list(collected)
                    # Leave headroom for the diarization phase, which
                    # (per spec) holds progress at DIARIZE_HOLD_PROGRESS
                    # within whatever range remains above progress_floor.
                    job["progress"] = progress_floor + progress * DIARIZE_HOLD_PROGRESS * (
                        1 - progress_floor
                    )

    def _transcribe_job_parakeet(
        self, job_id: str, file_path: str, progress_floor: float
    ) -> None:
        """S12b (§C R4): the ParakeetMlxBackend arm of _transcribe_job.
        Backend.transcribe_file() already maps AlignedSentence -> the
        {"start","end","text"} job segment shape and raises the exact
        "未检测到 ffmpeg" RuntimeError faster-whisper's file-job path
        never explicitly checked for (see that method's own docstring)
        — propagates straight up to _run_job/_run_url_job's own
        `except Exception` -> job.error handling, unchanged. Batch
        transcription is already complete (127.9x realtime warm,
        P6_throughput.py) by the time transcribe_file() returns, so
        there is no incremental per-segment progress to stream — one
        jump straight to this phase's own ceiling, matching what the
        faster-whisper branch's progress formula converges to at its
        own progress=1.0."""
        segments, _duration = self.model.transcribe_file(file_path, self.default_language)
        with self.lock:
            job = self.jobs.get(job_id)
            if job is not None:
                job["segments"] = segments
                job["progress"] = progress_floor + DIARIZE_HOLD_PROGRESS * (1 - progress_floor)

    def _load_diarize_pipeline(self, hf_token: Optional[str] = None) -> tuple[Any, Optional[str]]:
        """Returns (pipeline, error_message); error_message is None on
        success. Thin wrapper over the module-level
        `_shared_diarize_pipeline` singleton (shared with the realtime
        ws path so the model is only ever loaded once per process) —
        `hf_token` (a per-job override, see start_job) takes precedence
        over the CLI/env one on first load, whichever caller loads it
        first. See _SharedDiarizePipeline.get for the full contract."""
        token = hf_token or self.hf_token
        return _shared_diarize_pipeline.get(token)

    def diarization_probe(self) -> tuple[bool, bool, Optional[str]]:
        """Lightweight readiness check for GET /health: does pyannote
        import, and is a token available (CLI/env, or the most recent
        per-request hf_token)? Deliberately does NOT call
        Pipeline.from_pretrained() (that downloads/loads the model) —
        it only checks the import + token presence, per spec.

        Returns (installed, ready, error) — three orthogonal facts (S5
        decision C, replacing the old (ready, error) pair): `installed`
        is the pyannote import result alone, token-independent, so
        /health can report "already installed" even before any token
        is configured; `ready` is installed AND token present (the
        pre-S5 boolean, kept as-is for back-compat — arming a meeting
        still needs both); `error` explains whichever check failed.
        Checked import-FIRST, token second (the old order was token-
        first, which could never tell "pyannote missing" apart from
        "no token" — this is the 检测状态 bug S5 fixes)."""
        # pyannote is never imported anywhere in this process before a
        # successful pip install (this probe is its first-ever import
        # attempt), so there is no stale NEGATIVE sys.modules entry to
        # worry about here — invalidate_caches() only needs to bust the
        # path-based finders' cached directory listing from before the
        # install wrote pyannote's files into site-packages, so a
        # still-running server picks up a just-installed pyannote on
        # the very next probe, no restart required.
        importlib.invalidate_caches()
        try:
            import pyannote.audio  # noqa: F401  type: ignore[import-not-found]
        except Exception as exc:  # noqa: BLE001 - see _load_diarize_pipeline docstring
            return False, False, (
                f"pyannote.audio 未安装（{type(exc).__name__}: {exc}） / "
                "pyannote.audio not installed"
            )
        token = self.hf_token or self.last_request_token
        if not token:
            return True, False, "未配置 HF Token / no HF token available"
        return True, True, None

    @staticmethod
    def _to_wav_for_diarization(file_path: str) -> tuple[str, bool]:
        """Re-encode audio to a clean 16 kHz mono WAV for pyannote.

        Returns (path, is_temp). Best-effort: if ffmpeg is missing or the
        conversion fails, returns the original path with is_temp=False so
        diarization still attempts (and degrades gracefully) on it.
        """
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            return file_path, False
        fd, wav_path = tempfile.mkstemp(suffix=".wav", prefix="jargonslayer-diar-")
        os.close(fd)
        try:
            subprocess.run(
                [ffmpeg, "-nostdin", "-y", "-i", file_path,
                 "-ac", "1", "-ar", "16000", "-f", "wav", wav_path],
                check=True,
                capture_output=True,
                timeout=600,
            )
            return wav_path, True
        except Exception:  # noqa: BLE001 - fall back to the original file
            try:
                os.remove(wav_path)
            except OSError:
                pass
            return file_path, False

    def _diarize_job(
        self, job_id: str, file_path: str, hf_token: Optional[str] = None
    ) -> None:
        self._set(
            job_id, progress=DIARIZE_HOLD_PROGRESS, status_detail="diarizing"
        )

        pipeline, load_error = self._load_diarize_pipeline(hf_token)
        if pipeline is None:
            # Token set but pyannote.audio unavailable/broken — complete
            # the job undiarized rather than failing it.
            detail = f"（{load_error}）" if load_error else ""
            self._set(
                job_id,
                warning=(
                    f"说话人分离不可用，已跳过{detail} / speaker diarization "
                    "unavailable, skipped (pip install pyannote.audio; "
                    "needs a valid HF token + accepted model license)"
                ),
            )
            return

        # pyannote 4.x crops fixed-length windows and rejects a chunk
        # whose decoded sample count is even slightly off (e.g. AAC/m4a
        # encoder padding yields 477888 vs the expected 480000 samples).
        # Re-encode to a clean 16 kHz mono WAV first so sample counts are
        # exact; fall back to the original path if ffmpeg is unavailable.
        diar_path, diar_is_temp = self._to_wav_for_diarization(file_path)
        try:
            with _pipeline_call_lock:
                result = pipeline(diar_path)
            # pyannote 4.x returns a DiarizeOutput wrapper whose
            # .speaker_diarization is the Annotation; 3.x returns the
            # Annotation directly. Accept both.
            diarization = getattr(result, "speaker_diarization", result)
            turns = [
                (turn.start, turn.end, label)
                for turn, _track, label in diarization.itertracks(yield_label=True)
            ]
        except Exception as exc:  # noqa: BLE001 - diarization is best-effort
            self._set(
                job_id,
                warning=(
                    f"说话人分离运行失败，已跳过（{type(exc).__name__}: {exc}） / "
                    "speaker diarization failed at runtime, skipped"
                ),
            )
            return
        finally:
            if diar_is_temp:
                try:
                    os.remove(diar_path)
                except OSError:
                    pass

        # Remap pyannote's native labels (SPEAKER_00, SPEAKER_01, ...)
        # to the spec's SPEAKER_1/2/... in first-seen order.
        label_order: list[str] = []
        for _start, _end, label in turns:
            if label not in label_order:
                label_order.append(label)
        label_map = {
            label: f"SPEAKER_{i + 1}" for i, label in enumerate(label_order)
        }

        job = self.get(job_id)
        if job is None:
            return
        segments = job["segments"]
        for seg in segments:
            seg["speaker"] = self._speaker_for_segment(seg, turns, label_map)

        self._set(job_id, segments=segments, diarized=True, status_detail=None)

    @staticmethod
    def _speaker_for_segment(
        seg: dict[str, Any],
        turns: list[tuple[float, float, str]],
        label_map: dict[str, str],
    ) -> Optional[str]:
        """Assign the diarization label with maximum time-overlap
        against this whisper segment's [start, end) span. Thin wrapper
        over the shared `speaker_for_turns` pure function (also used
        by the realtime ws path's segment_log back-assignment)."""
        best_label = speaker_for_turns((seg["start"], seg["end"]), turns)
        return label_map.get(best_label) if best_label is not None else None


def make_job_http_handler(
    job_manager: JobManager, default_language: str
) -> type[BaseHTTPRequestHandler]:
    """Build a BaseHTTPRequestHandler subclass closing over the shared
    JobManager (stdlib handlers are instantiated per-request, so state
    must live outside the class via closure)."""

    class JobHTTPHandler(BaseHTTPRequestHandler):
        server_version = "JargonSlayerSidecar/1.0"

        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
            pass  # keep stdout to the startup banner + explicit prints

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header(
                "Access-Control-Allow-Methods", "PUT, POST, GET, OPTIONS"
            )
            self.send_header(
                "Access-Control-Allow-Headers", "Content-Type"
            )

        def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib naming convention
            self.send_response(HTTPStatus.NO_CONTENT)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_PUT(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path != "/transcribe":
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return

            qs = parse_qs(parsed.query)
            filename = (qs.get("filename") or ["upload.bin"])[0]
            language = (qs.get("language") or [None])[0]
            diarize_param = (qs.get("diarize") or [None])[0]
            diarize = None if diarize_param is None else diarize_param == "1"
            # hf_token travels over plain localhost HTTP (127.0.0.1) only
            # — the sidecar never listens beyond loopback by default —
            # so passing it as a query param alongside the upload is an
            # accepted tradeoff for a local-only job API, not a general
            # web-facing auth token.
            hf_token = (qs.get("hf_token") or [None])[0]
            # v0.4.7 Lane B (glossary -> recognizer bias): same
            # localhost-only tradeoff as hf_token above.
            initial_prompt = (qs.get("initial_prompt") or [None])[0]

            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                self._send_json(
                    HTTPStatus.BAD_REQUEST, {"error": "empty request body"}
                )
                return
            # ~3h of 16-bit 48kHz stereo WAV ≈ 2GB; audio meetings live
            # far below this. Reject before buffering to protect /tmp.
            if length > MAX_UPLOAD_BYTES:
                self._send_json(
                    HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                    {"error": f"文件过大（上限 {MAX_UPLOAD_BYTES // (1 << 20)}MB） / file too large"},
                )
                return

            suffix = Path(filename).suffix or ".bin"
            fd, tmp_path = tempfile.mkstemp(suffix=suffix, prefix="jargonslayer-")
            try:
                remaining = length
                with os.fdopen(fd, "wb") as f:
                    chunk_size = 1 << 20
                    while remaining > 0:
                        chunk = self.rfile.read(min(chunk_size, remaining))
                        if not chunk:
                            break
                        f.write(chunk)
                        remaining -= len(chunk)
            except Exception as exc:  # noqa: BLE001
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"failed to read upload: {exc}"},
                )
                return

            job_id = job_manager.start_job(
                tmp_path, language, diarize=diarize, hf_token=hf_token, initial_prompt=initial_prompt
            )
            if job_id is None:
                # FB4: the shared parakeet workload slot (live ws
                # session XOR a running parakeet file/URL job,
                # process-wide) was already held — start_job never
                # created a job/background thread in that case, so
                # THIS handler owns cleaning up the already-written
                # upload file (mirrors the exception branch above).
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
                self._send_json(HTTPStatus.CONFLICT, parakeet_busy_response())
                return
            self._send_json(HTTPStatus.ACCEPTED, {"job_id": job_id})

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)

            if parsed.path == "/download-model":
                # decision B's :8766 model-switch job (see JobManager.
                # start_download_job) — server already healthy/live, so
                # this endpoint (unlike --download-only's first-run
                # one-shot) is reachable. Mirrors /ingest-url's own
                # body-parsing shape below.
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0:
                    self._send_json(
                        HTTPStatus.BAD_REQUEST, {"error": "empty request body"}
                    )
                    return
                try:
                    raw = self.rfile.read(length)
                    payload = json.loads(raw)
                except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                    self._send_json(
                        HTTPStatus.BAD_REQUEST, {"error": f"请求体不是合法 JSON: {exc}"}
                    )
                    return

                model = payload.get("model") if isinstance(payload, dict) else None
                model_error = validate_download_model(model)
                if model_error is not None:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": model_error})
                    return

                # Single-flight (S4 review finding, HIGH — see
                # JobManager.start_download_job's own docstring):
                # job_id is None iff another download job is already
                # in flight, in which case active_job_id names it and
                # no new job was created/started.
                job_id, active_job_id = job_manager.start_download_job(model)
                if job_id is None:
                    self._send_json(
                        HTTPStatus.CONFLICT,
                        download_conflict_response(active_job_id),
                    )
                    return
                self._send_json(HTTPStatus.ACCEPTED, {"job_id": job_id})
                return

            # Field-test issue 6 (cancellable model downloads) —
            # POST /jobs/{job_id}/cancel. `parts`-based routing mirrors
            # do_GET's own /jobs/{id} shape below rather than a second
            # urlparse-only check, since this is the one POST route with
            # a path SEGMENT (not just a fixed literal like
            # /download-model or /ingest-url above/below).
            parts = [p for p in parsed.path.split("/") if p]
            if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "cancel":
                result = job_manager.request_cancel_download(parts[1])
                if result == "not_found":
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": "job not found"})
                elif result == "terminal":
                    self._send_json(HTTPStatus.CONFLICT, {"error": "任务已结束，无法取消"})
                else:
                    self._send_json(HTTPStatus.ACCEPTED, {"job_id": parts[1]})
                return

            if parsed.path != "/ingest-url":
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return

            # SSRF gate (see ingest_origin_allowed docstring) — checked
            # before reading the body at all, so a rejected drive-by
            # request never even gets Content-Length/body handling.
            if not ingest_origin_allowed(self.headers.get("Origin")):
                self._send_json(
                    HTTPStatus.FORBIDDEN,
                    {"error": "仅限本机应用调用（浏览器跨站请求已拒绝）"},
                )
                return

            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                self._send_json(
                    HTTPStatus.BAD_REQUEST, {"error": "empty request body"}
                )
                return
            if length > MAX_UPLOAD_BYTES:
                self._send_json(
                    HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                    {"error": f"请求体过大（上限 {MAX_UPLOAD_BYTES // (1 << 20)}MB） / request too large"},
                )
                return

            try:
                raw = self.rfile.read(length)
                payload = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                self._send_json(
                    HTTPStatus.BAD_REQUEST, {"error": f"请求体不是合法 JSON: {exc}"}
                )
                return

            url = payload.get("url") if isinstance(payload, dict) else None
            url_error = validate_ingest_url(url)
            if url_error is not None:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": url_error})
                return

            if shutil.which("yt-dlp") is None:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {
                        "error": "未检测到 yt-dlp，请先安装（brew install yt-dlp "
                        "或 pipx install yt-dlp）"
                    },
                )
                return
            if shutil.which("ffmpeg") is None:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "未检测到 ffmpeg，请先安装（brew install ffmpeg）"},
                )
                return

            # Concurrency cap: yt-dlp downloads are network-bound and
            # can run for minutes, so an unbounded number of concurrent
            # URL-import jobs is a much easier DoS/self-inflicted-abuse
            # vector than the upload path (which has no such external
            # network phase). Checked under the lock immediately before
            # starting one more, so two racing requests can't both pass
            # the check before either job is recorded.
            with job_manager.lock:
                active = count_active_url_jobs(job_manager.jobs)
            if active >= MAX_ACTIVE_URL_JOBS:
                self._send_json(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    {"error": "已有下载任务进行中，请稍后再试"},
                )
                return

            language = payload.get("language") if isinstance(payload.get("language"), str) else None
            diarize_raw = payload.get("diarize")
            diarize = None if diarize_raw is None else bool(diarize_raw)
            hf_token = payload.get("hf_token") if isinstance(payload.get("hf_token"), str) else None
            # v0.4.7 Lane B (glossary -> recognizer bias): mirrors
            # hf_token's own isinstance gate above.
            initial_prompt = (
                payload.get("initial_prompt") if isinstance(payload.get("initial_prompt"), str) else None
            )

            job_id = job_manager.start_url_job(
                url, language, diarize=diarize, hf_token=hf_token, initial_prompt=initial_prompt
            )
            if job_id is None:
                # FB4: same shared-slot rejection as do_PUT /transcribe
                # above — no download has started yet (start_url_job
                # never created a job/background thread), so there is
                # nothing to clean up here.
                self._send_json(HTTPStatus.CONFLICT, parakeet_busy_response())
                return
            self._send_json(HTTPStatus.ACCEPTED, {"job_id": job_id})

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            parts = [p for p in parsed.path.split("/") if p]

            if parts == ["health"]:
                installed, ready, error = job_manager.diarization_probe()
                self._send_json(
                    HTTPStatus.OK,
                    health_payload(job_manager.model_name, installed, ready, error),
                )
                return

            if parts == ["jobs"]:
                self._send_json(
                    HTTPStatus.OK, {"jobs": job_manager.list_recent(20)}
                )
                return

            if len(parts) == 2 and parts[0] == "jobs":
                job = job_manager.get(parts[1])
                if job is None:
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": "job not found"})
                    return
                self._send_json(HTTPStatus.OK, job)
                return

            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    return JobHTTPHandler


def run_http_server(
    host: str, port: int, job_manager: JobManager, default_language: str
) -> ThreadingHTTPServer:
    """Start the job-API HTTP server on its own daemon thread; returns
    the server instance (caller keeps a reference so it isn't GC'd)."""
    handler_cls = make_job_http_handler(job_manager, default_language)
    httpd = ThreadingHTTPServer((host, port), handler_cls)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


def health_payload(model_name: str, installed: bool, ready: bool, error: Optional[str]) -> dict[str, Any]:
    """JSON body for GET /health. `installed`/`ready`/`error` are
    JobManager.diarization_probe()'s three orthogonal facts (S5
    decision C) — `diarization_ready`/`diarization_error` keep their
    pre-S5 meaning exactly unchanged (ready implies installed; error is
    None whenever ready), `diarization_installed` is the new,
    token-independent field. Factored out as its own pure function,
    mirroring download_conflict_response/validate_download_model's
    convention below, so its shape is directly unit-testable without
    constructing a live handler — see test_whisper_protocol.py."""
    return {
        "ok": True,
        "model": model_name,
        "diarization_installed": installed,
        "diarization_ready": ready,
        "diarization_error": None if ready else error,
    }


# =================================================================
# Model download (S4): MODEL_CHOICES is the single source of truth for
# every valid --model value — argparse's own choices=, POST
# /download-model's validator, and --download-only all read from this
# one list (previously hand-duplicated inline in argparse's choices=).
# download_model_snapshot is the one shared helper behind BOTH
# download paths (decision B, docs/design-explorations/
# s4-model-wizard-blueprint.md): --download-only (first-run one-shot,
# see run_download_only) and JobManager.start_download_job (:8766
# model-switch job) — "one shared helper, only invocation + progress
# transport differ." Every huggingface_hub/tqdm import below is
# deferred into the function that needs it, so importing this module
# itself stays independent of the ML stack — every OTHER test file
# relies on that already. Neither of this section's own repo-id maps
# (WHISPER_REPO_IDS/PARAKEET_REPO_ID below) needs faster_whisper at all
# any more (S12a fix round F3, see WHISPER_REPO_IDS's own docstring) —
# only load_model() (the actual model-LOADING path, not download)
# still lazily `from faster_whisper import WhisperModel`s, and only
# when a whisper model is what's being loaded.
# =================================================================

# S12a (v0.4.4, MLX local-STT lane, docs/design-explorations/
# s12-mlx-blueprint.md §C/R1) — parakeet-tdt-0.6b-v3 rides the SAME
# MODEL_CHOICES/download/validate machinery as every whisper model
# (decision Q1: "a model under `whisper`, not a new engine"); see
# PARAKEET_REPO_ID/PARAKEET_ALLOW_PATTERNS below for its registry
# entry and WHISPER_REPO_IDS (further down) for every faster-whisper
# entry's own (static, dependency-free — F3) repo id.
PARAKEET_MODEL = "parakeet-tdt-0.6b-v3"

MODEL_CHOICES = [
    "tiny",
    "base",
    "small",
    "medium",
    "large-v3",
    "large-v3-turbo",
    PARAKEET_MODEL,
]

# The SAME allow_patterns faster_whisper.utils.download_model uses
# internally (verified against the pinned faster-whisper==1.2.1's
# installed source) — this is exactly the file set WhisperModel(model)
# itself downloads/needs. Mirroring it here means a pre-download
# populates precisely the cache a later load_model() call reads (no
# wasted bytes on e.g. a repo's README.md/.gitattributes, and our
# upfront size total below matches what actually gets fetched).
MODEL_DOWNLOAD_ALLOW_PATTERNS = [
    "config.json",
    "preprocessor_config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.*",
]

# mlx-community/parakeet-tdt-0.6b-v3's repo id + allow_patterns —
# verified LIVE two ways (s12-mlx-blueprint.md §B finding 12 / §C R1,
# 2026-07-16): (1) the HF repo's own file listing has config.json,
# model.safetensors, tokenizer.model, tokenizer.vocab, vocab.txt
# (+README/.gitattributes); (2) the installed parakeet_mlx==0.5.2
# wheel's utils.from_pretrained (unzipped, NOT installed into any venv
# — see requirements-mlx.in's own note) calls
# `hf_hub_download(repo, "config.json", cache_dir=cache_dir)` and
# `hf_hub_download(repo, "model.safetensors", cache_dir=cache_dir)`
# ONLY — the vocab is embedded in config.json and the tokenizer/vocab
# files on the repo are simply never read. A pre-download that mirrors
# EXACTLY this two-file set is therefore both the honest disk-space
# total (model.safetensors alone is 2,508,288,736 bytes = ~2.51GB live
# 2026-07-16, NOT the ~1GB an earlier estimate assumed — §B finding
# 12) and precisely what a later `from_pretrained(repo, cache_dir=
# None)` call needs — no wasted bytes on the unused tokenizer/vocab
# files, same invariant MODEL_DOWNLOAD_ALLOW_PATTERNS keeps above.
PARAKEET_REPO_ID = "mlx-community/parakeet-tdt-0.6b-v3"
PARAKEET_ALLOW_PATTERNS = ["config.json", "model.safetensors"]


def backend_for_model(model: str) -> str:
    """Pure map: model id -> which Backend serves it ("faster-whisper"
    or "parakeet-mlx") — §C 3.1's `backend_for_model`, the one
    genuinely new seam Q1 calls for. A sidecar process loads exactly
    one model for its whole lifetime (see parse_args's --model), so
    main() calls this once at startup to choose between (WhisperServer,
    JobManager(raw faster-whisper model)) — byte-unchanged — and
    (ParakeetMlxServer, JobManager(ParakeetMlxBackend)), see the
    "S12b: parakeet-mlx backend" section above WhisperServer's own job-
    API section."""
    return "parakeet-mlx" if model == PARAKEET_MODEL else "faster-whisper"


def parakeet_busy_response() -> dict[str, Any]:
    """JSON body for do_PUT /transcribe's and do_POST /ingest-url's 409
    (HTTPStatus.CONFLICT) when JobManager.start_job/start_url_job
    refuses to admit a new parakeet-backend job because the ONE shared
    parakeet workload slot (S12b fix round FB4) is already held — by a
    live ws session (ParakeetMlxServer.handle) or another already-
    running parakeet file/URL job; either way there is nothing job-
    specific to name (contrast download_conflict_response's
    active_job_id — a live SESSION has no job id to point at), so this
    takes no argument. `type` matches the ws wire event's own
    discriminator (ParakeetMlxServer.handle's "parakeet-busy") so a
    future client can recognize the SAME busy condition uniformly
    across both the ws and HTTP transports; `error` carries the exact
    zh copy the fix round specified. Whisper-model jobs/sessions are
    NEVER gated by this at all (see start_job's own isinstance check)."""
    return {
        "type": "parakeet-busy",
        "error": "本机正在实时转录，请结束后再上传",
    }


def validate_download_model(model: Any) -> Optional[str]:
    """Returns a zh error message if `model` isn't a MODEL_CHOICES
    entry, else None. Mirrors validate_ingest_url's pattern; do_POST
    /download-model uses this for its 400 response."""
    if not isinstance(model, str) or model not in MODEL_CHOICES:
        return f"未知模型：{model}"
    return None


def download_conflict_response(active_job_id: str) -> dict[str, Any]:
    """JSON body for do_POST /download-model's 409 (HTTPStatus.
    CONFLICT) when JobManager.start_download_job refuses to start a
    new download because one is already in flight (single-flight, S4
    review finding — see start_download_job's own docstring) — names
    the in-flight job so a client could poll it (GET /jobs/{id})
    instead of retrying blind. Factored out as its own pure function,
    mirroring this file's validate_download_model/
    ingest_url_display_name/etc. convention, so its shape is directly
    unit-testable without constructing a live handler — see
    test_download.py."""
    return {"error": "已有模型下载任务进行中，请稍后再试", "active_job_id": active_job_id}


def check_disk_space(total_bytes: int, check_dir: str) -> None:
    """Raises RuntimeError with a zh message if free space at
    check_dir is under total_bytes * 1.2. Called BEFORE any write by
    download_model_snapshot (decision B's disk precheck). `total_bytes`
    is already resolved by the caller (HfApi().model_info(...)) — this
    function only creates check_dir if needed (shutil.disk_usage
    requires an existing path) and does the disk_usage/compare/raise."""
    os.makedirs(check_dir, exist_ok=True)
    free = shutil.disk_usage(check_dir).free
    needed = total_bytes * 1.2
    if free < needed:
        raise RuntimeError(
            "磁盘空间不足：下载该模型预计需要约 "
            f"{needed / (1 << 30):.1f}GB 可用空间，当前仅剩 "
            f"{free / (1 << 30):.1f}GB / not enough disk space to "
            "download this model"
        )


# Static repo-id map for the 6 whisper-family MODEL_CHOICES entries —
# DELIBERATELY not a lazy `from faster_whisper.utils import _MODELS`
# lookup (S12a fix round F3, HIGH, Sol3, 2026-07-16 adversarial pair —
# docs/design-explorations/s12-mlx-blueprint.md §D). faster_whisper is
# absent from the mlx venv's lock by design (requirements-mlx.lock
# pins only parakeet-mlx + websockets; §C R1: "faster_whisper imports
# stay lazy inside FasterWhisperBackend... one file runs under either
# venv") — but the ORIGINAL lazy `_MODELS` import here still ran for
# EVERY non-parakeet model, including when this same whisper_server.py
# process is the one running under the mlx venv (S12b, parakeet
# selected). A user switching BACK to a whisper model then hit
# /download-model -> download_model_snapshot -> _repo_id_for_model,
# which raised ModuleNotFoundError even when the target model was
# already cached — stuck on parakeet with no way back. Red-confirmed
# live before this fix: `sys.modules["faster_whisper"] = None` then
# `_repo_id_for_model("medium")` raised exactly that. A static map
# needs no import at all, so this path is now venv-independent — see
# test_model_registry.py's import-blocked section, which resolves
# every non-parakeet MODEL_CHOICES id with faster_whisper made
# unimportable.
#
# Values verified live against the installed faster-whisper==1.2.1's
# own faster_whisper.utils._MODELS dict (test_model_registry.py's
# base-venv drift-guard section re-asserts this map against that same
# live dict on every run — a future faster-whisper bump that moves one
# of these entries fails that test loudly instead of silently
# drifting, the exact risk the old lazy-lookup docstring flagged).
WHISPER_REPO_IDS: dict[str, str] = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
}


def _repo_id_for_model(model: str) -> str:
    """Resolve `model` to its Hugging Face Hub repo id — the first half
    of the model->(repo_id, allow_patterns) registry (see
    _allow_patterns_for_model below for the other half). PARAKEET_MODEL
    short-circuits to its static PARAKEET_REPO_ID; every other model
    resolves via the static WHISPER_REPO_IDS map above — NO import at
    all (S12a fix round F3; see that map's own docstring for why the
    prior lazy faster_whisper.utils._MODELS lookup broke switching back
    from parakeet inside the mlx venv). Dependency-free end to end."""
    if model == PARAKEET_MODEL:
        return PARAKEET_REPO_ID

    repo_id = WHISPER_REPO_IDS.get(model)
    if repo_id is None:
        raise ValueError(f"未知模型：{model}")
    return repo_id


def _allow_patterns_for_model(model: str) -> list[str]:
    """Resolve `model` to its snapshot_download allow_patterns — the
    second half of the model->(repo_id, allow_patterns) registry (see
    _repo_id_for_model above). PARAKEET_MODEL uses PARAKEET_ALLOW_
    PATTERNS (exactly the 2 files parakeet_mlx.from_pretrained reads);
    every other model keeps MODEL_DOWNLOAD_ALLOW_PATTERNS, byte-
    identical to before S12a."""
    if model == PARAKEET_MODEL:
        return PARAKEET_ALLOW_PATTERNS
    return MODEL_DOWNLOAD_ALLOW_PATTERNS


class DownloadCancelled(Exception):
    """Raised from _raise_if_cancelled — called both from _ProgressBar.
    update() (see _make_progress_bar_class below) once a download job's
    cancel_event has been set, AND from three explicit checkpoints
    download_model_snapshot adds around its own two huggingface_hub
    calls (F3, review-round fix, Sol MEDIUM #8, live-verified ~12s
    latency — see that function's own call sites): immediately before
    HfApi().model_info(), immediately before snapshot_download(), and
    immediately after snapshot_download() returns. The tqdm-update()
    path alone (pre-F3, the ONLY checkpoint) left two dead stretches
    cancel_event was never observed in: the leading model_info metadata
    round trip (no bar exists yet to call update() on) and the gap
    between snapshot_download's own LAST update() call and the moment
    it actually returns — a cancel landing in that second gap used to
    let the job finish as "done" even though POST /jobs/{id}/cancel had
    already answered 202 (a 202-then-done race). Checked at every tqdm
    update() call across all THREE bar roles that function's own
    docstring documents (not just the "Reconstructing" bytes bar), so
    the effective latency a cancel can still see is bounded by
    whichever role's own update() cadence is tightest in practice — the
    per-chunk "Downloading bytes" transfer bar, typically — or now, one
    of the three explicit checkpoints, whichever gap this download
    happens to be in. Caught by JobManager._run_download_job, which
    turns it into the job's "cancelled" terminal status — never
    "error"; a deliberate cancel is not a failure."""


def _raise_if_cancelled(cancel_event: Optional[threading.Event]) -> None:
    """Single shared checkpoint — raises DownloadCancelled iff
    `cancel_event` is not None and set, else a no-op. Called from
    _ProgressBar.update() below AND from download_model_snapshot's own
    three explicit checkpoints (F3, review-round fix) — one helper, not
    four copies of the same two-line check, so every call site agrees
    on exactly what "cancelled" means."""
    if cancel_event is not None and cancel_event.is_set():
        raise DownloadCancelled("download cancelled")


def _make_progress_bar_class(total: int, on_progress, cancel_event: Optional[threading.Event] = None, devnull=None):
    """Build a `tqdm_class` for huggingface_hub.snapshot_download's
    `tqdm_class=` kwarg — verified LIVE against the pinned
    huggingface-hub version (see requirements-sidecar.txt) by actually
    downloading a small real repo with an instrumented shim:
    snapshot_download instantiates the class we pass for THREE
    distinct roles —
      1. a per-file "Fetching N files" counter, from tqdm.contrib.
         concurrent.thread_map, which wraps it around an iterable and
         needs the FULL real-tqdm protocol (__iter__, get_lock/
         set_lock classmethods) — this is why we subclass real tqdm
         rather than hand-roll a mimic;
      2. a network "Downloading bytes" transfer bar whose total is
         dedup/xet-adjusted and dynamically grown/snapped — NOT a
         stable denominator;
      3. a "Reconstructing (incomplete total...)" bar fed via a plain
         update(n) once per file (whether or not xet applies) for that
         file's full size, reaching a stable total = sum of file sizes.
    We forward only #3 (identified by its desc) into
    on_progress(downloaded, total) — `total` here is OUR OWN
    precomputed figure (HfApi().model_info, same number check_disk_space
    used), not the bar's own (which starts at 0 and grows as
    snapshot_download discovers each file). If a future huggingface_hub
    bump ever changes that desc string, on_progress simply stops firing
    mid-download (falls back to the single 100% call
    download_model_snapshot makes after snapshot_download returns) —
    a degraded-but-safe failure mode, not a crash; re-verify live
    (a small repo, no need for a real model) after bumping the pin.

    Must NOT set disable=True to silence rendering: real tqdm's
    update() short-circuits its `self.n += n` bookkeeping entirely
    when disabled (verified against the pinned tqdm's tqdm.std.tqdm.
    update source: `if self.disable: return` precedes it) — silently
    freezing every bar's progress at 0. Redirecting `file=` to a null
    sink suppresses the actual bar output instead, without touching
    that bookkeeping.

    `cancel_event` (field-test issue 6): checked at the TOP of every
    update() call (via _raise_if_cancelled) — see DownloadCancelled's
    own doc comment for why this is unconditional (every bar role), not
    gated behind `self._is_bytes` the way the on_progress forward below
    is. `None` (every pre-cancel caller, e.g. run_download_only's
    first-run --download-only path, which is killed at the OS-process
    level by Rust's cancel_prewarm instead — see server.rs) never
    raises.

    `devnull` (F6, review-round fix): an already-open write-mode file
    object every bar's own `file=` kwarg redirects to (see "Must NOT set
    disable=True" above for why redirecting output, rather than
    disabling, is how this class silences rendering) — shared by every
    bar instance THIS one `tqdm_class=` produces (snapshot_download
    constructs several, see this docstring's own "THREE distinct
    roles"). Threaded in rather than opened here so the CALLER
    (download_model_snapshot, the only production call site — a
    long-lived sidecar process makes many downloads over its lifetime)
    owns closing it exactly once, in its own finally, instead of this
    function leaking one os.devnull fd per download with no owner ever
    closing it. `None` (every direct test-only caller in
    test_download.py, none of which run inside a long-lived process)
    falls back to opening+leaving-open a private handle, byte-identical
    to this function's behavior before this fix.
    """
    from tqdm.auto import tqdm as _tqdm

    devnull_handle = devnull if devnull is not None else open(os.devnull, "w")

    class _ProgressBar(_tqdm):
        def __init__(self, *args, **kwargs):
            kwargs.setdefault("file", devnull_handle)
            super().__init__(*args, **kwargs)
            self._is_bytes = kwargs.get("unit") == "B" and str(
                kwargs.get("desc", "")
            ).startswith("Reconstructing")

        def update(self, n=1):
            _raise_if_cancelled(cancel_event)
            result = super().update(n)
            if self._is_bytes:
                on_progress(self.n, total)
            return result

    return _ProgressBar


def download_model_snapshot(
    model: str,
    on_progress=None,
    hf_token: Optional[str] = None,
    cancel_event: Optional[threading.Event] = None,
) -> str:
    """Download one model's snapshot from the Hugging Face Hub —
    faster-whisper's CT2 snapshot, or (S12a) parakeet's config.json +
    model.safetensors pair — reporting cumulative progress via
    on_progress(downloaded_bytes, total_bytes) as it goes (best-effort
    granularity — see _make_progress_bar_class; always called once
    more with (total, total) at the very end, so a caller always sees
    100% on success even if no finer-grained call ever fired). Shared
    by --download-only (first-run one-shot, see run_download_only) and
    JobManager.start_download_job (:8766 model-switch job) — decision B
    of docs/design-explorations/s4-model-wizard-blueprint.md: "one
    shared helper, only invocation + progress transport differ."
    repo_id/allow_patterns come from the model->(repo_id, allow_
    patterns) registry (_repo_id_for_model/_allow_patterns_for_model
    above, s12-mlx-blueprint.md §C R1).

    Runs under the process's own HF_HOME (set by the Rust launcher
    exactly like load_model()'s WhisperModel(...) call already relies
    on) — no explicit cache_dir override here, for the same reason; a
    later load_model() (faster-whisper) or ParakeetMlxBackend's
    from_pretrained(repo, cache_dir=None) (S12b) call finds this
    snapshot already cached under the SAME root, because neither this
    function nor either loader ever passes an explicit cache_dir —
    both resolve huggingface_hub's own default (HF_HUB_CACHE, itself
    derived from HF_HOME) identically. Introducing a divergent
    cache_dir here would silently break that and trigger a second
    full download at load time (s12-mlx-blueprint.md §B finding 10 —
    the exact bug this invariant avoids); see test_download.py's cache-
    root-invariant section.

    `hf_token` (S12a Q6/F11): threaded from the caller's own --hf-token/
    $HF_TOKEN (JobManager.self.hf_token / args.hf_token — the SAME
    token diarization already falls back to) into BOTH the metadata
    call and the actual snapshot_download, raising rate limits and
    improving resumption reliability for a large anonymous pull (her
    18%-stall field incident, 2026-07-13). `token=None` (the default)
    is not a behavior change from before this parameter existed —
    huggingface_hub's own build_hf_headers still falls back to reading
    $HF_TOKEN/the cached login token implicitly in that case — this
    param just makes an explicit CLI/Settings-supplied token
    deterministic rather than relying on that implicit resolution.

    Raises RuntimeError with a zh message if free disk space is short
    (checked BEFORE any write — see check_disk_space), or re-raises
    whatever huggingface_hub/httpx raises on a network/repo failure —
    the caller (JobManager._run_download_job or run_download_only)
    turns either into job.error / a download_error line.

    `cancel_event` (field-test issue 6, JobManager.start_download_job
    only — run_download_only never passes one; see that function's own
    doc comment) is threaded straight into _make_progress_bar_class,
    which raises DownloadCancelled from inside hf_snapshot_download's
    own tqdm_class callbacks the next time the flag is observed set —
    propagates straight out of this function uncaught (the caller,
    JobManager._run_download_job, is what catches it). F3 (review-round
    fix, Sol MEDIUM #8): the tqdm-callback path alone left two dead
    stretches where a cancel was never observed — this function ALSO
    checks cancel_event (via _raise_if_cancelled) immediately before
    the model_info metadata call, immediately before snapshot_download,
    and immediately after snapshot_download returns — see those three
    call sites below, and DownloadCancelled's own doc comment for the
    202-then-done race the third one closes."""
    from huggingface_hub import HfApi
    from huggingface_hub import constants as hf_constants
    from huggingface_hub import snapshot_download as hf_snapshot_download

    repo_id = _repo_id_for_model(model)
    allow_patterns = _allow_patterns_for_model(model)

    # F3 checkpoint (a): before the metadata round trip even starts —
    # the dead stretch _ProgressBar.update() (pre-fix, the only
    # checkpoint) could never observe, since no bar exists yet.
    _raise_if_cancelled(cancel_event)
    info = HfApi().model_info(repo_id, files_metadata=True, token=hf_token)
    total = sum(
        sibling.size or 0
        for sibling in info.siblings or []
        if any(
            fnmatch.fnmatch(sibling.rfilename, pattern)
            for pattern in allow_patterns
        )
    )

    # Disk precheck — BEFORE any write. hf_constants.HF_HUB_CACHE is
    # exactly the directory snapshot_download itself resolves to below
    # (we don't pass cache_dir, so it defaults the same way), which is
    # itself derived from HF_HOME — respected exactly as load_model()'s
    # WhisperModel(...) call already relies on. `total` here is already
    # the honest per-model figure (allow_patterns-filtered — ~2.51GB
    # for parakeet, not a stale ~1GB estimate — s12-mlx-blueprint.md §B
    # finding 12), so this ×1.2 precheck floor is honest too.
    check_disk_space(total, hf_constants.HF_HUB_CACHE)

    # F6 (review-round fix): devnull is THIS function's own resource —
    # opened right before the first bar can possibly be constructed,
    # closed in the finally below on every exit path (success,
    # DownloadCancelled, or any other snapshot_download failure) —
    # see _make_progress_bar_class's own `devnull` param doc for why
    # the handle is threaded in rather than left for that function to
    # open (and never close) itself once per download.
    devnull = open(os.devnull, "w")
    try:
        progress_bar_cls = _make_progress_bar_class(
            total, on_progress or (lambda d, t: None), cancel_event=cancel_event, devnull=devnull
        )
        # F3 checkpoint (b): immediately before the actual transfer
        # starts.
        _raise_if_cancelled(cancel_event)
        hf_snapshot_download(
            repo_id,
            allow_patterns=allow_patterns,
            token=hf_token,
            tqdm_class=progress_bar_cls,
        )
        # F3 checkpoint (c): AFTER snapshot_download returns, before
        # this function ever reports success back to its caller
        # (JobManager._run_download_job marks the job "done" right
        # after this call returns normally) — closes the 202-then-done
        # race: a cancel landing after the last tqdm update() callback
        # but before hf_snapshot_download actually returns must still
        # end the job "cancelled," never "done."
        _raise_if_cancelled(cancel_event)
    finally:
        devnull.close()

    if on_progress is not None:
        on_progress(total, total)
    return repo_id


def should_emit_download_progress(
    *, now: float, last_emit: float, percent: int, last_percent: int
) -> bool:
    """Throttle rule for --download-only's NDJSON progress lines: "~1
    line/500ms or on whole-percent change" (the Rust side parses
    stdout line-by-line — see run_download_only) — emit if EITHER at
    least 500ms have passed since the last line OR the whole-percent
    value actually changed, so a percent transition is never silently
    dropped even if it lands inside the same 500ms window as the
    previous emit."""
    return (now - last_emit >= 0.5) or (percent != last_percent)


def run_download_only(model: str, hf_token: Optional[str] = None) -> bool:
    """--download-only mode body (decision B's first-run one-shot
    path, see main()): run download_model_snapshot, emitting
    newline-delimited JSON progress lines to stdout for the Rust
    launcher to parse (line-based — see docs/design-explorations/
    s4-model-wizard-blueprint.md's Anchors: tqdm's own \\r bars won't
    survive run_venv_python_streaming), then a final download_done/
    download_error line. Returns True on success, False on failure —
    main() turns this into the process exit code. `hf_token` (S12a
    Q6): threaded straight from args.hf_token (--hf-token/$HF_TOKEN,
    see parse_args) into download_model_snapshot."""
    last_emit = 0.0
    last_percent = -1

    def on_progress(downloaded: int, total: int) -> None:
        nonlocal last_emit, last_percent
        now = time.monotonic()
        percent = int(downloaded * 100 / total) if total else 0
        if not should_emit_download_progress(
            now=now, last_emit=last_emit, percent=percent, last_percent=last_percent
        ):
            return
        last_emit = now
        last_percent = percent
        print(
            json.dumps({"type": "download_progress", "downloaded": downloaded, "total": total}),
            flush=True,
        )

    try:
        download_model_snapshot(model, on_progress, hf_token=hf_token)
    except Exception as exc:  # noqa: BLE001 - report any failure to the launcher
        print(json.dumps({"type": "download_error", "message": str(exc)}), flush=True)
        return False
    print(json.dumps({"type": "download_done"}), flush=True)
    return True


def load_model(model_name: str, device: str, compute_type: str):
    """Load the faster-whisper model once at startup and time it."""
    from faster_whisper import WhisperModel

    start = time.monotonic()
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    load_seconds = time.monotonic() - start
    return model, load_seconds


# =================================================================
# S13 hotfix (v0.4.4 field report: "huge python RAM usage even after
# transcription finished" — a 系统识别/osspeech user who never touches
# the whisper sidecar still got it fully loaded, every launch, because
# an already-provisioned install's STARTING path (bootstrap.ts)
# restarts the sidecar unconditionally regardless of which STT engine
# is actually persisted — the S11 "park dormant" gate only covers a
# FRESH NEEDS_PROVISION decision, not this case; see that file's own
# SIDECAR_ENGINES/getDesktopEngine wiring). Classic faster-whisper
# backend ONLY — ParakeetMlxBackend above is untouched by this hotfix
# (a different beast: MLX weights bound to a dedicated executor
# thread, no ctranslate2 involved at all).
#
# Opt-in via --lazy-load (parse_args below): main() constructs THIS
# wrapper instead of calling load_model() eagerly at boot, and passes
# it as the SAME `model=` constructor arg WhisperServer/JobManager
# already take. Every isinstance(self.model, LazyWhisperModel) check
# added by this hotfix (WhisperServer.handle, JobManager._run_job/
# _run_url_job) mirrors JobManager's own pre-existing isinstance(self.
# model, ParakeetMlxBackend) idiom exactly — so the eager path (flag
# absent: main() calls load_model() directly and passes the RAW
# faster-whisper WhisperModel, exactly as before this hotfix) hits
# isinstance(..., LazyWhisperModel) == False everywhere and is
# otherwise completely untouched: zero behavior change, byte-identical
# spawn/runtime path.
#
# Verified LIVE (2026-07-16, sidecar/.venv against the already-cached
# Systran/faster-whisper-medium snapshot in ~/.cache/huggingface, no
# network): ctranslate2.models.Whisper's OWN unload_model()/
# load_model() pair (the seemingly "correct" API for exactly this
# warm-swap use case — faster_whisper.WhisperModel.model IS a
# ctranslate2.models.Whisper) does NOT actually shrink process RSS in
# practice — its own docstring's "keep enough runtime context to
# quickly resume" is apparently doing exactly that, keeping memory
# resident (measured: RSS unchanged across an unload_model() + explicit
# gc.collect() call). What DOES work: dropping the WHOLE WhisperModel
# Python wrapper (`self._model = None`) + gc.collect() — measured
# ~2.3GB -> ~1.6GB RSS on a real medium/int8 load -> transcribe ->
# unload cycle, repeatable across two full load/unload cycles with no
# growth. The ~1.6GB floor (not a full return to the ~220MB pre-load
# baseline) is an accepted partial-credit outcome — native-allocator
# arena retention (ctranslate2/oneDNN/BLAS thread pools), not a leak —
# still a substantial, real fix for the field-reported symptom.
# Reloading after an unload therefore reconstructs a FRESH WhisperModel
# via this file's own load_model() above (the exact same call the
# eager path makes at boot), rather than trying to reuse ctranslate2's
# own faster-but-apparently-non-freeing resume path.
# =================================================================

IDLE_UNLOAD_MINUTES = 15.0  # --lazy-load only: default idle window (LazyWhisperModel.release) before releasing the loaded model; a plain constant per this hotfix's own spec (no new CLI flag needed)


class LazyWhisperModel:
    """Opt-in (--lazy-load only) wrapper around a faster-whisper
    WhisperModel: defers the actual load (this file's own load_model())
    until first use, and releases it again after IDLE_UNLOAD_MINUTES of
    zero "active work" (see acquire/release below). Exposes ONE proxy
    method — `.transcribe(*args, **kwargs)` — matching the raw
    WhisperModel's own call signature exactly, so NEITHER of this
    file's two real call sites (WhisperServer._transcribe, JobManager.
    _transcribe_job's faster-whisper branch) needs to change beyond
    main() constructing this wrapper instead of the raw model.

    `_lock` deliberately guards `_model`/`_active_count`/`_idle_timer`
    TOGETHER (not three separate locks) — this is what makes "never
    unload mid-job" actually hold: `_on_idle_timeout` (the threading.
    Timer callback) and a competing `acquire()` can never observe each
    other's half-finished state, since whichever reaches the lock first
    completes its entire critical section (including, for
    `_on_idle_timeout`, the unload itself) before the other proceeds."""

    def __init__(
        self,
        model_name: str,
        device: str,
        compute_type: str,
        *,
        idle_unload_seconds: float = IDLE_UNLOAD_MINUTES * 60.0,
    ) -> None:
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        # Overridable ONLY for tests (see test_lazy_load.py) — every
        # real caller (main()) uses the IDLE_UNLOAD_MINUTES default.
        self.idle_unload_seconds = idle_unload_seconds
        self._model: Any = None
        self._active_count = 0
        self._lock = threading.Lock()
        self._idle_timer: Optional[threading.Timer] = None
        # F7 fix (Sol, MINOR): monotonically-increasing identity for
        # whichever timer is CURRENTLY armed — see _start_idle_timer_
        # locked/_on_idle_timeout below for why a stale callback needs
        # this to detect it's been superseded.
        self._timer_generation = 0

    def transcribe(self, *args, **kwargs):
        """Proxy for WhisperModel.transcribe — same call signature/
        return shape both real call sites already use (see this
        class's own docstring), so neither needs to change beyond
        main() constructing this wrapper instead of the raw model.
        Ensures the model is loaded first (blocking only on the FIRST
        call, or the first call after an idle-unload; every other call
        sees an already-warm model)."""
        self.ensure_loaded()
        return self._model.transcribe(*args, **kwargs)

    def ensure_loaded(self) -> None:
        """Loads the model if it isn't currently resident. Safe to
        call from any thread — double-checked under `_lock` so two
        callers racing the very first load only ever pay for one
        actual load_model() call (the second simply finds `_model`
        already set once it acquires the lock).

        F8 fix (Sol, MINOR — wrong operational advice on a load
        failure): this is the ONE load site both real call paths
        (transcribe()'s direct call, and acquire()'s call below — which
        covers BOTH WhisperServer.handle's ws path and JobManager.
        _run_job/_run_url_job's job path) go through, so wrapping the
        exception here exactly once is enough for either path to carry
        it. A load failure (corrupt/missing model files, OOM, etc.) is
        re-raised prefixed with the literal Chinese string "模型加载失败："
        (model load failed:) followed by the original exception's own
        message — this is a WIRE CONTRACT the client-side code matches
        on verbatim to tell a load failure (server was reachable, the
        job/connection was accepted) apart from an actual "can't reach
        the sidecar at all" failure, which gets different advice.
        `self._model` is never assigned on this path (the exception
        fires before that line runs), so it's left exactly as it was —
        None on a first-ever load, meaning the NEXT ensure_loaded() call
        (via the next acquire()/transcribe()) retries a fresh load from
        scratch; never double-wrapped, since each retry wraps whatever
        THAT attempt's own load_model() call raises, not a previous
        wrapped message."""
        with self._lock:
            if self._model is None:
                try:
                    self._model, _ = load_model(self.model_name, self.device, self.compute_type)
                except Exception as exc:  # noqa: BLE001 - wrap once here; see docstring's WIRE CONTRACT note
                    raise RuntimeError(f"模型加载失败：{exc}") from exc

    def acquire(self) -> None:
        """Call at the start of one unit of "active work" (a live ws
        connection opening, or a file/URL job starting/queued) —
        WhisperServer.handle and JobManager._run_job/_run_url_job each
        call this exactly once, paired with exactly one LATER release()
        call regardless of how that unit of work ends (success, error,
        or a crash mid-job — see each call site's own try/finally).

        Increments the counter FIRST (a fast, non-raising, lock-
        protected step) and only THEN attempts the load — so a load
        failure (this method's own `ensure_loaded()` call, which DOES
        propagate) still leaves the counter correctly incremented,
        keeping every acquire() unconditionally pairable with exactly
        one later release() regardless of whether the load itself
        succeeds (the caller's own existing error handling — a ws
        connection closing uncleanly, or a job's `except Exception` —
        already covers a load failure like any other per-connection/
        per-job exception; this class only needs its OWN bookkeeping to
        stay consistent either way).

        Also cancels any pending idle-unload countdown (see release())
        — a fresh unit of work arriving mid-countdown must never let
        that countdown fire out from under it; see _cancel_idle_timer_
        locked."""
        with self._lock:
            self._active_count += 1
            self._cancel_idle_timer_locked()
        self.ensure_loaded()

    def release(self) -> None:
        """Call at the end of one unit of work. Once the LAST active
        unit ends (count reaches 0), arms a fresh IDLE_UNLOAD_MINUTES
        countdown (see _start_idle_timer_locked/_on_idle_timeout) —
        never while count > 0, and any later acquire() cancels a
        pending one outright, so the countdown genuinely restarts on
        every fresh burst of activity rather than ever firing mid-job.
        Clamped at 0 (never negative) so this stays safe to call
        exactly once per acquire() even on an unusual exit path."""
        with self._lock:
            self._active_count = max(0, self._active_count - 1)
            if self._active_count == 0 and self._model is not None:
                self._start_idle_timer_locked()

    def _cancel_idle_timer_locked(self) -> None:
        if self._idle_timer is not None:
            self._idle_timer.cancel()
            self._idle_timer = None

    def _start_idle_timer_locked(self) -> None:
        self._cancel_idle_timer_locked()
        # F7 fix (Sol, MINOR — stale-timer-unloads-a-freshly-used-model):
        # every freshly-armed timer gets its OWN identity, captured here
        # and handed to its callback as an argument (NOT read back off
        # `self._idle_timer` inside the callback — that attribute is
        # exactly what a stale callback would otherwise misread as "me").
        # See _on_idle_timeout's own docstring for the race this closes.
        self._timer_generation += 1
        generation = self._timer_generation
        timer = threading.Timer(self.idle_unload_seconds, self._on_idle_timeout, args=(generation,))
        timer.daemon = True
        self._idle_timer = timer
        timer.start()

    def _on_idle_timeout(self, generation: int) -> None:
        """threading.Timer's own callback thread. `generation` is the
        identity _start_idle_timer_locked captured at ARM time for
        exactly this timer instance.

        F7 fix (Sol, MINOR): the pre-fix version re-checked only
        `_active_count`, which misses a real (if narrow) race — Timer A
        fires and blocks on `_lock`; meanwhile a fresh unit of work
        arrives, cancels A (too late: A already fired and is just
        waiting on the lock), completes its OWN work, and installs
        Timer B via a fresh release(). Once A finally gets the lock,
        `_active_count` is back to 0 (B's own work already finished) —
        so the old bare active_count check would wrongly let A unload
        the model B is now responsible for, breaking the promised idle
        window and forcing an avoidable cold reload. Comparing
        `generation` against `self._timer_generation` (both read/written
        only under `_lock`) catches this: A's captured generation is
        stale the instant ANY newer timer (B) has been armed, regardless
        of whether A's own cancel() call landed in time — so A returns
        here without touching `_model`/`_idle_timer` at all, leaving B
        (and its own countdown) completely intact.

        Also re-checks `_active_count` same as before — a fresh
        acquire() that beat this callback to the lock (however narrow
        the race) means active work is underway RIGHT NOW; acquire()
        already cancels this exact timer instance in the overwhelmingly
        common case (see _cancel_idle_timer_locked), so reaching this
        method at all already means the timer fired before any such
        cancel() landed — this check remains the belt for that
        vanishingly narrow race, not the primary mechanism (the
        generation check above is what closes the specific bug this
        fix addresses)."""
        with self._lock:
            if generation != self._timer_generation:
                return  # stale callback — a newer timer (or fresh activity) has since superseded this one
            if self._active_count > 0:
                return
            self._idle_timer = None
            if self._model is None:
                return  # nothing loaded (e.g. every acquire() so far failed to load) — nothing to unload
            self._model = None
        # Outside the lock: gc.collect() is a global, thread-safe
        # operation (see class docstring) — never needs to serialize
        # against a concurrent acquire()/ensure_loaded() reload, which
        # would simply construct a brand-new, fully-reachable
        # WhisperModel this collection pass can't and shouldn't touch.
        gc.collect()


def normalize_hf_token(token: Optional[str]) -> Optional[str]:
    """Normalize an --hf-token/$HF_TOKEN value (S12a fix round F8,
    LOW, Sol8 — docs/design-explorations/s12-mlx-blueprint.md §D): a
    whitespace-only string ("   ") is truthy in Python, so left un-
    normalized it would make print_banner's `diarize_enabled=bool(
    args.hf_token)` advertise diarization as armed, and every down-
    stream consumer (WhisperServer.default_hf_token/JobManager.
    hf_token/run_download_only's hf_token) would send that garbage as
    an actual Authorization value on real requests. Also strips
    surrounding whitespace off a non-blank token (cheap hygiene
    against an accidentally pasted trailing newline/space) — mirrors
    F8's Rust half in the same direction (server.rs trims + omits
    before setting $HF_TOKEN in the spawn env, so a blank Settings
    field never becomes a truthy env var in the first place). Returns
    None for None, "", or an all-whitespace string; otherwise the
    stripped token. parse_args() below is this file's ONE call site —
    --hf-token's own argparse default already unifies the CLI value
    and the $HF_TOKEN env fallback into the single args.hf_token
    attribute (`default=os.environ.get("HF_TOKEN")` on that argument,
    below), so normalizing it once there covers both sources; no
    downstream code needs its own whitespace check."""
    if token is None:
        return None
    stripped = token.strip()
    return stripped or None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "JargonSlayer 本地 Whisper 转录服务 / JargonSlayer local Whisper "
            "transcription sidecar (privacy mode, all audio stays on "
            "this machine)."
        )
    )
    parser.add_argument(
        "--model",
        default="small",
        choices=MODEL_CHOICES,
        help="Whisper 模型大小 / model size (default: small)",
    )
    parser.add_argument(
        "--port", type=int, default=8765, help="监听端口 / listen port (default: 8765)"
    )
    parser.add_argument(
        "--http-port",
        type=int,
        default=8766,
        help=(
            "录音上传任务 API 端口 / upload-a-recording job API HTTP "
            "port (default: 8766)"
        ),
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="监听地址 / listen host (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--language",
        default="en",
        help="默认识别语言 / default transcription language code (default: en)",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cpu", "cuda"],
        help="推理设备 / inference device (default: auto)",
    )
    parser.add_argument(
        "--compute",
        default="int8",
        help="计算精度 / compute type, e.g. int8, float16, float32 (default: int8)",
    )
    parser.add_argument(
        "--lazy-load",
        action="store_true",
        default=False,
        help=(
            "经典 faster-whisper 模型（--model 非 parakeet 时）延迟到首次实际"
            "使用（ws 连接或文件/URL 任务）才加载，而非默认的启动时立即加载"
            "（LazyWhisperModel，见本文件同名类注释）；配合空闲释放一起使用"
            f"（默认 {int(IDLE_UNLOAD_MINUTES)} 分钟内零活跃连接/任务后自动释放"
            "已加载模型，下次使用再加载），供未使用本地 Whisper 的引擎（如系统"
            "识别）在已预置安装的情况下也不必让 sidecar 常驻多 GB 内存 / defer "
            "the classic faster-whisper model's load (--model, when NOT a "
            "parakeet id) until first actual use (a ws connection or a "
            "file/URL job), instead of eagerly loading it at boot — pairs "
            "with idle-unload (releases the loaded model after "
            f"{int(IDLE_UNLOAD_MINUTES)} idle minutes with zero active "
            "connections/jobs, reloading again on next use) so a launch "
            "whose configured STT engine never actually needs the sidecar "
            "(e.g. 系统识别/osspeech) doesn't keep multi-GB of RAM resident "
            "for nothing. Never affects a parakeet-mlx model (always eager "
            "— see ParakeetMlxBackend). Default: off (eager) — byte-"
            "identical to every pre-existing launch of this file"
        ),
    )
    parser.add_argument(
        "--save-audio",
        default=None,
        metavar="PATH",
        help=(
            "将收到的全部 PCM 追加写入该 WAV 文件，供会后转录/说话人分离使用 "
            "/ append all received PCM to this WAV file for post-meeting "
            "diarization (optional)"
        ),
    )
    parser.add_argument(
        "--partials",
        action="store_true",
        default=False,
        help=(
            "启用滚动中间转录（每 ~2 秒一次）的服务端默认值——现由 App 内设置"
            "「实时转录预览」按连接控制（config 消息的 partials 字段），本参数"
            "仅在旧版 App 未发送该字段时生效 / server-wide default for rolling "
            "partial transcriptions every ~2s during active speech; the app's "
            "own 实时转录预览 setting now overrides this per connection (config "
            "message's partials field) — this flag only matters as the "
            "fallback for an old app build that never sends it (default: off)"
        ),
    )
    parser.add_argument(
        "--hf-token",
        default=os.environ.get("HF_TOKEN"),
        metavar="TOKEN",
        help=(
            "Hugging Face token，启用录音上传的说话人分离（可选，需先在 "
            "pyannote/speaker-diarization-3.1 模型页接受协议）/ Hugging "
            "Face token to enable optional speaker diarization for "
            "uploaded recordings (falls back to $HF_TOKEN env var; "
            "requires `pip install pyannote.audio` + accepting the "
            "model license on Hugging Face)"
        ),
    )
    parser.add_argument(
        "--download-only",
        action="store_true",
        default=False,
        help=(
            "仅下载 --model 指定的模型后退出，不启动服务、不占用端口 / "
            "download the --model snapshot and exit, without starting "
            "the server or binding any port (first-run one-shot path — "
            "see download_model_snapshot/run_download_only; prints "
            "newline-delimited JSON progress to stdout)"
        ),
    )
    args = parser.parse_args()
    # S12a fix round F8: normalize ONCE here — see normalize_hf_token's
    # own docstring — so every downstream consumer reads an already-
    # normalized value.
    args.hf_token = normalize_hf_token(args.hf_token)
    return args


def print_banner(
    model_name: str,
    device: str,
    load_seconds: float,
    host: str,
    port: int,
    http_port: int,
    diarize_enabled: bool,
    lazy: bool = False,
) -> None:
    print("=" * 60)
    print("JargonSlayer 本地 Whisper 服务 / local Whisper sidecar")
    print(f"  model:     {model_name}")
    print(f"  device:    {device}")
    # S13 hotfix: `lazy` defaults False so the parakeet call site below
    # (which never passes this kwarg) and every pre-hotfix caller print
    # the exact same "load: Xs" line as before — only an explicit
    # lazy=True (main()'s own --lazy-load branch) swaps it for a fixed
    # line, since load_seconds has no real meaning yet (nothing loaded).
    if lazy:
        print("  load:      lazy（首次使用时加载）/ lazy (loads on first use)")
    else:
        print(f"  load:      {load_seconds:.2f}s")
    print(f"  diarize:   {'on' if diarize_enabled else 'off'}")
    print(f"ws://{host}:{port} 等待连接 — 在 JargonSlayer 设置中选择「本地 Whisper」")
    print(
        f"http://{host}:{http_port} 录音上传任务 API — "
        "PUT /transcribe, POST /ingest-url, GET /jobs"
    )
    print("=" * 60)


async def main() -> None:
    args = parse_args()

    if args.download_only:
        # First-run one-shot (decision B) — pure download, no server/
        # port at all; skips load_model()/run_http_server()/
        # websockets.serve() entirely. See run_download_only.
        ok = run_download_only(args.model, hf_token=args.hf_token)
        sys.exit(0 if ok else 1)

    # S12b: backend_for_model decides ONCE, at startup, which of the
    # two backends this whole process runs (a sidecar process loads
    # exactly one model for its lifetime) — see the "S12b: parakeet-mlx
    # backend" section above WhisperServer's own job-API section.
    if backend_for_model(args.model) == "parakeet-mlx":
        backend = ParakeetMlxBackend(args.model)
        load_seconds = backend.load()
        print_banner(
            args.model,
            "mlx (Metal)",
            load_seconds,
            args.host,
            args.port,
            args.http_port,
            diarize_enabled=False,  # not implemented for parakeet, S12b
        )

        server: Any = ParakeetMlxServer(
            backend=backend,
            default_language=args.language,
            emit_partials=args.partials,
            save_audio_path=args.save_audio,
        )
        job_manager = JobManager(
            model=backend,
            model_name=args.model,
            default_language=args.language,
            hf_token=args.hf_token,
        )
    else:
        if args.lazy_load:
            # S13 hotfix (--lazy-load, classic faster-whisper backend
            # only — see LazyWhisperModel's own module-section
            # docstring above): skip load_model() entirely here — the
            # model loads on FIRST actual use (a ws connection or a
            # file/URL job), not at boot. `load_seconds` has no real
            # meaning yet (nothing was loaded), hence print_banner's
            # own lazy=True branch below prints a fixed line instead of
            # a measured Xs figure.
            model: Any = LazyWhisperModel(args.model, args.device, args.compute)
            load_seconds = 0.0
        else:
            model, load_seconds = load_model(args.model, args.device, args.compute)
        print_banner(
            args.model,
            args.device,
            load_seconds,
            args.host,
            args.port,
            args.http_port,
            diarize_enabled=bool(args.hf_token),
            lazy=args.lazy_load,
        )

        server = WhisperServer(
            model=model,
            default_language=args.language,
            emit_partials=args.partials,
            save_audio_path=args.save_audio,
            default_hf_token=args.hf_token,
        )

        job_manager = JobManager(
            model=model,
            model_name=args.model,
            default_language=args.language,
            hf_token=args.hf_token,
        )
    # Job API runs on its own daemon thread — http.server is blocking/
    # synchronous, so it can't share the asyncio event loop below.
    httpd = run_http_server(args.host, args.http_port, job_manager, args.language)

    try:
        async with websockets.serve(server.handle, args.host, args.port):
            await asyncio.Future()  # run forever
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n已停止 / stopped.")
