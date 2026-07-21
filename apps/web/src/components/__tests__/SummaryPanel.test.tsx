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
