// DemoEngine is the DEFAULT engine (DEFAULT_SETTINGS.engine === "demo")
// and therefore the first-run experience — yet its real timer/teardown
// lifecycle ran in zero tests: every useMeeting suite mocks @/lib/stt
// away wholesale. Deterministic here via fake timers (which also freeze
// Date.now for the startedAt contract) plus a pinned Math.random, so the
// word-tick cadence collapses to exact, assertable steps.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, STTEvents, STTStatus } from "@jargonslayer/core/types";
import { DemoEngine, demoTranslationFor } from "../demo";

type Recorded =
  | { kind: "status"; status: STTStatus; detail?: string }
  | { kind: "interim"; text: string; speaker?: string; sttSpeaker?: string }
  | { kind: "final"; text: string; sttSpeaker?: string; startedAt?: number };

function makeRecorder(): { events: STTEvents; seen: Recorded[] } {
  const seen: Recorded[] = [];
  const events: STTEvents = {
    onInterim: (text, speaker, sttSpeaker) => seen.push({ kind: "interim", text, speaker, sttSpeaker }),
    onFinal: (text, opts) =>
      seen.push({ kind: "final", text, sttSpeaker: opts?.sttSpeaker, startedAt: opts?.startedAt }),
    onStatus: (status, detail) => seen.push({ kind: "status", status, detail }),
  };
  return { events, seen };
}

const FIRST_LINE =
  "Okay everyone, let's get the ball rolling. Thanks for joining, I know Q3 planning snuck up on us fast.";
const LAST_LINE =
  "Great meeting. Action items: Mike owns billing, Lily owns the churn dashboard, and I'll circle back with runway updates Friday.";

// With Math.random pinned to 0.5: 3 words per interim tick
// (Math.round(randRange(2,3)) = Math.round(2.5) = 3), 285ms per tick
// (randRange(250,320)), 1250ms between lines (randRange(900,1600)).
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("DemoEngine", () => {
  it("declares the demo engine kind", () => {
    expect(new DemoEngine().kind).toBe("demo");
  });

  it("start() reports listening and emits the first cumulative interim synchronously", async () => {
    const { events, seen } = makeRecorder();
    await new DemoEngine().start(events, {} as Settings);

    expect(seen[0]).toEqual({ kind: "status", status: "listening", detail: undefined });
    expect(seen[1]).toEqual({
      kind: "interim",
      text: "Okay everyone, let's",
      speaker: "对方",
      sttSpeaker: "CH_SYS",
    });
  });

  it("interims grow as cumulative prefixes of the same line until the final lands verbatim", async () => {
    const { events, seen } = makeRecorder();
    vi.setSystemTime(5000);
    await new DemoEngine().start(events, {} as Settings);

    // Line 1 is 19 words: 7 in-flight ticks after the synchronous first
    // interim reach the final (3→6→9→12→15→18→19 words, then finalize).
    vi.advanceTimersByTime(285 * 7 + 1);

    const interims = seen.filter((e) => e.kind === "interim");
    const finals = seen.filter((e) => e.kind === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0]).toEqual({
      kind: "final",
      text: FIRST_LINE,
      sttSpeaker: "CH_SYS",
      // The engine stamps line start, not finalize time — the fake clock
      // has advanced ~2s by now, so this catches a Date.now()-at-final bug.
      startedAt: 5000,
    });
    for (let i = 1; i < interims.length; i++) {
      expect(interims[i].text.startsWith(interims[i - 1].text)).toBe(true);
    }
    expect(FIRST_LINE.startsWith(interims[interims.length - 1].text)).toBe(true);
  });

  it("replays all 16 lines in order and ends with the demo_finished idle status", async () => {
    const { events, seen } = makeRecorder();
    await new DemoEngine().start(events, {} as Settings);

    vi.runAllTimers();

    const finals = seen.filter((e) => e.kind === "final");
    expect(finals).toHaveLength(16);
    expect(finals[0].text).toBe(FIRST_LINE);
    expect(finals[finals.length - 1].text).toBe(LAST_LINE);
    // Dual-capture framing: both channels present, and the listener's
    // own mic is the minority (4 of 16 lines).
    expect(new Set(finals.map((f) => f.sttSpeaker))).toEqual(new Set(["CH_MIC", "CH_SYS"]));
    expect(finals.filter((f) => f.sttSpeaker === "CH_MIC")).toHaveLength(4);
    // Every scripted final has a recorded translation to replay.
    for (const f of finals) expect(demoTranslationFor(f.text)).toMatch(/[\u4e00-\u9fff]/);

    const last = seen[seen.length - 1];
    expect(last).toEqual({ kind: "status", status: "idle", detail: "demo_finished" });
  });

  it("stop() halts the replay: no further events fire even for already-scheduled ticks", async () => {
    const { events, seen } = makeRecorder();
    const engine = new DemoEngine();
    await engine.start(events, {} as Settings);
    vi.advanceTimersByTime(285); // one in-flight tick beyond the synchronous interim

    await engine.stop();
    const countAtStop = seen.length;

    vi.runAllTimers();
    expect(seen.length).toBe(countAtStop);
  });

  it("can start a fresh replay after stop()", async () => {
    const first = makeRecorder();
    const engine = new DemoEngine();
    await engine.start(first.events, {} as Settings);
    vi.advanceTimersByTime(285 * 3);
    await engine.stop();

    const second = makeRecorder();
    await engine.start(second.events, {} as Settings);
    expect(second.seen[0]).toEqual({ kind: "status", status: "listening", detail: undefined });
    vi.runAllTimers();
    expect(second.seen.filter((e) => e.kind === "final")).toHaveLength(16);
    expect(second.seen[second.seen.length - 1]).toEqual({
      kind: "status",
      status: "idle",
      detail: "demo_finished",
    });
  });

  it("demoTranslationFor trims its input and misses on unscripted text", () => {
    expect(demoTranslationFor(`  ${FIRST_LINE} `)).toBe(demoTranslationFor(FIRST_LINE));
    expect(demoTranslationFor("not in the script")).toBeUndefined();
  });
});
