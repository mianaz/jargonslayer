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
import { diagLog } from "../diag/log";

// Exported so SettingsDialog.tsx (S9.4, D6) can reuse this exact shape
// for its own audiocap_capabilities() probe (the ENGINE_CARDS
// macOS-floor gating) instead of hand-duplicating an equivalent
// interface — the wire contract above is the single source of truth
// for both callers.
export interface AudiocapCapabilities {
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
//
// INVARIANT (S9 adversarial review, finding F3): this must stay LONGER
// than Rust's own STOP_GRACE_PERIOD (3s, apps/desktop/src-tauri/src/
// audiocap.rs) — Rust clears its single-flight `running` slot (SIGKILL
// fallback included) on that timer before this JS-side wait ever gives
// up, so a stop_app_audio racing a fresh start_app_audio can't collide
// with a slot Rust hasn't released yet. Rust carries the mirror comment
// against STOP_GRACE_PERIOD itself.
const STOP_ENDED_TIMEOUT_MS = 4000;

// F3: every TERMINAL status kind — the helper is gone (or never going
// to start) once any of these arrives, so stop()'s own wait below has
// nothing left to wait FOR (see helperTerminated's own doc).
const TERMINAL_STATUS_KINDS = new Set<AudiocapStatusKind>([
  "ended",
  "crashed",
  "permission-denied",
  "unsupported",
  "device-changed",
]);

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

  // F3 (adversarial review, HIGH, both reviewers converged): latched
  // true the moment ANY TERMINAL status (TERMINAL_STATUS_KINDS) arrives
  // — set in handleStatus() regardless of whether we're already
  // stopping, since a terminal status can just as easily arrive BEFORE
  // stop() is ever called (e.g. permission-denied). stop() reads this
  // to skip waitForEndedOrTimeout() entirely once the helper is
  // already known-dead: without it, EVERY helper-side failure — not
  // just a clean "ended" — burned the full STOP_ENDED_TIMEOUT_MS wait
  // for nothing, since no "ended" was ever going to arrive to resolve
  // it early.
  private helperTerminated = false;

  // stop()'s wait for the helper's "ended" status — see
  // STOP_ENDED_TIMEOUT_MS's own doc comment above.
  private stopEndedResolve: (() => void) | null = null;
  private stopEndedTimer: ReturnType<typeof setTimeout> | null = null;

  async start(events: STTEvents, settings: Settings): Promise<void> {
    this.events = events;
    this.stopping = false;
    this.feedAttached = false;
    this.helperTerminated = false;
    const myGeneration = ++this.generation;

    // S9 adversarial review, finding F2: stop() can land at ANY await
    // point below, not just the two spot-checks this file used to carry
    // — in particular WHILE listen() itself is still in flight, when
    // this.unlistenStatus is still null. A spot-check re-reading
    // this.unlistenStatus/this.transport only AFTER a given await had
    // already returned would tear down whatever it could see at THAT
    // moment and return; anything acquired LATER (e.g. the listener,
    // once listen() finally resolved) then had no one left to ever
    // unregister it — a leaked `audiocap://status` listener. Fix: track
    // exactly what THIS call has acquired in local holders, re-check
    // after EVERY awaited acquisition, and route every abandonment
    // through the ONE abandonStart() routine below — local holders only
    // (never this.transport/this.unlistenStatus directly), so an
    // abandoned OLD call can never clobber a NEWER start()'s own live
    // state (see superseded()'s own doc).
    let unlisten: UnlistenFn | null = null;
    let transport: WsTransport | null = null;
    // Whether start_app_audio has actually been told to run — abandoning
    // BEFORE that point has nothing server-side to stop, and (if this
    // call was superseded by a NEWER start() rather than a stop())
    // firing stop_app_audio anyway could reach across and stop that
    // newer session's own helper instead of this dead one's.
    let helperStarted = false;

    // Superseded either by a stop() for this SAME generation, or by a
    // NEWER start() that has already bumped this.generation past
    // myGeneration.
    const superseded = () => myGeneration !== this.generation || this.stopping;

    // Tears down exactly what THIS call has acquired so far, however
    // late a given await resolves. Idempotent — every branch nulls what
    // it touches, so a second call is a clean no-op.
    const abandonStart = async (): Promise<void> => {
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      if (transport) {
        await transport.stop();
        transport = null;
      }
      if (helperStarted) {
        const invokeFn = await getInvoke();
        invokeFn("stop_app_audio").catch(() => {});
      }
    };

    const invoke = await getInvoke();
    if (superseded()) {
      await abandonStart();
      return;
    }
    const listen = await getListen();
    if (superseded()) {
      await abandonStart();
      return;
    }
    const createChannel = await getChannelFactory();
    if (superseded()) {
      await abandonStart();
      return;
    }

    let caps: AudiocapCapabilities;
    try {
      caps = await invoke<AudiocapCapabilities>("audiocap_capabilities");
    } catch {
      if (superseded()) {
        await abandonStart();
        return;
      }
      events.onStatus("error", "无法确认系统音频捕获是否可用，请重试");
      return;
    }
    if (superseded()) {
      await abandonStart();
      return;
    }
    if (!caps.appAudioSupported) {
      events.onStatus(
        "error",
        caps.reason || "当前系统不支持系统音频捕获，需要 macOS 14.4 或更高版本",
      );
      return;
    }

    transport = new WsTransport({
      events,
      settings,
      connectFailureMessage: (url) =>
        `系统音频捕获需要本地 Whisper sidecar（见 README），无法连接 ${url}`,
    });
    this.transport = transport;

    unlisten = await listen<AudiocapStatusPayload>("audiocap://status", (event) => {
      this.handleStatus(myGeneration, event.payload);
    });
    this.unlistenStatus = unlisten;
    if (superseded()) {
      await abandonStart();
      return;
    }

    const channel = createChannel((data) => {
      this.handleChannelMessage(myGeneration, data);
    });

    try {
      await invoke("start_app_audio", { channel });
      helperStarted = true;
    } catch {
      if (superseded()) {
        await abandonStart();
        return;
      }
      events.onStatus("error", "无法启动系统音频捕获，请重试");
      await this.stop();
      return;
    }

    // Mirrors every check above, one last time, for the just-requested
    // capture itself.
    if (superseded()) {
      await abandonStart();
    }
  }

  private handleStatus(myGeneration: number, payload: AudiocapStatusPayload): void {
    if (myGeneration !== this.generation) return; // D5 generation guard — stale session

    // F3: latch BEFORE branching on this.stopping below — a terminal
    // status is just as meaningful arriving pre-stop (e.g.
    // permission-denied, surfaced as an error below, which useMeeting.ts
    // then reacts to by calling stop() itself) as it is arriving
    // mid-stop (the "ended" case the branch below already handles).
    // Either way, once the helper is known-dead, stop()'s own wait has
    // nothing left to wait for.
    if (TERMINAL_STATUS_KINDS.has(payload.kind)) this.helperTerminated = true;

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
   * tabAudio.ts's pause() exactly.
   *
   * F4-js (adversarial review, HIGH, pinned contract): pause must gate
   * in Rust too — the tap keeps producing frames the WHOLE time only
   * this JS-side transport.pauseFeed() gate is holding, so a slow
   * drain/reconnect could otherwise let a burst through before the
   * local gate catches it. invoke("pause_app_audio") (idempotent,
   * no-arg — server-side companion to this fix) runs FIRST and gates at
   * the source; transport.pauseFeed() below stays as belt-and-
   * suspenders regardless of whether that invoke succeeds — an invoke
   * failure is logged-not-fatal, since the JS-side gate alone is still
   * a correct (if not double-gated) pause. */
  async pause(): Promise<void> {
    if (this.stopping || !this.transport) return;
    const transport = this.transport;
    const invoke = await getInvoke();
    try {
      await invoke("pause_app_audio");
    } catch (err) {
      // Logged-not-fatal — see this method's own doc comment.
      diagLog("warn", "stt-appaudio", "pause_app_audio 调用失败，已回退到仅本地暂停", String(err));
    }
    transport.pauseFeed();
  }

  /** Resume after pause() — same transport, no re-invoke. Mirrors
   * pause()'s own invoke-then-local-gate ordering (F4-js) via
   * resume_app_audio. */
  async resume(): Promise<void> {
    if (this.stopping || !this.transport) return;
    const transport = this.transport;
    const invoke = await getInvoke();
    try {
      await invoke("resume_app_audio");
    } catch (err) {
      // Logged-not-fatal — see pause()'s own doc comment.
      diagLog("warn", "stt-appaudio", "resume_app_audio 调用失败，已回退到仅本地恢复", String(err));
    }
    transport.resumeFeed();
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
    // drain wait when the ws was never OPEN). F3: equally skip it once
    // helperTerminated is already latched — a helper that's already
    // reported permission-denied/crashed/unsupported/device-changed (or
    // even a pre-stop "ended") is known-dead, so no FURTHER "ended" is
    // ever coming to resolve the wait early; every one of those cases
    // used to still burn the full STOP_ENDED_TIMEOUT_MS for nothing. The
    // live user-stop drain path (helper alive -> stop() -> "ended"
    // arrives DURING the wait, caught by handleStatus's `if
    // (this.stopping)` branch above) is untouched: helperTerminated is
    // still false at the moment this check runs in that case.
    if (this.unlistenStatus && !this.helperTerminated) {
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
