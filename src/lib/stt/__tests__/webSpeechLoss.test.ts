import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings, STTEvents } from "../../types";
import { WebSpeechEngine } from "../webSpeech";
import {
  type FakeSpeechRecognitionScript,
  type QuietRange,
  hearableWords,
  installFakeSpeechRecognition,
  untranscribableWords,
} from "./fakeSpeechRecognition";

const T0 = 0;

interface LossMetrics {
  scenario: string;
  hearableWords: number;
  lostWords: number;
  lossPct: number;
  dupWords: number;
  abortCount: number;
  rotationCount: number;
  untranscribable: number;
}

interface ScenarioResult {
  metrics: LossMetrics;
  finals: string[];
}

function buildWords(
  durationMs: number,
  everyMs: number,
  startMs = 0,
  prefix = "w",
): { word: string; atMs: number }[] {
  const out: { word: string; atMs: number }[] = [];
  for (let atMs = startMs; atMs <= durationMs; atMs += everyMs) {
    out.push({ word: `${prefix}${String(out.length + 1).padStart(4, "0")}`, atMs });
  }
  return out;
}

function buildPausedSpeech(): { word: string; atMs: number }[] {
  const out: { word: string; atMs: number }[] = [];
  let id = 1;
  for (let sentenceStart = 0; sentenceStart < 180_000; sentenceStart += 9_500) {
    for (let i = 0; i < 22; i += 1) {
      out.push({
        word: `p${String(id).padStart(4, "0")}`,
        atMs: sentenceStart + i * 300,
      });
      id += 1;
    }
  }
  return out;
}

function countWords(words: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of words) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

function wordsFromFinals(finals: string[]): string[] {
  return finals
    .join(" ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

function measure(
  scenario: string,
  script: FakeSpeechRecognitionScript,
  finals: string[],
  abortCount: number,
  rotationCount: number,
  spokenUntilMs: number,
): LossMetrics {
  const measuredScript = {
    ...script,
    timeline: script.timeline.filter((word) => word.atMs <= spokenUntilMs),
  };
  const truth = hearableWords(measuredScript);
  const finalWords = wordsFromFinals(finals);
  const truthCounts = countWords(truth);
  const finalCounts = countWords(finalWords);

  let lostWords = 0;
  for (const [word, expected] of truthCounts.entries()) {
    const actual = finalCounts.get(word) ?? 0;
    if (actual < expected) lostWords += expected - actual;
  }

  let dupWords = 0;
  for (const [word, actual] of finalCounts.entries()) {
    const expected = truthCounts.get(word) ?? 0;
    if (actual > expected) dupWords += actual - expected;
  }

  return {
    scenario,
    hearableWords: truth.length,
    lostWords,
    lossPct: Number(((lostWords / truth.length) * 100).toFixed(2)),
    dupWords,
    abortCount,
    rotationCount,
    untranscribable: untranscribableWords(measuredScript).length,
  };
}

async function runScenario(
  scenario: string,
  script: FakeSpeechRecognitionScript,
  runForMs: number,
  stopAtMs = runForMs,
): Promise<ScenarioResult> {
  vi.useFakeTimers();
  vi.setSystemTime(T0);

  const stats = installFakeSpeechRecognition(script);
  const finals: string[] = [];
  const events: STTEvents = {
    onInterim: () => undefined,
    onFinal: (text) => {
      finals.push(text);
    },
    onStatus: () => undefined,
  };

  const engine = new WebSpeechEngine();
  await engine.start(events, { language: "zh-CN" } as Settings);
  await vi.advanceTimersByTimeAsync(stopAtMs);
  await engine.stop();
  await vi.advanceTimersByTimeAsync(Math.max(0, runForMs - stopAtMs) + 1_000);

  return {
    metrics: measure(
      scenario,
      script,
      finals,
      stats.aborts,
      stats.rotations,
      stopAtMs,
    ),
    finals,
  };
}

afterEach(() => {
  vi.useRealTimers();
  const target = globalThis as typeof globalThis & {
    window?: Record<string, unknown>;
  };
  if (target.window) {
    delete target.window.SpeechRecognition;
    delete target.window.webkitSpeechRecognition;
  }
});

describe("WebSpeechEngine word-loss measurement harness", () => {
  it("a. measures continuous speech loss across forced rotations", async () => {
    /*
     * Baseline observed: 515 hearable, 7 lost (1.36%), 1 dup,
     * 0 aborts, 3 rotations.
     */
    const script = { timeline: buildWords(180_000, 350) };
    const { metrics } = await runScenario(
      "a. continuous speech",
      script,
      185_000,
    );

    console.table([metrics]);
    expect(metrics.lossPct).toBeLessThan(30);
    expect(metrics.dupWords).toBeLessThan(5);
    expect(metrics.rotationCount).toBeGreaterThanOrEqual(2);
  });

  it("b. measures speech with natural pauses near rotations", async () => {
    /*
     * Baseline observed: 418 hearable, 9 lost (2.15%), 66 dup,
     * 0 aborts, 3 rotations.
     */
    const script = { timeline: buildPausedSpeech() };
    const { metrics } = await runScenario("b. natural pauses", script, 185_000);

    console.table([metrics]);
    expect(metrics.lossPct).toBeLessThan(5);
    expect(metrics.dupWords).toBeLessThan(100);
    expect(metrics.rotationCount).toBeGreaterThanOrEqual(2);
  });

  it("c. measures quiet-block watchdog abort recovery", async () => {
    /*
     * Baseline observed: 429 hearable, 7 lost (1.63%), 1 dup,
     * 1 abort, 2 rotations, 86 untranscribable.
     */
    const quietRanges: QuietRange[] = [{ startMs: 70_000, endMs: 100_000 }];
    const script = {
      timeline: buildWords(180_000, 350),
      quietRanges,
    };
    const { metrics } = await runScenario("c. quiet block", script, 185_000);

    console.table([metrics]);
    expect(metrics.untranscribable).toBeGreaterThan(0);
    expect(metrics.abortCount).toBeGreaterThanOrEqual(1);
    expect(metrics.lossPct).toBeLessThan(15);
    expect(metrics.dupWords).toBeLessThan(5);
  });

  it("d. measures silent-stall watchdog recovery", async () => {
    /*
     * Baseline observed: 515 hearable, 52 lost (10.1%), 1 dup,
     * 1 abort, 2 rotations.
     */
    const script = {
      timeline: buildWords(180_000, 350),
      stallAtMs: 70_000,
    };
    const { metrics } = await runScenario("d. silent stall", script, 185_000);

    console.table([metrics]);
    expect(metrics.abortCount).toBeGreaterThanOrEqual(1);
    expect(metrics.lossPct).toBeLessThan(20);
    expect(metrics.dupWords).toBeLessThan(5);
  });

  it("e. measures stop() mid-utterance flush rescue", async () => {
    /*
     * Baseline observed: 86 hearable, 3 lost (3.49%), 1 dup,
     * 0 aborts, 0 rotations.
     */
    const script = { timeline: buildWords(40_000, 350) };
    const { metrics } = await runScenario(
      "e. stop mid-utterance",
      script,
      40_000,
      30_000,
    );

    console.table([metrics]);
    expect(metrics.rotationCount).toBe(0);
    expect(metrics.lossPct).toBeLessThan(5);
    expect(metrics.dupWords).toBeLessThan(5);
  });
});
