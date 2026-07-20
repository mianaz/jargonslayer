// Web Speech API engine. Uses the browser's built-in (cloud-backed)
// recognizer — zero setup, but requires Chrome/Edge and an internet
// connection. Note: Web Speech API ignores `deviceId` — it always
// records from the OS-selected default microphone, there is no way
// to target a specific input device via this API (nor to disable the
// browser's echo-cancellation/noise-suppression chain, which is why
// this engine picks up speaker-played "external" audio poorly — the
// local Whisper engine or tab-audio mode are the answers there).
//
// Continuous-speech hardening (see webSpeechSession.ts for the
// segmentation rationale, sttSupervisor.ts for the full rotation/
// recovery policy this shell just executes): Chrome never finalizes
// mid-speech and its recognizer silently stalls after ~1–2min of
// uninterrupted talking. The shell therefore (a) self-flushes long
// interims into synthetic finals via UtteranceAssembler, (b) polls the
// pure sttSupervisor on a WATCHDOG_TICK_MS timer for what to do next
// (rotate/recover/steer/none) given the current session age, idle
// time, and — when available — a VAD's speaking/silence signal, and
// (c) executes that decision uniformly via endSession(): flush what's
// safely flushable, then stop() (never abort() as the FIRST resort —
// MDN: stop() "must attempt to return a recognition result based on
// audio already collected", abort() discards it), escalating to
// abort() only if stop() itself produces no onend (a zombie session).
//
// VAD integration (see vad.ts): launched asynchronously right after
// recognition.start() so it never delays capture start; if it fails
// (unsupported browser, permission denial, ...) the engine simply runs
// the VAD-unavailable legacy policy branch — strictly no worse than
// before VAD existed. The VAD implementation is injectable (constructor
// arg) so tests can drive a scripted speech/silence timeline.

import type { STTEngine, STTEngineKind, STTEvents, Settings } from "@jargonslayer/core/types";
import { diagLog } from "../diag/log";
import {
  SESSION_ROTATE_SOFT_MS,
  type SupervisorAction,
  decideAction,
} from "./sttSupervisor";
import { SpeechActivityDetector, type VadHandle } from "./vad";
import { UtteranceAssembler } from "./webSpeechSession";
import {
  decideOnDeviceMode,
  type OnDeviceAvailability,
  type OnDeviceDecision,
  type OnDeviceMode,
} from "./onDeviceSpeech";

// ---- minimal local shims for the (non-standardized) Web Speech API ----
// lib.dom.d.ts does not declare these; we type only what we touch.

interface SpeechRecognitionAlternative {
  transcript: string;
}

interface SpeechRecognitionResult {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent {
  error: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  // On-device recognition (Chrome 139+ — docs/research/
  // stt-live-engines-2026-07.md item #1; verified against MDN
  // 2026-07). Settable before start(); true forces on-device-only
  // processing. Only ever set once this engine's own availability
  // check has confirmed a local model is ready for `lang` (see
  // onDeviceSpeech.ts's decision core + this file's resolveOnDevice
  // Decision) — never set blind.
  processLocally?: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

// available()/install() shared options shape (MDN, 2026-07): `langs`
// is required by both; `quality` defaults to "command" and is never
// set by this engine (SOME on-device model for the language is enough
// — we don't need a higher-quality dictation/conversation-tier pack);
// `processLocally` is documented on available()'s formal params and
// shown (informally, in the example code) on install()'s page too —
// passed to both here for symmetry.
interface SpeechRecognitionAvailabilityOptions {
  langs: string[];
  quality?: "command" | "dictation" | "conversation";
  processLocally?: boolean;
}

type SpeechRecognitionAvailabilityResult =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable";

interface SpeechRecognitionCtor {
  new (): SpeechRecognition;
  // Static feature-detection/install (Chrome 139+) — absent entirely
  // on older Chrome/other browsers, and on every SpeechRecognition
  // test double in this repo that predates this feature; hence
  // optional. Every call site feature-detects with
  // `typeof Ctor.available === "function"` rather than assuming
  // presence from the type alone.
  available?(
    options: SpeechRecognitionAvailabilityOptions,
  ): Promise<SpeechRecognitionAvailabilityResult>;
  install?(options: SpeechRecognitionAvailabilityOptions): Promise<boolean>;
}

interface WindowWithSpeech extends Window {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as WindowWithSpeech;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// ---- on-device Web Speech (processLocally) shell — see
// onDeviceSpeech.ts for the pure decision core this wraps. ----

// Per-language availability cache (module-level, survives across
// engine instances/meetings within the SAME page load). Internal
// supervisor rotation never re-queries at all — the availability
// check only ever runs once per WebSpeechEngine.start() call (see
// start()'s own call site): rotation reuses the SAME recognizer
// instance via stop()/start(), it never reconstructs one (see
// setupRecognition, called exactly once per start()). This cache's
// real payoff is across MULTIPLE top-level start() calls in one page
// load — a new meeting, or a pause/resume teardown+reattach cycle
// (WebSpeech implements neither STTEngine.pause nor .resume, so
// useMeeting.ts's resume() always goes through the teardown-reattach
// branch, which DOES call start() again).
const onDeviceAvailabilityCache = new Map<string, Promise<OnDeviceAvailability>>();
const KNOWN_AVAILABILITY = new Set<string>([
  "available",
  "downloadable",
  "downloading",
  "unavailable",
]);

function queryOnDeviceAvailability(
  Ctor: SpeechRecognitionCtor,
  lang: string,
): Promise<OnDeviceAvailability> {
  if (typeof Ctor.available !== "function") return Promise.resolve("api-absent");
  return Ctor.available({ langs: [lang], processLocally: true }).then(
    (result): OnDeviceAvailability =>
      KNOWN_AVAILABILITY.has(result) ? (result as OnDeviceAvailability) : "unavailable",
    () => "unavailable" as OnDeviceAvailability,
  );
}

function getOnDeviceAvailability(
  Ctor: SpeechRecognitionCtor,
  lang: string,
): Promise<OnDeviceAvailability> {
  const cached = onDeviceAvailabilityCache.get(lang);
  if (cached) return cached;
  const promise = queryOnDeviceAvailability(Ctor, lang);
  onDeviceAvailabilityCache.set(lang, promise);
  return promise;
}

// One install() attempt per language per page-load — fire-and-forget;
// this engine never hot-swaps a LIVE session onto a freshly-installed
// model (see start()'s own doc). A later session's own availability
// query picks up a successful install because it invalidates the
// cached verdict below, so that query is a real recheck instead of a
// replay of the stale "downloadable".
const onDeviceInstallAttempted = new Set<string>();

function triggerOnDeviceInstallOnce(Ctor: SpeechRecognitionCtor, lang: string): void {
  if (onDeviceInstallAttempted.has(lang) || typeof Ctor.install !== "function") return;
  onDeviceInstallAttempted.add(lang);
  diagLog("info", "stt-ondevice", "开始下载设备端语音识别模型", `lang=${lang}`);
  void Ctor.install({ langs: [lang], processLocally: true }).then(
    (installed) => {
      diagLog(
        installed ? "info" : "warn",
        "stt-ondevice",
        "设备端语音识别模型下载完成",
        `lang=${lang} installed=${installed}`,
      );
      if (installed) onDeviceAvailabilityCache.delete(lang);
    },
    () => {
      diagLog("warn", "stt-ondevice", "设备端语音识别模型下载失败", `lang=${lang}`);
    },
  );
}

// Mode-decision diag throttle — mirrors detect-dict-floor's posture
// (detect/scheduler.ts's recordDictDiagHit): this CAN repeat across
// top-level engine attaches (a new meeting, or a pause/resume
// reattach), so throttle to <=1/60s, except the very first entry this
// page load (so a short session still leaves evidence).
const ONDEVICE_DECISION_LOG_THROTTLE_MS = 60_000;
let lastOnDeviceDecisionLogAt = -Infinity;
let onDeviceDecisionLoggedOnce = false;

function logOnDeviceDecision(
  decision: OnDeviceDecision,
  availability: OnDeviceAvailability,
  lang: string,
): void {
  const now = Date.now();
  const isFirst = !onDeviceDecisionLoggedOnce;
  if (!isFirst && now - lastOnDeviceDecisionLogAt < ONDEVICE_DECISION_LOG_THROTTLE_MS) return;
  onDeviceDecisionLoggedOnce = true;
  lastOnDeviceDecisionLogAt = now;
  diagLog(
    "info",
    "stt-ondevice",
    "设备端识别模式决策",
    `mode=${decision.mode} availability=${availability} lang=${lang}`,
  );
}

async function resolveOnDeviceDecision(
  Ctor: SpeechRecognitionCtor,
  settings: Settings,
): Promise<OnDeviceDecision> {
  const availability = await getOnDeviceAvailability(Ctor, settings.language);
  const decision = decideOnDeviceMode(availability, settings.preferOnDeviceSpeech);
  logOnDeviceDecision(decision, availability, settings.language);
  if (decision.triggerInstall) triggerOnDeviceInstallOnce(Ctor, settings.language);
  return decision;
}

/** Test helper — clears the per-language availability cache, the
 *  one-shot install-attempt set, and the mode-decision diag throttle. */
export function resetOnDeviceSpeechState(): void {
  onDeviceAvailabilityCache.clear();
  onDeviceInstallAttempted.clear();
  lastOnDeviceDecisionLogAt = -Infinity;
  onDeviceDecisionLoggedOnce = false;
}

const RESTART_DELAY_MS = 250;
const MAX_INSTANT_FAILURES = 3;
// Watchdog now polls the supervisor at 500ms (was 5000ms) — the
// supervisor's own thresholds (STALL_SPEECH_MS=7s etc.) are what keep
// this from being noisy; the tighter tick just shrinks the DECISION
// latency once a threshold is actually crossed.
const WATCHDOG_TICK_MS = 500;
// endSession() recovery grace: stop() should fire onend (whose
// handler relaunches) once the recognizer has finished finalizing
// whatever it already collected. Renamed from RECOVER_FALLBACK_MS and
// widened 600ms -> 2000ms (2026-07 VAD-supervisor review finding #3a):
// real cloud finalization routinely takes longer than 600ms, and the
// old value's job wasn't just "detect a zombie" — endSession()'s
// escalation used to INFER whether onend had already relaunched from
// `Date.now() - lastStartAt <= 600`, so a merely-slow (not zombied)
// onend beyond that window got its trailing final discarded by an
// abort() that fired out from under it. The endGen token below (see
// endSession's doc comment) replaced that time-based inference with
// an exact match, so this constant now purely bounds "how long do we
// wait for cloud finalization before treating the session as dead" —
// hence the rename.
const CLOUD_FINALIZE_GRACE_MS = 2_000;

const STEER_NOTICE =
  "一直在说话但识别不出，可能语言不匹配，试试本地 Whisper 或标签页音频模式";

export class WebSpeechEngine implements STTEngine {
  readonly kind: STTEngineKind = "webspeech";

  private recognition: SpeechRecognition | null = null;
  private events: STTEvents | null = null;
  private userStopped = false;
  private consecutiveInstantFailures = 0;
  private lastStartAt = 0;
  private lastEventAt = 0;

  private assembler = new UtteranceAssembler();
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  // sttSupervisor.ts bookkeeping — see decideAction's SupervisorInput
  // doc comments for what each field means.
  private realFinalSinceSoft = false;
  private consecutiveSpeechStalls = 0;
  private lastRecoverAt = -Infinity;
  private steerNotified = false;
  // True from the moment endSession() calls stop() until the next
  // launch(). A dying session's stop() reliably produces a trailing
  // real final for whatever it had buffered (MDN) — that's leftover
  // content from BEFORE the stall was even detected, not evidence the
  // recognizer resumed working, so it must not reset the stall
  // counters below (else STALL_STEER_AFTER becomes unreachable
  // whenever the very first stalled session happens to have anything
  // buffered — see sttSupervisor.test.ts's steer-threshold cases and
  // the loss harness's untranscribable-block scenario).
  private endingSession = false;

  // End-cycle generation token (2026-07 VAD-supervisor review finding
  // #3): endSession() increments endGen and records the new value in
  // awaitingOnendForGen for the WHOLE window between its stop() call
  // and a matching onend (or the escalation giving up on one ever
  // arriving). Three things this single mechanism fixes together:
  //  (a) the watchdog NO-OPs entirely while an end is in flight (see
  //      watchdogTick) — a stop() whose onend takes a while can no
  //      longer have the SAME stall double-counted by the next tick,
  //      nor trigger a re-entrant stop()/launch() while the first one
  //      is still resolving;
  //  (b) handleEnd matches the exact generation instead of inferring
  //      "did this onend already relaunch?" from elapsed wall-clock
  //      time (see CLOUD_FINALIZE_GRACE_MS's doc comment) — no more
  //      false-zombie aborts on a merely-slow real finalization;
  //  (c) the escalation timers below fire abort()/force-launch() ONLY
  //      if awaitingOnendForGen STILL matches the gen they were
  //      scheduled for — a late-but-real onend (or a second endSession
  //      cycle entirely) clears/replaces it first, so a delayed
  //      escalation callback can never abort or launch out from under
  //      a cycle it no longer applies to.
  private endGen = 0;
  private awaitingOnendForGen: number | null = null;

  private vad: VadHandle | null = null;

  // On-device Web Speech (processLocally) — see resolveOnDeviceDecision
  // and onDeviceSpeech.ts's decision core. `onDeviceMode` tracks what
  // the CURRENT recognizer is actually configured for (flipped to
  // "cloud" by launch()'s defensive fallback if starting on-device
  // throws); `modeAnnounced`/`onDeviceFallbackAttempted` are both
  // one-shot per engine lifetime, reset in start().
  private onDeviceMode: OnDeviceMode = "cloud";
  private modeAnnounced = false;
  private onDeviceFallbackAttempted = false;

  constructor(
    private readonly createVad: () => VadHandle = () =>
      new SpeechActivityDetector(),
  ) {}

  async start(events: STTEvents, settings: Settings): Promise<void> {
    this.events = events;
    this.userStopped = false;
    this.consecutiveInstantFailures = 0;
    this.modeAnnounced = false;
    this.onDeviceFallbackAttempted = false;

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      // Keyless-path hint (S14 mobile-preview follow-up): a browser
      // with no SpeechRecognition at all (most non-Chromium mobile
      // browsers) still has a fully working way in — 导入 accepts an
      // audio/transcript upload with no mic and no API key, in any
      // browser.
      events.onStatus(
        "error",
        "当前浏览器不支持语音识别，请使用 Chrome/Edge，或切换到本地 Whisper / 演示模式，也可点击「导入」上传音频/文稿，无需麦克风与 API Key，任何浏览器都能用",
      );
      return;
    }

    const onDeviceDecision = await resolveOnDeviceDecision(Ctor, settings);
    // Race guard (same idiom as the VAD capture's `this.vad !== vad`
    // below): this await is a NEW yield point stop()/a newer start()
    // can land in — `this.events` no longer matching the local
    // `events` this call captured means exactly that happened, and
    // this call must not resurrect a session that was already
    // cancelled (or launch a stale recognizer out from under a NEWER
    // start()).
    if (this.events !== events) return;
    this.onDeviceMode = onDeviceDecision.mode;
    this.setupRecognition(Ctor, settings, onDeviceDecision);
    this.watchdogTimer = setInterval(() => this.watchdogTick(), WATCHDOG_TICK_MS);
    this.launch(events);

    // Bring the VAD up asynchronously — never block/delay recognition
    // start on it. Until it resolves (or if it fails outright),
    // vad.available stays false and the supervisor runs its
    // VAD-unavailable legacy branch, which is the exact behavior this
    // engine had before VAD existed (strict enhancement).
    //
    // The LOCAL `vad` capture (not `this.vad`) is what makes this race
    // -safe (2026-07 VAD-supervisor review finding #2b): a
    // stop()->start() while this promise is still pending resets
    // `this.userStopped` back to false for the NEW call, which would
    // make a naive `if (this.userStopped) this.vad?.stop()` wrongly
    // conclude "still wanted" for a detector that a LATER start() has
    // already replaced with a different instance. Checking
    // `this.vad !== vad` catches exactly that: this callback belongs
    // to a specific instance, and only ever acts on that one.
    const vad = this.createVad();
    this.vad = vad;
    void vad.start().then((ok) => {
      if (this.userStopped || this.vad !== vad || !ok) vad.stop();
    });
  }

  private setupRecognition(
    Ctor: SpeechRecognitionCtor,
    settings: Settings,
    onDeviceDecision: OnDeviceDecision,
  ): void {
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = settings.language;
    if (onDeviceDecision.mode === "on-device") {
      recognition.processLocally = true;
    }

    recognition.onresult = (ev) => this.handleResult(ev);
    recognition.onerror = (ev) => this.handleError(ev);
    recognition.onend = () => this.handleEnd();

    this.recognition = recognition;
  }

  private handleResult(ev: SpeechRecognitionEvent): void {
    if (!this.events) return;
    const now = Date.now();
    this.lastEventAt = now;

    const changed = [];
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      changed.push({
        index: i,
        transcript: ev.results[i][0]?.transcript ?? "",
        isFinal: ev.results[i].isFinal,
      });
    }

    const out = this.assembler.push(changed, now);
    for (const f of out.finals) {
      this.events.onFinal(f.text, { startedAt: f.startedAt });
    }
    // Honest interim contract (fix #A4): `null` = no change, skip the
    // event entirely; a non-null string (INCLUDING `""`) is a real
    // signal — the old truthiness check here used to swallow a
    // retract-to-empty (the interim clearing out with nothing to show)
    // instead of forwarding it.
    if (out.interim !== null) {
      this.events.onInterim(out.interim);
    }

    if (out.sawRealFinal) {
      // A final while a session is actively ENDING (endSession()'s
      // stop() call) is just its trailing buffered-content flush, not
      // proof the recognizer resumed working — see endingSession's
      // doc comment. Only a final from a session we're NOT in the
      // middle of tearing down counts as genuine progress.
      if (!this.endingSession) {
        this.consecutiveSpeechStalls = 0;
        this.steerNotified = false;
      }
      // Rotation opportunity tracking is unaffected either way: once
      // past the soft-rotate age, ANY real final (including a dying
      // session's trailing flush) is the cheapest moment to finish
      // rotating, which the next watchdog tick will act on.
      if (now - this.lastStartAt >= SESSION_ROTATE_SOFT_MS) {
        this.realFinalSinceSoft = true;
      }
    }
  }

  private handleError(ev: SpeechRecognitionErrorEvent): void {
    if (!this.events) return;
    // Diagnostics (S14.1 field fix, item 7a): every onerror, including
    // the benign no-speech/aborted codes the switch below silently
    // swallows — a readable field timeline needs all of them, not just
    // the ones that already reach a user-facing onStatus("error")
    // (useMeeting.ts's own logAndToastError diag-logs those separately,
    // at "error" level with zh copy — this is a terser, code-level
    // breadcrumb alongside that, not a replacement).
    diagLog(
      "info",
      "stt-webspeech-lifecycle",
      "onerror",
      `code=${ev.error} sinceLastEventMs=${Date.now() - this.lastEventAt}`,
    );
    this.lastEventAt = Date.now();

    switch (ev.error) {
      case "no-speech":
      case "aborted":
        // Benign — recognizer will restart via onend.
        return;
      case "not-allowed":
        this.events.onStatus(
          "error",
          "麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问",
        );
        return;
      case "service-not-allowed":
        // iOS Safari (2026-07 S14 mobile-preview follow-up): this
        // error code is what iOS reports both for a denied mic AND for
        // Siri 与听写 being switched off system-wide — the base
        // mic-permission guidance alone sends an iPhone/iPad user
        // chasing the wrong setting, so it gets the extra hint too.
        this.events.onStatus(
          "error",
          "麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问，若在 iPhone/iPad 上，请在 系统设置→Siri 与听写 中开启听写",
        );
        return;
      case "network":
        this.events.onStatus(
          "error",
          "语音识别网络错误，Web Speech 需要联网，可切换到本地 Whisper 引擎",
        );
        return;
      default:
        return;
    }
  }

  private handleEnd(): void {
    // Diagnostics (item 7a): every onend, unconditionally — including
    // the userStopped case the very next line returns early on. This
    // is also the anchor launch()'s own "relaunch" log below reads its
    // "gap since previous end" against (lastEventAt, stamped right
    // here).
    diagLog(
      "info",
      "stt-webspeech-lifecycle",
      "onend",
      `sinceStartMs=${Date.now() - this.lastStartAt} userStopped=${this.userStopped}`,
    );
    this.lastEventAt = Date.now();
    if (this.userStopped || !this.recognition || !this.events) return;

    // This onend completes the end cycle endSession() started (see
    // endGen's doc comment) — EXACT generation match, not a
    // Date.now()-based guess. Clearing awaitingOnendForGen here is
    // also what cancels the escalation timers below (they check for
    // this same match and no-op once it's gone) and lets the watchdog
    // resume evaluating on its next tick. A deliberate stop()'s onend
    // is not a recognizer crash, so — unlike a spontaneous onend —
    // it must never feed consecutiveInstantFailures.
    const deliberateEnd = this.awaitingOnendForGen !== null;
    if (deliberateEnd) {
      this.awaitingOnendForGen = null;
      this.endingSession = false;
    } else {
      const elapsed = Date.now() - this.lastStartAt;
      if (elapsed < 50) {
        this.consecutiveInstantFailures += 1;
      } else {
        this.consecutiveInstantFailures = 0;
      }

      if (this.consecutiveInstantFailures >= MAX_INSTANT_FAILURES) {
        this.events.onStatus(
          "error",
          "语音识别持续失败，请检查麦克风权限或切换引擎",
        );
        return;
      }
    }

    setTimeout(() => {
      if (this.userStopped || !this.recognition || !this.events) return;
      this.launch(this.events);
    }, RESTART_DELAY_MS);
  }

  private launch(events: STTEvents): void {
    if (!this.recognition) return;
    // Rescue whatever flushStable/self-flush held back if the session
    // that's ending right now never produced the trailing real final
    // that was supposed to complete it (2026-07 VAD-supervisor review
    // finding #4) — reset() below wipes pendingSnapshots
    // unconditionally, and a final that hasn't shown up by the time we
    // relaunch never will (this session is gone). The common case (a
    // real trailing final DID arrive) already cleared pendingSnapshots
    // via handleResult()'s assembler.push() before this ever runs, so
    // flushAll() is a no-op then — no duplicate emission.
    const rescued = this.assembler.flushAll(Date.now());
    if (rescued) {
      events.onFinal(rescued.text, { startedAt: rescued.startedAt });
      // Observability only (fix #A6) — lengths, never transcript text.
      diagLog(
        "warn",
        "stt-relaunch-rescue",
        "rescued a pending tail that never received a trailing real final before relaunch",
        `rescuedChars=${rescued.text.length}`,
      );
    }

    // Diagnostics (item 7a): every RELAUNCH — i.e. not the very first
    // launch() from start() (lastEventAt is still its 0 default then)
    // — logs the gap since the previous onend (handleEnd() is the only
    // thing that sets lastEventAt between one launch() and the next).
    // This is the actual "~47s gap" timeline the field report needs: a
    // healthy relaunch gap is ~RESTART_DELAY_MS (250ms); a much larger
    // one means something between onend and this relaunch stalled.
    if (this.lastEventAt !== 0) {
      diagLog(
        "info",
        "stt-webspeech-lifecycle",
        "relaunch",
        `gapSincePrevEndMs=${Date.now() - this.lastEventAt}`,
      );
    }

    this.lastStartAt = Date.now();
    this.lastEventAt = this.lastStartAt;
    this.assembler.reset();
    this.realFinalSinceSoft = false;
    this.endingSession = false;
    try {
      this.recognition.start();
      events.onStatus("listening");
      this.announceModeOnce(events);
    } catch {
      // Defensive on-device fallback (research memo's kill-criteria
      // posture): a session decided on-device can still throw where
      // cloud wouldn't have (a race between available() and start(),
      // or a model that got uninstalled in between) — retry THIS
      // session once as cloud rather than surface a spurious error.
      // One-shot per engine lifetime (onDeviceFallbackAttempted),
      // regardless of which launch() call (first start or a later
      // rotation) hits it.
      if (this.recognition.processLocally && !this.onDeviceFallbackAttempted) {
        this.onDeviceFallbackAttempted = true;
        diagLog(
          "warn",
          "stt-ondevice",
          "设备端识别启动失败，已回退云端重试",
          `lang=${this.recognition.lang}`,
        );
        this.recognition.processLocally = false;
        this.onDeviceMode = "cloud";
        try {
          this.recognition.start();
          events.onStatus("listening");
          this.announceModeOnce(events);
          return;
        } catch {
          // Both attempts failed — fall through to the generic
          // failure-counting below (one increment for the episode).
        }
      }
      // start() throws if already started, or on rapid restart races.
      this.consecutiveInstantFailures += 1;
      if (this.consecutiveInstantFailures >= MAX_INSTANT_FAILURES) {
        events.onStatus("error", "语音识别持续失败，请检查麦克风权限或切换引擎");
      }
    }
  }

  /** Surface the mode this engine session actually ended up running
   *  in (see STTEvents.onEngineMode's own doc) — once per engine
   *  lifetime, after the FIRST successful recognition.start() (post
   *  any defensive fallback above), never re-announced on later
   *  supervisor-driven rotation restarts. */
  private announceModeOnce(events: STTEvents): void {
    if (this.modeAnnounced) return;
    this.modeAnnounced = true;
    events.onEngineMode?.(this.onDeviceMode);
  }

  private watchdogTick(): void {
    if (this.userStopped || !this.recognition || !this.events) return;
    // An end cycle is already in flight (see endGen's doc comment) —
    // no-op entirely until it resolves. Without this, a stop() whose
    // onend takes a while used to let the NEXT tick(s) re-evaluate the
    // supervisor against the SAME still-unresolved stall and
    // double-count it (premature steer), or even call endSession()
    // again re-entrantly while the first stop() was still pending.
    if (this.awaitingOnendForGen !== null) return;
    const now = Date.now();
    const vadAvailable = this.vad?.available ?? false;
    const vadState = vadAvailable ? this.vad!.state : null;

    const action: SupervisorAction = decideAction({
      now,
      sessionStartedAt: this.lastStartAt,
      lastEventAt: this.lastEventAt,
      vadAvailable,
      vadSpeaking: vadState?.speaking ?? false,
      lastSpeechAt: vadState?.lastSpeechAt ?? -Infinity,
      hasPendingInterim: this.assembler.hasPendingInterim(),
      realFinalSinceSoft: this.realFinalSinceSoft,
      consecutiveSpeechStalls: this.consecutiveSpeechStalls,
      lastRecoverAt: this.lastRecoverAt,
    });

    // Diagnostics (item 7a): every rotation trigger (rotate/recover/
    // steer) — WHY the supervisor is about to tear down + relaunch
    // this session, with the session age/idle time it decided on.
    // "none" (the overwhelming common case, every WATCHDOG_TICK_MS)
    // is deliberately not logged — that would flood the ring buffer
    // for no diagnostic value.
    if (action.type !== "none") {
      diagLog(
        "info",
        "stt-webspeech-lifecycle",
        "rotation trigger",
        `reason=${action.type} sessionAgeMs=${now - this.lastStartAt} idleMs=${now - this.lastEventAt}`,
      );
    }

    switch (action.type) {
      case "none":
        return;
      case "rotate":
        this.endSession();
        return;
      case "recover":
        this.consecutiveSpeechStalls += 1;
        this.lastRecoverAt = now;
        this.endSession();
        return;
      case "steer":
        this.consecutiveSpeechStalls += 1;
        this.lastRecoverAt = now;
        if (!this.steerNotified) {
          this.steerNotified = true;
          this.events.onNotice?.(STEER_NOTICE);
        }
        this.endSession();
        return;
    }
  }

  /** End the current session for any supervisor-decided reason
   *  (rotate/recover/steer share this): flush the safely-flushable
   *  prefix (flushStable — the tail is expected to complete via this
   *  session's own trailing real final, see webSpeechSession.ts), then
   *  stop(). abort() fires ONLY as a zombie-session escalation if
   *  stop() produces no onend within CLOUD_FINALIZE_GRACE_MS — gated
   *  by the endGen token (see its doc comment) rather than a
   *  Date.now() guess, so a merely-slow (not zombied) onend is never
   *  mistaken for one that already relaunched. watchdogTick() no-ops
   *  for the entire window this token is set, so this can never be
   *  entered re-entrantly while a previous cycle is still resolving
   *  (finding #3b/#3c). */
  private endSession(): void {
    this.flushRotationTail();
    this.endingSession = true;
    const gen = ++this.endGen;
    this.awaitingOnendForGen = gen;
    try {
      this.recognition?.stop();
    } catch {
      // stop() threw with no pending onend to relaunch us — schedule
      // the escalation path anyway (finding #11): returning early
      // here used to skip it entirely, stranding the engine with no
      // way back to listening.
    }
    this.scheduleEndEscalation(gen);
  }

  /** Escalation for the end cycle identified by `gen`: wait for a
   *  matching onend; if it never (or not yet) arrives within
   *  CLOUD_FINALIZE_GRACE_MS, abort() the zombie session; if EVEN THAT
   *  produces no matching onend within another
   *  CLOUD_FINALIZE_GRACE_MS, force a relaunch. Every stage re-checks
   *  `awaitingOnendForGen === gen` first — once handleEnd() matches
   *  this generation (or a later endSession() call replaces it), every
   *  remaining stage here becomes a no-op for good. */
  private scheduleEndEscalation(gen: number): void {
    setTimeout(() => {
      if (this.awaitingOnendForGen !== gen) return; // already matched — no zombie
      if (this.userStopped || !this.recognition || !this.events) return;
      try {
        this.recognition.abort();
      } catch {
        // ignore — the forced relaunch below still covers it
      }
      setTimeout(() => {
        if (this.awaitingOnendForGen !== gen) return; // matched in the meantime
        if (this.userStopped || !this.recognition || !this.events) return;
        this.awaitingOnendForGen = null;
        this.endingSession = false;
        this.launch(this.events);
      }, CLOUD_FINALIZE_GRACE_MS);
    }, CLOUD_FINALIZE_GRACE_MS);
  }

  private flushRotationTail(): void {
    if (!this.events) return;
    const tail = this.assembler.flushStable(Date.now());
    if (tail) {
      this.events.onFinal(tail.text, { startedAt: tail.startedAt });
    }
    // Fix #A1: flushStable only ever emits the SAFE prefix — whatever
    // it deliberately held back (the revision-prone tail) would
    // otherwise just vanish from the screen the instant the final
    // above fires (onFinal -> setInterim(null) in useMeeting.ts) and
    // stay gone until either the dying session's own trailing real
    // final lands or the relaunch rescue (launch()'s flushAll) runs.
    // peekInterim() re-syncs the assembler's honest-interim-contract
    // baseline (#A4) to what we're about to show here, so the NEXT
    // push() diffs against THIS value instead of an earlier one.
    const rem = this.assembler.peekInterim();
    if (rem) {
      this.events.onInterim(rem);
      // Observability only (fix #A6) — length, never transcript text.
      diagLog(
        "warn",
        "stt-rotate-tail",
        "re-showing the held-back tail after a rotation flush",
        `tailChars=${rem.length}`,
      );
    }
  }

  private flushPendingTail(): void {
    if (!this.events) return;
    const tail = this.assembler.flushAll(Date.now());
    if (tail) {
      this.events.onFinal(tail.text, { startedAt: tail.startedAt });
    }
  }

  async stop(): Promise<void> {
    this.userStopped = true;
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    // Rescue the in-flight utterance BEFORE tearing down — a stop
    // during continuous speech used to silently drop everything Chrome
    // had not yet finalized (useMeeting saves the session right after
    // engine.stop() resolves, so this final lands in time). Uses
    // flushAll (not flushStable): nothing further will be processed
    // once events/recognition are torn down below, so this is the only
    // chance to grab the revision-prone tail too.
    this.flushPendingTail();
    const recognition = this.recognition;
    this.recognition = null;
    this.events = null;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        // already stopped — ignore
      }
    }
    this.vad?.stop();
    this.vad = null;
  }
}
