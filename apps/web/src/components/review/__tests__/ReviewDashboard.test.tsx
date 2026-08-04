// @vitest-environment jsdom
//
// UI polish train (L5): ReviewDashboard IA reorder (the review action —
// due count + start-review CTA — leads, ahead of the stat tiles) and the
// .skeleton/.stat-numeral primitives it now consumes. createRoot/act
// pattern, matching this repo's test stack (no @testing-library/react —
// see DueReview.render.test.tsx's comment).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    // jsdom has no scrollIntoView on elements — stubbed here (same
    // convention as CardStrip.test.tsx) for the F8 fallback-scroll test.
    Element.prototype.scrollIntoView = vi.fn();
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

  // F8 fix round (MEDIUM): the CTA used to be a bare getElementById(
  // "due-queue") scroll — inert once the caller (app/review/page.tsx)
  // had switched away from the 到期复习 tab, since DueReview (the only
  // element carrying that id) unmounts there. onStartReview, when
  // supplied, now takes over entirely.
  it("F8: calls onStartReview when supplied, instead of the fallback scroll", async () => {
    const onStartReview = vi.fn();
    await act(async () => {
      root!.render(<ReviewDashboard cache={{}} loading={false} onStartReview={onStartReview} />);
    });

    const cta = container!.querySelector('[data-testid="start-review-cta"]') as HTMLButtonElement;
    await act(async () => {
      cta.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onStartReview).toHaveBeenCalledTimes(1);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  // Without a caller-supplied onStartReview (e.g. this file's OWN bare
  // render calls above), the CTA stays usable standalone — falls back
  // to the original #due-queue scroll rather than becoming a dead
  // button.
  it("F8: without onStartReview, falls back to scrolling the #due-queue element directly", async () => {
    const dueQueue = document.createElement("div");
    dueQueue.id = "due-queue";
    document.body.appendChild(dueQueue);

    await act(async () => {
      root!.render(<ReviewDashboard cache={{}} loading={false} />);
    });

    const cta = container!.querySelector('[data-testid="start-review-cta"]') as HTMLButtonElement;
    await act(async () => {
      cta.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(dueQueue.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    dueQueue.remove();
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

  it("all five stat tiles set their numerals in .stat-numeral (今日待复习 lives on ReviewLead alone)", async () => {
    await act(async () => {
      root!.render(<ReviewDashboard cache={{}} loading={false} />);
    });

    const stats = container!.querySelector('[data-testid="stats-strip"]');
    expect(stats!.querySelectorAll(".stat-numeral").length).toBe(5);
    expect(stats!.textContent).not.toContain("今日待复习");
  });

  it("renders static .skeleton placeholders (not the old 加载中… text) while the session cache is loading", async () => {
    await act(async () => {
      root!.render(<ReviewDashboard cache={{}} loading={true} />);
    });

    expect(container!.textContent).not.toContain("加载中");
    expect(container!.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });
});
