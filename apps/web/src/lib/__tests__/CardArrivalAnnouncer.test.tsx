// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { ExpressionCard } from "@jargonslayer/core/types";
import { useApp } from "../store";
import { CardArrivalAnnouncer } from "../a11y";

function makeCard(expression: string, id: string): ExpressionCard {
  return {
    id,
    normKey: expression.toLowerCase(),
    expression,
    category: "idiom",
    meaning: "",
    chinese_explanation: "",
    plain_english: "",
    tone: "",
    firstSeenAt: 1,
    lastSeenAt: 1,
    count: 1,
    source: "dictionary",
    confidence: 1,
    source_sentence: "",
  };
}

describe("CardArrivalAnnouncer", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.remove();
    container = null;
    useApp.setState({ cards: [] });
    vi.restoreAllMocks();
  });

  async function renderAnnouncer() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<CardArrivalAnnouncer />);
    });
  }

  it("renders a visually hidden polite live region", async () => {
    await renderAnnouncer();
    const region = container!.querySelector("[role='status']");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.className).toContain("sr-only");
  });

  it("announces the newest card headword when cards grow", async () => {
    await renderAnnouncer();
    await act(async () => {
      useApp.setState({ cards: [makeCard("touch base", "c1")] });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const region = container!.querySelector("[role='status']");
    expect(region?.textContent).toBe("新卡片：touch base");
  });
});
