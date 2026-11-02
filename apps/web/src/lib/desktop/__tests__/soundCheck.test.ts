import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type STTEngine, type STTEvents } from "@jargonslayer/core/types";
import { CH_MIC_SPEAKER, CH_SYS_SPEAKER } from "../../store";
import {
  channelForSttSpeaker,
  createSoundCheck,
  requiredChannels,
  type SoundCheckMode,
  type SoundCheckState,
} from "../soundCheck";

class FakeEngine implements STTEngine {
  readonly kind = "osspeech" as const;
  events: STTEvents | null = null;
  start = vi.fn(async (events: STTEvents) => {
    this.events = events;
  });
  stop = vi.fn(async () => {});
}

function setup(mode: SoundCheckMode, opts: { startImpl?: () => Promise<void>; timeoutMs?: number } = {}) {
  const engine = new FakeEngine();
  if (opts.startImpl) engine.start.mockImplementation(opts.startImpl);
  const states: SoundCheckState[] = [];
  const check = createSoundCheck({
    createEngine: () => engine,
    settings: { ...DEFAULT_SETTINGS, engine: "osspeech", mode },
    mode,
    onChange: (s) => states.push(s),
    timeoutMs: opts.timeoutMs,
  });
  const latest = () => states[states.length - 1];
  return { engine, check, states, latest };
}

describe("soundCheck helpers", () => {
  it("dual needs both channels; system-audio needs only the meeting audio", () => {
    expect(requiredChannels("dual")).toEqual(["mic", "system"]);
    expect(requiredChannels("system-audio")).toEqual(["system"]);
  });

  it("maps channel speaker ids, treating channel-less text as meeting audio", () => {
    expect(channelForSttSpeaker(CH_MIC_SPEAKER)).toBe("mic");
    expect(channelForSttSpeaker(CH_SYS_SPEAKER)).toBe("system");
    expect(channelForSttSpeaker(undefined)).toBe("system");
  });
});

describe("createSoundCheck", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dual: passes only once BOTH 我 and 对方 produced text, then stops the engine", async () => {
    const { engine, check, latest } = setup("dual");
    await check.start();
    expect(engine.start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: "dual" }));
    expect(latest().phase).toBe("starting");

    engine.events!.onStatus("listening");
    expect(latest().phase).toBe("listening");

    engine.events!.onInterim("hello can you hear me", undefined, CH_MIC_SPEAKER);
    expect(latest().mic).toEqual({ heard: true, sample: "hello can you hear me" });
    expect(latest().system.heard).toBe(false);
    expect(latest().phase).toBe("listening");
    expect(engine.stop).not.toHaveBeenCalled();

    engine.events!.onFinal("welcome to the lab meeting", { sttSpeaker: CH_SYS_SPEAKER });
    expect(latest().system).toEqual({ heard: true, sample: "welcome to the lab meeting" });
    expect(latest().phase).toBe("passed");
    await vi.runAllTimersAsync();
    expect(engine.stop).toHaveBeenCalledTimes(1);
  });

  it("system-audio: channel-less meeting text passes on its own; mic-tagged text is ignored", async () => {
    const { engine, check, latest } = setup("system-audio");
    await check.start();
    engine.events!.onStatus("listening");
    engine.events!.onInterim("stray mic text", undefined, CH_MIC_SPEAKER);
    expect(latest().mic.heard).toBe(false);
    expect(latest().phase).toBe("listening");

    engine.events!.onInterim("the meeting audio", undefined, undefined);
    expect(latest().phase).toBe("passed");
  });

  it("blank transcripts don't count as hearing anything", async () => {
    const { engine, check, latest } = setup("dual");
    await check.start();
    engine.events!.onStatus("listening");
    engine.events!.onInterim("   ", undefined, CH_MIC_SPEAKER);
    expect(latest().mic.heard).toBe(false);
  });

  it("long samples are clipped to their tail", async () => {
    const { engine, check, latest } = setup("dual");
    await check.start();
    engine.events!.onInterim("word ".repeat(40), undefined, CH_MIC_SPEAKER);
    const sample = latest().mic.sample!;
    expect(sample.startsWith("…")).toBe(true);
    expect(sample.length).toBeLessThanOrEqual(49);
  });

  it("an engine error (e.g. permission denied) surfaces the engine's own copy and stops", async () => {
    const { engine, check, latest } = setup("dual");
    await check.start();
    engine.events!.onStatus("error", "JargonSlayer 没有麦克风权限");
    expect(latest()).toMatchObject({ phase: "error", error: "JargonSlayer 没有麦克风权限" });
    await vi.runAllTimersAsync();
    expect(engine.stop).toHaveBeenCalledTimes(1);
  });

  it("a start() that throws lands in the error phase instead of rejecting", async () => {
    const { check, latest } = setup("dual", {
      startImpl: async () => {
        throw new Error("无法启动系统识别");
      },
    });
    await expect(check.start()).resolves.toBeUndefined();
    expect(latest()).toMatchObject({ phase: "error", error: "无法启动系统识别" });
  });

  it("times out after listening for the full window without hearing every channel", async () => {
    const { engine, check, latest } = setup("dual", { timeoutMs: 5_000 });
    await check.start();
    engine.events!.onStatus("listening");
    engine.events!.onInterim("only me", undefined, CH_MIC_SPEAKER);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(latest().phase).toBe("listening");
    await vi.advanceTimersByTimeAsync(1);
    expect(latest().phase).toBe("timeout");
    expect(latest().mic.heard).toBe(true);
    expect(latest().system.heard).toBe(false);
    expect(engine.stop).toHaveBeenCalledTimes(1);
  });

  it("the timeout doesn't start counting until capture is actually listening", async () => {
    const { engine, check, latest } = setup("dual", { timeoutMs: 1_000 });
    await check.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(latest().phase).toBe("starting");
    engine.events!.onStatus("listening");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(latest().phase).toBe("timeout");
  });

  it("the engine ending on its own mid-check is an error, with zh copy rather than the internal code", async () => {
    const { engine, check, latest } = setup("dual");
    await check.start();
    engine.events!.onStatus("listening");
    engine.events!.onStatus("idle", "capture_ended");
    expect(latest()).toMatchObject({ phase: "error", error: "收音意外结束，请重试" });
  });

  it("events arriving after a user stop are ignored (no late 'passed' or error flip)", async () => {
    const { engine, check, states } = setup("dual");
    await check.start();
    engine.events!.onStatus("listening");
    await check.stop();
    const count = states.length;
    engine.events!.onStatus("idle", "capture_ended");
    engine.events!.onInterim("late", undefined, CH_MIC_SPEAKER);
    expect(states.length).toBe(count);
    expect(engine.stop).toHaveBeenCalledTimes(1);
  });

  it("notices (speech model downloading) are passed through", async () => {
    const { engine, check, latest } = setup("dual");
    await check.start();
    engine.events!.onNotice?.("正在下载系统语音资源（系统自带，仅首次）…");
    expect(latest().notice).toBe("正在下载系统语音资源（系统自带，仅首次）…");
  });

  it("start() again (重试) resets the result and runs a fresh engine session", async () => {
    const { engine, check, latest } = setup("dual");
    await check.start();
    engine.events!.onStatus("error", "denied");
    await check.start();
    expect(latest()).toMatchObject({ phase: "starting", error: null, mic: { heard: false } });
    expect(engine.start).toHaveBeenCalledTimes(2);
  });
});
