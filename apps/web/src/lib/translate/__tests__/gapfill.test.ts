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
// F8(b) fix regression coverage — stopSystemTranslator itself is a
// real no-op outside a desktop/iOS build, so it's mocked here purely to
// make "was it called" observable, not to change its behavior.
const stopSystemTranslatorMock = vi.fn();
vi.mock("../providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers")>();
  return {
    ...actual,
    resolveTranslationProvider: (...args: unknown[]) => resolveTranslationProviderMock(...args),
    stopSystemTranslator: (...args: unknown[]) => stopSystemTranslatorMock(...args),
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

function installProvider(translate: ReturnType<typeof vi.fn>, prepare = vi.fn(), kind = "llm") {
  resolveTranslationProviderMock.mockReturnValue({ kind, prepare, translate });
  return { prepare, translate };
}

describe("gapfill — runGapFill / isGapFillRunning", () => {
  beforeEach(() => {
    segIndex = 0;
    resolveTranslationProviderMock.mockReset();
    stopSystemTranslatorMock.mockReset();
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

  it("F1 fix: an id whose translation resolves to '' is given up on (counted failed), never re-selected — no infinite loop", async () => {
    const seg = makeSegment();
    useApp.setState({ segments: [seg] });

    // Bounded call counter — a regression that reintroduces the
    // infinite loop would blow well past any sane call count instead of
    // this test just hanging forever.
    let calls = 0;
    const translate = vi.fn().mockImplementation(async (items: { id: string; text: string }[]) => {
      calls++;
      if (calls > 5) throw new Error("runaway loop — same empty-result id kept being re-selected");
      return items.map((it) => ({ id: it.id, text: "" }));
    });
    installProvider(translate);

    const result = await runGapFill();

    expect(result).toEqual({ filled: 0, failed: 1, aborted: false });
    expect(translate).toHaveBeenCalledTimes(1); // gave up after the one empty result, no re-fetch
    expect(useApp.getState().translations[seg.id]).toBeUndefined();
  });

  it("F3 fix: re-entry while already running JOINS the same in-flight run instead of no-opping", async () => {
    useApp.setState({ segments: [makeSegment()] });
    // A controllable pending promise (not `new Promise(() => {})`) — this
    // test resolves it (with a REAL translation, closing the gap) before
    // finishing, so the module-level `currentRun` is guaranteed to clear
    // again before the NEXT test in this file runs (it's a shared module
    // singleton, not per-test state) instead of looping forever on a
    // still-open gap.
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

    // A second call while the first is still pending must return the
    // SAME promise — not a stub {aborted:false} — so a caller
    // (SummaryPanel's 补全后导出) that fires it genuinely waits for the
    // real result.
    const second = runGapFill();
    expect(second).toBe(first);
    expect(translate).toHaveBeenCalledTimes(1); // the second call never triggered its own batch

    settleFirstBatch();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual({ filled: 1, failed: 0, aborted: false });
    expect(secondResult).toBe(firstResult);
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

  it("F8 fix: a no-gap call never resolves a provider at all (nothing to prime/tear down)", async () => {
    useApp.setState({ segments: [makeSegment({ text: "hello" })], translations: { "seg-1": "你好" } });
    const translate = vi.fn();
    installProvider(translate);

    const result = await runGapFill();

    expect(result).toEqual({ filled: 0, failed: 0, aborted: false });
    expect(resolveTranslationProviderMock).not.toHaveBeenCalled();
  });

  it.each(["listening", "connecting", "paused"] as const)(
    "F4 fix: status %s aborts immediately without resolving a provider — a live meeting's own TranslateQueue owns this",
    async (status) => {
      useApp.setState({ segments: [makeSegment()], status });
      const translate = vi.fn();
      installProvider(translate);

      const result = await runGapFill();

      expect(result).toEqual({ filled: 0, failed: 0, aborted: true });
      expect(resolveTranslationProviderMock).not.toHaveBeenCalled();
    },
  );

  it("F5 fix: drops a translation for a segment whose text changed mid-flight, without giving it up (still eligible next pass)", async () => {
    const seg = makeSegment({ text: "original text" });
    useApp.setState({ segments: [seg] });

    let calls = 0;
    const translate = vi.fn().mockImplementation(async (items: { id: string; text: string }[]) => {
      calls++;
      if (calls === 1) {
        // Simulates a concurrent edit landing while this batch's
        // translate() request is still in flight — mutates the store's
        // segment text BEFORE the request resolves.
        useApp.setState({
          segments: useApp
            .getState()
            .segments.map((s) => (s.id === seg.id ? { ...s, text: "edited text" } : s)),
        });
      }
      return items.map((it) => ({ id: it.id, text: `${it.text} 译` }));
    });
    installProvider(translate);

    await runGapFill();

    // The stale translation ("original text 译", computed from the text
    // AS SENT) must never land — only the SECOND attempt, re-dispatched
    // with the post-edit text, is applied. Two calls (not one) is itself
    // proof the id was left as an ordinary gap rather than given up on.
    expect(translate).toHaveBeenCalledTimes(2);
    expect(useApp.getState().translations[seg.id]).toBe("edited text 译");
  });

  it("F8 fix: tears down a system-kind provider's native child via stopSystemTranslator after completion", async () => {
    useApp.setState({ segments: [makeSegment()] });
    const translate = vi
      .fn()
      .mockImplementation(async (items: { id: string; text: string }[]) =>
        items.map((it) => ({ id: it.id, text: `${it.text} 译` })),
      );
    installProvider(translate, vi.fn(), "system");

    expect(stopSystemTranslatorMock).not.toHaveBeenCalled();
    await runGapFill();

    expect(stopSystemTranslatorMock).toHaveBeenCalledTimes(1);
  });

  it("does not tear down a non-system (llm) provider", async () => {
    useApp.setState({ segments: [makeSegment()] });
    const translate = vi
      .fn()
      .mockImplementation(async (items: { id: string; text: string }[]) =>
        items.map((it) => ({ id: it.id, text: `${it.text} 译` })),
      );
    installProvider(translate); // default kind: "llm"

    await runGapFill();

    expect(stopSystemTranslatorMock).not.toHaveBeenCalled();
  });

  it("R2-2 fix: does NOT tear down a system-kind provider when meetingGen changed mid-run (ownership moved to the newer flow)", async () => {
    const segments = Array.from({ length: 12 }, () => makeSegment());
    useApp.setState({ segments, meetingGen: 0 });
    const translate = vi
      .fn()
      .mockImplementationOnce(async (items: { id: string; text: string }[]) =>
        items.map((it) => ({ id: it.id, text: `${it.text} 译` })),
      )
      .mockImplementationOnce(async (items: { id: string; text: string }[]) => {
        // Simulates loadSession/newMeeting landing WHILE this batch's
        // request is in flight — the newer flow now owns translator
        // teardown for its own prepare() call.
        useApp.setState({ meetingGen: 1 });
        return items.map((it) => ({ id: it.id, text: `${it.text} 译` }));
      });
    installProvider(translate, vi.fn(), "system");

    const result = await runGapFill();

    expect(result.aborted).toBe(true);
    expect(stopSystemTranslatorMock).not.toHaveBeenCalled();
  });

  it("R2-3 fix: an id edited mid-flight during an exhausted give-up retry escapes quarantine and is retried with its new text on the next pass", async () => {
    const segA = makeSegment({ text: "A original" });
    const segB = makeSegment({ text: "B original" });
    useApp.setState({ segments: [segA, segB] });

    let attempt = 0;
    const translate = vi.fn().mockImplementation(async (items: { id: string; text: string }[]) => {
      attempt++;
      if (attempt <= 2) {
        if (attempt === 2) {
          // Concurrent edit lands DURING the exhausted (2nd) attempt,
          // before it rejects — by the time the give-up path re-reads
          // segments, segA's text has already diverged from what was
          // sent.
          useApp.setState({
            segments: useApp
              .getState()
              .segments.map((s) => (s.id === segA.id ? { ...s, text: "A edited" } : s)),
          });
        }
        throw new Error("boom");
      }
      // 3rd call: the NEXT loop pass, re-reading fresh gaps — only segA
      // should still be open (segB was quarantined on give-up).
      return items.map((it) => ({ id: it.id, text: `${it.text} 译` }));
    });
    installProvider(translate);

    const result = await runGapFill();

    expect(translate).toHaveBeenCalledTimes(3); // initial + 1 retry (both fail) + a fresh pass for the edited id alone
    expect(translate.mock.calls[2][0]).toEqual([{ id: segA.id, text: "A edited" }]);
    expect(result.failed).toBe(1); // only segB given up on
    expect(result.filled).toBe(1); // segA translated with its NEW text
    expect(useApp.getState().translations[segA.id]).toBe("A edited 译");
    expect(useApp.getState().translations[segB.id]).toBeUndefined();
  });

  it("R2-6 fix: triggers an immediate saveCurrentSession when the run fills at least one gap and its own gen is still current", async () => {
    useApp.setState({ segments: [makeSegment()] });
    // vi.spyOn on an ALREADY-spied store method (leftover from an
    // earlier test's own spyOn call, since zustand's merged state
    // objects carry the spy function reference forward across
    // setState() calls) returns that SAME mock with its prior call
    // history intact rather than a fresh one — mockClear() gives this
    // test its own clean count regardless.
    const saveSpy = vi.spyOn(useApp.getState(), "saveCurrentSession");
    saveSpy.mockClear();
    const translate = vi
      .fn()
      .mockImplementation(async (items: { id: string; text: string }[]) =>
        items.map((it) => ({ id: it.id, text: `${it.text} 译` })),
      );
    installProvider(translate);

    await runGapFill();

    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("R2-6 fix: does NOT save when nothing was filled (all given up)", async () => {
    useApp.setState({ segments: [makeSegment()] });
    // vi.spyOn on an ALREADY-spied store method (leftover from an
    // earlier test's own spyOn call, since zustand's merged state
    // objects carry the spy function reference forward across
    // setState() calls) returns that SAME mock with its prior call
    // history intact rather than a fresh one — mockClear() gives this
    // test its own clean count regardless.
    const saveSpy = vi.spyOn(useApp.getState(), "saveCurrentSession");
    saveSpy.mockClear();
    const translate = vi
      .fn()
      .mockImplementation(async (items: { id: string; text: string }[]) =>
        items.map((it) => ({ id: it.id, text: "" })),
      );
    installProvider(translate);

    await runGapFill();

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("R2-6 fix: does NOT save when meetingGen changed mid-run (ownership/persistence moved to the newer flow)", async () => {
    const segments = Array.from({ length: 12 }, () => makeSegment());
    useApp.setState({ segments, meetingGen: 0 });
    // vi.spyOn on an ALREADY-spied store method (leftover from an
    // earlier test's own spyOn call, since zustand's merged state
    // objects carry the spy function reference forward across
    // setState() calls) returns that SAME mock with its prior call
    // history intact rather than a fresh one — mockClear() gives this
    // test its own clean count regardless.
    const saveSpy = vi.spyOn(useApp.getState(), "saveCurrentSession");
    saveSpy.mockClear();
    const translate = vi
      .fn()
      .mockImplementationOnce(async (items: { id: string; text: string }[]) =>
        items.map((it) => ({ id: it.id, text: `${it.text} 译` })),
      )
      .mockImplementationOnce(async (items: { id: string; text: string }[]) => {
        useApp.setState({ meetingGen: 1 });
        return items.map((it) => ({ id: it.id, text: `${it.text} 译` }));
      });
    installProvider(translate);

    const result = await runGapFill();

    expect(result.aborted).toBe(true);
    expect(saveSpy).not.toHaveBeenCalled();
  });
});
