// @vitest-environment jsdom
//
// MobilePanels — mobile full-screen panels view (CardStrip's 全部卡片
// opens this). createRoot/act pattern, real zustand store (mirrors
// CardStrip.test.tsx). jsdom has no scrollTo/scrollIntoView on elements
// — both are stubbed below (CardsPanel's own useFocusRing calls them).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "../../lib/store";
import type { ExpressionCard } from "@jargonslayer/core/types";

import MobilePanels from "../MobilePanels";

function makeCard(overrides: Partial<ExpressionCard> = {}): ExpressionCard {
  return {
    id: "c1",
    normKey: "circle back",
    expression: "circle back",
    category: "phrase",
    meaning: "return to this topic",
    chinese_explanation: "回头再聊这个话题",
    plain_english: "come back to this later",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    source_sentence: "let's circle back on this next week",
    firstSeenAt: 1000,
    lastSeenAt: 1000,
    count: 1,
    source: "dictionary",
    ...overrides,
  };
}

describe("MobilePanels", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    Element.prototype.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });

  function render() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    useApp.setState({ cards: [], terms: [], status: "idle", focusCardId: null });
    vi.restoreAllMocks();
  });

  it("tab=cards renders CardsPanel content", async () => {
    useApp.setState({ cards: [makeCard()], terms: [], status: "idle" });
    render();
    await act(async () => {
      root!.render(
        <MobilePanels tab="cards" onTabChange={vi.fn()} onClose={vi.fn()} />,
      );
    });

    expect(container!.querySelector('[data-testid="mobile-panels-fullscreen"]')).not.toBeNull();
    expect(container!.textContent).toContain("circle back");
  });

  it("tapping a tab button calls onTabChange with that tab", async () => {
    const onTabChange = vi.fn();
    render();
    await act(async () => {
      root!.render(
        <MobilePanels tab="cards" onTabChange={onTabChange} onClose={vi.fn()} />,
      );
    });

    await act(async () => {
      container!
        .querySelector('[data-testid="tab-summary"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onTabChange).toHaveBeenCalledWith("summary");
  });

  it("back button calls onClose", async () => {
    const onClose = vi.fn();
    render();
    await act(async () => {
      root!.render(
        <MobilePanels tab="cards" onTabChange={vi.fn()} onClose={onClose} />,
      );
    });

    await act(async () => {
      container!
        .querySelector('[aria-label="返回"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
