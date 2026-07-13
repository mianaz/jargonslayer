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

    if (!this.detectSupport()) {
      this.isActive = false;
      this.callbacks.onStatusChange("unsupported", UNSUPPORTED_NOTICE);
      return;
    }

    const permissionState = await this.queryMicPermissionFn();
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

    this.engine = this.createEngine();
    await this.engine.start(events, settings);
  }

  /** No-op while not running (re-entrancy guard) — safe to call even
   *  if start() never got past the permission/support checks. */
  async stop(): Promise<void> {
    if (!this.isActive) return;
    this.isActive = false;

    const engine = this.engine;
    this.engine = null;
    await engine?.stop();

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

    await this.saveSessionFn(session);
    this.callbacks.onStatusChange("stopped");
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
    if (status === "error" && detail?.includes(MIC_DENIED_DETAIL_MARKER)) {
      this.callbacks.onGrantNeeded();
    }
  }
}
