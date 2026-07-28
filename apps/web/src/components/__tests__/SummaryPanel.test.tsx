// @vitest-environment jsdom
//
// SummaryPanel — Bit celebration trigger (v0.5.1 Bit sprint, Lane B).
// createRoot/act pattern (no @testing-library/react in this repo's test
// stack — mirrors CardsPanel.test.tsx/SettingsDialog.test.tsx). The one
// external boundary mocked is summarizeApi (network/LLM call); NoKeyError
// rides through via importOriginal since GenerateCta's catch branch still
// does `err instanceof NoKeyError`, which would throw on an undefined
// right-hand side if left unmocked. saveCurrentSession is swapped for a
// plain stub the same way CardsPanel.test.tsx swaps updateCard/updateTerm.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "../../lib/store";
import { DEFAULT_SETTINGS, type MeetingSummary, type SummaryResult } from "@jargonslayer/core/types";

const summarizeApiMock = vi.fn();
vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return {
    ...actual,
    summarizeApi: (...args: unknown[]) => summarizeApiMock(...args),
  };
});

// gapfill.ts is worker-B-owned and may not exist on disk while this
// lane works — this mock IS the pinned contract (v071 blueprint's
// Shared contract section), not a stand-in for the real module.
const runGapFillMock = vi.fn();
vi.mock("@/lib/translate/gapfill", () => ({
  runGapFill: (...args: unknown[]) => runGapFillMock(...args),
}));

// downloadFile/downloadBlob poke browser download machinery
// (URL.createObjectURL) jsdom doesn't implement — swapped for stubs so
// a real export click doesn't throw; buildMarkdownReport/buildAnkiTSV/
// buildSessionJson stay real so the gate's export-path plumbing is
// still exercised end to end.
const downloadFileMock = vi.fn();
const downloadBlobMock = vi.fn();
vi.mock("@/lib/history/export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/history/export")>();
  return {
    ...actual,
    downloadFile: (...args: unknown[]) => downloadFileMock(...args),
    downloadBlob: (...args: unknown[]) => downloadBlobMock(...args),
  };
});

import SummaryPanel from "../SummaryPanel";

function makeSummaryResult(overrides: Partial<SummaryResult> = {}): SummaryResult {
  const summary: MeetingSummary = {
    topic: { en: "Weekly sync", zh: "周会" },
    key_points: [],
    decisions: [],
    action_items: [],
  };
  return {
    summary,
    translations: [],
    flashcards: [],
    generatedAt: 1000,
    model: "test-model",
    ...overrides,
  };
}

// Captured at module-eval time (before any test overrides it) — same
// restore posture as CardsPanel.test.tsx's REAL_UPDATE_CARD/TERM.
const REAL_SAVE_CURRENT_SESSION = useApp.getState().saveCurrentSession;

describe("SummaryPanel — Bit celebration on summary generation success (v0.5.1 Bit sprint, Lane B)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  async function flush() {
    // Drains the microtask queue the fire-and-forget handleGenerate()
    // kicks off — same helper shape as SettingsDialog.test.tsx's own.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    summarizeApiMock.mockReset();
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: "sk-test" },
      status: "stopped",
      summary: null,
      summarizing: false,
      segments: [],
      cards: [],
      terms: [],
      bitCelebrateNonce: 0,
      saveCurrentSession: vi.fn(async () => "session-1"),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    useApp.setState({
      summary: null,
      summarizing: false,
      bitCelebrateNonce: 0,
      saveCurrentSession: REAL_SAVE_CURRENT_SESSION,
    });
  });

  function clickGenerate() {
    const btn = container!.querySelector(
      '[data-testid="btn-generate-summary"]',
    ) as HTMLButtonElement | null;
    if (!btn) throw new Error("生成会议报告 button not found");
    return act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("fires celebrateBit exactly once when generation succeeds", async () => {
    summarizeApiMock.mockResolvedValue(makeSummaryResult());

    await act(async () => {
      root!.render(<SummaryPanel />);
    });
    await flush();

    await clickGenerate();
    await flush();

    expect(useApp.getState().summary).not.toBeNull();
    expect(useApp.getState().bitCelebrateNonce).toBe(1);
  });

  it("does NOT fire celebrateBit when generation fails (retry/failure — negative scenario)", async () => {
    summarizeApiMock.mockRejectedValue(new Error("network boom"));

    await act(async () => {
      root!.render(<SummaryPanel />);
    });
    await flush();

    await clickGenerate();
    await flush();

    expect(useApp.getState().summary).toBeNull();
    expect(useApp.getState().bitCelebrateNonce).toBe(0);
  });
});

// v0.7.1 Chamber C — export-path gate. md/docx/复制纪要 all carry the
// live transcript, so they're gated behind an inline confirm when
// bilingual translation is on and segments still have gaps; JSON/Anki
// stay exempt. runGapFill is mocked per the pinned worker-B contract
// (v071 blueprint's Shared contract section) — the mock itself IS the
// contract, not a stand-in for gapfill.ts's real behavior.
describe("SummaryPanel — export-path gate (v0.7.1 Chamber C)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function findButton(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === text,
    );
    if (!btn) throw new Error(`button "${text}" not found`);
    return btn;
  }

  function clickButton(btn: HTMLButtonElement) {
    return act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  const segWithGap = {
    id: "seg1",
    index: 0,
    startedAt: 1000,
    endedAt: 1500,
    text: "Untranslated.",
    engine: "demo" as const,
  };
  const segTranslated = {
    id: "seg2",
    index: 1,
    startedAt: 1600,
    endedAt: 2000,
    text: "Translated already.",
    engine: "demo" as const,
  };

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    runGapFillMock.mockReset();
    downloadFileMock.mockReset();
    downloadBlobMock.mockReset();
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: "sk-test", bilingualTranscript: true },
      status: "stopped",
      summary: null,
      summarizing: false,
      segments: [segWithGap, segTranslated],
      cards: [],
      terms: [],
      translations: { seg2: "已翻译。" },
      toast: null,
      meetingGen: 0,
      saveCurrentSession: vi.fn(async () => "session-1"),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    useApp.setState({
      summary: null,
      summarizing: false,
      segments: [],
      translations: {},
      toast: null,
      meetingGen: 0,
      saveCurrentSession: REAL_SAVE_CURRENT_SESSION,
    });
  });

  it("shows the inline confirm with the untranslated count when bilingual is on and a gap exists", async () => {
    await act(async () => {
      root!.render(<SummaryPanel />);
    });
    await flush();

    await clickButton(findButton("导出报告 .md"));
    await flush();

    expect(container!.querySelector('[data-testid="export-gap-fill"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="export-anyway"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="export-cancel"]')).not.toBeNull();
    expect(container!.textContent).toContain("还有 1 段未翻译");
  });

  it("直接导出 exports immediately without calling runGapFill", async () => {
    await act(async () => {
      root!.render(<SummaryPanel />);
    });
    await flush();

    await clickButton(findButton("导出报告 .md"));
    await flush();
    await clickButton(container!.querySelector('[data-testid="export-anyway"]') as HTMLButtonElement);
    await flush();

    expect(runGapFillMock).not.toHaveBeenCalled();
    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    expect(container!.querySelector('[data-testid="export-gap-fill"]')).toBeNull();
  });

  it("补全后导出 awaits runGapFill before exporting, disabling the confirm's buttons meanwhile", async () => {
    let resolveGapFill: (v: { filled: number; failed: number; aborted: boolean }) => void = () => {};
    runGapFillMock.mockReturnValue(
      new Promise((resolve) => {
        resolveGapFill = resolve;
      }),
    );

    await act(async () => {
      root!.render(<SummaryPanel />);
    });
    await flush();

    await clickButton(findButton("导出报告 .md"));
    await flush();
    await clickButton(container!.querySelector('[data-testid="export-gap-fill"]') as HTMLButtonElement);

    // Still awaiting runGapFill — no export yet, confirm buttons disabled.
    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(
      (container!.querySelector('[data-testid="export-gap-fill"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (container!.querySelector('[data-testid="export-anyway"]') as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      resolveGapFill({ filled: 1, failed: 0, aborted: false });
    });
    await flush();

    expect(runGapFillMock).toHaveBeenCalledTimes(1);
    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    expect(container!.querySelector('[data-testid="export-gap-fill"]')).toBeNull();
  });

  it("shows a toast and still exports when gap-fill reports failures", async () => {
    runGapFillMock.mockResolvedValue({ filled: 0, failed: 1, aborted: false });

    await act(async () => {
      root!.render(<SummaryPanel />);
    });
    await flush();

    await clickButton(findButton("导出报告 .md"));
    await flush();
    await clickButton(container!.querySelector('[data-testid="export-gap-fill"]') as HTMLButtonElement);
    await flush();

    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    expect(useApp.getState().toast).toEqual(expect.stringContaining("1 段未能翻译"));
  });

  // R2-1 fix (v0.7.1 train-2 round-2 review): loadSession/newMeeting
  // landing WHILE runGapFill() is still in flight bumps meetingGen —
  // exporting after that would carry a DIFFERENT session's transcript
  // under this confirm's kind. runGapFillMock bumps meetingGen itself
  // (simulating that race) right before resolving.
  it("R2-1 fix: cancels the export and toasts when meetingGen changes mid gap-fill (cross-session)", async () => {
    runGapFillMock.mockImplementation(async () => {
      useApp.setState({ meetingGen: useApp.getState().meetingGen + 1 });
      return { filled: 1, failed: 0, aborted: false };
    });

    await act(async () => {
      root!.render(<SummaryPanel />);
    });
    await flush();

    await clickButton(findButton("导出报告 .md"));
    await flush();
    await clickButton(container!.querySelector('[data-testid="export-gap-fill"]') as HTMLButtonElement);
    await flush();

    expect(runGapFillMock).toHaveBeenCalledTimes(1);
    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(useApp.getState().toast).toEqual(expect.stringContaining("会话已切换"));
    expect(container!.querySelector('[data-testid="export-gap-fill"]')).toBeNull(); // confirm closed
  });

  it("取消 closes the confirm without exporting or calling runGapFill", async () => {
    await act(async () => {
      root!.render(<SummaryPanel />);
    });
    await flush();

    await clickButton(findButton("导出报告 .md"));
    await flush();
    await clickButton(container!.querySelector('[data-testid="export-cancel"]') as HTMLButtonElement);
    await flush();

    expect(runGapFillMock).not.toHaveBeenCalled();
    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="export-gap-fill"]')).toBeNull();
  });

  it("does not gate the JSON export path", async () => {
    await act(async () => {
      root!.render(<SummaryPanel />);
    });
    await flush();

    await clickButton(findButton("导出 JSON"));
    await flush();

    expect(container!.querySelector('[data-testid="export-gap-fill"]')).toBeNull();
    expect(downloadFileMock).toHaveBeenCalledTimes(1);
  });

  it("also gates the .docx and 复制纪要 export paths", async () => {
    await act(async () => {
      root!.render(<SummaryPanel />);
    });
    await flush();

    await clickButton(findButton("导出 .docx"));
    await flush();
    expect(container!.querySelector('[data-testid="export-gap-fill"]')).not.toBeNull();
    await clickButton(container!.querySelector('[data-testid="export-cancel"]') as HTMLButtonElement);
    await flush();

    await clickButton(findButton("复制纪要"));
    await flush();
    expect(container!.querySelector('[data-testid="export-gap-fill"]')).not.toBeNull();
  });

  // F4(b) fix (v0.7.1 train-2 adversarial review): a live meeting already
  // has its own TranslateQueue filling gaps — gapfill.ts's own status
  // guard (F4a) would abort a run started here anyway, so 补全后导出
  // itself must not even be offered while one is in progress. The
  // 未翻译 count text (and 直接导出/取消) stay exactly as before.
  it("F4(b) fix: only 直接导出/取消 are offered while a live meeting is running — no 补全后导出", async () => {
    useApp.setState({ status: "listening" });

    await act(async () => {
      root!.render(<SummaryPanel />);
    });
    await flush();

    await clickButton(findButton("导出报告 .md"));
    await flush();

    expect(container!.textContent).toContain("还有 1 段未翻译");
    expect(container!.querySelector('[data-testid="export-gap-fill"]')).toBeNull();
    expect(container!.querySelector('[data-testid="export-anyway"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="export-cancel"]')).not.toBeNull();
  });

  // F6 fix (v0.7.1 train-2 adversarial review): oversized segments (too
  // long for gap-fill to ever pick up — GAP_MAX_TEXT_CHARS) used to be
  // invisible to this gate entirely, so a meeting with ONLY oversized
  // gaps exported silently missing translations with no warning at all.
  describe("F6 — oversized-segment visibility", () => {
    const oversizedSeg = {
      id: "seg-big",
      index: 2,
      startedAt: 2000,
      endedAt: 2500,
      text: "x".repeat(1600), // > GAP_MAX_TEXT_CHARS (1500)
      engine: "demo" as const,
    };

    it("an ONLY-oversized gap still shows the gate, with no 补全后导出 button (nothing gap-fill could ever do)", async () => {
      useApp.setState({
        segments: [oversizedSeg, segTranslated],
        translations: { seg2: "已翻译。" },
      });

      await act(async () => {
        root!.render(<SummaryPanel />);
      });
      await flush();

      await clickButton(findButton("导出报告 .md"));
      await flush();

      expect(container!.querySelector('[data-testid="export-gap-fill"]')).toBeNull();
      expect(container!.querySelector('[data-testid="export-anyway"]')).not.toBeNull();
      expect(container!.textContent).toContain("还有 0 段未翻译");
      expect(container!.textContent).toContain("另有 1 段过长，无法自动翻译");
    });

    it("a MIXED gap (eligible + oversized) renders both counts, with 补全后导出 still available for the eligible one", async () => {
      useApp.setState({
        segments: [segWithGap, oversizedSeg, segTranslated],
        translations: { seg2: "已翻译。" },
      });

      await act(async () => {
        root!.render(<SummaryPanel />);
      });
      await flush();

      await clickButton(findButton("导出报告 .md"));
      await flush();

      expect(container!.querySelector('[data-testid="export-gap-fill"]')).not.toBeNull();
      expect(container!.textContent).toContain("还有 1 段未翻译");
      expect(container!.textContent).toContain("另有 1 段过长，无法自动翻译");
    });
  });
});
