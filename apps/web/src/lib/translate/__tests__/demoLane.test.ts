// UI-1: the demo's translation lane. DemoTranslationProvider replays the
// DemoEngine script's recorded translations, and a queue built around it
// runs even with the user's bilingualTranscript toggle off (the toggle is
// never flipped, so nothing demo-only can persist). Every other provider
// keeps honoring the toggle exactly as before (queue.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings, type TranscriptSegment } from "@jargonslayer/core/types";
import { TranslateQueue } from "../queue";
import { DemoTranslationProvider, type TranslationProvider } from "../providers";
import { bilingualActive } from "../bilingual";

const FIRST_LINE =
  "Okay everyone, let's get the ball rolling. Thanks for joining, I know Q3 planning snuck up on us fast.";

function seg(id: string, text: string): TranscriptSegment {
  return { id, index: 0, startedAt: 0, endedAt: 0, text, engine: "demo" };
}

describe("bilingualActive", () => {
  const base: Settings = { ...DEFAULT_SETTINGS, language: "en-US", explainLanguage: "zh" };

  it("follows the user's toggle outside a demo replay", () => {
    expect(bilingualActive({ ...base, bilingualTranscript: false }, false)).toBe(false);
    expect(bilingualActive({ ...base, bilingualTranscript: true }, false)).toBe(true);
  });

  it("is on for a demo replay even with the toggle off", () => {
    expect(bilingualActive({ ...base, bilingualTranscript: false }, true)).toBe(true);
  });

  it("stays off for an en->en pair, demo or not", () => {
    expect(bilingualActive({ ...base, explainLanguage: "en", bilingualTranscript: true }, true)).toBe(false);
  });
});

describe("DemoTranslationProvider", () => {
  it("replays the script's recorded translation and skips unscripted text", async () => {
    const out = await new DemoTranslationProvider().translate(
      [
        { id: "a", text: FIRST_LINE },
        { id: "b", text: "an edited line that is not in the script" },
      ],
      "zh",
    );
    expect(out).toEqual([{ id: "a", text: expect.stringMatching(/^好，大家开始吧/) }]);
  });
});

describe("TranslateQueue with the demo provider", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeQueue(provider: TranslationProvider, settings: Settings) {
    const onTranslations = vi.fn<(map: Record<string, string>, gen: number) => void>();
    const queue = new TranslateQueue({
      getSettings: () => settings,
      getMeetingGen: () => 0,
      provider,
      onTranslations,
      onError: vi.fn(),
    });
    return { queue, onTranslations };
  }

  it("translates with the user's toggle off", async () => {
    const { queue, onTranslations } = makeQueue(new DemoTranslationProvider(), {
      ...DEFAULT_SETTINGS,
      bilingualTranscript: false,
    });
    queue.pushSegment(seg("s1", FIRST_LINE));
    await vi.advanceTimersByTimeAsync(2000);
    expect(onTranslations).toHaveBeenCalledTimes(1);
    expect(onTranslations.mock.calls[0][0].s1).toMatch(/^好，大家开始吧/);
    queue.stop();
  });

  it("a non-demo provider with the toggle off stays a no-op", async () => {
    const translate = vi.fn(async () => []);
    const provider: TranslationProvider = { kind: "llm", prepare: () => {}, translate };
    const { queue } = makeQueue(provider, { ...DEFAULT_SETTINGS, bilingualTranscript: false });
    queue.pushSegment(seg("s1", FIRST_LINE));
    await vi.advanceTimersByTimeAsync(2000);
    expect(translate).not.toHaveBeenCalled();
    queue.stop();
  });
});
