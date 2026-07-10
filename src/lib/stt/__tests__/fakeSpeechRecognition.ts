export interface WordAt {
  word: string;
  atMs: number;
}

export interface QuietRange {
  startMs: number;
  endMs: number;
}

export interface FakeSpeechRecognitionScript {
  timeline: WordAt[];
  quietRanges?: QuietRange[];
  stallAtMs?: number;
  warmupMs?: number;
  interimTickMs?: number;
  pauseFinalMs?: number;
}

export interface FakeSpeechRecognitionStats {
  starts: number;
  stops: number;
  aborts: number;
  ends: number;
  rotations: number;
  instances: FakeSpeechRecognition[];
}

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

const DEFAULT_WARMUP_MS = 400;
const DEFAULT_INTERIM_TICK_MS = 300;
const DEFAULT_PAUSE_FINAL_MS = 1_200;
const END_DELAY_MS = 100;

function makeResult(
  transcript: string,
  isFinal: boolean,
): SpeechRecognitionResult {
  return {
    0: { transcript },
    isFinal,
    length: 1,
  };
}

function makeResults(
  entries: Map<number, { transcript: string; isFinal: boolean }>,
): SpeechRecognitionResultList {
  const maxIndex = Math.max(...entries.keys());
  const results: SpeechRecognitionResult[] = [];
  for (let i = 0; i <= maxIndex; i += 1) {
    const entry = entries.get(i);
    results[i] = makeResult(entry?.transcript ?? "", entry?.isFinal ?? true);
  }
  return results as unknown as SpeechRecognitionResultList;
}

function isInRange(atMs: number, ranges: QuietRange[]): boolean {
  return ranges.some((r) => atMs >= r.startMs && atMs < r.endMs);
}

function normalizeText(words: string[]): string {
  return words.join(" ").replace(/\s+/g, " ").trim();
}

export class FakeSpeechRecognition extends EventTarget {
  static activeScript: Required<
    Pick<
      FakeSpeechRecognitionScript,
      "timeline" | "quietRanges" | "warmupMs" | "interimTickMs" | "pauseFinalMs"
    >
  > &
    Pick<FakeSpeechRecognitionScript, "stallAtMs">;

  static activeStats: FakeSpeechRecognitionStats;

  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((ev: SpeechRecognitionEvent) => void) | null = null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;

  private running = false;
  private heardCursor = 0;
  private currentResultIndex = 0;
  private currentWords: string[] = [];
  private finalResults = new Map<number, string>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private startCallTime = 0;
  private stalled = false;
  private stallConsumed = false;
  private revisionFlip = false;

  constructor() {
    super();
    FakeSpeechRecognition.activeStats.instances.push(this);
  }

  start(): void {
    if (this.running) throw new Error("FakeSpeechRecognition already started");
    this.running = true;
    this.stalled = false;
    this.startCallTime = Date.now();
    FakeSpeechRecognition.activeStats.starts += 1;
    this.tickTimer = setInterval(
      () => this.tick(),
      FakeSpeechRecognition.activeScript.interimTickMs,
    );
  }

  stop(): void {
    if (!this.running) throw new Error("FakeSpeechRecognition is not running");
    FakeSpeechRecognition.activeStats.stops += 1;
    this.flushFinal();
    this.endSoon();
  }

  abort(): void {
    if (!this.running) throw new Error("FakeSpeechRecognition is not running");
    FakeSpeechRecognition.activeStats.aborts += 1;
    this.currentWords = [];
    this.currentResultIndex += 1;
    this.endSoon();
  }

  private tick(): void {
    if (!this.running) return;
    const now = Date.now();
    const script = FakeSpeechRecognition.activeScript;
    if (
      script.stallAtMs !== undefined &&
      !this.stallConsumed &&
      now >= script.stallAtMs
    ) {
      this.stalled = true;
      this.stallConsumed = true;
    }
    if (this.stalled || isInRange(now, script.quietRanges)) return;

    let changed = false;
    while (this.heardCursor < script.timeline.length) {
      const word = script.timeline[this.heardCursor];
      if (word.atMs > now) break;
      this.heardCursor += 1;

      if (word.atMs < this.startCallTime + script.warmupMs) continue;
      if (isInRange(word.atMs, script.quietRanges)) continue;

      const previous = this.previousHearableWordBefore(this.heardCursor - 1);
      if (
        this.currentWords.length > 0 &&
        previous &&
        word.atMs - previous.atMs >= script.pauseFinalMs
      ) {
        this.emitFinalAndAdvance();
      }
      this.currentWords.push(word.word);
      changed = true;
    }

    if (this.currentWords.length > 0) {
      this.emitCurrentInterim();
    } else if (changed) {
      this.emitChanged(new Map());
    }
  }

  private previousHearableWordBefore(index: number): WordAt | null {
    const script = FakeSpeechRecognition.activeScript;
    for (let i = index - 1; i >= 0; i -= 1) {
      const word = script.timeline[i];
      if (!isInRange(word.atMs, script.quietRanges)) return word;
    }
    return null;
  }

  private emitCurrentInterim(): void {
    const transcript = this.revisedTranscript();
    this.emitChanged(
      new Map([[this.currentResultIndex, { transcript, isFinal: false }]]),
    );
  }

  private revisedTranscript(): string {
    if (this.currentWords.length < 2) return normalizeText(this.currentWords);
    this.revisionFlip = !this.revisionFlip;
    if (!this.revisionFlip) return normalizeText(this.currentWords);

    const revised = [...this.currentWords];
    const last = revised[revised.length - 1];
    revised[revised.length - 1] = `${last}x`;
    return normalizeText(revised);
  }

  private emitFinalAndAdvance(): void {
    if (this.currentWords.length === 0) return;
    const transcript = normalizeText(this.currentWords);
    this.finalResults.set(this.currentResultIndex, transcript);
    this.emitChanged(
      new Map([[this.currentResultIndex, { transcript, isFinal: true }]]),
    );
    this.currentWords = [];
    this.currentResultIndex += 1;
    this.revisionFlip = false;
  }

  private flushFinal(): void {
    if (this.currentWords.length === 0) return;
    this.emitFinalAndAdvance();
  }

  private emitChanged(
    changedEntries: Map<number, { transcript: string; isFinal: boolean }>,
  ): void {
    if (!this.onresult || changedEntries.size === 0) return;
    const entries = new Map<number, { transcript: string; isFinal: boolean }>();
    for (const [index, transcript] of this.finalResults.entries()) {
      entries.set(index, { transcript, isFinal: true });
    }
    for (const [index, entry] of changedEntries.entries()) {
      entries.set(index, entry);
    }
    this.onresult({
      resultIndex: Math.min(...changedEntries.keys()),
      results: makeResults(entries),
    });
  }

  private endSoon(): void {
    this.running = false;
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    setTimeout(() => {
      FakeSpeechRecognition.activeStats.ends += 1;
      this.onend?.();
    }, END_DELAY_MS);
  }
}

export function installFakeSpeechRecognition(
  script: FakeSpeechRecognitionScript,
): FakeSpeechRecognitionStats {
  const stats: FakeSpeechRecognitionStats = {
    starts: 0,
    stops: 0,
    aborts: 0,
    ends: 0,
    get rotations() {
      return Math.max(0, this.stops - 1);
    },
    instances: [],
  };
  FakeSpeechRecognition.activeStats = stats;
  FakeSpeechRecognition.activeScript = {
    timeline: script.timeline,
    quietRanges: script.quietRanges ?? [],
    stallAtMs: script.stallAtMs,
    warmupMs: script.warmupMs ?? DEFAULT_WARMUP_MS,
    interimTickMs: script.interimTickMs ?? DEFAULT_INTERIM_TICK_MS,
    pauseFinalMs: script.pauseFinalMs ?? DEFAULT_PAUSE_FINAL_MS,
  };

  if (typeof window === "undefined") {
    Object.defineProperty(globalThis, "window", {
      value: {},
      configurable: true,
      writable: true,
    });
  }
  const speechWindow = window as unknown as Window & Record<string, unknown>;
  speechWindow.SpeechRecognition = FakeSpeechRecognition;
  speechWindow.webkitSpeechRecognition = FakeSpeechRecognition;

  return stats;
}

export function hearableWords(script: FakeSpeechRecognitionScript): string[] {
  const quietRanges = script.quietRanges ?? [];
  return script.timeline
    .filter((word) => !isInRange(word.atMs, quietRanges))
    .map((word) => word.word);
}

export function untranscribableWords(script: FakeSpeechRecognitionScript): string[] {
  const quietRanges = script.quietRanges ?? [];
  return script.timeline
    .filter((word) => isInRange(word.atMs, quietRanges))
    .map((word) => word.word);
}
