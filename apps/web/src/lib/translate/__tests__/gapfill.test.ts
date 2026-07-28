// @vitest-environment jsdom
//
// v0.7.1 translation train-2, Chamber B (docs/design-explorations/
// v071-translation-train2-blueprint.md §Chamber B). gapfill.ts's public
// API is PINNED (worker C's export-gate imports it directly) — these
// tests exercise the runner against the REAL zustand store (same
// convention as TranscriptPanel.f1f2.test.tsx), with only the LLM error
// classes and resolveTranslationProvider itself mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings, type TranscriptSegment } from "@jargonslayer/core/types";

vi.mock("../../llm/client", () => ({
  NoKeyError: class NoKeyError extends Error {
    constructor(message = "未配置 API Key") {
      super(message);
      this.name = "NoKeyError";
    }
  },
  RateLimitApiError: class RateLimitApiError extends Error {
    constructor(message = "请求过于频繁，请稍后重试") {
      super(message);
      this.name = "RateLimitApiError";
    }
  },
}));

const resolveTranslationProviderMock = vi.fn();
vi.mock("../providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers")>();
  return {
    ...actual,
    resolveTranslationProvider: (...args: unknown[]) => resolveTranslationProviderMock(...args),
  };
});

import { NoKeyError, RateLimitApiError } from "../../llm/client";
import { SystemTranslatorUnavailableError } from "../providers";
import { useApp } from "@/lib/store";
import { isGapFillRunning, runGapFill } from "../gapfill";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, bilingualTranscript: true, ...overrides };
}

let segIndex = 0;
function makeSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  segIndex++;
  return {
    id: `seg-${segIndex}`,
    index: segIndex,
    startedAt: Date.now(),
    endedAt: Date.now(),
    text: `hello ${segIndex}`,
    engine: "demo",
    ...overrides,
  };
}

function installProvider(translate: ReturnType<typeof vi.fn>, prepare = vi.fn()) {
  resolveTranslationProviderMock.mockReturnValue({ kind: "llm", prepare, translate });
  return { prepare, translate };
}

describe("gapfill — runGapFill / isGapFillRunning", () => {
  beforeEach(() => {
    segIndex = 0;
    resolveTranslationProviderMock.mockReset();
    useApp.setState({
      segments: [],
      translations: {},
      settings: makeSettings(),
      meetingGen: 0,
      status: "stopped",
      translateStatus: { state: "off", pending: 0 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    useApp.setState({
      segments: [],
      translations: {},
      settings: DEFAULT_SETTINGS,
      meetingGen: 0,
      status: "idle",
      translateStatus: { state: "off", pending: 0 },
    });
  });

  it("fills gaps in batches (size 6) and applies to the store, ending busy→done", async () => {
    const segments = Array.from({ length: 8 }, () => makeSegment());
    useApp.setState({ segments });

    const statusSpy = vi.spyOn(useApp.getState(), "setTranslateStatus");
    const translate = vi.fn().mockImplementation(async (items: { id: string; text: string }[]) =>
      items.map((it) => ({ id: it.id, text: `${it.text} 译` })),
    );
    installProvider(translate);

    const result = await runGapFill();

    expect(translate).toHaveBeenCalledTimes(2); // 6 + 2
    expect(translate.mock.calls[0][0]).toHaveLength(6);
    expect(translate.mock.calls[1][0]).toHaveLength(2);
    expect(result).toEqual({ filled: 8, failed: 0, aborted: false });

    for (const s of segments) {
      expect(useApp.getState().translations[s.id]).toBe(`${s.text} 译`);
    }

    const states = statusSpy.mock.calls.map((c) => c[0].state);
    expect(states[0]).toBe("busy");
    expect(states[states.length - 1]).toBe("done");
  });

  it("gen bump mid-run aborts without applying the in-flight batch", async () => {
    const segments = Array.from({ length: 12 }, () => makeSegment());
    useApp.setState({ segments, meetingGen: 0 });

    const applySpy = vi.spyOn(useApp.getState(), "applyTranslations");
    const translate = vi
      .fn()
      .mockImplementationOnce(async (items: { id: string; text: string }[]) =>
        items.map((it) => ({ id: it.id, text: `${it.text} 译` })),
      )
      .mockImplementationOnce(async (items: { id: string; text: string }[]) => {
        // Simulates loadSession/newMeeting landing WHILE this batch's
        // request is in flight — bumps meetingGen before the runner's
        // own await resolves.
        useApp.setState({ meetingGen: 1 });
        return items.map((it) => ({ id: it.id, text: `${it.text} 译` }));
      });
    installProvider(translate);

    const result = await runGapFill();

    expect(result.aborted).toBe(true);
    expect(result.filled).toBe(6); // first batch landed before the bump
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledTimes(2); // second batch was attempted, its result just never applied
  });

  it("NoKeyError aborts immediately and toasts", async () => {
    useApp.setState({ segments: [makeSegment()] });
    const showToastSpy = vi.spyOn(useApp.getState(), "showToast");
    const translate = vi.fn().mockRejectedValue(new NoKeyError());
    installProvider(translate);

    const result = await runGapFill();

    expect(result).toEqual({ filled: 0, failed: 0, aborted: true });
    expect(translate).toHaveBeenCalledTimes(1); // no retry
    expect(showToastSpy).toHaveBeenCalledWith("翻译引擎未配置 Key，请在设置中填写");
    expect(useApp.getState().translateStatus.state).toBe("off"); // nothing landed
  });

  it("SystemTranslatorUnavailableError aborts with the reason-specific toast", async () => {
    useApp.setState({ segments: [makeSegment()] });
    const showToastSpy = vi.spyOn(useApp.getState(), "showToast");
    const translate = vi.fn().mockRejectedValue(new SystemTranslatorUnavailableError("downloading"));
    installProvider(translate);

    const result = await runGapFill();

    expect(result.aborted).toBe(true);
    expect(showToastSpy).toHaveBeenCalledWith("系统翻译语言包下载中，请稍后再试");
  });

  it("rate-limit waits (30s) up to a budget of 2, then aborts on the 3rd", async () => {
    vi.useFakeTimers();
    useApp.setState({ segments: [makeSegment()] });
    const translate = vi.fn().mockRejectedValue(new RateLimitApiError());
    installProvider(translate);

    const promise = runGapFill();
    await vi.advanceTimersByTimeAsync(30_000); // 1st wait
    await vi.advanceTimersByTimeAsync(30_000); // 2nd wait
    const result = await promise; // 3rd rejection aborts without a 3rd wait

    expect(result).toEqual({ filled: 0, failed: 0, aborted: true });
    expect(translate).toHaveBeenCalledTimes(3);
  });

  it("generic error retries a batch once, then counts it failed and continues to the next batch", async () => {
    const segments = Array.from({ length: 8 }, () => makeSegment());
    useApp.setState({ segments });

    const translate = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom again"))
      .mockImplementationOnce(async (items: { id: string; text: string }[]) =>
        items.map((it) => ({ id: it.id, text: `${it.text} 译` })),
      );
    installProvider(translate);

    const result = await runGapFill();

    expect(translate).toHaveBeenCalledTimes(3); // batch1 x2 (initial+retry) + batch2 x1
    expect(result).toEqual({ filled: 2, failed: 6, aborted: false });
    expect(useApp.getState().translateStatus.state).toBe("done"); // something landed overall
  });

  it("re-entry while already running is a no-op", async () => {
    useApp.setState({ segments: [makeSegment()] });
    // A controllable pending promise (not `new Promise(() => {})`) — this
    // test resolves it (with a REAL translation, closing the gap) before
    // finishing, so the module-level `running` flag is guaranteed to
    // clear again before the NEXT test in this file runs (it's a shared
    // module singleton, not per-test state) instead of looping forever
    // on a still-open gap.
    let settleFirstBatch: () => void = () => {};
    const translate = vi.fn().mockImplementation(
      (items: { id: string; text: string }[]) =>
        new Promise<{ id: string; text: string }[]>((resolve) => {
          settleFirstBatch = () => resolve(items.map((it) => ({ id: it.id, text: `${it.text} 译` })));
        }),
    );
    installProvider(translate);

    const first = runGapFill();
    expect(isGapFillRunning()).toBe(true);

    const second = await runGapFill();
    expect(second).toEqual({ filled: 0, failed: 0, aborted: false });
    expect(translate).toHaveBeenCalledTimes(1); // the second call never even resolved a provider

    settleFirstBatch();
    await first;
    expect(isGapFillRunning()).toBe(false);
  });

  it("calls provider.prepare() synchronously, before the first await", async () => {
    useApp.setState({ segments: [makeSegment()] });
    const prepare = vi.fn();
    // Resolves with a REAL translation (closes the gap on the first
    // batch) so the run actually terminates instead of looping forever
    // re-fetching the same still-open gap.
    const translate = vi
      .fn()
      .mockImplementation(async (items: { id: string; text: string }[]) =>
        items.map((it) => ({ id: it.id, text: `${it.text} 译` })),
      );
    installProvider(translate, prepare);

    const promise = runGapFill(); // not yet awaited
    expect(prepare).toHaveBeenCalledTimes(1); // already ran, synchronously

    await promise;
  });

  it("no-ops (no provider resolution at all) when source === target", async () => {
    useApp.setState({
      segments: [makeSegment()],
      settings: makeSettings({ language: "en-US", explainLanguage: "en" }),
    });
    const translate = vi.fn();
    installProvider(translate);

    const result = await runGapFill();

    expect(result).toEqual({ filled: 0, failed: 0, aborted: false });
    expect(resolveTranslationProviderMock).not.toHaveBeenCalled();
  });
});
