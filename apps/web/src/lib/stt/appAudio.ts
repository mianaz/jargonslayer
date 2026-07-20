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
//   invoke("start_app_audio", { channel, token })
//     channel: Channel<ArrayBuffer>; token: string — FB3 (S12b fix round
//     B, replaces F4(b)'s Rust-returned-generation design): a CLIENT-
//     GENERATED attempt token (newId(), @jargonslayer/core/types),
//     minted BEFORE this invoke is ever sent. Rust stores it verbatim on
//     the session it reserves.
//   invoke("stop_app_audio", { token })  — idempotent; token: string,
//     REQUIRED — must be the exact token the matching start_app_audio
//     call used. A mismatch (nothing running, or a DIFFERENT attempt's
//     token) is a clean no-op — there is no unscoped fallback on the
//     wire at all (see stop()'s own doc comment for why the CLIENT-
//     generated token, known before the invoke, closes the hole the old
//     Rust-returned generation left open: a REJECTED start never
//     receives one, so its own unwind had nothing to scope to and fell
//     back to unscoped, which could kill an unrelated live session).
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

import {
  newId,
  type MeetingLexicon,
  type STTEngine,
  type STTEngineKind,
  type STTEvents,
  type Settings,
} from "@jargonslayer/core/types";
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

  // F17 (S12 blueprint §2.6′, generation-safe appAudio stop-wait parity —
  // Sol adversarial finding 17): mirrors osSpeech.ts's `running` flag for
  // stop()'s own gate below, but GENERATION-SCOPED rather than a shared
  // boolean — this file's own generation-isolation invariant (see the
  // LOCAL `helperStarted` in start()) means a plain shared boolean would
  // let an OLDER, late-resolving start_app_audio invoke() set it back
  // AFTER a newer start()'s own reset, corrupting stop()'s gate for
  // whichever generation is actually live (wrong-generation 4s waits, or
  // teardown clearing the live generation's own flag). Set in start()
  // (see that method's own comment) only once THIS call's generation is
  // confirmed NOT superseded — an abandoned old call never touches this.
  // stop() captures its own current generation and both waits and clears
  // only on a match (see stop() below).
  private helperStartedGeneration: number | null = null;

  // FB3 (S12b fix round B, Sol3, HIGH — replaces F4(b)'s rustGeneration
  // design): a CLIENT-GENERATED attempt token (newId()), published
  // SYNCHRONOUSLY and UNCONDITIONALLY at the top of every start() call,
  // alongside `this.generation`'s own bump (see that field's own doc
  // comment) — deliberately NOT gated behind a "confirmed not
  // superseded" check the way helperStartedGeneration is. This mirrors
  // this.generation's own publish discipline for the same reason: JS is
  // single-threaded, so no OTHER start() call's synchronous prefix can
  // ever interleave with THIS one's — the LATEST call to reach this line
  // is always the authoritative one, exactly like this.generation itself
  // — and unlike the OLD Rust-returned generation (which only existed
  // AFTER a successful start_app_audio invoke), this token is known
  // BEFORE that invoke is ever sent, so it is ALWAYS available to scope
  // every stop_app_audio call: the live "user stops it" path, the F1
  // pre-resolve-cancellation race (stop() landing before THIS SAME
  // attempt's own start_app_audio has resolved), AND a REJECTED start's
  // own catch-block unwind (which, under the old rustGeneration design,
  // had nothing to scope to and fell back to an unscoped null — Sol's
  // finding: that unscoped stop could kill a DIFFERENT, unrelated live
  // session). `null` only when start() has never been called on this
  // engine instance at all. Threaded into every stop_app_audio invoke
  // (both stop()'s own call and abandonStart()'s best-effort one) — see
  // stop_app_audio's own doc comment in audiocap.rs for the full
  // contract.
  private attemptToken: string | null = null;

  // stop()'s wait for the helper's "ended" status — see
  // STOP_ENDED_TIMEOUT_MS's own doc comment above.
  private stopEndedResolve: (() => void) | null = null;
  private stopEndedTimer: ReturnType<typeof setTimeout> | null = null;

  // S9 live-failure investigation (docs/design-explorations/
  // s9-app-audio-tap-blueprint.md) — the field export showed ZERO
  // appaudio diag entries even though a capture had actually run, so
  // this engine had no visibility into which of three things happened:
  // (a) the tap captured pure silence, (b) the Channel delivered a
  // different runtime shape than source-reading suggested, or (c) the
  // helper failed at start with a status the user missed. These fields
  // back the one-time/first-arrival diag markers below — all reset per
  // start() alongside feedAttached/helperTerminated above.
  private firstChannelMessageLogged = false;
  private jsonDegradedChannelLogged = false;
  private unrecognizedChannelPayloadLogged = false;
  private channelMessageCount = 0;
  private channelByteTotal = 0;

  async start(events: STTEvents, settings: Settings, lexicon?: MeetingLexicon): Promise<void> {
    diagLog("info", "stt-appaudio", "系统音频引擎启动请求");
    this.events = events;
    this.stopping = false;
    this.feedAttached = false;
    this.helperTerminated = false;
    this.firstChannelMessageLogged = false;
    this.jsonDegradedChannelLogged = false;
    this.unrecognizedChannelPayloadLogged = false;
    this.channelMessageCount = 0;
    this.channelByteTotal = 0;
    const myGeneration = ++this.generation;
    // FB3: minted and published RIGHT HERE, synchronously and
    // unconditionally — see this.attemptToken's own doc comment for why
    // this (not the "only once confirmed live" discipline
    // helperStartedGeneration follows) is the correct, safe publish
    // point for this specific field.
    const myToken = newId();
    this.attemptToken = myToken;

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
    // BEFORE that point has nothing server-side to stop, so this still
    // guards abandonStart()'s own stop_app_audio call purely as an
    // efficiency skip (a call before this point is a GUARANTEED no-op:
    // either the macOS-version-gate rejected before Rust's own try_begin
    // ever ran, or try_begin succeeded but the spawn itself failed,
    // which releases the slot server-side before the invoke even
    // rejects here) — NOT a safety gate anymore. FB3 (S12b fix round B):
    // safety now comes from `myToken` (this.attemptToken's own local
    // capture, below) being ALWAYS correctly scoped to THIS attempt,
    // known before start_app_audio is even called — a stale/superseded
    // OR flatly-rejected attempt's own stop can no longer reach across
    // and stop a different session's helper (see stop_app_audio's own
    // doc comment in audiocap.rs).
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
        // FB3: ALWAYS this attempt's OWN local myToken — never
        // this.attemptToken (which may since belong to a NEWER attempt).
        invokeFn("stop_app_audio", { token: myToken }).catch(() => {});
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
      lexicon,
      connectFailureMessage: (url) =>
        `系统音频捕获需要本地 Whisper（见 README），无法连接 ${url}`,
    });

    unlisten = await listen<AudiocapStatusPayload>("audiocap://status", (event) => {
      this.handleStatus(myGeneration, event.payload);
    });
    if (superseded()) {
      await abandonStart();
      return;
    }
    // F4(a) (S12a fix round, adversarial pair 2026-07-16, GPT-5.6-Sol
    // finding 4): publish BOTH acquisitions to instance state only now,
    // past this SAME post-acquisition superseded() check — the same
    // discipline helperStartedGeneration's own assignment follows below.
    // The pre-fix ordering (this.transport/this.unlistenStatus written
    // IMMEDIATELY on acquisition, before ever checking superseded()) let
    // an OLD generation's belated listen() resolution overwrite a NEWER,
    // already-live generation's own this.unlistenStatus/this.transport
    // with its own soon-to-be-abandoned values: abandonStart() below only
    // ever unregisters THIS call's own LOCAL listener/transport (see that
    // routine's own doc comment), leaving the newer generation's real
    // listener orphaned — nothing left ever calls its own unlisten(), a
    // leak — and/or its transport reference lost. No status event can
    // reach handleStatus() before listen() above has actually resolved,
    // so deferring this publish to right here (rather than the instant
    // each value is acquired) costs nothing observable.
    this.transport = transport;
    this.unlistenStatus = unlisten;

    const channel = createChannel((data) => {
      this.handleChannelMessage(myGeneration, data);
    });

    try {
      await invoke("start_app_audio", { channel, token: myToken });
      helperStarted = true;
    } catch {
      if (superseded()) {
        await abandonStart();
        return;
      }
      // FB3: even on a REJECTED invoke, this.attemptToken (== myToken)
      // was ALREADY published at the top of this call, before the
      // invoke was ever sent — so the stop() below (unlike the OLD
      // rustGeneration design, which had nothing to scope to here) is
      // always correctly scoped to THIS attempt's own token, never
      // falling back to an unscoped stop that could reach a different,
      // unrelated live session (Sol's finding).
      events.onStatus("error", "无法启动系统音频捕获，请重试");
      await this.stop();
      return;
    }

    // Mirrors every check above, one last time, for the just-requested
    // capture itself. F17: this is also the ONLY place
    // helperStartedGeneration is ever assigned — deliberately AFTER this
    // superseded() check, not alongside the local `helperStarted = true`
    // above, so an abandoned OLD call (superseded by a newer start())
    // touches NO instance state at all; only a call that reaches here
    // live claims helperStartedGeneration for its own generation (see
    // that field's own doc comment, and stop()'s matching gen check
    // below). this.attemptToken needs no equivalent assignment here — it
    // was already published, unconditionally, at the top of this call
    // (see that field's own doc comment for why that's the correct,
    // safe publish point).
    if (superseded()) {
      await abandonStart();
      return;
    }
    this.helperStartedGeneration = myGeneration;
  }

  private handleStatus(myGeneration: number, payload: AudiocapStatusPayload): void {
    // S9 live-failure investigation: logged for EVERY status this
    // listener ever receives, before the generation guard below — a
    // status the user "missed" (hypothesis c) is exactly the kind of
    // thing this must never silently drop from the diag ring, even for
    // a generation this particular engine instance goes on to ignore.
    diagLog("info", "stt-appaudio", `audiocap://status 收到: ${payload.kind}`, payload.message);

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

  private handleChannelMessage(myGeneration: number, data: unknown): void {
    if (myGeneration !== this.generation) return; // D5 generation guard — stale session

    // S9 live-failure investigation: logged once, for the very FIRST
    // Channel message this (current-generation) session ever receives
    // — the runtime shape is exactly what discriminates hypothesis (b)
    // (production IPC handing back something other than the ArrayBuffer
    // source-reading predicts) from a healthy channel.
    if (!this.firstChannelMessageLogged) {
      this.firstChannelMessageLogged = true;
      const shape = {
        ctor: (data as { constructor?: { name?: string } } | null | undefined)?.constructor?.name,
        byteLength: (data as { byteLength?: number } | null | undefined)?.byteLength,
        isArray: Array.isArray(data),
      };
      diagLog("info", "stt-appaudio", "首个 Channel 消息到达", JSON.stringify(shape));
    }

    const buffer = this.normalizeChannelPayload(data);
    if (!buffer) return;

    this.channelMessageCount++;
    this.channelByteTotal += buffer.byteLength;

    // Deliberately NOT gated on `this.stopping`: the D5 stop ordering
    // has the helper's own drain/flush tail still arriving over this
    // SAME channel right up until "ended" — that tail must still reach
    // the sidecar before WsTransport.stop()'s own ws drain begins (see
    // stop() below). transport.pushPcm() applies its own guard once
    // that later drain is actually underway; a null transport (already
    // torn down) is a silent no-op here.
    this.transport?.pushPcm(buffer);
  }

  /** Defensive normalization for whatever runtime shape the Channel
   *  actually hands `onmessage` (S9 live-failure investigation):
   *  source-reading (@tauri-apps/api 2.11.1) says InvokeResponseBody
   *  ::Raw arrives as ArrayBuffer, but that's source, not a pinned
   *  runtime guarantee — production IPC could hand back a different JS
   *  shape than source suggests (hypothesis b), so every shape short of
   *  a real ArrayBuffer is handled explicitly rather than forwarded to
   *  pushPcm()/ws.send() blind:
   *   - ArrayBuffer: forwarded AS-IS (same reference, never copied —
   *     matches the existing arrival-shape pin in appAudio.test.ts).
   *   - any other ArrayBufferView (TypedArray/DataView): an
   *     EXACT-WINDOW copy of its buffer — `.buffer` can be a larger
   *     backing store than the view itself spans.
   *   - a plain JS array (the serde JSON-number-array fallback D5's
   *     own blueprint comment warns "would hide silently" at this
   *     bitrate): converted via Uint8Array.from(...).buffer, flagged
   *     with a ONE-TIME diag marker so a live JSON-degraded channel is
   *     never silently absorbed.
   *   - anything else: dropped, one-time diag marker — pushPcm() (and
   *     therefore ws.send()) must never be called with a non-buffer
   *     value. */
  private normalizeChannelPayload(data: unknown): ArrayBuffer | null {
    if (data instanceof ArrayBuffer) return data;

    if (ArrayBuffer.isView(data)) {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    }

    if (Array.isArray(data)) {
      if (!this.jsonDegradedChannelLogged) {
        this.jsonDegradedChannelLogged = true;
        diagLog(
          "warn",
          "stt-appaudio",
          "Channel 消息以 JSON 数组形式到达（应为 ArrayBuffer），已转换但性能受影响",
        );
      }
      return Uint8Array.from(data).buffer;
    }

    if (!this.unrecognizedChannelPayloadLogged) {
      this.unrecognizedChannelPayloadLogged = true;
      diagLog(
        "error",
        "stt-appaudio",
        "Channel 消息类型无法识别，已丢弃",
        `ctor=${(data as { constructor?: { name?: string } } | null | undefined)?.constructor?.name ?? typeof data}`,
      );
    }
    return null;
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
    // F17: captured synchronously, atomically with `this.stopping = true`
    // above (no await between them, so no concurrent start() can
    // interleave) — `gen` is exactly the generation THIS stop() call is
    // being asked to stop. A concurrent start() may still bump
    // this.generation further after this point, but that call's own
    // superseded() check (`|| this.stopping`) makes it abandon itself
    // before ever assigning helperStartedGeneration for its own newer
    // generation — so only `gen` itself could ever have set that field,
    // and the match check below stays sound.
    const gen = this.generation;
    // FB3 (S12b fix round B): this.attemptToken is ALWAYS current for
    // `gen` — published synchronously and unconditionally at the top of
    // EVERY start() call (see that field's own doc comment for why,
    // unlike helperStartedGeneration, it needs no "matches gen" gate
    // here at all: nothing can interleave between two start() calls' own
    // synchronous prefixes, so whichever token is currently published is
    // always the one belonging to the CURRENT generation). `null` only
    // when start() has never been called on this engine instance at all
    // — in that one case there is nothing valid to send (stop_app_audio's
    // own `token` parameter is REQUIRED, not optional — no unscoped path
    // exists anymore), and nothing could be running on this engine's own
    // account anyway, so the invoke is skipped outright rather than sent
    // with a bogus value.
    const token = this.attemptToken;

    if (token !== null) {
      const invoke = await getInvoke();
      try {
        await invoke("stop_app_audio", { token });
      } catch {
        // best-effort — tear down our own side regardless of whether the
        // helper actually heard us.
      }
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
    // still false at the moment this check runs in that case. F17 (S12
    // blueprint §2.6′): ALSO only if a session for THIS generation
    // actually started — `this.helperStartedGeneration === gen` — in the
    // first place. A REJECTED start_app_audio invoke() (see start()'s own
    // catch block) routes through this SAME stop() to unwind without
    // helperStartedGeneration ever having been set for its generation;
    // unlistenStatus is already registered by then too (both acquired
    // BEFORE the invoke), so without this extra check the wait below
    // still ran and burned the full STOP_ENDED_TIMEOUT_MS for an "ended"
    // no helper process was ever going to send. Generation-scoped (not a
    // shared boolean, see that field's own doc comment) so an OLDER,
    // late-resolving start_app_audio invoke() from an already-abandoned
    // call can never satisfy or corrupt a NEWER generation's own gate.
    if (this.unlistenStatus && !this.helperTerminated && this.helperStartedGeneration === gen) {
      await this.waitForEndedOrTimeout();
    }

    // S9 live-failure investigation: cumulative Channel message
    // count/bytes for the WHOLE session, logged once at teardown — the
    // drain/flush tail above (if any) has already arrived by this
    // point, so this is the true final tally, not a mid-session
    // snapshot.
    diagLog(
      "info",
      "stt-appaudio",
      "系统音频引擎停止",
      `channelMessages=${this.channelMessageCount} channelBytes=${this.channelByteTotal}`,
    );

    const transport = this.transport;
    this.transport = null;
    if (transport) {
      await transport.stop();
    }

    const unlisten = this.unlistenStatus;
    this.unlistenStatus = null;
    unlisten?.();

    // F17: clear only the MATCHING generation's flag — a newer start()
    // may already have claimed helperStartedGeneration for its own live
    // generation by the time this (older) stop() call finally reaches
    // teardown; clearing unconditionally here would corrupt that newer
    // generation's own stop() gate out from under it. this.attemptToken
    // needs no equivalent clear (FB3) — it is unconditionally
    // OVERWRITTEN by the very next start() call regardless of whatever
    // stale value is left here (mirrors this.generation's own "never
    // cleared, only ever advanced" discipline — see that field's own doc
    // comment).
    if (this.helperStartedGeneration === gen) {
      this.helperStartedGeneration = null;
    }

    this.events = null;
  }
}
