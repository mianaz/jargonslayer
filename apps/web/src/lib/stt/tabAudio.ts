// Tab/system audio capture engine: transcribes the OTHER side of a
// Zoom/Teams/Meet call (or any tab/window audio) via getDisplayMedia,
// with zero extra software — no virtual audio cable, no OS-level
// loopback setup. Requires the local Whisper sidecar; audio flows
// only to that local sidecar process and never leaves the machine.

import type { STTEngine, STTEngineKind, STTEvents, Settings } from "@jargonslayer/core/types";
import { WsTransport } from "./wsTransport";

export class TabAudioEngine implements STTEngine {
  readonly kind: STTEngineKind = "tabaudio";

  private transport: WsTransport | null = null;
  private displayStream: MediaStream | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private events: STTEvents | null = null;
  private stopping = false;

  async start(events: STTEvents, settings: Settings): Promise<void> {
    this.events = events;
    this.stopping = false;

    let stream: MediaStream;
    try {
      // Chrome requires video:true for getDisplayMedia even when we
      // only want audio — the video track is kept alive (so the
      // capture stays valid) but never read/rendered anywhere.
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
    // keep recording a tab on a stopped engine (codex review
    // 2026-07-10; same class as whisperSocket's post-acquire guard).
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

    const transport = new WsTransport({
      events,
      settings,
      connectFailureMessage: (url) =>
        `标签页音频需要本地 Whisper（见 README），无法连接 ${url}`,
    });
    this.transport = transport;

    try {
      await transport.attachStream(stream);
    } catch {
      events.onStatus("error", "无法初始化音频处理，请刷新页面重试");
      await this.stop();
    }
  }

  /** Soft pause (STT protocol v2, B4 pause matrix): gates PCM
   * forwarding on the SAME transport/capture stream — the OS/browser
   * share picker never re-opens on resume, and Chrome's own "sharing
   * this tab" bar staying visible through the pause is honest (nothing
   * was actually torn down). No-op if already stopping or if start()
   * never got far enough to attach a transport. */
  async pause(): Promise<void> {
    if (this.stopping || !this.transport) return;
    this.transport.pauseFeed();
  }

  /** Resume after pause() — same transport, no reconnect. */
  async resume(): Promise<void> {
    if (this.stopping || !this.transport) return;
    this.transport.resumeFeed();
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
