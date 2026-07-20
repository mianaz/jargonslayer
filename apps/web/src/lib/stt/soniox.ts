// Soniox cloud STT (BYOK, experimental — v0.4 S4 blueprint decision
// E): streams 16kHz mono PCM from the mic, via the same AudioWorklet
// downsampler whisperSocket.ts/tabAudio.ts use, straight to Soniox's
// real-time endpoint (wss://stt-rt.soniox.com/transcribe-websocket) —
// no local sidecar involved. The WebSocket/audio-graph plumbing plus
// the Soniox wire protocol live in sonioxTransport.ts (modeled on
// wsTransport.ts, NOT sharing it — see that file's own header for
// why). No pause/resume: canPause is a chunk-6 UI concern
// (useMeeting's teardown-pause fallback already covers any engine that
// doesn't implement the optional STTEngine.pause/resume methods).

import type {
  ApiErrorBody,
  MeetingLexicon,
  STTEngine,
  STTEngineKind,
  STTEvents,
  Settings,
} from "@jargonslayer/core/types";
import { withBase } from "../basePath";
import { SONIOX_PREVIEW_LANE } from "../deployTier";
import { SonioxTransport } from "./sonioxTransport";

// Preview lane fallback (no server error body to read a message off
// at all — a network drop, or a non-JSON 5xx) — never leaks the raw
// fetch/parse failure, mirrors llm/client.ts's own "generic zh string
// on an unparseable failure" posture.
const SONIOX_PREVIEW_UNAVAILABLE = "Soniox 预览体验暂不可用";

/** Preview lane (hosted Soniox trial, SONIOX_PREVIEW_LANE): mints a
 *  temp key off the owner's server credential via POST /api/soniox/
 *  token (single_use, ~10-min server-capped session — see that route's
 *  own header) instead of sending a BYOK key directly. Matches
 *  SonioxTransportCallbacks.mintToken's shape (`(key: string) =>
 *  Promise<string>`) even though `key` itself is unused here — this
 *  path is only ever wired up when there IS no BYOK sonioxKey (see
 *  start() below), so there is nothing in `key` to mint FROM.
 *
 *  On a non-OK response, throws an Error whose message is the server's
 *  own ApiErrorBody.error string when present — already user-readable
 *  zh (e.g. "预览版 Soniox 体验额度已达上限…" for a 429 preview_budget) —
 *  falling back to SONIOX_PREVIEW_UNAVAILABLE only when the body can't
 *  be parsed at all. sonioxTransport.ts's sendConfig forwards THIS
 *  message to onStatus("error") verbatim rather than a generic
 *  fallback (scrubApiKey's own S4 review finding 2 guard still applies
 *  underneath — there's no BYOK key in scope here to redact anyway). */
async function mintPreviewToken(_key: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(withBase("/api/soniox/token"), { method: "POST" });
  } catch {
    throw new Error(SONIOX_PREVIEW_UNAVAILABLE);
  }
  if (!res.ok) {
    let body: ApiErrorBody | undefined;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      body = undefined;
    }
    throw new Error(body?.error || SONIOX_PREVIEW_UNAVAILABLE);
  }
  let json: { api_key?: unknown };
  try {
    json = (await res.json()) as { api_key?: unknown };
  } catch {
    throw new Error(SONIOX_PREVIEW_UNAVAILABLE);
  }
  if (typeof json.api_key !== "string" || !json.api_key) {
    throw new Error(SONIOX_PREVIEW_UNAVAILABLE);
  }
  return json.api_key;
}

export class SonioxEngine implements STTEngine {
  readonly kind: STTEngineKind = "soniox";

  private transport: SonioxTransport | null = null;
  private stream: MediaStream | null = null;
  private stopping = false;

  async start(events: STTEvents, settings: Settings, lexicon?: MeetingLexicon): Promise<void> {
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
    // (same guard as whisperSocket.ts's own, codex review 2026-07-10).
    if (this.stopping) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;

    // Preview lane (hosted Soniox trial, SONIOX_PREVIEW_LANE): a preview
    // user has no BYOK sonioxKey to send — mintPreviewToken mints one
    // server-side instead of buildSonioxConfig's default identity mint.
    // A user who HAS entered their own key always keeps using it
    // directly (mintToken stays undefined) even with the lane on — a
    // deliberate BYOK choice must never be silently rerouted through
    // the shared server credential instead.
    const mintToken = SONIOX_PREVIEW_LANE && !settings.sonioxKey ? mintPreviewToken : undefined;
    const transport = new SonioxTransport({ events, settings, mintToken, lexicon });
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

    const transport = this.transport;
    this.transport = null;
    if (transport) {
      await transport.stop();
    }

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }
}
