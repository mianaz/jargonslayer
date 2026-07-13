// Binds a live STT engine's event stream to the panel's UI (S7
// blueprint §4 data flow) — the seam blueprint Decision A calls out as
// the ONE thing an eventual offscreen-document pivot would need to
// swap (everything downstream — accumulator, transcript, history —
// stays byte-identical either way). Deliberately DOM-free: every side
// effect the panel needs crosses an injected callback, and the engine
// itself crosses an injected factory, so the whole lifecycle below
// runs against a scripted fake engine + fake permission fns under
// plain node-env vitest (see __tests__/captureController.test.ts) —
// no jsdom, no real Chrome/Web Speech globals required.
//
// Ownership note: this file never calls micPermission.openPermissionPage()
// itself — the panel-side "需要麦克风权限" affordance (blueprint §7) is
// gated behind an EXPLICIT extra click ("点下面的按钮会打开一个页面"),
// which main.ts wires directly to openPermissionPage(). This controller
// only ever decides WHEN that affordance should be shown (onGrantNeeded)
// and picks back up wherever the user left off the next time start()
// runs (e.g. after granting in the tab and returning to click 开始聆听
// again) — no cross-tab messaging needed for that manual retry loop.

import {
  DEFAULT_SETTINGS,
  type STTEngine,
  type STTEvents,
  type STTStatus,
  type Settings,
} from "@jargonslayer/core/types";

import { createAccumulator, type AccumulatorSnapshot } from "../detect/accumulator";
import { WebSpeechEngine } from "../capture/webSpeech";
import { diagLog } from "../lib/diag";
import {
  decideMicPermissionAction,
  queryMicPermission,
} from "../permission/micPermission";
import {
  saveSession,
  type LiteSegment,
  type LiteSession,
} from "../storage/history";

/** Controller-level status — STTEvents.onStatus's own vocabulary
 *  (idle/connecting/listening/error) plus two states the CONTROLLER
 *  owns rather than the engine: "stopped" (a session that just
 *  finished saving) and "unsupported" (feature-detection failed
 *  before an engine was ever constructed — never an engine-reported
 *  status, since the engine is never even built in that case). */
export type CaptureStatus = STTStatus | "stopped" | "unsupported";

export interface CaptureControllerCallbacks {
  /** Drives the 开始聆听/停止聆听 button + the inline 正在聆听…/已停止/
   *  error status line. `detail` carries the engine's own zh error
   *  message on "error", and the fixed 浏览器不支持 notice on
   *  "unsupported". */
  onStatusChange: (status: CaptureStatus, detail?: string) => void;
  /** One channel for BOTH interim updates and finalized segments,
   *  matching renderTranscript.ts's single render pass over both. */
  onTranscriptChange: (segments: LiteSegment[], interim: string) => void;
  /** Fires after every finalized segment is scanned/merged into the
   *  running session accumulator (and once, with an empty snapshot,
   *  right as a new session starts — clears whatever a PRIOR session
   *  left on screen). */
  onCardsChange: (snapshot: AccumulatorSnapshot) => void;
  /** Mirrors STTEvents.onEngineMode — drives the 设备端/云端 privacy
   *  line. Fires once per engine session. */
  onPrivacyMode: (mode: "on-device" | "cloud") => void;
  /** The mic isn't usable yet — proactively (permission state
   *  resolved to "open-grant-page" or "denied-guidance"; blueprint §7
   *  gives no separate panel copy for an explicit prior denial, so
   *  both funnel into the same 需要麦克风权限 affordance here) or
   *  reactively (the engine's own not-allowed/service-not-allowed
   *  error mid-session). Show that affordance; its own button is what
   *  actually opens the grant tab (main.ts, not this controller). */
  onGrantNeeded: () => void;
  /** STT VAD supervisor's advisory steer notice — never stops capture. */
  onNotice?: (msg: string) => void;
  /** A session was stopped, built, and saved — exactly once per stop(). */
  onSaved: (session: LiteSession) => void;
}

export interface CaptureControllerOptions {
  callbacks: CaptureControllerCallbacks;
  /** Defaults to a real WebSpeechEngine. The offscreen-pivot seam
   *  (blueprint Decision A) and the test harness's scripted fake
   *  engine both go through here — captureController never
   *  constructs WebSpeechEngine directly outside this default. */
  createEngine?: () => STTEngine;
  saveSession?: typeof saveSession;
  queryMicPermission?: typeof queryMicPermission;
  decideMicPermissionAction?: typeof decideMicPermissionAction;
  /** Real default below typeof-checks window.SpeechRecognition /
   *  webkitSpeechRecognition (blueprint §2-A: verify at runtime, never
   *  assert). Injectable because vitest's node environment has no
   *  `window` at all — tests targeting the SUPPORTED-browser paths
   *  override this rather than faking a DOM global just to get past
   *  the check; the unsupported-browser test relies on the real
   *  default instead, since "no window" already IS the case it needs
   *  to prove. */
  detectSpeechRecognitionSupport?: () => boolean;
}

const MIC_DENIED_DETAIL_MARKER = "麦克风权限被拒绝";
export const UNSUPPORTED_NOTICE =
  "这个浏览器用不了语音识别，请用桌面版 Chrome。也可以直接粘贴文本来检测。";
// F2: surfaced via onNotice when saveSession rejects in teardownAndSave —
// the session itself is lost (never retried), so this is a user-visible
// failure notice, not the VAD supervisor's advisory onNotice channel.
export const SAVE_FAILED_NOTICE = "历史保存失败，本次会话未能写入本地存储";

// lib.dom.d.ts does not declare SpeechRecognition (same reason
// capture/webSpeech.ts shims its own SpeechRecognitionCtor) — this
// controller only needs to know whether the constructor EXISTS, never
// touches it otherwise (constructing it is entirely webSpeech.ts's job).
interface WindowWithSpeechRecognition extends Window {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
}

function defaultDetectSpeechRecognitionSupport(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as WindowWithSpeechRecognition;
  return typeof w.SpeechRecognition === "function" || typeof w.webkitSpeechRecognition === "function";
}

/** ~40 chars per the blueprint's title rule; already-trimmed input. */
function truncateTitle(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

export class CaptureController {
  private readonly callbacks: CaptureControllerCallbacks;
  private readonly createEngine: () => STTEngine;
  private readonly saveSessionFn: typeof saveSession;
  private readonly queryMicPermissionFn: typeof queryMicPermission;
  private readonly decideMicPermissionActionFn: typeof decideMicPermissionAction;
  private readonly detectSupport: () => boolean;

  // True from an ACCEPTED start() (permission resolved to "start")
  // through stop()'s completion — the single re-entrancy guard for
  // both methods. Reset back to false whenever start() bails out
  // without actually launching an engine (unsupported browser, grant
  // needed) so a subsequent 开始聆听 click is always a fresh attempt.
  private isActive = false;
  private engine: STTEngine | null = null;
  private segments: LiteSegment[] = [];
  private accumulator = createAccumulator();
  private sessionStartedAt = 0;

  // F3: bumped by stop() and the terminal-error teardown (handleStatus)
  // ONLY — never by start()'s own early-return branches. start()
  // captures the value current at its own entry and re-checks it after
  // every await; a mismatch means a stop()/error raced it to completion
  // while it was suspended, so it must discard whatever it was doing
  // instead of resurrecting a session nobody asked for anymore.
  private generation = 0;

  constructor(options: CaptureControllerOptions) {
    this.callbacks = options.callbacks;
    this.createEngine = options.createEngine ?? (() => new WebSpeechEngine());
    this.saveSessionFn = options.saveSession ?? saveSession;
    this.queryMicPermissionFn = options.queryMicPermission ?? queryMicPermission;
    this.decideMicPermissionActionFn =
      options.decideMicPermissionAction ?? decideMicPermissionAction;
    this.detectSupport =
      options.detectSpeechRecognitionSupport ?? defaultDetectSpeechRecognitionSupport;
  }

  /** No-op while already starting/listening (re-entrancy guard). */
  async start(): Promise<void> {
    if (this.isActive) return;
    this.isActive = true;
    // F3: captured BEFORE the first await — the one value this whole
    // call checks itself against every time it resumes.
    const myGeneration = this.generation;

    if (!this.detectSupport()) {
      this.isActive = false;
      this.callbacks.onStatusChange("unsupported", UNSUPPORTED_NOTICE);
      return;
    }

    const permissionState = await this.queryMicPermissionFn();
    // F3: a stop() (or terminal error) could have raced this call to
    // completion while queryMicPermissionFn() was pending — no engine
    // exists yet at this point, so there's nothing to discard, just
    // bail before acting on a permission result nobody asked for
    // anymore (this is what used to save a bogus startedAt:0 session,
    // built from whatever stop() saw at the time).
    if (myGeneration !== this.generation || !this.isActive) return;

    const action = this.decideMicPermissionActionFn(permissionState);
    if (action !== "start") {
      this.isActive = false;
      this.callbacks.onGrantNeeded();
      return;
    }

    this.segments = [];
    this.accumulator = createAccumulator();
    this.sessionStartedAt = Date.now();
    // Clear whatever a PRIOR session left rendered before this one
    // produces its first event.
    this.callbacks.onTranscriptChange([], "");
    this.callbacks.onCardsChange(this.accumulator.snapshot());

    const events: STTEvents = {
      onInterim: (text) => this.handleInterim(text),
      onFinal: (text, opts) => this.handleFinal(text, opts?.startedAt),
      onStatus: (status, detail) => this.handleStatus(status, detail),
      onNotice: (msg) => this.callbacks.onNotice?.(msg),
      onEngineMode: (mode) => this.callbacks.onPrivacyMode(mode),
    };
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      language: "en-US",
      preferOnDeviceSpeech: true,
    };

    const engine = this.createEngine();
    this.engine = engine;
    await engine.start(events, settings);

    // F3: same race, checked again after the second (and last) await.
    // An engine now exists, so a mismatch here means discarding it for
    // real — but only if IT is still the one on `this.engine`: a
    // terminal error can fire synchronously inside engine.start()
    // itself (handleStatus already tears down + bumps the generation
    // before this line ever runs), in which case this.engine is
    // already null and stopping `engine` again would be redundant
    // (webSpeech.stop() is idempotent, but there's no reason to rely
    // on that twice).
    if (myGeneration !== this.generation || !this.isActive) {
      if (this.engine === engine) {
        this.engine = null;
        await engine.stop();
      }
      return;
    }
  }

  /** No-op while not running (re-entrancy guard) — safe to call even
   *  if start() never got past the permission/support checks. */
  async stop(): Promise<void> {
    if (!this.isActive) return;
    this.isActive = false;
    this.generation += 1;

    // F2: teardownAndSave() never throws (a saveSession rejection is
    // caught internally) — the try/finally is a defensive belt on top
    // of that guarantee, not a substitute for it: onStatusChange
    // ("stopped") and the button/UI reset it drives must fire no
    // matter what happens above, or 停止聆听 would leave a dead button.
    try {
      await this.teardownAndSave(true);
    } finally {
      this.callbacks.onStatusChange("stopped");
    }
  }

  /** Shared by stop() and the terminal-error path in handleStatus() —
   *  stop the engine (if any), then build + persist the LiteSession
   *  from whatever was captured this session. Zero-segment sessions
   *  save only on an explicit stop() of a real session
   *  (`saveWhenEmpty`, preserving the pre-existing time-string-title
   *  behavior — the user deliberately ended it): the terminal-error
   *  path passes false so a start that erred before any speech (mic
   *  denied, network) doesn't deposit an empty junk entry in history
   *  (F1's "if any segments were captured"), and F3's raced-start case
   *  (no engine ever ran) never saves regardless. */
  private async teardownAndSave(saveWhenEmpty: boolean): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    if (engine) {
      try {
        await engine.stop();
      } catch (err) {
        // Engine teardown failure must neither block saving what was
        // captured nor escape (stop() promises to never throw; the
        // error path void's this promise entirely).
        diagLog("warn", "capture-engine-stop-failed", "引擎停止时报错", String(err));
      }
    }

    if (this.segments.length === 0 && (!engine || !saveWhenEmpty)) {
      return;
    }

    const firstText = this.segments[0]?.text.trim();
    const session: LiteSession = {
      id: crypto.randomUUID(),
      title: firstText ? truncateTitle(firstText) : new Date(this.sessionStartedAt).toLocaleTimeString(),
      startedAt: this.sessionStartedAt,
      endedAt: Date.now(),
      engine: "webspeech",
      segments: this.segments.slice(),
      ...this.accumulator.snapshot(),
    };

    try {
      await this.saveSessionFn(session);
    } catch {
      // F2: the session is lost (never retried) — surface it as a
      // user-visible notice rather than an unhandled rejection that
      // would otherwise wedge stop()'s caller. Lengths only, no
      // transcript content, per diag.ts's privacy rule.
      this.callbacks.onNotice?.(SAVE_FAILED_NOTICE);
      diagLog(
        "error",
        "capture-save-failed",
        "历史会话保存失败",
        `segments=${session.segments.length}`,
      );
      return;
    }
    this.callbacks.onSaved(session);
  }

  private handleInterim(text: string): void {
    this.callbacks.onTranscriptChange(this.segments.slice(), text);
  }

  private handleFinal(text: string, startedAt?: number): void {
    // Prefer the engine's utterance-start stamp over receipt time —
    // exports render elapsed times from these, and receipt time would
    // shift every line late by its own utterance length (lead
    // amendment over blueprint §4's literal `Date.now()`).
    this.segments.push({ text, startedAt: startedAt ?? Date.now() });
    // A final always retires whatever interim line preceded it — the
    // finalized segment just took its place on screen.
    this.callbacks.onTranscriptChange(this.segments.slice(), "");
    this.callbacks.onCardsChange(this.accumulator.addFinal(text));
  }

  private handleStatus(status: STTStatus, detail?: string): void {
    this.callbacks.onStatusChange(status, detail);
    // F1: every "error" the engine reports here is terminal (mic
    // denial, persistent recognition failure, network — see
    // webSpeech.ts's handleError/handleEnd; benign cases like
    // no-speech/aborted never reach onStatus at all) — the engine is
    // already dead or dying, and 停止聆听 is no longer reachable for
    // this session, so tear down + auto-save through the SAME path
    // stop() uses rather than leaving isActive true (which would wedge
    // every subsequent 开始聆听 as a silent no-op) and the engine's
    // mic/VAD/AudioContext/watchdog alive underneath it.
    if (status !== "error" || !this.isActive) return;

    this.isActive = false;
    this.generation += 1;
    // Fired synchronously, BEFORE the async teardown below — matches
    // the pre-existing (synchronous) timing this callback has always
    // had, so a caller observing onGrantNeeded right after firing
    // onStatus("error", …) still sees it without needing to await
    // anything extra.
    if (detail?.includes(MIC_DENIED_DETAIL_MARKER)) {
      this.callbacks.onGrantNeeded();
    }
    void this.teardownAndSave(false);
  }
}
