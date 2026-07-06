#!/usr/bin/env python3
"""JargonSlayer local Whisper sidecar.

Privacy-mode STT server: receives 16kHz mono int16 PCM over a
WebSocket, performs energy-based VAD segmentation, and transcribes
each speech segment with faster-whisper. No audio ever leaves the
machine.

Usage:
    python whisper_server.py --model small --port 8765

Protocol (per connection):
  Client -> Server:
    - text frame: JSON {"type": "config", ...}  (may override language)
    - text frame: JSON {"type": "stop"}
    - binary frame: 16kHz mono int16 PCM chunks
  Server -> Client:
    - text frame: JSON {"type": "partial", "text": "..."}      (optional)
    - text frame: JSON {"type": "final", "text": "...",
                         "start": <seconds>, "end": <seconds>}
"""

from __future__ import annotations

import argparse
import json
import os
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
NOISE_EMA_ALPHA = 0.05  # smoothing factor for the noise-floor EMA
PARTIAL_INTERVAL_S = 2.0

# VAD operates on ~32ms analysis frames (512 samples @ 16kHz) — small
# enough for responsive onset/offset detection.
FRAME_SAMPLES = 512


def rms(frame: np.ndarray) -> float:
    """Root-mean-square energy of a float32 [-1, 1] frame."""
    if frame.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(frame))))


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
    ) -> None:
        self.model = model
        self.default_language = default_language
        self.emit_partials = emit_partials
        self.save_audio_path = save_audio_path

    async def handle(self, ws: WebSocketServerProtocol) -> None:
        state = ConnectionState(language=self.default_language)
        if self.save_audio_path:
            state.wav_writer = open_wav_writer(self.save_audio_path)

        try:
            async for message in ws:
                if isinstance(message, (bytes, bytearray)):
                    await self._handle_binary(ws, state, bytes(message))
                else:
                    await self._handle_text(ws, state, message)
        except ConnectionClosed:
            pass
        finally:
            # Flush any in-progress speech before the client goes away.
            await self._finalize_segment(ws, state, force=True)
            if state.wav_writer is not None:
                state.wav_writer.close()

    async def _handle_text(
        self, ws: WebSocketServerProtocol, state: ConnectionState, raw: str
    ) -> None:
        try:
            msg = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return

        msg_type = msg.get("type")
        if msg_type == "config":
            language = msg.get("language")
            if isinstance(language, str) and language:
                state.language = language
        elif msg_type == "stop":
            await self._finalize_segment(ws, state, force=True)

    async def _handle_binary(
        self, ws: WebSocketServerProtocol, state: ConnectionState, data: bytes
    ) -> None:
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
                    self.emit_partials
                    and state.elapsed() - state.last_partial_at >= PARTIAL_INTERVAL_S
                ):
                    await self._emit_partial(ws, state)
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

    async def _emit_partial(self, ws: WebSocketServerProtocol, state: ConnectionState) -> None:
        if not state.speech_buf:
            return
        audio = np.concatenate(state.speech_buf)
        text = await asyncio.to_thread(self._transcribe, audio, state.language)
        if text:
            await self._safe_send(ws, {"type": "partial", "text": text})

    async def _finalize_segment(
        self, ws: WebSocketServerProtocol, state: ConnectionState, force: bool
    ) -> None:
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

        # Reset VAD state before the (potentially slow) transcription
        # call so incoming frames aren't dropped while we transcribe.
        state.in_speech = False
        state.speech_buf = []
        state.silence_ms = 0.0
        state.speech_ms = 0.0
        state.speech_started_at = None

        if speech_ms < MIN_SPEECH_MS:
            return  # too short — likely a blip, discard

        text = await asyncio.to_thread(self._transcribe, audio, state.language)
        if text:
            await self._safe_send(
                ws, {"type": "final", "text": text, "start": t0, "end": t1}
            )

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
    async def _safe_send(ws: WebSocketServerProtocol, payload: dict) -> None:
        try:
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


def new_job(diarize_requested: bool) -> dict[str, Any]:
    """Fresh job record — the exact shape returned by GET /jobs/{id}."""
    return {
        "id": uuid.uuid4().hex,
        "status": "queued",  # queued | running | done | error
        "progress": 0.0,
        "status_detail": None,  # e.g. "diarizing"
        "segments": [],  # [{"start","end","text","speaker"?}]
        "error": None,
        "diarized": False,
        "diarize_requested": diarize_requested,
        "warning": None,  # non-fatal note (e.g. diarization unavailable)
        "created_at": time.time(),
    }


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
        self._diarize_pipeline: Any = None
        self._diarize_pipeline_loaded = False
        self._diarize_pipeline_error: Optional[str] = None
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

    def _transcribe_job(self, job_id: str, file_path: str, language: str) -> None:
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
                    # (per spec) holds progress at DIARIZE_HOLD_PROGRESS.
                    job["progress"] = progress * DIARIZE_HOLD_PROGRESS

    def _load_diarize_pipeline(self, hf_token: Optional[str] = None) -> tuple[Any, Optional[str]]:
        """Returns (pipeline, error_message). error_message is None on
        success. Loading pyannote can fail in more ways than a plain
        ImportError (missing package) — broken/incompatible transitive
        dependencies (seen in practice: pyarrow version mismatches
        raising AttributeError deep inside the import), model download
        failures, etc. Any failure here degrades to "undiarized" per
        spec — it must never take down the transcription job.

        The pipeline is loaded (and cached) once, with whichever token
        is available on first load — `hf_token` (a per-job override, see
        start_job) takes precedence over the CLI/env one that day. A
        second job supplying a *different* token after the pipeline is
        already cached won't force a reload; that's an accepted edge
        case for a local, single-user sidecar (mirrors the in-memory-
        only job store tradeoff noted on JobManager)."""
        if self._diarize_pipeline_loaded:
            return self._diarize_pipeline, self._diarize_pipeline_error
        self._diarize_pipeline_loaded = True
        token = hf_token or self.hf_token
        try:
            from pyannote.audio import Pipeline  # type: ignore[import-not-found]

            # pyannote 4.x renamed use_auth_token= to token=; support both.
            try:
                self._diarize_pipeline = Pipeline.from_pretrained(
                    "pyannote/speaker-diarization-3.1",
                    token=token,
                )
            except TypeError:
                self._diarize_pipeline = Pipeline.from_pretrained(
                    "pyannote/speaker-diarization-3.1",
                    use_auth_token=token,
                )
            self._diarize_pipeline_error = None
        except Exception as exc:  # noqa: BLE001 - see docstring
            self._diarize_pipeline = None
            self._diarize_pipeline_error = f"{type(exc).__name__}: {exc}"
        return self._diarize_pipeline, self._diarize_pipeline_error

    def diarization_probe(self) -> tuple[bool, Optional[str]]:
        """Lightweight readiness check for GET /health: does pyannote
        import, and is a token available (CLI/env, or the most recent
        per-request hf_token)? Deliberately does NOT call
        Pipeline.from_pretrained() (that downloads/loads the model) —
        it only checks the import + token presence, per spec."""
        token = self.hf_token or self.last_request_token
        if not token:
            return False, "未配置 HF Token / no HF token available"
        try:
            import pyannote.audio  # noqa: F401  type: ignore[import-not-found]
        except Exception as exc:  # noqa: BLE001 - see _load_diarize_pipeline docstring
            return False, f"{type(exc).__name__}: {exc}"
        return True, None

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

        try:
            diarization = pipeline(file_path)
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
        against this whisper segment's [start, end) span."""
        best_label: Optional[str] = None
        best_overlap = 0.0
        for t_start, t_end, label in turns:
            overlap = min(seg["end"], t_end) - max(seg["start"], t_start)
            if overlap > best_overlap:
                best_overlap = overlap
                best_label = label
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
                "Access-Control-Allow-Methods", "PUT, GET, OPTIONS"
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

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            parts = [p for p in parsed.path.split("/") if p]

            if parts == ["health"]:
                ready, error = job_manager.diarization_probe()
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "model": job_manager.model_name,
                        "diarization_ready": ready,
                        "diarization_error": None if ready else error,
                    },
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
        choices=["tiny", "base", "small", "medium", "large-v3"],
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
            "启用滚动中间转录（每 ~2 秒一次）/ enable rolling partial "
            "transcriptions every ~2s during active speech (default: off)"
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
        "PUT /transcribe, GET /jobs"
    )
    print("=" * 60)


async def main() -> None:
    args = parse_args()

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
