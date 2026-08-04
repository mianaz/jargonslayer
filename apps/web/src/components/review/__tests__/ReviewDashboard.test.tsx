// @vitest-environment jsdom
//
// UI polish train (L5): ReviewDashboard IA reorder (the review action —
// due count + start-review CTA — leads, ahead of the stat tiles) and the
// .skeleton/.stat-numeral primitives it now consumes. createRoot/act
// pattern, matching this repo's test stack (no @testing-library/react —
// see DueReview.render.test.tsx's comment).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import ReviewDashboard from "../ReviewDashboard";
import { useApp } from "@/lib/store";
import type { LearnRecord } from "@jargonslayer/core/learn/types";
import type { SessionMeta } from "@jargonslayer/core/types";

function dueRecord(overrides: Partial<LearnRecord> = {}): LearnRecord {
  return {
    learnKey: "expression:circle back",
    kind: "expression",
    surface: "circle back",
    familiarity: 0.5,
    suppressed: false,
    reps: 2,
    intervalDays: 5,
    ease: 2.5,
    dueAt: 0, // already due against any real Date.now()
    lapses: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function sessionMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    title: "Meeting",
    startedAt: 0,
    endedAt: 1000,
    segmentCount: 3,
    cardCount: 2,
    termCount: 1,
    hasSummary: false,
    ...overrides,
  };
}

describe("ReviewDashboard — IA reorder + skeleton/stat-numeral primitives (UI polish train)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    useApp.setState({
      sessions: [sessionMeta()],
      learnset: { "expression:circle back": dueRecord() },
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
    container?.remove();
    container = null;
    useApp.setState({ sessions: [], learnset: {} });
  });

  it("renders the start-review CTA before the stat tiles (review action leads)", async () => {
    await act(async () => {
      root!.render(<ReviewDashboard cache={{}} loading={false} />);
    });

    const cta = container!.querySelector('[data-testid="start-review-cta"]');
    const stats = container!.querySelector('[data-testid="stats-strip"]');
    expect(cta).not.toBeNull();
    expect(stats).not.toBeNull();
    // The stats grid must come AFTER the CTA in document order.
    expect(
      cta!.compareDocumentPosition(stats!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows today's due count on the leading block via .stat-numeral", async () => {
    await act(async () => {
      root!.render(<ReviewDashboard cache={{}} loading={false} />);
    });

    const lead = container!.querySelector('[data-testid="review-lead"]');
    expect(lead).not.toBeNull();
    const numeral = lead!.querySelector(".stat-numeral");
    expect(numeral).not.toBeNull();
    expect(numeral!.textContent).toBe("1");
  });

  it("all six stat tiles set their numerals in .stat-numeral", async () => {
    await act(async () => {
      root!.render(<ReviewDashboard cache={{}} loading={false} />);
    });

    const stats = container!.querySelector('[data-testid="stats-strip"]');
    expect(stats!.querySelectorAll(".stat-numeral").length).toBe(6);
  });

  it("renders static .skeleton placeholders (not the old 加载中… text) while the session cache is loading", async () => {
    await act(async () => {
      root!.render(<ReviewDashboard cache={{}} loading={true} />);
    });

    expect(container!.textContent).not.toContain("加载中");
    expect(container!.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });
});
