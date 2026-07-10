import type { VadHandle } from "../vad";
import type { VadState } from "../vadCore";

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
  // Renamed in spirit (not in field name, to keep existing scenario
  // assertions readable) by the VAD-supervisor rewrite: under the old
  // engine every restart-that-isn't-the-first-start WAS a scheduled
  // rotation. Now recover()/steer() ALSO call stop() as their primary
  // action (see sttSupervisor.ts) — so this counts every session
  // restart, whichever policy branch caused it. Individual scenarios
  // below scope their time windows so they can still reason about
  // "how many restarts happened", and stopTimestamps (below) lets a
  // scenario inspect WHEN each one happened if it needs to verify
  // backoff spacing.
  rotations: number;
  /** Wall-clock (Date.now(), i.e. vitest fake-timer time) of every
   *  stop() call — lets a scenario verify recovery cadence/backoff
   *  directly instead of only counting totals. */
  stopTimestamps: number[];
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
  private lastWordAt = 0;
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
    FakeSpeechRecognition.activeStats.stopTimestamps.push(Date.now());
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
    // A genuinely stalled/untranscribable-block recognizer produces
    // NOTHING at all (that's the whole premise those scenarios test —
    // see the diagnosis in stt-vad-supervisor.md) — bail before even
    // the proactive finalization check below.
    if (this.stalled || isInRange(now, script.quietRanges)) return;

    // Proactive silence-triggered finalization: a real recognizer
    // doesn't wait for you to start talking again before deciding the
    // PREVIOUS utterance is done — a long-enough pause finalizes on
    // its own (checked every tick, so this fires DURING genuine dead
    // air, not retroactively once new speech arrives). The
    // word-arrival-triggered check below still exists as a fallback
    // for gaps only barely at pauseFinalMs, where the next word can
    // arrive before this timer-based check gets a chance to run.
    if (
      this.currentWords.length > 0 &&
      now - this.lastWordAt >= script.pauseFinalMs
    ) {
      this.emitFinalAndAdvance();
    }

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
      this.lastWordAt = word.atMs;
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
    stopTimestamps: [],
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

// ---- scripted VAD (for the injectable-VAD engine constructor arg) ----
// A deterministic, script-driven VadHandle so loss-harness scenarios
// can assert supervisor behavior (rotate-into-pause, speech-stall
// recovery/steer, VAD-unavailable fallback) without going through the
// real dB/EMA simulation vadCore.test.ts already covers directly.

export interface VadRange {
  startMs: number;
  endMs: number;
}

export interface FakeVadOptions {
  /** start() resolves false, simulating a VAD that never comes up
   *  (permission denied / unsupported browser / capture failure) —
   *  exercises sttSupervisor.ts's vadAvailable=false legacy branch. */
  fail?: boolean;
}

export class FakeVad implements VadHandle {
  available = false;

  constructor(
    private readonly ranges: VadRange[],
    private readonly opts: FakeVadOptions = {},
  ) {}

  async start(): Promise<boolean> {
    if (this.opts.fail) {
      this.available = false;
      return false;
    }
    this.available = true;
    return true;
  }

  stop(): void {
    this.available = false;
  }

  get state(): VadState {
    const now = Date.now();
    let speaking = false;
    let lastSpeechAt = -Infinity;
    for (const r of this.ranges) {
      if (now >= r.startMs && now < r.endMs) speaking = true;
      if (r.startMs <= now) lastSpeechAt = Math.max(lastSpeechAt, Math.min(now, r.endMs));
    }
    return { speaking, lastSpeechAt };
  }
}

/** Cluster a word timeline into VAD "speaking" ranges: consecutive
 *  words within `gapMs` of each other merge into one continuous run
 *  (a short mouth-closing/breath pad, `trailMs`, extends past the
 *  run's last word). Built from the RAW timeline (not filtered by
 *  quietRanges) so an "untranscribable audio" block — someone
 *  genuinely talking, the recognizer just can't transcribe it — still
 *  reads as VAD-speaking, exactly like real acoustic energy would. */
export function deriveVadRanges(
  timeline: WordAt[],
  opts: { gapMs?: number; trailMs?: number } = {},
): VadRange[] {
  const gapMs = opts.gapMs ?? 400;
  const trailMs = opts.trailMs ?? 150;
  const ranges: VadRange[] = [];
  let start: number | null = null;
  let end: number | null = null;
  for (const w of timeline) {
    if (start === null) {
      start = w.atMs;
      end = w.atMs;
    } else if (w.atMs - (end as number) <= gapMs) {
      end = w.atMs;
    } else {
      ranges.push({ startMs: start, endMs: (end as number) + trailMs });
      start = w.atMs;
      end = w.atMs;
    }
  }
  if (start !== null) ranges.push({ startMs: start, endMs: (end as number) + trailMs });
  return ranges;
}
