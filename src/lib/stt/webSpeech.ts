// Web Speech API engine. Uses the browser's built-in (cloud-backed)
// recognizer — zero setup, but requires Chrome/Edge and an internet
// connection. Note: Web Speech API ignores `deviceId` — it always
// records from the OS-selected default microphone, there is no way
// to target a specific input device via this API.

import type { STTEngine, STTEngineKind, STTEvents, Settings } from "../types";

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

export class WebSpeechEngine implements STTEngine {
  readonly kind: STTEngineKind = "webspeech";

  private recognition: SpeechRecognition | null = null;
  private events: STTEvents | null = null;
  private userStopped = false;
  private consecutiveInstantFailures = 0;
  private lastStartAt = 0;
  private currentUtteranceStart: number | null = null;

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

    let interimText = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const result = ev.results[i];
      const transcript = result[0]?.transcript ?? "";

      if (this.currentUtteranceStart === null) {
        this.currentUtteranceStart = Date.now();
      }

      if (result.isFinal) {
        const startedAt = this.currentUtteranceStart ?? Date.now();
        this.events.onFinal(transcript, { startedAt });
        this.currentUtteranceStart = null;
      } else {
        interimText += transcript;
      }
    }

    if (interimText) {
      this.events.onInterim(interimText);
    }
  }

  private handleError(ev: SpeechRecognitionErrorEvent): void {
    if (!this.events) return;

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
          "语音识别网络错误 — Web Speech 需要联网，可切换到本地 Whisper 引擎",
        );
        return;
      default:
        return;
    }
  }

  private handleEnd(): void {
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

  async stop(): Promise<void> {
    this.userStopped = true;
    const recognition = this.recognition;
    this.recognition = null;
    this.events = null;
    this.currentUtteranceStart = null;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        // already stopped — ignore
      }
    }
  }
}
