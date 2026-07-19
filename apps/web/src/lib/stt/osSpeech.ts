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
//   invoke("start_os_speech", { locale, contextualJson })
//   invoke("stop_os_speech")                 — idempotent
//   invoke("pause_os_speech")/("resume_os_speech") — idempotent, no-arg
//   event "osspeech://transcript" -> { final, seq, startMs, endMs, text }
//   event "osspeech://status" -> { kind, message?, progress?,
//     resolvedLocale?, supportedLocales? }, kind one of the CLOSED set
//     below (OsSpeechStatusKind).
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

import type { CustomEntry, STTEngine, STTEngineKind, STTEvents, Settings } from "@jargonslayer/core/types";
import { customEntrySurfaces } from "@jargonslayer/core/types";
import { getInvoke, type UnlistenFn } from "../desktop/tauriApi";
import { trackOsSpeechAsset, type OsSpeechAssetTracker } from "../desktop/jobsBridge";
import { diagLog } from "../diag/log";
import { useApp } from "../store";
import { IS_IOS } from "../platform/ios";
import { listenOsSpeechStatus, listenOsSpeechTranscript } from "./osSpeechTransport";

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
}

export interface OsSpeechTranscriptPayload {
  final: boolean;
  seq: number;
  startMs: number;
  endMs: number;
  text: string;
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

// Q11 (v1 scope, blueprint §1): contextualStrings biasing from the
// personal glossary's headwords+variants ONLY (dictionary packs
// deferred to v0.4.4). BOTH caps are enforced independently on every
// candidate term — a glossary heavy on CJK entries can blow past ~8KB
// of encoded JSON well under 100 terms, so term-count alone isn't a
// sufficient bound.
const MAX_CONTEXTUAL_TERMS = 100;
const MAX_CONTEXTUAL_BYTES = 8 * 1024;

/** Builds the `contextualJson` wire value for start_os_speech from the
 *  personal glossary (customEntrySurfaces already gives headword+variants,
 *  deduped per entry — this dedupes ACROSS entries too). Pure so it's
 *  unit-testable without the store/useApp — start() below is the one
 *  real caller, feeding it useApp.getState().customEntries. Empty (no
 *  entries, or nothing left after dedup) -> null, the wire's own "no
 *  bias" value. */
export function buildContextualJson(entries: CustomEntry[]): string | null {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const entry of entries) {
    for (const surface of customEntrySurfaces(entry)) {
      if (seen.has(surface)) continue;
      seen.add(surface);
      candidates.push(surface);
    }
  }

  const encoder = new TextEncoder();
  const terms: string[] = [];
  let bytes = 2; // "[" + "]"
  for (const surface of candidates) {
    if (terms.length >= MAX_CONTEXTUAL_TERMS) break;
    // +1 for the joining comma once this wouldn't be the first element.
    const extra = encoder.encode(JSON.stringify(surface)).length + (terms.length > 0 ? 1 : 0);
    if (bytes + extra > MAX_CONTEXTUAL_BYTES) break;
    terms.push(surface);
    bytes += extra;
  }

  return terms.length > 0 ? JSON.stringify(terms) : null;
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

  // Recorded at "capturing" (§2.6) — currently diagnostic-only: A3
  // verify-from-source (see this file's onFinal call in handleTranscript)
  // found wsTransport.ts's own onFinal call passes no `startedAt` at all,
  // so this engine matches that semantic by passing none either, rather
  // than inventing a value nothing downstream of appaudio/wsTransport
  // actually consumes.
  private sessionStartEpoch: number | null = null;
  private finalCount = 0;

  async start(events: STTEvents, settings: Settings): Promise<void> {
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
    const myGeneration = ++this.generation;

    // Mirrors appAudio.ts's F2 fix exactly (see this file's header
    // comment): local holders only, re-checked after every awaited
    // acquisition, torn down via the ONE abandonStart() below so an
    // abandoned OLD call can never clobber a NEWER start()'s own state.
    let unlistenTranscript: UnlistenFn | null = null;
    let unlistenStatus: UnlistenFn | null = null;
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

    // Q11: gathered fresh every start() (a glossary edit mid-session
    // has no live effect — start-time one-shot, per the blueprint).
    const contextualJson = buildContextualJson(useApp.getState().customEntries);

    try {
      await invoke("start_os_speech", { locale: settings.language, contextualJson });
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
      events.onFinal(payload.text);
    } else {
      events.onInterim(payload.text);
    }
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
          events.onNotice?.("正在检查系统识别模型…");
        }
        break;
      case "asset-downloading":
        events.onStatus("connecting");
        this.assetTracker?.handle("asset-downloading", payload.progress);
        if (!this.assetDownloadingNoticeShown) {
          this.assetDownloadingNoticeShown = true;
          events.onNotice?.("首次使用需下载系统识别模型，请保持网络畅通…");
        }
        break;
      case "asset-installed":
        // No status transition of our own (§2.6) — completeTask only.
        this.assetTracker?.handle("asset-installed");
        break;
      case "asset-failed":
        this.assetTracker?.handle("asset-failed", undefined, payload.message);
        events.onStatus("error", "系统识别模型下载失败，请检查网络后重试");
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

    this.running = false;
    this.events = null;
  }
}
