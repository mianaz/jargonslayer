// Web Speech API engine. Uses the browser's built-in (cloud-backed)
// recognizer — zero setup, but requires Chrome/Edge and an internet
// connection. Note: Web Speech API ignores `deviceId` — it always
// records from the OS-selected default microphone, there is no way
// to target a specific input device via this API (nor to disable the
// browser's echo-cancellation/noise-suppression chain, which is why
// this engine picks up speaker-played "external" audio poorly — the
// local Whisper engine or tab-audio mode are the answers there).
//
// Continuous-speech hardening (see webSpeechSession.ts for the full
// rationale): Chrome never finalizes mid-speech and its recognizer
// silently stalls after ~1–2min of uninterrupted talking. The shell
// therefore (a) self-flushes long interims into synthetic finals via
// UtteranceAssembler, (b) proactively rotates the recognition session
// every SESSION_ROTATE_MS preferring natural pauses, and (c) runs a
// stall watchdog that force-recovers a dead session.

import type { STTEngine, STTEngineKind, STTEvents, Settings } from "../types";
import {
  ROTATE_GRACE_MS,
  SESSION_ROTATE_MS,
  STALL_SILENCE_MS,
  STALL_SPEECH_MS,
  UtteranceAssembler,
} from "./webSpeechSession";

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
const WATCHDOG_TICK_MS = 5_000;
// Watchdog recovery: abort() should fire onend (whose handler
// relaunches); this fallback covers a zombie session where even
// abort() produces no event.
const RECOVER_FALLBACK_MS = 600;

export class WebSpeechEngine implements STTEngine {
  readonly kind: STTEngineKind = "webspeech";

  private recognition: SpeechRecognition | null = null;
  private events: STTEvents | null = null;
  private userStopped = false;
  private consecutiveInstantFailures = 0;
  private lastStartAt = 0;
  private lastEventAt = 0;

  private assembler = new UtteranceAssembler();
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private rotateRequestedAt: number | null = null;

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

    // Deferred rotation: take the natural pause (a real final) as the
    // boundary, or force once the grace window expires mid-speech.
    if (
      this.rotateRequestedAt !== null &&
      (out.sawRealFinal || now - this.rotateRequestedAt >= ROTATE_GRACE_MS)
    ) {
      this.doRotate();
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
    this.rotateRequestedAt = null;
    this.armRotateTimer();
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

  private armRotateTimer(): void {
    this.clearRotateTimer();
    this.rotateTimer = setTimeout(() => {
      if (this.userStopped || !this.recognition) return;
      if (this.assembler.hasPendingInterim()) {
        // Mid-speech: wait for a natural pause (or the grace window)
        // — handleResult performs the actual rotation.
        this.rotateRequestedAt = Date.now();
      } else {
        this.doRotate();
      }
    }, SESSION_ROTATE_MS);
  }

  private clearRotateTimer(): void {
    if (this.rotateTimer !== null) {
      clearTimeout(this.rotateTimer);
      this.rotateTimer = null;
    }
  }

  /** Flush the pending tail and end the session; handleEnd relaunches. */
  private doRotate(): void {
    this.rotateRequestedAt = null;
    this.clearRotateTimer();
    this.flushPendingTail();
    try {
      this.recognition?.stop();
    } catch {
      // already stopped — onend/watchdog will pick it up
    }
  }

  private flushPendingTail(): void {
    if (!this.events) return;
    const tail = this.assembler.flushAll(Date.now());
    if (tail) {
      this.events.onFinal(tail.text, { startedAt: tail.startedAt });
    }
  }

  private watchdogTick(): void {
    if (this.userStopped || !this.recognition || !this.events) return;
    const idle = Date.now() - this.lastEventAt;
    const limit = this.assembler.hasPendingInterim()
      ? STALL_SPEECH_MS
      : STALL_SILENCE_MS;
    if (idle < limit) return;

    // Session presumed dead: rescue the un-finalized text, then kick
    // the recognizer. abort() normally fires onend → relaunch; the
    // fallback below covers a fully zombie session.
    this.flushPendingTail();
    try {
      this.recognition.abort();
    } catch {
      // ignore — fallback relaunch below
    }
    setTimeout(() => {
      if (this.userStopped || !this.recognition || !this.events) return;
      // If onend already relaunched us, lastStartAt is fresh — skip.
      if (Date.now() - this.lastStartAt <= RECOVER_FALLBACK_MS) return;
      this.launch(this.events);
    }, RECOVER_FALLBACK_MS);
  }

  async stop(): Promise<void> {
    this.userStopped = true;
    this.clearRotateTimer();
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    // Rescue the in-flight utterance BEFORE tearing down — a stop
    // during continuous speech used to silently drop everything Chrome
    // had not yet finalized (useMeeting saves the session right after
    // engine.stop() resolves, so this final lands in time).
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
  }
}
