// @vitest-environment jsdom
//
// FloatingCaption — the ONE shared presentational view for S14's
// floating live caption (both hosts, see lib/captionWindow.ts's own
// header comment, portal it into a PiP window / a shrunk desktop
// window). Mirrors StatusLine.test.tsx's createRoot/act pattern (no
// @testing-library/react in this repo's test stack).

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "@/lib/store";
import type { ExpressionCard, TermCard, TranscriptSegment } from "@jargonslayer/core/types";
import FloatingCaption, { mostRecentGlossLine, tailText } from "../FloatingCaption";

function makeSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "seg-1",
    index: 0,
    startedAt: 1000,
    endedAt: 1100,
    text: "hello",
    engine: "whisper",
    ...overrides,
  };
}

function makeCard(overrides: Partial<ExpressionCard> = {}): ExpressionCard {
  return {
    id: "c1",
    expression: "circle back",
    category: "phrase",
    meaning: "revisit later",
    chinese_explanation: "回头再聊",
    plain_english: "discuss again later",
    tone: "neutral",
    confidence: 0.9,
    source_sentence: "Let's circle back on this later.",
    normKey: "circle back",
    firstSeenAt: 1000,
    lastSeenAt: 1000,
    count: 1,
    source: "llm",
    ...overrides,
  };
}

function makeTerm(overrides: Partial<TermCard> = {}): TermCard {
  return {
    id: "t1",
    term: "KPI",
    type: "metric",
    gloss_en: "Key Performance Indicator",
    gloss_zh: "关键绩效指标",
    normKey: "KPI",
    firstSeenAt: 1000,
    lastSeenAt: 1000,
    count: 1,
    source: "llm",
    ...overrides,
  };
}

describe("tailText — pure tail-truncation", () => {
  it("returns the text unchanged when it already fits", () => {
    expect(tailText("hello world", 20)).toBe("hello world");
  });

  it("trims from the FRONT, keeping the tail, prefixed with an ellipsis", () => {
    expect(tailText("the quick brown fox jumps", 9)).toBe("…fox jumps");
  });

  it("trims surrounding whitespace before measuring", () => {
    expect(tailText("  hello  ", 20)).toBe("hello");
  });
});

describe("mostRecentGlossLine — pure most-recent-across-both-kinds pick", () => {
  it("null when there is nothing to show", () => {
    expect(mostRecentGlossLine([], [])).toBeNull();
  });

  it("formats as 'surface — gloss'", () => {
    expect(mostRecentGlossLine([makeCard()], [])).toBe("circle back — 回头再聊");
  });

  it("picks the newer of a card vs. a term by lastSeenAt, regardless of kind", () => {
    const card = makeCard({ lastSeenAt: 1000 });
    const term = makeTerm({ lastSeenAt: 2000 });
    expect(mostRecentGlossLine([card], [term])).toBe("KPI — 关键绩效指标");

    const newerCard = makeCard({ lastSeenAt: 3000 });
    expect(mostRecentGlossLine([newerCard], [term])).toBe("circle back — 回头再聊");
  });
});

describe("FloatingCaption — render smoke", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  function resetStore() {
    useApp.setState({ segments: [], interim: null, cards: [], terms: [] });
  }

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    resetStore();
    vi.unstubAllGlobals();
  });

  async function renderCaption(onClose = () => {}) {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<FloatingCaption onClose={onClose} />);
    });
  }

  it("idle/no content: shows the waiting placeholder, nothing else", async () => {
    resetStore();
    await renderCaption();

    expect(container!.textContent).toContain("等待字幕…");
  });

  it("shows the final segment's tail, the interim line, and the most recent gloss — no placeholder", async () => {
    useApp.setState({
      segments: [makeSegment({ id: "a", text: "we should circle back on this" })],
      interim: { text: "let's touch base tomorrow" },
      cards: [makeCard()],
      terms: [],
    });
    await renderCaption();

    expect(container!.textContent).toContain("we should circle back on this");
    expect(container!.textContent).toContain("let's touch base tomorrow");
    expect(container!.textContent).toContain("circle back — 回头再聊");
    expect(container!.textContent).not.toContain("等待字幕…");
  });

  it("shows only the gloss line when there is no transcript yet (e.g. a custom-dictionary hit before any segment renders)", async () => {
    useApp.setState({ segments: [], interim: null, cards: [], terms: [makeTerm()] });
    await renderCaption();

    expect(container!.textContent).toContain("KPI — 关键绩效指标");
    expect(container!.textContent).not.toContain("等待字幕…");
  });

  it("root carries data-tauri-drag-region=\"deep\" (subtree drag — the ✕ button is auto-excluded by Tauri's own drag script, see lib/captionWindow.ts's doc)", async () => {
    await renderCaption();

    const root = container!.querySelector('[data-testid="floating-caption"]');
    expect(root!.getAttribute("data-tauri-drag-region")).toBe("deep");
  });

  it("clicking the close button fires onClose", async () => {
    const onClose = vi.fn();
    await renderCaption(onClose);

    const closeBtn = container!.querySelector('[data-testid="floating-caption-close"]');
    expect(closeBtn).not.toBeNull();

    await act(async () => {
      closeBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
