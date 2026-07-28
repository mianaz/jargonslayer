// @vitest-environment jsdom
//
// CardStrip — mobile horizontal swipeable card strip (vertical dock
// replacement). createRoot/act pattern, real zustand store (mirrors
// CardsPanel.test.tsx). jsdom has no scrollTo/scrollIntoView on
// elements — both are stubbed with vi.fn() below.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "../../lib/store";
import type { ExpressionCard, TermCard } from "@jargonslayer/core/types";

import CardStrip from "../CardStrip";

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

function makeTerm(overrides: Partial<TermCard> = {}): TermCard {
  return {
    id: "t1",
    normKey: "ARR",
    term: "ARR",
    type: "metric",
    gloss_en: "Annual Recurring Revenue",
    gloss_zh: "年度经常性收入",
    firstSeenAt: 1000,
    lastSeenAt: 1000,
    count: 1,
    source: "dictionary",
    ...overrides,
  };
}

describe("CardStrip", () => {
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

  function strips(): HTMLElement[] {
    return Array.from(container!.querySelectorAll('[data-testid="strip-card"]'));
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
    useApp.setState({ cards: [], terms: [], focusCardId: null });
    vi.restoreAllMocks();
  });

  it("newest item renders as the first strip-card in DOM order", async () => {
    useApp.setState({
      cards: [makeCard({ id: "c1", firstSeenAt: 1000, lastSeenAt: 1000 })],
      terms: [makeTerm({ id: "t1", firstSeenAt: 2000, lastSeenAt: 2000 })],
    });
    render();
    await act(async () => {
      root!.render(<CardStrip onOpenList={vi.fn()} onHide={vi.fn()} focusEnabled />);
    });

    const cards = strips();
    expect(cards).toHaveLength(2);
    expect(cards[0].dataset.cardId).toBe("t1");
    expect(cards[1].dataset.cardId).toBe("c1");
  });

  it("tapping a card calls onOpenList with that card's id", async () => {
    const onOpenList = vi.fn();
    useApp.setState({ cards: [makeCard()], terms: [] });
    render();
    await act(async () => {
      root!.render(<CardStrip onOpenList={onOpenList} onHide={vi.fn()} focusEnabled />);
    });

    await act(async () => {
      strips()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onOpenList).toHaveBeenCalledWith("c1");
  });

  it("chrome-row buttons call onOpenList() / onHide()", async () => {
    const onOpenList = vi.fn();
    const onHide = vi.fn();
    useApp.setState({ cards: [makeCard()], terms: [] });
    render();
    await act(async () => {
      root!.render(<CardStrip onOpenList={onOpenList} onHide={onHide} focusEnabled />);
    });

    await act(async () => {
      container!
        .querySelector('[aria-label="全部卡片"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenList).toHaveBeenCalledWith();

    await act(async () => {
      container!
        .querySelector('[aria-label="隐藏卡片"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("回到最新 hidden initially; appears once scrolled and clicking it scrolls back to left 0", async () => {
    useApp.setState({ cards: [makeCard()], terms: [] });
    render();
    await act(async () => {
      root!.render(<CardStrip onOpenList={vi.fn()} onHide={vi.fn()} focusEnabled />);
    });

    expect(container!.querySelector('[data-testid="strip-back-to-latest"]')).toBeNull();

    const row = strips()[0].parentElement as HTMLDivElement;
    await act(async () => {
      Object.defineProperty(row, "scrollLeft", { value: 200, configurable: true });
      row.dispatchEvent(new Event("scroll", { bubbles: false }));
    });

    const backBtn = container!.querySelector(
      '[data-testid="strip-back-to-latest"]',
    ) as HTMLButtonElement;
    expect(backBtn).not.toBeNull();

    await act(async () => {
      backBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(row.scrollTo).toHaveBeenCalledWith({ left: 0, behavior: "smooth" });

    // Pill hides immediately on click, and scroll events during the
    // return-to-latest window must not resurrect it (they fire
    // throughout the smooth animation with scrollLeft still > 40).
    expect(container!.querySelector('[data-testid="strip-back-to-latest"]')).toBeNull();
    await act(async () => {
      Object.defineProperty(row, "scrollLeft", { value: 120, configurable: true, writable: true });
      row.dispatchEvent(new Event("scroll", { bubbles: false }));
    });
    expect(container!.querySelector('[data-testid="strip-back-to-latest"]')).toBeNull();
  });

  it("re-promotion reorder keeps the anchored card in place (no rightward drift)", async () => {
    useApp.setState({
      cards: [
        makeCard({ id: "cA", normKey: "a", expression: "alpha", firstSeenAt: 2000, lastSeenAt: 2000 }),
        makeCard({ id: "cB", normKey: "b", expression: "beta", firstSeenAt: 1000, lastSeenAt: 1000 }),
      ],
      terms: [],
    });
    render();
    await act(async () => {
      root!.render(<CardStrip onOpenList={vi.fn()} onHide={vi.fn()} focusEnabled />);
    });

    // Simulated layout: two 304px cards at offsets 0 / 312.
    const row = strips()[0].parentElement as HTMLDivElement;
    row.querySelectorAll<HTMLElement>("[data-card-id]").forEach((el, i) => {
      Object.defineProperty(el, "offsetLeft", { value: i * 312, configurable: true });
      Object.defineProperty(el, "offsetWidth", { value: 304, configurable: true });
    });
    // Viewer scrolled to cB (the older card): anchor = {cB, off 0}.
    await act(async () => {
      Object.defineProperty(row, "scrollLeft", { value: 312, configurable: true, writable: true });
      row.dispatchEvent(new Event("scroll", { bubbles: false }));
    });

    // cB gets re-detected → re-promoted to the head; the list reorders.
    // v1 diff compensation blindly added a card width (→ 624); the
    // anchor restore must instead pin cB right where the viewer left it.
    await act(async () => {
      useApp.setState({
        cards: [
          makeCard({ id: "cA", normKey: "a", expression: "alpha", firstSeenAt: 2000, lastSeenAt: 2000 }),
          makeCard({ id: "cB", normKey: "b", expression: "beta", firstSeenAt: 1000, lastSeenAt: 3000 }),
        ],
        terms: [],
      });
    });

    expect(strips()[0].dataset.cardId).toBe("cB");
    expect(row.scrollLeft).toBe(312);
  });

  it("focusEnabled + focusCardId set: scrollIntoView called on the matching card and focusCardId cleared", async () => {
    vi.useFakeTimers();
    useApp.setState({ cards: [makeCard({ id: "c1" }), makeCard({ id: "c2" })], terms: [] });
    render();
    await act(async () => {
      root!.render(<CardStrip onOpenList={vi.fn()} onHide={vi.fn()} focusEnabled />);
    });

    await act(async () => {
      useApp.setState({ focusCardId: "c2" });
    });

    const target = container!.querySelector('[data-card-id="c2"]') as HTMLElement;
    expect(target.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(useApp.getState().focusCardId).toBeNull();
    vi.useRealTimers();
  });

  it("focusEnabled=false does NOT consume focusCardId", async () => {
    useApp.setState({ cards: [makeCard({ id: "c1" })], terms: [], focusCardId: "c1" });
    render();
    await act(async () => {
      root!.render(
        <CardStrip onOpenList={vi.fn()} onHide={vi.fn()} focusEnabled={false} />,
      );
    });

    const target = container!.querySelector('[data-card-id="c1"]') as HTMLElement;
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    expect(useApp.getState().focusCardId).toBe("c1");
  });

  it("n === 0: empty hint renders, no strip-card", async () => {
    useApp.setState({ cards: [], terms: [] });
    render();
    await act(async () => {
      root!.render(<CardStrip onOpenList={vi.fn()} onHide={vi.fn()} focusEnabled />);
    });

    expect(strips()).toHaveLength(0);
    expect(container!.textContent).toContain("卡片将随会议自动出现");
  });
});
