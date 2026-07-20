// v0.5 Wave-1 Feature 2 (AI transcript correction, §5 A5) — postFilter
// coverage: "shared zod CorrectResponseSchema validation (reject blank/
// duplicate ids, filter to requested ids)". The schema itself
// (providerCore.ts's CorrectResponseSchema) is shape-only (mirrors
// TranslateSegmentsSchema); this is where a malformed row actually gets
// dropped WITHOUT sinking the whole batch — same "extract, don't fork"
// posture as tasks/translate.ts's own postFilter.
import { describe, expect, it } from "vitest";
import type { CallJsonOptions, ProviderCaller } from "../../providerCore";
import {
  capLexiconChars,
  chunkCorrectSegments,
  CORRECT_MAX_LEXICON_CHARS,
  CORRECT_MAX_SEGMENTS_PER_CALL,
  CORRECT_MAX_TOTAL_CHARS_PER_CALL,
  runCorrectTask,
  totalLexiconChars,
  totalSegmentChars,
  type CorrectTaskInput,
} from "../correct";
import type { CorrectResponse } from "@jargonslayer/core/types";

function baseInput(overrides: Partial<CorrectTaskInput> = {}): CorrectTaskInput {
  return {
    apiKey: "key",
    model: "model",
    provider: "anthropic",
    baseUrl: "",
    segments: [
      { id: "s1", text: "scar an seek" },
      { id: "s2", text: "everything else fine" },
    ],
    context: "",
    lexicon: ["scRNA-seq"],
    ...overrides,
  };
}

function makeCall(response: CorrectResponse): ProviderCaller {
  return (async <T>(_opts: CallJsonOptions<T>): Promise<T> => response as T) as ProviderCaller;
}

describe("runCorrectTask — postFilter", () => {
  it("passes through a well-formed response unchanged", async () => {
    const res = await runCorrectTask(
      baseInput(),
      makeCall({
        corrections: [
          { id: "s1", text: "scRNA-seq" },
          { id: "s2", text: "everything else fine" },
        ],
      }),
    );
    expect(res.corrections).toEqual([
      { id: "s1", text: "scRNA-seq" },
      { id: "s2", text: "everything else fine" },
    ]);
  });

  it("drops a correction with a blank id", async () => {
    const res = await runCorrectTask(
      baseInput(),
      makeCall({
        corrections: [
          { id: "", text: "should be dropped" },
          { id: "s1", text: "scRNA-seq" },
        ],
      }),
    );
    expect(res.corrections).toEqual([{ id: "s1", text: "scRNA-seq" }]);
  });

  it("drops the SECOND occurrence of a duplicate id, keeping the first", async () => {
    const res = await runCorrectTask(
      baseInput(),
      makeCall({
        corrections: [
          { id: "s1", text: "first" },
          { id: "s1", text: "second — should be dropped" },
        ],
      }),
    );
    expect(res.corrections).toEqual([{ id: "s1", text: "first" }]);
  });

  it("drops a correction for an id that was never requested", async () => {
    const res = await runCorrectTask(
      baseInput(),
      makeCall({
        corrections: [
          { id: "s1", text: "scRNA-seq" },
          { id: "unrequested-id", text: "should be dropped" },
        ],
      }),
    );
    expect(res.corrections).toEqual([{ id: "s1", text: "scRNA-seq" }]);
  });

  it("a single malformed row never sinks the whole batch — every OTHER valid row still comes through", async () => {
    const res = await runCorrectTask(
      baseInput({
        segments: [
          { id: "s1", text: "a" },
          { id: "s2", text: "b" },
          { id: "s3", text: "c" },
        ],
      }),
      makeCall({
        corrections: [
          { id: "", text: "blank" },
          { id: "s1", text: "s1-fixed" },
          { id: "s1", text: "s1-dup" },
          { id: "extra", text: "unrequested" },
          { id: "s2", text: "s2-fixed" },
        ],
      }),
    );
    expect(res.corrections).toEqual([
      { id: "s1", text: "s1-fixed" },
      { id: "s2", text: "s2-fixed" },
    ]);
  });

  it("forwards the resolved lexicon/context/segments into the provider call's user message", async () => {
    let capturedUser = "";
    const call: ProviderCaller = (async <T>(opts: CallJsonOptions<T>): Promise<T> => {
      capturedUser = opts.user;
      return { corrections: [] } as T;
    }) as ProviderCaller;

    await runCorrectTask(
      baseInput({ context: "prior discussion of RNA sequencing", lexicon: ["scRNA-seq", "UMAP"] }),
      call,
    );

    expect(capturedUser).toContain("scRNA-seq, UMAP");
    expect(capturedUser).toContain("prior discussion of RNA sequencing");
    expect(capturedUser).toContain(JSON.stringify(baseInput().segments));
  });
});

// Finding 1 fix (pre-merge review) — per-call caps, single-sourced
// here and mirrored by app/api/correct/route.ts's zod schema.
describe("runCorrectTask — per-call cap validation (Finding 1, desktop/iOS parity)", () => {
  function makeSegments(count: number, textLen = 10): { id: string; text: string }[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `seg-${i}`,
      text: "a".repeat(textLen),
    }));
  }

  it("rejects a window with more segments than CORRECT_MAX_SEGMENTS_PER_CALL — never dispatches a provider call", async () => {
    let called = false;
    const call: ProviderCaller = (async <T>(): Promise<T> => {
      called = true;
      return { corrections: [] } as T;
    }) as ProviderCaller;

    await expect(
      runCorrectTask(
        baseInput({ segments: makeSegments(CORRECT_MAX_SEGMENTS_PER_CALL + 1, 1) }),
        call,
      ),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("accepts exactly CORRECT_MAX_SEGMENTS_PER_CALL segments", async () => {
    await expect(
      runCorrectTask(
        baseInput({ segments: makeSegments(CORRECT_MAX_SEGMENTS_PER_CALL, 1) }),
        makeCall({ corrections: [] }),
      ),
    ).resolves.toBeDefined();
  });

  it("rejects a window whose total segment text exceeds CORRECT_MAX_TOTAL_CHARS_PER_CALL", async () => {
    // 10 segments * (CORRECT_MAX_TOTAL_CHARS_PER_CALL/10 + 1) chars > cap.
    const textLen = Math.floor(CORRECT_MAX_TOTAL_CHARS_PER_CALL / 10) + 1;
    const segments = makeSegments(10, textLen);
    expect(totalSegmentChars(segments)).toBeGreaterThan(CORRECT_MAX_TOTAL_CHARS_PER_CALL);

    await expect(runCorrectTask(baseInput({ segments }), makeCall({ corrections: [] }))).rejects.toThrow();
  });

  it("rejects a lexicon exceeding CORRECT_MAX_LEXICON_CHARS", async () => {
    const lexicon = ["x".repeat(CORRECT_MAX_LEXICON_CHARS + 1)];
    expect(totalLexiconChars(lexicon)).toBeGreaterThan(CORRECT_MAX_LEXICON_CHARS);

    await expect(
      runCorrectTask(baseInput({ lexicon }), makeCall({ corrections: [] })),
    ).rejects.toThrow();
  });

  it("accepts a lexicon at exactly CORRECT_MAX_LEXICON_CHARS", async () => {
    const lexicon = ["x".repeat(CORRECT_MAX_LEXICON_CHARS)];
    await expect(
      runCorrectTask(baseInput({ lexicon }), makeCall({ corrections: [] })),
    ).resolves.toBeDefined();
  });
});

describe("capLexiconChars", () => {
  it("keeps the priority-ordered prefix that fits under maxChars, without reordering", () => {
    expect(capLexiconChars(["aaa", "bbb", "ccc"], 6)).toEqual(["aaa", "bbb"]);
  });

  it("keeps everything when the whole list already fits", () => {
    expect(capLexiconChars(["aaa", "bbb"], 100)).toEqual(["aaa", "bbb"]);
  });

  it("drops a term that would push the running total over the budget even if a LATER, shorter term would still fit (prefix-only, never reorders)", () => {
    expect(capLexiconChars(["aaaaa", "b"], 4)).toEqual([]);
  });
});

// Finding 1 fix — chunkCorrectSegments: the windowing logic
// CorrectionReview.tsx builds its per-window correctApi() loop from.
describe("chunkCorrectSegments", () => {
  function makeSegments(count: number, textLen = 10): { id: string; text: string }[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `s${i}`,
      text: "a".repeat(textLen),
    }));
  }

  it("a small meeting (under both caps) stays a single window with empty context", () => {
    const segments = makeSegments(3, 5);
    const windows = chunkCorrectSegments(segments);
    expect(windows).toHaveLength(1);
    expect(windows[0].segments).toEqual(segments);
    expect(windows[0].context).toBe("");
  });

  it("splits by the segment-COUNT cap when text is short (each window <= CORRECT_MAX_SEGMENTS_PER_CALL)", () => {
    const segments = makeSegments(90, 5); // 90*5=450 chars total, way under the char cap
    const windows = chunkCorrectSegments(segments);
    expect(windows.map((w) => w.segments.length)).toEqual([40, 40, 10]);
    // Every id is covered exactly once, in order.
    expect(windows.flatMap((w) => w.segments.map((s) => s.id))).toEqual(segments.map((s) => s.id));
  });

  it("splits by the total-CHAR cap when segments are long (segment count stays well under 40)", () => {
    // 20 segments * 1500 chars = 30,000 > CORRECT_MAX_TOTAL_CHARS_PER_CALL (24,000).
    const segments = makeSegments(20, 1500);
    const windows = chunkCorrectSegments(segments);
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) {
      expect(totalSegmentChars(w.segments)).toBeLessThanOrEqual(CORRECT_MAX_TOTAL_CHARS_PER_CALL);
    }
  });

  it("every window obeys BOTH per-call caps by construction", () => {
    const segments = makeSegments(137, 37);
    const windows = chunkCorrectSegments(segments);
    for (const w of windows) {
      expect(w.segments.length).toBeLessThanOrEqual(CORRECT_MAX_SEGMENTS_PER_CALL);
      expect(totalSegmentChars(w.segments)).toBeLessThanOrEqual(CORRECT_MAX_TOTAL_CHARS_PER_CALL);
    }
  });

  it("each window (after the first) carries the ~2 segments immediately preceding it as read-only context", () => {
    const segments = makeSegments(90, 5);
    const windows = chunkCorrectSegments(segments);
    expect(windows[0].context).toBe(""); // nothing precedes the first window
    // Window 2 starts at s40 — context is s38's + s39's text, joined.
    expect(windows[1].context).toBe([segments[38].text, segments[39].text].join("\n"));
    // Window 3 starts at s80 — context is s78's + s79's text.
    expect(windows[2].context).toBe([segments[78].text, segments[79].text].join("\n"));
  });

  it("context segments are never duplicated into the window's own segments", () => {
    const segments = makeSegments(90, 5);
    const windows = chunkCorrectSegments(segments);
    const window2Ids = new Set(windows[1].segments.map((s) => s.id));
    expect(window2Ids.has("s38")).toBe(false);
    expect(window2Ids.has("s39")).toBe(false);
    expect(window2Ids.has("s40")).toBe(true);
  });

  it("returns [] for an empty segment list", () => {
    expect(chunkCorrectSegments([])).toEqual([]);
  });
});
