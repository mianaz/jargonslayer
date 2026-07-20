// Tab audio without the local sidecar (v0.5 Wave-1 Feature 4, cloud
// path — docs/design-explorations/v05-wave1-blueprint.md §1 Feature 4 +
// §5 A4): getDisplayMedia capture — byte-identical to tabAudio.ts's own
// acquisition (required-but-unused video track, same audio constraints,
// same zh screen-share error copy) — routed into a BYOK cloud transport
// (Soniox or Deepgram, Settings.tabAudioCloudProvider) instead of
// tabAudio.ts's local Whisper sidecar (WsTransport). The resample
// problem is already solved: SonioxTransport/DeepgramTransport's own
// attachStream(stream) both accept ANY MediaStream through the SAME
// shared worklet /worklets/pcm-processor.js graph the mic engines use —
// a tab stream is just a different MediaStream into that graph (same
// worklet ASSET and equivalent graph, not shared transport code — A4).
//
// No pause/resume (mirrors soniox.ts/deepgram.ts, NOT tabAudio.ts):
// neither SonioxTransport nor DeepgramTransport exposes a
// pauseFeed/resumeFeed the way WsTransport does — useMeeting.ts's
// teardown-pause fallback already covers any engine that doesn't
// implement the optional STTEngine.pause/resume methods.
//
// Lexicon: threaded through to SonioxTransport exactly as soniox.ts
// does (SonioxTransportCallbacks.lexicon -> buildSonioxConfig's own
// context.terms projection). Deepgram deliberately does NOT receive it
// — see deepgram.ts's own D1 header comment: keyterm bias is a billed
// add-on with no settings toggle yet, so silently threading the
// lexicon through here would turn it on for every tab-cloud session the
// moment any glossary/pack term exists — DeepgramTransportCallbacks has
// no `lexicon` field at all, so there is nothing to pass even by
// accident.
//
// Provider key gate (A4): unlike soniox.ts/deepgram.ts (one fixed key,
// always used — a local preflight there would be redundant), this
// engine dispatches between TWO keys at runtime, so a missing MATCHING
// key is checked up front — before ever opening the getDisplayMedia
// share picker — and reported the same way soniox.ts/deepgram.ts report
// every other start() failure: one onStatus("error", ...) zh string,
// no transport ever constructed.

import type { MeetingLexicon, STTEngine, STTEngineKind, STTEvents, Settings } from "@jargonslayer/core/types";
import { SonioxTransport } from "./sonioxTransport";
import { DeepgramTransport } from "./deepgramTransport";
import { resolveTabAudioCloudProvider, type TabAudioCloudProvider } from "./engineCapabilities";

const PROVIDER_NAME: Record<TabAudioCloudProvider, string> = {
  soniox: "Soniox",
  deepgram: "Deepgram",
};

export class TabAudioCloudEngine implements STTEngine {
  readonly kind: STTEngineKind = "tabaudio-cloud";

  private transport: SonioxTransport | DeepgramTransport | null = null;
  private displayStream: MediaStream | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private events: STTEvents | null = null;
  private stopping = false;

  async start(events: STTEvents, settings: Settings, lexicon?: MeetingLexicon): Promise<void> {
    this.events = events;
    this.stopping = false;

    const provider = resolveTabAudioCloudProvider(settings);
    const key = provider === "deepgram" ? settings.deepgramKey : settings.sonioxKey;
    if (!key) {
      events.onStatus(
        "error",
        `标签页音频·云端需要 ${PROVIDER_NAME[provider]} API Key，请前往设置填写后重试`,
      );
      return;
    }

    let stream: MediaStream;
    try {
      // Chrome requires video:true for getDisplayMedia even when we
      // only want audio — the video track is kept alive (so the
      // capture stays valid) but never read/rendered anywhere. See
      // tabAudio.ts's own identical call for the full rationale.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError") {
        events.onStatus(
          "error",
          "已取消共享。提示：选择会议所在的浏览器标签页并勾选「分享标签页音频」",
        );
      } else {
        events.onStatus(
          "error",
          "无法捕获标签页音频，请重试或选择其他引擎",
        );
      }
      return;
    }

    // stop() can land while the share picker is open — without this
    // re-check the granted capture would attach AFTER teardown and
    // keep recording a tab on a stopped engine (mirrors tabAudio.ts's
    // own identical guard, codex review 2026-07-10).
    if (this.stopping) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      events.onStatus(
        "error",
        "没有检测到音频，请选择「Chrome 标签页」并勾选左下角「分享标签页音频」",
      );
      return;
    }

    this.displayStream = stream;
    this.audioTrack = audioTracks[0];
    this.audioTrack.addEventListener("ended", this.handleTrackEnded);

    const transport =
      provider === "deepgram"
        ? new DeepgramTransport({ events, settings })
        : new SonioxTransport({ events, settings, lexicon });
    this.transport = transport;

    try {
      await transport.attachStream(stream);
    } catch {
      events.onStatus("error", "无法初始化音频处理，请刷新页面重试");
      await this.stop();
    }
  }

  private handleTrackEnded = (): void => {
    // User clicked the browser's native "停止共享" control.
    if (this.stopping) return;
    this.events?.onStatus("idle", "capture_ended");
  };

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    const transport = this.transport;
    this.transport = null;
    if (transport) {
      await transport.stop();
    }

    if (this.audioTrack) {
      this.audioTrack.removeEventListener("ended", this.handleTrackEnded);
      this.audioTrack = null;
    }

    if (this.displayStream) {
      // Stop every track, including the unused video track.
      this.displayStream.getTracks().forEach((t) => t.stop());
      this.displayStream = null;
    }

    this.events = null;
  }
}
