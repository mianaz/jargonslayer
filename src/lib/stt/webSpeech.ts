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

import type { STTEngine, STTEngineKind, STTEvents, Settings } from "../types";
import {
  SESSION_ROTATE_SOFT_MS,
  type SupervisorAction,
  decideAction,
} from "./sttSupervisor";
import { SpeechActivityDetector, type VadHandle } from "./vad";
import { UtteranceAssembler } from "./webSpeechSession";

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
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognition;

interface WindowWithSpeech extends Window {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as WindowWithSpeech;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const RESTART_DELAY_MS = 250;
const MAX_INSTANT_FAILURES = 3;
// Watchdog now polls the supervisor at 500ms (was 5000ms) — the
// supervisor's own thresholds (STALL_SPEECH_MS=7s etc.) are what keep
// this from being noisy; the tighter tick just shrinks the DECISION
// latency once a threshold is actually crossed.
const WATCHDOG_TICK_MS = 500;
// endSession() recovery: stop() should fire onend (whose handler
// relaunches); this fallback covers a zombie session where even
// stop() — and then abort() — produces no event.
const RECOVER_FALLBACK_MS = 600;

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

  private vad: VadHandle | null = null;

  constructor(
    private readonly createVad: () => VadHandle = () =>
      new SpeechActivityDetector(),
  ) {}

  async start(events: STTEvents, settings: Settings): Promise<void> {
    this.events = events;
    this.userStopped = false;
    this.consecutiveInstantFailures = 0;

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      events.onStatus(
        "error",
        "当前浏览器不支持语音识别，请使用 Chrome/Edge，或切换到本地 Whisper / 演示模式",
      );
      return;
    }

    this.setupRecognition(Ctor, settings);
    this.watchdogTimer = setInterval(() => this.watchdogTick(), WATCHDOG_TICK_MS);
    this.launch(events);

    // Bring the VAD up asynchronously — never block/delay recognition
    // start on it. Until it resolves (or if it fails outright),
    // vad.available stays false and the supervisor runs its
    // VAD-unavailable legacy branch, which is the exact behavior this
    // engine had before VAD existed (strict enhancement).
    this.vad = this.createVad();
    void this.vad.start().then(() => {
      if (this.userStopped) this.vad?.stop();
    });
  }

  private setupRecognition(
    Ctor: SpeechRecognitionCtor,
    settings: Settings,
  ): void {
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = settings.language;

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
    if (out.interim) {
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
    this.lastEventAt = Date.now();

    switch (ev.error) {
      case "no-speech":
      case "aborted":
        // Benign — recognizer will restart via onend.
        return;
      case "not-allowed":
      case "service-not-allowed":
        this.events.onStatus(
          "error",
          "麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问",
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
    this.lastEventAt = Date.now();
    if (this.userStopped || !this.recognition || !this.events) return;

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

    setTimeout(() => {
      if (this.userStopped || !this.recognition || !this.events) return;
      this.launch(this.events);
    }, RESTART_DELAY_MS);
  }

  private launch(events: STTEvents): void {
    if (!this.recognition) return;
    this.lastStartAt = Date.now();
    this.lastEventAt = this.lastStartAt;
    this.assembler.reset();
    this.realFinalSinceSoft = false;
    this.endingSession = false;
    try {
      this.recognition.start();
      events.onStatus("listening");
    } catch {
      // start() throws if already started, or on rapid restart races.
      this.consecutiveInstantFailures += 1;
      if (this.consecutiveInstantFailures >= MAX_INSTANT_FAILURES) {
        events.onStatus("error", "语音识别持续失败，请检查麦克风权限或切换引擎");
      }
    }
  }

  private watchdogTick(): void {
    if (this.userStopped || !this.recognition || !this.events) return;
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
   *  stop() produces no onend within RECOVER_FALLBACK_MS. */
  private endSession(): void {
    this.flushRotationTail();
    this.endingSession = true;
    try {
      this.recognition?.stop();
    } catch {
      // already stopped — onend/relaunch handles it
      return;
    }
    setTimeout(() => {
      if (this.userStopped || !this.recognition || !this.events) return;
      if (Date.now() - this.lastStartAt <= RECOVER_FALLBACK_MS) return; // onend already relaunched
      try {
        this.recognition.abort();
      } catch {
        // ignore — the fallback relaunch below covers it
      }
      setTimeout(() => {
        if (this.userStopped || !this.recognition || !this.events) return;
        if (Date.now() - this.lastStartAt <= RECOVER_FALLBACK_MS) return;
        this.launch(this.events);
      }, RECOVER_FALLBACK_MS);
    }, RECOVER_FALLBACK_MS);
  }

  private flushRotationTail(): void {
    if (!this.events) return;
    const tail = this.assembler.flushStable(Date.now());
    if (tail) {
      this.events.onFinal(tail.text, { startedAt: tail.startedAt });
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
