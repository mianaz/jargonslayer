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
