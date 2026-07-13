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
    - text frame: JSON {"type": "partial", "text": "..."}      (optional)
    - text frame: JSON {"type": "final", "text": "...",
                         "start": <seconds>, "end": <seconds>,
                         "seg_id": <int>}
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
import fnmatch
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
                text = await asyncio.to_thread(self._transcribe, audio, state.language)
            except Exception as exc:  # noqa: BLE001 - a partial preview is best-effort;
                # never worth tearing down the connection over.
                print(f"[whisper_server] partial transcription failed: {exc}")
                return
            if text:
                await self._safe_send(ws, state, {"type": "partial", "text": text})
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
                text = await asyncio.to_thread(self._transcribe, job.audio, state.language)
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

    def _transcribe(self, audio: np.ndarray, language: str) -> str:
        segments, _info = self.model.transcribe(
            audio,
            language=language,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
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
        "status": "queued",  # queued | running | done | error
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
    holds, without any extra I/O — mirrors count_active_url_jobs."""
    for job in jobs.values():
        if job.get("kind") == "download" and job.get("status") not in ("done", "error"):
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
    ) -> str:
        """Register a queued job and kick off its background worker
        thread. Returns the job id immediately (non-blocking).

        `diarize`: caller's diarize=0|1 query param, or None to fall
        back to the default (on iff any token is available). `hf_token`:
        this job's hf_token= query param — localhost-only transport, so
        passing it per-request (rather than only via --hf-token/HF_TOKEN
        at process start) is fine; it's preferred over the CLI/env token
        for this job when present."""
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
            args=(job_id, file_path, language or self.default_language, effective_token),
            daemon=True,
        )
        thread.start()
        return job_id

    def _run_job(
        self, job_id: str, file_path: str, language: str, hf_token: Optional[str]
    ) -> None:
        try:
            self._set(job_id, status="running")
            self._transcribe_job(job_id, file_path, language)

            job = self.get(job_id)
            if job is not None and job["diarize_requested"]:
                self._diarize_job(job_id, file_path, hf_token)

            self._set(job_id, status="done", progress=1.0, status_detail=None)
        except Exception as exc:  # noqa: BLE001 - report any failure to the client
            self._set(job_id, status="error", error=str(exc))
        finally:
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
    ) -> str:
        """Register a queued URL-import (#43 phase 2c, LOCAL TIER ONLY)
        job and kick off its background worker thread. Returns the job
        id immediately (non-blocking) — mirrors start_job's contract
        exactly, only the acquisition method differs (yt-dlp download
        instead of an already-uploaded file); everything downstream
        (transcribe, diarize, cleanup) reuses _transcribe_job/
        _diarize_job unchanged, called from _run_url_job below instead
        of _run_job."""
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
            args=(job_id, url, language or self.default_language, effective_token),
            daemon=True,
        )
        thread.start()
        return job_id

    def _run_url_job(
        self, job_id: str, url: str, language: str, hf_token: Optional[str]
    ) -> None:
        """Download phase (yt-dlp) followed by the SAME transcribe/
        diarize phases _run_job uses — progress 0-0.3 for the
        download, 0.3-1.0 for transcription (DIARIZE_HOLD_PROGRESS
        still governs the diarization hold within that range, exactly
        as for an uploaded file)."""
        tmp_dir = tempfile.mkdtemp(prefix="jargonslayer-ingest-")
        try:
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
            )

            job = self.get(job_id)
            if job is not None and job["diarize_requested"]:
                self._diarize_job(job_id, file_path, hf_token)

            self._set(job_id, status="done", progress=1.0, status_detail=None)
        except Exception as exc:  # noqa: BLE001 - report any failure to the client
            self._set(job_id, status="error", error=str(exc))
        finally:
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

        thread = threading.Thread(
            target=self._run_download_job,
            args=(job_id, model),
            daemon=True,
        )
        thread.start()
        return job_id, None

    def _run_download_job(self, job_id: str, model: str) -> None:
        def on_progress(downloaded: int, total: int) -> None:
            progress = min(downloaded / total, 1.0) if total else 0.0
            self._set(job_id, progress=progress)

        try:
            self._set(job_id, status="running", status_detail="下载中")
            download_model_snapshot(model, on_progress)
            self._set(job_id, status="done", progress=1.0, status_detail=None)
        except Exception as exc:  # noqa: BLE001 - report any failure to the client
            self._set(job_id, status="error", error=str(exc))

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
    ) -> None:
        """`progress_floor`: for the upload path (default 0.0, the
        only caller until #43 phase 2c) transcription progress maps
        into [0, DIARIZE_HOLD_PROGRESS] exactly as before. The URL-
        import path (_run_url_job) passes INGEST_DOWNLOAD_HOLD_PROGRESS
        so the download phase's own [0, floor] range is never
        overwritten — transcription then maps into
        [floor, floor + (1 - floor) * DIARIZE_HOLD_PROGRESS], still
        reserving its own tail for the diarization-hold phase exactly
        as the plain floor=0.0 case does."""
        segments_gen, info = self.model.transcribe(
            file_path,
            language=language,
            beam_size=1,
            vad_filter=True,
            word_timestamps=False,
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
                tmp_path, language, diarize=diarize, hf_token=hf_token
            )
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

            job_id = job_manager.start_url_job(
                url, language, diarize=diarize, hf_token=hf_token
            )
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
# transport differ." Every huggingface_hub/faster_whisper/tqdm import
# below is deferred into the function that needs it (mirrors
# load_model()'s own lazy `from faster_whisper import WhisperModel`)
# so importing this module itself stays independent of the ML stack —
# every OTHER test file relies on that already.
# =================================================================

MODEL_CHOICES = ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"]

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


def _repo_id_for_model(model: str) -> str:
    """Resolve `model` to its Hugging Face Hub repo id the SAME way
    faster-whisper's own WhisperModel(model) does internally — reuses
    faster_whisper.utils._MODELS directly (verified against the pinned
    faster-whisper==1.2.1: utils.download_model looks up this exact
    dict) rather than hand-duplicating the mapping, so a future
    faster-whisper bump that changes an entry can't silently drift the
    two out of sync."""
    from faster_whisper.utils import _MODELS

    repo_id = _MODELS.get(model)
    if repo_id is None:
        raise ValueError(f"未知模型：{model}")
    return repo_id


def _make_progress_bar_class(total: int, on_progress):
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
    """
    from tqdm.auto import tqdm as _tqdm

    devnull = open(os.devnull, "w")

    class _ProgressBar(_tqdm):
        def __init__(self, *args, **kwargs):
            kwargs.setdefault("file", devnull)
            super().__init__(*args, **kwargs)
            self._is_bytes = kwargs.get("unit") == "B" and str(
                kwargs.get("desc", "")
            ).startswith("Reconstructing")

        def update(self, n=1):
            result = super().update(n)
            if self._is_bytes:
                on_progress(self.n, total)
            return result

    return _ProgressBar


def download_model_snapshot(model: str, on_progress=None) -> str:
    """Download one faster-whisper model's CT2 snapshot from the
    Hugging Face Hub, reporting cumulative progress via
    on_progress(downloaded_bytes, total_bytes) as it goes (best-effort
    granularity — see _make_progress_bar_class; always called once
    more with (total, total) at the very end, so a caller always sees
    100% on success even if no finer-grained call ever fired). Shared
    by --download-only (first-run one-shot, see run_download_only) and
    JobManager.start_download_job (:8766 model-switch job) — decision B
    of docs/design-explorations/s4-model-wizard-blueprint.md: "one
    shared helper, only invocation + progress transport differ."

    Runs under the process's own HF_HOME (set by the Rust launcher
    exactly like load_model()'s WhisperModel(...) call already relies
    on) — no explicit cache_dir override here, for the same reason; a
    later load_model() call finds this snapshot already cached.

    Raises RuntimeError with a zh message if free disk space is short
    (checked BEFORE any write — see check_disk_space), or re-raises
    whatever huggingface_hub/httpx raises on a network/repo failure —
    the caller (JobManager._run_download_job or run_download_only)
    turns either into job.error / a download_error line."""
    from huggingface_hub import HfApi
    from huggingface_hub import constants as hf_constants
    from huggingface_hub import snapshot_download as hf_snapshot_download

    repo_id = _repo_id_for_model(model)

    info = HfApi().model_info(repo_id, files_metadata=True)
    total = sum(
        sibling.size or 0
        for sibling in info.siblings or []
        if any(
            fnmatch.fnmatch(sibling.rfilename, pattern)
            for pattern in MODEL_DOWNLOAD_ALLOW_PATTERNS
        )
    )

    # Disk precheck — BEFORE any write. hf_constants.HF_HUB_CACHE is
    # exactly the directory snapshot_download itself resolves to below
    # (we don't pass cache_dir, so it defaults the same way), which is
    # itself derived from HF_HOME — respected exactly as load_model()'s
    # WhisperModel(...) call already relies on.
    check_disk_space(total, hf_constants.HF_HUB_CACHE)

    progress_bar_cls = _make_progress_bar_class(total, on_progress or (lambda d, t: None))
    hf_snapshot_download(
        repo_id,
        allow_patterns=MODEL_DOWNLOAD_ALLOW_PATTERNS,
        tqdm_class=progress_bar_cls,
    )
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


def run_download_only(model: str) -> bool:
    """--download-only mode body (decision B's first-run one-shot
    path, see main()): run download_model_snapshot, emitting
    newline-delimited JSON progress lines to stdout for the Rust
    launcher to parse (line-based — see docs/design-explorations/
    s4-model-wizard-blueprint.md's Anchors: tqdm's own \\r bars won't
    survive run_venv_python_streaming), then a final download_done/
    download_error line. Returns True on success, False on failure —
    main() turns this into the process exit code."""
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
        download_model_snapshot(model, on_progress)
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
    return parser.parse_args()


def print_banner(
    model_name: str,
    device: str,
    load_seconds: float,
    host: str,
    port: int,
    http_port: int,
    diarize_enabled: bool,
) -> None:
    print("=" * 60)
    print("JargonSlayer 本地 Whisper 服务 / local Whisper sidecar")
    print(f"  model:     {model_name}")
    print(f"  device:    {device}")
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
        ok = run_download_only(args.model)
        sys.exit(0 if ok else 1)

    model, load_seconds = load_model(args.model, args.device, args.compute)
    print_banner(
        args.model,
        args.device,
        load_seconds,
        args.host,
        args.port,
        args.http_port,
        diarize_enabled=bool(args.hf_token),
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
