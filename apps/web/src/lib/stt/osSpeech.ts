// Zero-Install 系统识别 engine (S11, docs/design-explorations/
// s11-osspeech-blueprint.md): desktop-only, macOS 26+ on-device
// transcription via Apple's SpeechAnalyzer, riding the SAME CoreAudio
// process tap appaudio.ts already taps (jargonslayer-audiocap's new
// "transcribe" mode — byte-identical capture path up to the ring, see
// the blueprint's §0). Unlike appaudio, NO PCM ever reaches this
// process: the helper converts+feeds SpeechAnalyzer itself and emits
// already-transcribed text over the stderr NDJSON lane, which the Rust
// side (osspeech.rs) re-emits as two PARALLEL Tauri events —
// "osspeech://transcript" and "osspeech://status" — a CLOSED set
// distinct from appaudio's own "audiocap://status" (§2.5: zero
// contamination of that closed set). No WsTransport, no websocket, no
// local Whisper sidecar of any kind.
//
// Every `@tauri-apps/*` touch point goes through tauriApi.ts (the ONLY
// module in this app that imports it), same contract appAudio.ts
// already established — this file imports zero Tauri itself.
//
// Wire contract (PINNED — §2.4/§2.5/§2.6 of the blueprint):
//   invoke("start_os_speech", { locale, contextualJson, source? })
//   invoke("stop_os_speech")                 — idempotent
//   invoke("pause_os_speech")/("resume_os_speech") — idempotent, no-arg
//   event "osspeech://transcript" -> { final, seq, startMs, endMs, text,
//     channel? }
//   event "osspeech://status" -> { kind, message?, progress?,
//     resolvedLocale?, supportedLocales? }, kind one of the CLOSED set
//     below (OsSpeechStatusKind).
//
// Dual capture v1 (docs/design-explorations/dual-capture-2026-08.md,
// Rust side: apps/desktop/src-tauri/src/osspeech.rs): `source` is
// "mic"|"system"|"dual" — omitted (or "system") is byte-identical to
// every pre-dual-capture caller, the Rust command's own default.
// `channel` ("mic"|"system") rides ONLY a transcript whose session
// started with an explicit `source` — absent (never null) on a
// legacy/single-source ("system", the default) session. See start()/
// handleTranscript below for how this engine maps settings.mode <->
// source/channel.
//
// Generation guard (JS side, identical idiom to appAudio.ts's own header
// comment): every listen() callback registered by a given start() call
// captures that call's own generation number and drops anything that
// arrives once a LATER start() has superseded it — a late transcript/
// status from a dying session can never cross into a later one on the
// SAME engine instance. abandonStart() tears down exactly what THIS
// call has acquired so far via LOCAL holders (never this.unlistenX
// directly), re-checked after every awaited acquisition — see
// appAudio.ts's own F2 finding for why this matters.

import type { MeetingLexicon, STTEngine, STTEngineKind, STTEvents, Settings } from "@jargonslayer/core/types";
import { getInvoke, type UnlistenFn } from "../desktop/tauriApi";
import { trackOsSpeechAsset, type OsSpeechAssetTracker } from "../desktop/jobsBridge";
import { diagLog } from "../diag/log";
import { IS_IOS } from "../platform/ios";
import { IS_DESKTOP } from "../platform/desktop";
import { listenOsSpeechAudioStats, listenOsSpeechStatus, listenOsSpeechTranscript } from "./osSpeechTransport";
import { projectForOsSpeechContextualJson } from "./lexicon";
import { pushAudioWindow } from "./audioLiveness";
// Dual capture v1 (docs/design-explorations/dual-capture-2026-08.md):
// the two channel-tagged stable speaker ids — store.ts owns the
// speakerAliases/seedChannelAlias machinery these feed, so the literals
// live there and this file imports rather than hand-typing a second
// copy. No import cycle: jobsBridge.ts above already pulls in store.ts
// transitively (useApp), and store.ts itself never imports this file.
import { CH_MIC_SPEAKER, CH_SYS_SPEAKER } from "../store";

export type OsSpeechStatusKind =
  | "starting"
  | "capturing"
  | "asset-checking"
  | "asset-downloading"
  | "asset-installed"
  | "asset-failed"
  | "locale-resolved"
  | "permission-denied"
  | "unsupported"
  | "unsupported-locale"
  | "device-changed"
  | "crashed"
  | "ended";

export interface OsSpeechStatusPayload {
  kind: OsSpeechStatusKind;
  // S11 fix-round J1 (cross-lane contract, PINNED — Rust's osspeech.rs
  // implementing in parallel): every osspeech://status payload now names
  // the lane it came from — "session" (a running transcribe session, the
  // ONE source this file's own handleStatus below ever acts on) or
  // "preinstall" (the preinstall_os_speech background task — wizard/
  // Settings' own 预下载模型, driven by osspeechCaps.ts's
  // preinstallOsSpeech). Required (not optional): closes the false-latch
  // window where a background preinstall finishing/failing between THIS
  // engine's own listener registration and its own session start would
  // otherwise be mistaken for this session's own helper terminating —
  // see handleStatus's own guard, checked before any latch/status logic.
  source: "session" | "preinstall";
  message?: string;
  progress?: number;
  resolvedLocale?: string;
  supportedLocales?: string[];
  // Silent-session hint (2026-08-02 field report): desktop osspeech.rs
  // attaches this to a session's FINAL status event only — whether any
  // helper stats line ever reported a nonzero running peak, i.e.
  // whether the CoreAudio system-audio tap saw real audio at all.
  // Absent on every non-final event, on iOS (whose plugin lane taps the
  // MIC — the desktop steer copy below would be wrong there), and on an
  // older Rust side — which is why handleStatus checks `=== false`,
  // never mere falsiness.
  sawAudio?: boolean;
}

// Lane W (mid-session STT liveness watchdog + per-channel silence hint,
// lib/stt/audioLiveness.ts): the dedicated "osspeech://audio-stats" event
// (osspeech.rs's own emit_audio_stats_for_session) — a windowed peak per
// stats cadence (~5s, TranscribeConsumer.swift), distinct from the
// transcript/status lanes above. Desktop-only, same as dual capture
// itself — osSpeechTransport.ts's own listener never subscribes on iOS
// (no equivalent Rust event exists there).
export interface OsSpeechAudioStatsPayload {
  channel?: "mic" | "system";
  windowPeak: number;
  // Fix C (pre-tag fix round, sustained-audio predicate): forwarded
  // verbatim from Rust's own optional `windowLoudMs` (osspeech.rs) —
  // absent on an older/foreign helper build, see audioLiveness.ts's own
  // pushAudioWindow doc comment for the fallback this triggers.
  windowLoudMs?: number;
}

export interface OsSpeechTranscriptPayload {
  final: boolean;
  seq: number;
  startMs: number;
  endMs: number;
  text: string;
  // Dual capture v1: forwarded verbatim from Rust's own optional
  // `channel` field — absent (not null) on a legacy/single-source
  // ("system") session, see this file's header comment.
  channel?: "mic" | "system";
}

// §2.5 TERMINAL kinds — the helper is gone (or never going to start)
// once any of these arrives. Exported so osspeechCaps.ts's
// preinstallOsSpeech() can settle its own Promise on the SAME closed
// set without hand-duplicating it (single source of truth, mirrors
// this file's OsSpeechStatusPayload/Kind being the shared shape both
// modules read off the same "osspeech://status" lane).
export const OSSPEECH_TERMINAL_STATUS_KINDS = new Set<OsSpeechStatusKind>([
  "ended",
  "crashed",
  "permission-denied",
  "unsupported",
  "unsupported-locale",
  "device-changed",
  "asset-failed",
]);

// Bounds stop()'s wait for the helper's own "ended" status — identical
// idiom/value to appAudio.ts's own STOP_ENDED_TIMEOUT_MS (§2.7: Rust's
// STOP_GRACE_PERIOD, 3s, must stay shorter than this 4s JS-side wait —
// see that file's own doc comment for the full invariant).
const STOP_ENDED_TIMEOUT_MS = 4000;

/** Dual capture v1 / Fix B (pre-tag fix round): the one place a channel
 *  tag maps onto the matching stable sttSpeaker id — shared by both
 *  handleTranscript's final AND interim branches so the mapping can never
 *  drift between them. `undefined` for a channel-less payload (a legacy/
 *  single-source session), matching `channelFromSttSpeaker`'s own
 *  (useMeeting.ts) "no channel signal" contract on the other end. */
function sttSpeakerForChannel(channel: "mic" | "system" | undefined): string | undefined {
  if (channel === "mic") return CH_MIC_SPEAKER;
  if (channel === "system") return CH_SYS_SPEAKER;
  return undefined;
}

function unsupportedLocaleMessage(payload: OsSpeechStatusPayload): string {
  const requested = payload.message ? `（${payload.message}）` : "";
  const supported = payload.supportedLocales?.length
    ? `，支持的语言包括：${payload.supportedLocales.join("、")}`
    : "";
  return `系统识别不支持当前识别语言${requested}${supported}，请更换语言或切换到其他引擎`;
}

export class OsSpeechEngine implements STTEngine {
  readonly kind: STTEngineKind = "osspeech";

  private events: STTEvents | null = null;
  private stopping = false;

  // D5/S9 generation guard (JS side) — see this file's header comment.
  private generation = 0;

  private unlistenTranscript: UnlistenFn | null = null;
  private unlistenStatus: UnlistenFn | null = null;
  // Lane W (mid-session STT liveness watchdog, audioLiveness.ts): a
  // third, independent lane — see listenOsSpeechAudioStats's own doc
  // comment for why it's desktop-only (a no-op unlisten on iOS).
  private unlistenAudioStats: UnlistenFn | null = null;

  // True once start_os_speech has been successfully invoked for the
  // CURRENT generation — guards pause()/resume() from firing on a
  // session that never got that far, mirroring appAudio.ts's own
  // `!this.transport` check (there is no transport here to check
  // instead).
  private running = false;

  // F3 (appAudio.ts precedent): latched true the moment ANY TERMINAL
  // status (OSSPEECH_TERMINAL_STATUS_KINDS) arrives, regardless of
  // whether we're already stopping — see handleStatus's own comment.
  // stop() reads this to skip waitForEndedOrTimeout() once the helper
  // is already known-dead.
  private helperTerminated = false;

  private stopEndedResolve: (() => void) | null = null;
  private stopEndedTimer: ReturnType<typeof setTimeout> | null = null;

  // Per-session asset task-row driver (§2.6 asset-downloading/
  // asset-installed/asset-failed) — a FRESH tracker every start(), never
  // reused across sessions (a reused tracker would attach a later
  // session's downloading/installed/failed events onto an EARLIER
  // session's already-settled task id).
  private assetTracker: OsSpeechAssetTracker | null = null;
  private assetCheckingNoticeShown = false;
  private assetDownloadingNoticeShown = false;

  // Recorded at "capturing" (§2.6). Two consumers: (1) the silent-
  // session hint in handleStatus reads its non-null-ness as "capture
  // actually started" (a session abandoned during asset download must
  // not get mic-steering copy); (2) NOT onFinal timing — A3
  // verify-from-source (see this file's onFinal call in handleTranscript)
  // found wsTransport.ts's own onFinal call passes no `startedAt` at all,
  // so this engine matches that semantic by passing none either, rather
  // than inventing a value nothing downstream of appaudio/wsTransport
  // actually consumes.
  private sessionStartEpoch: number | null = null;
  private finalCount = 0;
  // Dual capture v1: true when THIS session started with a source that
  // captures the microphone (mic or dual) — set in start(), read only by
  // the silent-session hint in handleStatus, which must not tell a user
  // who deliberately picked 麦克风/麦克风+系统 that this engine "doesn't
  // capture the microphone". Defaults false so a legacy/system-audio
  // session (and every pre-dual-capture code path) behaves exactly as
  // before.
  private sessionCapturedMic = false;

  async start(events: STTEvents, settings: Settings, lexicon?: MeetingLexicon): Promise<void> {
    diagLog("info", "stt-osspeech", "系统识别引擎启动请求");
    this.events = events;
    this.stopping = false;
    this.running = false;
    this.helperTerminated = false;
    this.assetTracker = trackOsSpeechAsset();
    this.assetCheckingNoticeShown = false;
    this.assetDownloadingNoticeShown = false;
    this.sessionStartEpoch = null;
    this.finalCount = 0;
    // Reset beside its sibling session fields, not only at the assignment
    // further down: a start() that throws before reaching that line (caps
    // probe, permission) must not leave the PREVIOUS session's value
    // latched — a dual session followed by a failed one would otherwise
    // suppress the hint for a later system-audio session.
    this.sessionCapturedMic = false;
    const myGeneration = ++this.generation;

    // Mirrors appAudio.ts's F2 fix exactly (see this file's header
    // comment): local holders only, re-checked after every awaited
    // acquisition, torn down via the ONE abandonStart() below so an
    // abandoned OLD call can never clobber a NEWER start()'s own state.
    let unlistenTranscript: UnlistenFn | null = null;
    let unlistenStatus: UnlistenFn | null = null;
    let unlistenAudioStats: UnlistenFn | null = null;
    let helperStarted = false;

    const superseded = () => myGeneration !== this.generation || this.stopping;

    const abandonStart = async (): Promise<void> => {
      if (unlistenTranscript) {
        unlistenTranscript();
        unlistenTranscript = null;
      }
      if (unlistenStatus) {
        unlistenStatus();
        unlistenStatus = null;
      }
      if (unlistenAudioStats) {
        unlistenAudioStats();
        unlistenAudioStats = null;
      }
      if (helperStarted) {
        const invokeFn = await getInvoke();
        invokeFn("stop_os_speech").catch(() => {});
      }
    };

    const invoke = await getInvoke();
    if (superseded()) {
      await abandonStart();
      return;
    }

    // S13 (docs/design-explorations/s13-ios-blueprint.md, §2/§6 D2): both
    // subscriptions go through osSpeechTransport.ts's shim, the ONE place
    // that branches desktop's macOS global events vs iOS's plugin-scoped
    // ones — this engine's own generation-guard/latch logic is unchanged
    // either way.
    //
    // Fix-round F6 (Sol, MEDIUM): both subscription awaits now share the
    // SAME try as start_os_speech's own invoke() below — previously only
    // the invoke() was guarded, so a rejected SECOND subscription (e.g.
    // iOS's addPluginListener denied by the plugin ACL) skipped the catch
    // entirely and leaked the FIRST (transcript) listener forever, since
    // abandonStart() never ran. Scope-widening only — same two calls,
    // same order, same superseded() checks in between.
    try {
      unlistenTranscript = await listenOsSpeechTranscript((event) => {
        this.handleTranscript(myGeneration, event.payload);
      });
      this.unlistenTranscript = unlistenTranscript;
      if (superseded()) {
        await abandonStart();
        return;
      }

      unlistenStatus = await listenOsSpeechStatus((event) => {
        this.handleStatus(myGeneration, event.payload);
      });
      this.unlistenStatus = unlistenStatus;
      if (superseded()) {
        await abandonStart();
        return;
      }

      // Lane W: third, independent lane — a no-op subscription on iOS
      // (listenOsSpeechAudioStats's own doc comment), so this never
      // widens the F6 fix-round concern above (there is nothing to leak
      // there when IS_IOS is true).
      unlistenAudioStats = await listenOsSpeechAudioStats((event) => {
        this.handleAudioStats(myGeneration, event.payload);
      });
      this.unlistenAudioStats = unlistenAudioStats;
      if (superseded()) {
        await abandonStart();
        return;
      }

      // Q11, generalized (v0.4.7 Lane B, D8): `lexicon` is the ONE
      // snapshot useMeeting.ts's attachEngine already built fresh for
      // THIS start() call (glossary headwords/variants + enabled packs
      // + suppressed learn-set terms, tiered — see lexicon.ts) — no
      // store read here at all anymore, matching every other engine
      // this lane touched. `?? { terms: [] }` only guards a caller
      // (e.g. a test) that omits the optional 3rd param entirely.
      const contextualJson = projectForOsSpeechContextualJson(lexicon ?? { terms: [] });

      // Dual capture v1 is desktop-only (design contract: "Web/iOS
      // osspeech behavior unchanged, iOS stays mic-only") — iOS's own
      // start_os_speech Rust command (osspeech_ios.rs) has NO `source`
      // parameter at all, unlike desktop's (osspeech.rs), so this MUST
      // gate on IS_DESKTOP, not merely on mode. Without that gate, iOS
      // osspeech (whose mode is ALWAYS "mic" — modeForPersistedEngine's
      // own iOS branch never derives anything else) would send a
      // `source` key every single start(), an argument that command
      // doesn't declare. `source` is spread in ONLY for desktop
      // mic/dual — fully OMITTED for every other mode (system-audio) or
      // platform (iOS), byte-identical to every pre-dual-capture
      // caller's argv (build_transcribe_args, osspeech.rs, defaults to
      // "system" when the param is absent).
      const source =
        IS_DESKTOP && (settings.mode === "mic" || settings.mode === "dual") ? settings.mode : undefined;
      // The silent-session hint in handleStatus steers a user who picked
      // 系统 expecting mic capture — copy that is only TRUE for a
      // system-audio session. Latch what this session actually started
      // with (undefined source === the Rust default, "system") so that
      // hint can suppress itself on mic/dual, where the very confusion
      // it addresses cannot arise.
      this.sessionCapturedMic = source === "mic" || source === "dual";
      await invoke("start_os_speech", {
        locale: settings.language,
        contextualJson,
        ...(source ? { source } : {}),
      });
      helperStarted = true;
      this.running = true;
    } catch {
      if (superseded()) {
        await abandonStart();
        return;
      }
      events.onStatus("error", "无法启动系统识别，请重试");
      await this.stop();
      return;
    }

    if (superseded()) {
      await abandonStart();
    }
  }

  private handleTranscript(myGeneration: number, payload: OsSpeechTranscriptPayload): void {
    if (myGeneration !== this.generation) return; // stale session

    const events = this.events;
    if (!events) return;

    // Deliberately NOT gated on `this.stopping` — mirrors appAudio.ts's
    // own handleChannelMessage: the helper's drain/flush tail (§2.7)
    // still emits its remaining finals right up until "ended", and
    // those must still reach the transcript exactly like appaudio's own
    // PCM drain tail still reaches the ws during its own stop wait.
    if (payload.final) {
      this.finalCount++;
      // A3 verify-from-source: wsTransport.ts's own onFinal call (see
      // apps/web/src/lib/stt/wsTransport.ts:332,
      // `events.onFinal(final.text, { sttSeg: ... })`) passes NO
      // `startedAt` field at all — so this call matches that exact
      // semantic by passing none either, rather than inventing an
      // epoch-ms value (sessionStartEpoch + payload.startMs) nothing
      // downstream of the appaudio/wsTransport family actually reads.
      //
      // Dual capture v1: `channel` (present only on a session actually
      // started with a `source`) maps to the matching stable sttSpeaker
      // id — store.ts's addFinal resolves the DISPLAY name from it. The
      // 2nd arg is OMITTED entirely (not passed as `undefined`) for a
      // channel-less payload, so a legacy/single-source session's finals
      // stay byte-identical to before this feature (no phantom speaker).
      if (payload.channel) {
        events.onFinal(payload.text, {
          sttSpeaker: sttSpeakerForChannel(payload.channel),
        });
      } else {
        events.onFinal(payload.text);
      }
    } else {
      // Fix B (pre-tag fix round, HIGH): the interim branch used to drop
      // the channel entirely — see STTEvents.onInterim's own doc comment
      // for the third-argument contract this now feeds. `speaker` (2nd
      // arg, InterimLine's own display value) stays `undefined`, exactly
      // as before this fix — only the NEW third argument changes.
      events.onInterim(payload.text, undefined, sttSpeakerForChannel(payload.channel));
    }
  }

  // Lane W (mid-session STT liveness watchdog): forwarded straight into
  // audioLiveness.ts's own store — this engine carries no verdict/UI
  // logic of its own, same "dumb producer" posture handleTranscript/
  // handleStatus already have toward their own consumers. `channel`
  // absent (a legacy/single-source session) maps to "default" — the
  // same fallback key wsTransport.ts's whisper-family PCM fold uses,
  // since there is equally no per-channel signal to carry there.
  private handleAudioStats(myGeneration: number, payload: OsSpeechAudioStatsPayload): void {
    if (myGeneration !== this.generation) return; // stale session
    pushAudioWindow(payload.channel ?? "default", payload.windowPeak, payload.windowLoudMs);
  }

  private handleStatus(myGeneration: number, payload: OsSpeechStatusPayload): void {
    diagLog("info", "stt-osspeech", `osspeech://status 收到: ${payload.kind}`, payload.message);

    if (myGeneration !== this.generation) return; // stale session

    // S11 fix-round J1 (cross-lane contract): ignore anything that isn't
    // THIS session's own lane, before any latch/status logic runs. A
    // background preinstall (source: "preinstall") finishing/failing in
    // the race window between this engine's own listener registration
    // and its own session actually starting must never terminal-latch
    // (helperTerminated below) a session that hasn't even begun — see
    // OsSpeechStatusPayload's own doc comment on `source`.
    if (payload.source !== "session") return;

    // F3 (appAudio.ts precedent): latch BEFORE branching on
    // this.stopping — a terminal status is just as meaningful arriving
    // pre-stop (e.g. permission-denied) as mid-stop.
    if (OSSPEECH_TERMINAL_STATUS_KINDS.has(payload.kind)) {
      this.helperTerminated = true;
      // S11 fix-round J2(c): the session ending ANY other way (crashed/
      // permission-denied/device-changed/unsupported(-locale)/a normal
      // "ended" reached mid-download, incl. the user's own stop() —
      // latched unconditionally above, same as helperTerminated) must
      // not leave an asset row stuck "running" forever — e.g. a row this
      // session ADOPTED from a preempted preinstall (§J2b) never gets
      // its own asset-installed/asset-failed if the session itself ends
      // first. "asset-failed" is excluded: its own switch case below
      // already settles the row with the REAL failure message; calling
      // settle() here too would just relabel it with a less useful
      // neutral one right after.
      if (payload.kind !== "asset-failed") this.assetTracker?.settle();
    }

    // Silent-session hint (2026-08-02 field report): a desktop osspeech
    // session whose source is 系统声音 taps ONLY system OUTPUT — a user
    // who picked 系统 expecting mic capture sees a session that "runs"
    // fine (framesOut advancing) yet transcribes nothing. A clean end
    // with zero finals, a session that actually reached "capturing", and
    // an explicitly-false `sawAudio` (the Rust side's whole-session
    // peak==0 verdict — see the payload field's own doc comment for why
    // `=== false`, and why this can never fire on iOS) is exactly that
    // confusion: steer once, here BEFORE the `stopping` branch below,
    // because the common shape of this failure IS the user giving up and
    // pressing stop — the "ended" then arrives mid-stop and would never
    // reach the switch.
    //
    // Dual capture v1 amends the condition, not the copy: this engine is
    // no longer system-audio-only, and on a 麦克风/麦克风+系统 session the
    // copy's whole premise ("只采集系统播放的音频，不采集麦克风") is FALSE —
    // that session really is capturing the mic, so a silent one means
    // something else entirely (muted input, wrong input device) and
    // deserves its own diagnosis, not this steer. `sessionCapturedMic`
    // suppresses it there. A silent MIC channel inside a dual session got
    // its own hint (Lane W's silentChannel verdict, audioLiveness.ts) —
    // the separate, larger change this comment used to defer to: it needs
    // PER-CHANNEL silence, unlike this session-wide `sawAudio` steer,
    // which the windowPeak/channel-tagged stats event above now carries.
    // Deliberately a DIFFERENT surface (StatusLine's 单路无声 chip, info-
    // severity, mid-session) rather than folded into this end-of-session
    // onNotice — the two conditions/audiences don't overlap enough to share
    // one steer.
    if (
      payload.kind === "ended" &&
      payload.sawAudio === false &&
      this.finalCount === 0 &&
      this.sessionStartEpoch !== null &&
      !this.sessionCapturedMic
    ) {
      this.events?.onNotice?.(
        "未检测到系统声音——系统引擎只采集系统播放的音频，不采集麦克风；要转写麦克风请切换到本地模型或云端引擎",
      );
    }

    // "ended" is the one status meaningful even while stopping — see
    // waitForEndedOrTimeout()/resolveStopEnded(). Every OTHER status
    // arriving once we've already been asked to stop is noise, mirroring
    // appAudio.ts's identical guard.
    if (this.stopping) {
      if (payload.kind === "ended") this.resolveStopEnded();
      return;
    }

    const events = this.events;
    if (!events) return;

    switch (payload.kind) {
      case "starting":
        // Unlike appaudio (whose "connecting" comes from wsTransport's
        // own connect()), osspeech has no transport of its own — this
        // IS the one place "connecting" gets emitted before "capturing".
        events.onStatus("connecting");
        break;
      case "asset-checking":
        events.onStatus("connecting");
        this.assetTracker?.handle("asset-checking");
        if (!this.assetCheckingNoticeShown) {
          this.assetCheckingNoticeShown = true;
          events.onNotice?.("正在检查系统语音资源…");
        }
        break;
      case "asset-downloading":
        events.onStatus("connecting");
        this.assetTracker?.handle("asset-downloading", payload.progress);
        if (!this.assetDownloadingNoticeShown) {
          this.assetDownloadingNoticeShown = true;
          events.onNotice?.("正在下载系统语音资源（系统自带，仅首次）…");
        }
        break;
      case "asset-installed":
        // No status transition of our own (§2.6) — completeTask only.
        this.assetTracker?.handle("asset-installed");
        break;
      case "asset-failed":
        this.assetTracker?.handle("asset-failed", undefined, payload.message);
        events.onStatus("error", "系统语音资源下载失败，请检查网络后重试");
        break;
      case "locale-resolved":
        if (payload.resolvedLocale) events.onNotice?.(`识别语言：${payload.resolvedLocale}`);
        break;
      case "capturing":
        this.sessionStartEpoch = Date.now();
        events.onStatus("listening");
        break;
      case "permission-denied":
        // F7 (S13 blueprint §6): iOS has no 屏幕与系统音频录制 pane at
        // all — mic permission lives at 设置 → 隐私与安全性 → 麦克风
        // instead. macOS copy stays byte-identical.
        events.onStatus(
          "error",
          IS_IOS
            ? "JargonSlayer 没有麦克风权限，请前往 设置 → 隐私与安全性 → 麦克风 开启后重试"
            : "JargonSlayer 没有系统音频录制权限，请前往 系统设置 → 隐私与安全性 → 屏幕与系统音频录制 开启后重试",
        );
        break;
      case "device-changed":
        events.onStatus("error", "录音设备发生变化，系统识别已停止，请重新开始");
        break;
      case "unsupported":
        // F7: iOS floor is iOS 26, not macOS 26. macOS copy stays
        // byte-identical.
        events.onStatus("error", IS_IOS ? "系统识别需要 iOS 26 或更高版本" : "系统识别需要 macOS 26 或更高版本");
        break;
      case "unsupported-locale":
        events.onStatus("error", unsupportedLocaleMessage(payload));
        break;
      case "crashed":
        events.onStatus("error", "系统识别意外退出，请重试");
        break;
      case "ended":
        // Not stopping (handled above) — an unexpected end, mirrors
        // appAudio.ts's identical "ended" branch.
        events.onStatus("idle", "capture_ended");
        break;
    }
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

  /** Soft pause: gates entirely in the HELPER (blueprint Q3 — a
   *  stdin-command channel the Rust side writes "pause\n"/"resume\n"
   *  into), since no PCM of any kind ever reaches this process to gate
   *  locally the way appAudio.ts's transport.pauseFeed() does. No-op if
   *  already stopping or if start() never got far enough to actually
   *  invoke start_os_speech. */
  async pause(): Promise<void> {
    if (this.stopping || !this.running) return;
    const invoke = await getInvoke();
    try {
      await invoke("pause_os_speech");
    } catch (err) {
      diagLog("warn", "stt-osspeech", "pause_os_speech 调用失败", String(err));
    }
  }

  /** Resume after pause() — same session, no re-invoke of
   *  start_os_speech. */
  async resume(): Promise<void> {
    if (this.stopping || !this.running) return;
    const invoke = await getInvoke();
    try {
      await invoke("resume_os_speech");
    } catch (err) {
      diagLog("warn", "stt-osspeech", "resume_os_speech 调用失败", String(err));
    }
  }

  /** Stop ordering (mirrors appAudio.ts's stop() exactly, minus the
   *  transport drain — there is none here): mark stopping -> invoke
   *  stop_os_speech (helper's own drain/flush tail still emits its
   *  remaining finals over the transcript lane, per §2.7) -> wait for
   *  its "ended" status or STOP_ENDED_TIMEOUT_MS, whichever first ->
   *  unlisten both lanes. Safe to call twice — only the first call has
   *  effect. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    const invoke = await getInvoke();
    try {
      await invoke("stop_os_speech");
    } catch {
      // best-effort — tear down our own side regardless.
    }

    // Only worth waiting for "ended" if a status listener was ever
    // registered to hear it, and only if the helper isn't ALREADY
    // known-dead (F3) — see appAudio.ts's stop() for the full rationale,
    // identical here. S11 fix-round J4: ALSO only if a session actually
    // started — `this.running` — in the first place. A REJECTED
    // start_os_speech invoke() (a macOS-26 recheck failing, or a
    // single-flight busy rejection) routes through this SAME stop() to
    // unwind (see start()'s own catch block) without `this.running`
    // ever having gone true; unlistenStatus is already set by then too
    // (both listeners are registered BEFORE the invoke), so without this
    // extra check the wait below still ran and burned the full
    // STOP_ENDED_TIMEOUT_MS for an "ended" that no helper process was
    // ever going to send. (appAudio.ts's stop() has this SAME latent
    // gap — left untouched this sprint, byte-identity constraint; worth
    // a follow-up there too.)
    if (this.unlistenStatus && !this.helperTerminated && this.running) {
      await this.waitForEndedOrTimeout();
    }

    diagLog("info", "stt-osspeech", "系统识别引擎停止", `finals=${this.finalCount}`);

    const unlistenTranscript = this.unlistenTranscript;
    this.unlistenTranscript = null;
    unlistenTranscript?.();

    const unlistenStatus = this.unlistenStatus;
    this.unlistenStatus = null;
    unlistenStatus?.();

    const unlistenAudioStats = this.unlistenAudioStats;
    this.unlistenAudioStats = null;
    unlistenAudioStats?.();

    this.running = false;
    this.events = null;
  }
}
