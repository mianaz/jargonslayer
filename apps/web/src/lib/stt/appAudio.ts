// Native app/system audio capture engine (S9, docs/design-explorations/
// s9-app-audio-tap-blueprint.md): transcribes the OTHER side of a
// native-app call (Zoom/Teams/WeChat app — NOT a browser tab, which
// tabAudio.ts already covers via getDisplayMedia; macOS Chrome's
// getDisplayMedia can only ever capture tab audio, so this is the one
// case even the web version can never cover) via a CoreAudio process
// tap running in a Swift helper (apps/desktop/src-tauri's audiocap
// helper, S9.1/S9.2). Desktop-only (Tauri-gated, D6 — never reachable
// on a web build; the card/gating itself is S9.4's job).
//
// Modeled line-by-line on tabAudio.ts's lifecycle discipline. The only
// real difference is WHERE the PCM comes from: tabAudio drives
// wsTransport.ts's browser AudioContext/worklet graph via
// attachStream(); this engine instead drives that transport's D5 seam —
// attachPcmFeed() (builds no audio graph) + pushPcm() — fed by a Tauri
// Channel the native helper streams already-downsampled 16kHz mono i16
// PCM into, batched ~16KB (see wsTransport.ts's own header comment).
// Every `@tauri-apps/*` touch point goes through tauriApi.ts (the ONLY
// module in this app that imports it) — this file imports zero Tauri
// itself, same contract provisionRunner.ts/bootstrap.ts already
// established for the desktop-provisioning layer.
//
// Wire contract (PINNED — S9.2's Rust side builds against this exact
// shape):
//   invoke("audiocap_capabilities") -> { appAudioSupported, reason }
//   invoke("start_app_audio", { channel })  — channel: Channel<ArrayBuffer>
//   invoke("stop_app_audio")                — idempotent
//   event "audiocap://status" -> { kind, message }, kind one of:
//     "starting" | "capturing" | "exclude-pid-inactive" |
//     "permission-denied" | "unsupported" | "device-changed" |
//     "crashed" | "ended"
//
// D5's engine-local generation guard (JS side): every listen()/Channel
// callback registered by a given start() call captures that call's own
// generation number and drops anything that arrives once a LATER
// start() has superseded it — a late chunk/status from a dying session
// can never cross into a later one on the SAME engine instance.

import type { STTEngine, STTEngineKind, STTEvents, Settings } from "@jargonslayer/core/types";
import { WsTransport } from "./wsTransport";
import { getChannelFactory, getInvoke, getListen, type UnlistenFn } from "../desktop/tauriApi";

interface AudiocapCapabilities {
  appAudioSupported: boolean;
  reason: string | null;
}

type AudiocapStatusKind =
  | "starting"
  | "capturing"
  | "exclude-pid-inactive"
  | "permission-denied"
  | "unsupported"
  | "device-changed"
  | "crashed"
  | "ended";

interface AudiocapStatusPayload {
  kind: AudiocapStatusKind;
  message: string;
}

// Bounds stop()'s wait for the helper's own "ended" status (D5 stop
// ordering: stop helper -> drain/flush -> ordered EOS/ "ended" -> THEN
// drain the ws) — mirrors wsTransport.ts's own STOP_DRAIN_TIMEOUT_MS/
// POST_STOP_LINGER_MS "bounded wait for an external ack" idiom. A
// helper that never acks (crashed mid-teardown, stuck) must not hang
// the UI's End button forever.
const STOP_ENDED_TIMEOUT_MS = 4000;

export class AppAudioEngine implements STTEngine {
  readonly kind: STTEngineKind = "appaudio";

  private events: STTEvents | null = null;
  private transport: WsTransport | null = null;
  private stopping = false;

  // D5 generation guard (JS side): bumped at the top of every start(),
  // captured by that call's own listen()/Channel closures — see this
  // file's header comment.
  private generation = 0;

  private unlistenStatus: UnlistenFn | null = null;
  // Guards against a duplicate "capturing" status double-attaching the
  // feed (this.transport stays non-null for the whole session, so
  // checking that alone wouldn't catch a second "capturing").
  private feedAttached = false;

  // stop()'s wait for the helper's "ended" status — see
  // STOP_ENDED_TIMEOUT_MS's own doc comment above.
  private stopEndedResolve: (() => void) | null = null;
  private stopEndedTimer: ReturnType<typeof setTimeout> | null = null;

  async start(events: STTEvents, settings: Settings): Promise<void> {
    this.events = events;
    this.stopping = false;
    this.feedAttached = false;
    const myGeneration = ++this.generation;

    const invoke = await getInvoke();
    const listen = await getListen();
    const createChannel = await getChannelFactory();

    let caps: AudiocapCapabilities;
    try {
      caps = await invoke<AudiocapCapabilities>("audiocap_capabilities");
    } catch {
      events.onStatus("error", "无法确认系统音频捕获是否可用，请重试");
      return;
    }
    if (!caps.appAudioSupported) {
      events.onStatus(
        "error",
        caps.reason || "当前系统不支持系统音频捕获，需要 macOS 14.4 或更高版本",
      );
      return;
    }

    // stop() can land while the capabilities round-trip above was in
    // flight — mirror tabAudio.ts's post-acquire re-check (same class
    // as its share-picker guard): don't go on to register a listener or
    // request a live capture on an engine that's already been asked to
    // stop. Without this, a listener registered AFTER a concurrent
    // stop() already read (null) this.unlistenStatus would never get
    // unlistened.
    if (this.stopping) return;

    const transport = new WsTransport({
      events,
      settings,
      connectFailureMessage: (url) =>
        `系统音频捕获需要本地 Whisper sidecar（见 README），无法连接 ${url}`,
    });
    this.transport = transport;

    this.unlistenStatus = await listen<AudiocapStatusPayload>("audiocap://status", (event) => {
      this.handleStatus(myGeneration, event.payload);
    });

    const channel = createChannel((data) => {
      this.handleChannelMessage(myGeneration, data);
    });

    try {
      await invoke("start_app_audio", { channel });
    } catch {
      events.onStatus("error", "无法启动系统音频捕获，请重试");
      await this.stop();
      return;
    }

    // stop() can land while start_app_audio was in flight — the helper
    // may already be starting/capturing by the time we learn this
    // engine was asked to stop. Mirror tabAudio's post-acquire re-check
    // again, this time for the just-requested capture itself:
    // stop_app_audio is idempotent (pinned wire contract), so firing it
    // here is safe even if stop()'s own concurrent call already reached
    // the helper — stop() itself owns the rest of the teardown
    // (transport.stop()/unlisten), already in flight by the time we
    // get here.
    if (this.stopping) {
      invoke("stop_app_audio").catch(() => {});
    }
  }

  private handleStatus(myGeneration: number, payload: AudiocapStatusPayload): void {
    if (myGeneration !== this.generation) return; // D5 generation guard — stale session

    // "ended" is the one status meaningful even while stopping — it's
    // exactly what unblocks stop()'s own wait (see
    // waitForEndedOrTimeout()/resolveStopEnded()). Every OTHER status
    // arriving once we've already been asked to stop is noise — mirrors
    // tabAudio.ts's handleTrackEnded's own `if (this.stopping) return;`
    // guard (no spurious error toast after a deliberate stop()).
    if (this.stopping) {
      if (payload.kind === "ended") this.resolveStopEnded();
      return;
    }

    const events = this.events;
    if (!events) return;

    switch (payload.kind) {
      case "starting":
        // No status transition of our own here — wsTransport's connect()
        // (once attachPcmFeed() runs, at "capturing" below) already
        // emits "connecting"/"listening".
        break;
      case "capturing":
        if (this.feedAttached || !this.transport) return;
        this.feedAttached = true;
        this.transport.attachPcmFeed();
        break;
      case "exclude-pid-inactive":
        // Informational only (S9.1 D3 amendment: self-exclusion is
        // best-effort when the app hasn't registered with the audio HAL
        // yet) — never surfaced as an error.
        break;
      case "permission-denied":
        events.onStatus(
          "error",
          "JargonSlayer 没有系统音频录制权限，请前往 系统设置 → 隐私与安全性 → 屏幕与系统音频录制 开启后重试",
        );
        break;
      case "device-changed":
        // No hot re-tap in v1 (blueprint non-goals) — the helper exits
        // and the session must be restarted by hand.
        events.onStatus("error", "录音设备发生变化，系统音频捕获已停止，请重新开始");
        break;
      case "crashed":
        events.onStatus("error", "系统音频捕获意外退出，请重试");
        break;
      case "unsupported":
        // Normally caught synchronously by capabilities() above (D6:
        // "runtime commands re-check support" — kept here too in case a
        // future helper build discovers this only once actually asked
        // to start).
        events.onStatus("error", "当前系统不支持系统音频捕获，需要 macOS 14.4 或更高版本");
        break;
      case "ended":
        // Not stopping (handled above) — an unexpected end (helper
        // exited/tap died with no stop() of ours), mirrors tabAudio.ts's
        // handleTrackEnded exactly.
        events.onStatus("idle", "capture_ended");
        break;
    }
  }

  private handleChannelMessage(myGeneration: number, data: ArrayBuffer): void {
    if (myGeneration !== this.generation) return; // D5 generation guard — stale session
    // Deliberately NOT gated on `this.stopping`: the D5 stop ordering
    // has the helper's own drain/flush tail still arriving over this
    // SAME channel right up until "ended" — that tail must still reach
    // the sidecar before WsTransport.stop()'s own ws drain begins (see
    // stop() below). transport.pushPcm() applies its own guard once
    // that later drain is actually underway; a null transport (already
    // torn down) is a silent no-op here.
    this.transport?.pushPcm(data);
  }

  private resolveStopEnded(): void {
    if (this.stopEndedTimer) {
      clearTimeout(this.stopEndedTimer);
      this.stopEndedTimer = null;
    }
    this.stopEndedResolve?.();
    this.stopEndedResolve = null;
  }

  private waitForEndedOrTimeout(): Promise<void> {
    return new Promise((resolve) => {
      this.stopEndedResolve = resolve;
      this.stopEndedTimer = setTimeout(() => {
        this.stopEndedTimer = null;
        this.stopEndedResolve = null;
        resolve();
      }, STOP_ENDED_TIMEOUT_MS);
    });
  }

  /** Soft pause (STT protocol v2, B4 pause matrix): gates PCM
   * forwarding on the SAME transport — the helper (and its tap/
   * aggregate device) keeps running untouched, so resume needs no
   * re-invoke of start_app_audio. No-op if already stopping or if
   * start() never got far enough to attach a transport — mirrors
   * tabAudio.ts's pause() exactly. */
  async pause(): Promise<void> {
    if (this.stopping || !this.transport) return;
    this.transport.pauseFeed();
  }

  /** Resume after pause() — same transport, no re-invoke. */
  async resume(): Promise<void> {
    if (this.stopping || !this.transport) return;
    this.transport.resumeFeed();
  }

  /** Stop ordering (D5): mark stopping -> invoke stop_app_audio (helper
   * stops; its drain/flush tail still arrives over the channel) -> wait
   * for its "ended" status or STOP_ENDED_TIMEOUT_MS, whichever first ->
   * THEN transport.stop() (the ws drain handshake) -> unlisten. Safe to
   * call twice — only the first call has effect. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    const invoke = await getInvoke();
    try {
      await invoke("stop_app_audio");
    } catch {
      // best-effort — tear down our own side regardless of whether the
      // helper actually heard us.
    }
    // Only worth waiting for "ended" if a listener was ever registered
    // to hear it — otherwise (stop() landing before start() got that
    // far) nothing could ever resolve the wait early, so skip straight
    // to local teardown rather than always burning STOP_ENDED_TIMEOUT_MS
    // for nothing (mirrors wsTransport.ts's own stop() skipping its
    // drain wait when the ws was never OPEN).
    if (this.unlistenStatus) {
      await this.waitForEndedOrTimeout();
    }

    const transport = this.transport;
    this.transport = null;
    if (transport) {
      await transport.stop();
    }

    const unlisten = this.unlistenStatus;
    this.unlistenStatus = null;
    unlisten?.();

    this.events = null;
  }
}
