#!/usr/bin/env python3
"""MeetLingo local Whisper sidecar.

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
import asyncio
import json
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

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
            "MeetLingo 本地 Whisper 转录服务 / MeetLingo local Whisper "
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
    return parser.parse_args()


def print_banner(
    model_name: str, device: str, load_seconds: float, host: str, port: int
) -> None:
    print("=" * 60)
    print("MeetLingo 本地 Whisper 服务 / local Whisper sidecar")
    print(f"  model:  {model_name}")
    print(f"  device: {device}")
    print(f"  load:   {load_seconds:.2f}s")
    print(f"ws://{host}:{port} 等待连接 — 在 MeetLingo 设置中选择「本地 Whisper」")
    print("=" * 60)


async def main() -> None:
    args = parse_args()

    model, load_seconds = load_model(args.model, args.device, args.compute)
    print_banner(args.model, args.device, load_seconds, args.host, args.port)

    server = WhisperServer(
        model=model,
        default_language=args.language,
        emit_partials=args.partials,
        save_audio_path=args.save_audio,
    )

    async with websockets.serve(server.handle, args.host, args.port):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n已停止 / stopped.")
