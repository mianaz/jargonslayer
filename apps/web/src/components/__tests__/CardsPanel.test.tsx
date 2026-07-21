// @vitest-environment jsdom
//
// v0.5 Wave-1 Feature 7 (inline card/term edit, docs/design-explorations/
// v05-wave1-blueprint.md §1 Feature 7). createRoot/act pattern, real
// zustand store (mirrors AiStatusPanel.test.tsx) — updateCard/updateTerm
// are spied via a setState override (TaskCenterDrawer.desktop.test.tsx's
// own `showToastSpy` precedent), everything else rides the real store.
// Store-level gating/re-save behavior (status!=="stopped" refusal,
// post-stop debounced save) is already covered by store.test.ts's own
// "updateCard / updateTerm" describe block — this file only exercises
// the UI: affordance visibility + which fields the component sends.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "../../lib/store";
import type { ExpressionCard, TermCard } from "@jargonslayer/core/types";

// BitCameo (v0.5.1 Bit sprint) is a sibling lane's named export on
// PixelDragon.tsx, possibly not landed yet on disk — stubbed here so
// this suite is self-contained either way (per the task spec).
vi.mock("@/components/PixelDragon", () => ({
  BitCameo: (props: { pose?: string; costume?: string | null }) => (
    <div
      data-testid="bit-cameo-stub"
      data-pose={props.pose}
      data-costume={props.costume ?? ""}
    />
  ),
}));

import CardsPanel from "../CardsPanel";

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

// Captured at module-eval time (before any test overrides them) so
// afterEach can restore the real store actions — same posture as
// store.test.ts spying on storageModule, applied here to the store's
// OWN action slots instead of an imported module.
const REAL_UPDATE_CARD = useApp.getState().updateCard;
const REAL_UPDATE_TERM = useApp.getState().updateTerm;

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)!.set!;
const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype,
  "value",
)!.set!;
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  if (el instanceof HTMLTextAreaElement) {
    nativeTextareaValueSetter.call(el, value);
  } else {
    nativeInputValueSetter.call(el, value);
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("CardsPanel — v0.5 Wave-1 Feature 7 inline card/term edit", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  function render() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  function findButton(text: string): HTMLButtonElement | null {
    return (
      Array.from(container!.querySelectorAll("button")).find(
        (b) => b.textContent === text,
      ) ?? null
    );
  }

  function inputByLabel(label: string): HTMLInputElement | HTMLTextAreaElement {
    const el = container!.querySelector(`[aria-label="${label}"]`);
    if (!el) throw new Error(`no input labelled ${label}`);
    return el as HTMLInputElement | HTMLTextAreaElement;
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
    useApp.setState({
      cards: [],
      terms: [],
      status: "idle",
      focusCardId: null,
      updateCard: REAL_UPDATE_CARD,
      updateTerm: REAL_UPDATE_TERM,
    });
  });

  describe("ExpressionCardRow", () => {
    it("shows no 编辑 affordance while listening (live meetings show none at all)", async () => {
      useApp.setState({ cards: [makeCard()], terms: [], status: "listening" });
      render();
      await act(async () => {
        root!.render(<CardsPanel />);
      });

      expect(findButton("编辑")).toBeNull();
    });

    it("shows 编辑 once the session is stopped", async () => {
      useApp.setState({ cards: [makeCard()], terms: [], status: "stopped" });
      render();
      await act(async () => {
        root!.render(<CardsPanel />);
      });

      expect(findButton("编辑")).not.toBeNull();
    });

    it("保存 calls updateCard with ONLY the changed field", async () => {
      const updateCardSpy = vi.fn();
      useApp.setState({
        cards: [makeCard()],
        terms: [],
        status: "stopped",
        updateCard: updateCardSpy,
      });
      render();
      await act(async () => {
        root!.render(<CardsPanel />);
      });

      await act(async () => {
        findButton("编辑")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await act(async () => {
        typeInto(inputByLabel("直白说法"), "come back later");
      });
      await act(async () => {
        findButton("保存")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(updateCardSpy).toHaveBeenCalledTimes(1);
      expect(updateCardSpy).toHaveBeenCalledWith("c1", {
        plain_english: "come back later",
      });
    });

    // ITEM 5 (fix round, Sol, MEDIUM): 语境释义 (card.meaning) was
    // displayed but had no editable counterpart — extends the above
    // "ONLY the changed fields" pin to cover it alongside a second
    // changed field, proving the multi-field diff still sends exactly
    // what changed (not the whole draft).
    it("保存 also covers 语境释义 (meaning) — still ONLY the changed fields when multiple change", async () => {
      const updateCardSpy = vi.fn();
      useApp.setState({
        cards: [makeCard()],
        terms: [],
        status: "stopped",
        updateCard: updateCardSpy,
      });
      render();
      await act(async () => {
        root!.render(<CardsPanel />);
      });

      await act(async () => {
        findButton("编辑")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await act(async () => {
        typeInto(inputByLabel("语境释义"), "go back to this topic later");
      });
      await act(async () => {
        typeInto(inputByLabel("直白说法"), "come back later");
      });
      await act(async () => {
        findButton("保存")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(updateCardSpy).toHaveBeenCalledTimes(1);
      expect(updateCardSpy).toHaveBeenCalledWith("c1", {
        meaning: "go back to this topic later",
        plain_english: "come back later",
      });
    });

    it("取消 discards the draft: no updateCard call, original text stays", async () => {
      const updateCardSpy = vi.fn();
      useApp.setState({
        cards: [makeCard()],
        terms: [],
        status: "stopped",
        updateCard: updateCardSpy,
      });
      render();
      await act(async () => {
        root!.render(<CardsPanel />);
      });

      await act(async () => {
        findButton("编辑")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await act(async () => {
        typeInto(inputByLabel("直白说法"), "should not be saved");
      });
      await act(async () => {
        findButton("取消")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(updateCardSpy).not.toHaveBeenCalled();
      expect(container!.querySelector('[aria-label="直白说法"]')).toBeNull();
      expect(container!.textContent).toContain("come back to this later");
    });
  });

  describe("TermCardRow", () => {
    it("shows no 编辑 affordance while listening (live meetings show none at all)", async () => {
      useApp.setState({ cards: [], terms: [makeTerm()], status: "listening" });
      render();
      await act(async () => {
        root!.render(<CardsPanel />);
      });

      expect(findButton("编辑")).toBeNull();
    });

    it("shows 编辑 once the session is stopped", async () => {
      useApp.setState({ cards: [], terms: [makeTerm()], status: "stopped" });
      render();
      await act(async () => {
        root!.render(<CardsPanel />);
      });

      expect(findButton("编辑")).not.toBeNull();
    });

    it("保存 calls updateTerm with ONLY the changed field", async () => {
      const updateTermSpy = vi.fn();
      useApp.setState({
        cards: [],
        terms: [makeTerm()],
        status: "stopped",
        updateTerm: updateTermSpy,
      });
      render();
      await act(async () => {
        root!.render(<CardsPanel />);
      });

      await act(async () => {
        findButton("编辑")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await act(async () => {
        typeInto(inputByLabel("英文释义"), "Net Recurring Revenue");
      });
      await act(async () => {
        findButton("保存")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(updateTermSpy).toHaveBeenCalledTimes(1);
      expect(updateTermSpy).toHaveBeenCalledWith("t1", {
        gloss_en: "Net Recurring Revenue",
      });
    });

    it("取消 discards the draft: no updateTerm call, original text stays", async () => {
      const updateTermSpy = vi.fn();
      useApp.setState({
        cards: [],
        terms: [makeTerm()],
        status: "stopped",
        updateTerm: updateTermSpy,
      });
      render();
      await act(async () => {
        root!.render(<CardsPanel />);
      });

      await act(async () => {
        findButton("编辑")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await act(async () => {
        typeInto(inputByLabel("英文释义"), "should not be saved");
      });
      await act(async () => {
        findButton("取消")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(updateTermSpy).not.toHaveBeenCalled();
      expect(container!.querySelector('[aria-label="英文释义"]')).toBeNull();
      expect(container!.textContent).toContain("Annual Recurring Revenue");
    });
  });

  describe("EmptyState — Bit cameo (v0.5.1 Bit sprint, Lane B)", () => {
    it("renders the sleep-pose BitCameo above the 还没有开始会议 copy, costume resolved from settings", async () => {
      useApp.setState({
        cards: [],
        terms: [],
        status: "idle",
        settings: { ...useApp.getState().settings, bitCostume: "auto", themeId: "shuimo" },
      });
      render();
      await act(async () => {
        root!.render(<CardsPanel />);
      });

      const cameo = container!.querySelector('[data-testid="bit-cameo-stub"]');
      expect(cameo).not.toBeNull();
      expect(cameo!.getAttribute("data-pose")).toBe("sleep");
      // themeId "shuimo" + bitCostume "auto" resolves via THEME_COSTUME
      // (bitCostumes.ts) to "douli" — proves the store values actually
      // thread through resolveBitCostume into the rendered cameo.
      expect(cameo!.getAttribute("data-costume")).toBe("douli");
      expect(container!.textContent).toContain("还没有开始会议");
    });
  });
});
