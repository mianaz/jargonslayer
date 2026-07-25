// ElevenLabs Scribe realtime cloud STT (BYOK — v0.6 round 2): streams
// 16kHz mono PCM from the mic, via the same AudioWorklet downsampler
// sonioxTransport.ts/deepgramTransport.ts use, straight to ElevenLabs'
// realtime endpoint — no local sidecar involved, and no server-minted
// preview lane either (unlike soniox.ts's own SONIOX_PREVIEW_LANE —
// BYOK-only by design for this engine). The WebSocket/audio-graph
// plumbing plus the ElevenLabs wire protocol live in
// elevenLabsTransport.ts (modeled on DeepgramTransport/SonioxTransport,
// NOT sharing either — see that file's own header for why). No
// pause/resume: canPause is a chunk-6 UI concern (useMeeting's
// teardown-pause fallback already covers any engine that doesn't
// implement the optional STTEngine.pause/resume methods) — mirrors
// soniox.ts/deepgram.ts's identical posture.

import type { MeetingLexicon, STTEngine, STTEngineKind, STTEvents, Settings } from "@jargonslayer/core/types";
import { diagLog } from "../diag/log";
import { ElevenLabsTransport } from "./elevenLabsTransport";
import { recordSttSeconds } from "./usageTracking";

export class ElevenLabsEngine implements STTEngine {
  readonly kind: STTEngineKind = "elevenlabs";

  private transport: ElevenLabsTransport | null = null;
  private stream: MediaStream | null = null;
  private stopping = false;
  // Usage-ledger instrumentation (T2, lib/usage/ledger.ts) — stamped
  // once the transport's own "listening" status fires (S7 fix, v0.6
  // round-2 review: the transport confirms this once the server
  // actually acks the session — ElevenLabs' session_started message —
  // not merely once attachStream() resolves below, which only means the
  // LOCAL audio graph is wired up; the token mint + WebSocket connect +
  // server round trip all still happen AFTER that). Read back at stop()
  // to record a SINGLE wall-clock-elapsed seconds figure.
  private streamStartedAt: number | null = null;

  async start(events: STTEvents, settings: Settings, lexicon?: MeetingLexicon): Promise<void> {
    diagLog("info", "stt-elevenlabs", "ElevenLabs 引擎启动请求");
    this.stopping = false;

    let stream: MediaStream;
    try {
      stream = await this.acquireStream(settings);
    } catch {
      events.onStatus(
        "error",
        "无法访问麦克风，请检查浏览器权限或选择的输入设备",
      );
      return;
    }
    // stop() can land while getUserMedia is awaiting the permission
    // prompt/device — without this re-check the acquired stream would
    // attach AFTER teardown and leave a hot mic on a stopped engine
    // (same guard as soniox.ts/deepgram.ts's own).
    if (this.stopping) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;

    // S7 fix: intercepts the transport's own onStatus("listening") —
    // the actual authenticated/streaming start — to stamp
    // streamStartedAt, then forwards the call through unchanged.
    const wrappedEvents: STTEvents = {
      ...events,
      onStatus: (status, detail) => {
        if (status === "listening" && this.streamStartedAt === null) {
          this.streamStartedAt = Date.now();
        }
        events.onStatus(status, detail);
      },
    };

    const transport = new ElevenLabsTransport({ events: wrappedEvents, settings, lexicon });
    this.transport = transport;

    try {
      await transport.attachStream(stream);
    } catch {
      events.onStatus("error", "无法初始化音频处理，请刷新页面重试");
      stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  private async acquireStream(settings: Settings): Promise<MediaStream> {
    const audioConstraints: MediaTrackConstraints = {
      channelCount: 1,
      // Transcription capture, not a call — see whisperSocket.ts's own
      // doc for the full rationale (echo cancellation would actively
      // remove exactly the audio meant to be transcribed; noise
      // suppression garbles far-field speech; auto gain lifts
      // quiet/distant sources).
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
    };
    if (settings.micId) {
      audioConstraints.deviceId = { exact: settings.micId };
    }
    return navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    diagLog("info", "stt-elevenlabs", "ElevenLabs 引擎停止");

    // S7 fix (v0.6 round-2 review): captured BEFORE transport.stop(),
    // which can take up to STOP_DRAIN_TIMEOUT_MS (8s) waiting on the
    // server's own drain ack — the user already said "stop" and local
    // audio capture ends at THIS instant; the drain wait afterward is
    // teardown bookkeeping, not more billable streaming time.
    const endedAt = Date.now();

    const transport = this.transport;
    this.transport = null;
    if (transport) {
      await transport.stop();
    }

    if (this.streamStartedAt !== null) {
      recordSttSeconds(this.kind, (endedAt - this.streamStartedAt) / 1000);
      this.streamStartedAt = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }
}
