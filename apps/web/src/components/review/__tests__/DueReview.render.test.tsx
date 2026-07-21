// @vitest-environment jsdom
//
// F2 MEDIUM (codex review round 1): DueReview.test.ts already covers the
// pure hasPendingRelearn helper logic; this file covers the one
// rendering behavior that only shows up with an actually-mounted
// component — the queue memo re-evaluating "now" over time via the 30s
// tick (not just once per render off a stale [learnset, candidates] dep
// array). Mirrors TaskTray.test.tsx/HistoryDrawer.test.tsx's
// createRoot/act pattern (no @testing-library/react in this repo's test
// stack).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import DueReview from "../DueReview";
import { useApp } from "@/lib/store";
import { clearLearnset } from "@/lib/learn/store";
import { RELEARN_STEP_MS } from "@jargonslayer/core/learn/srs";
import type { LearnRecord } from "@jargonslayer/core/learn/types";

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
    dueAt: 5_000, // already due at the t0=10_000 system time used below
    lapses: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("DueReview — queue re-evaluates time while mounted (F2 MEDIUM)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    await clearLearnset();
    useApp.setState({
      cards: [],
      terms: [],
      customEntries: [],
      learnset: { "expression:circle back": dueRecord() },
      toast: null,
    });
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.remove();
    container = null;
    vi.useRealTimers();
  });

  function mount() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  it("card graded 0 empties the queue, then advancing fake timers past RELEARN_STEP_MS re-surfaces it with no further learnset change", async () => {
    mount();
    await act(async () => {
      root!.render(<DueReview cache={{}} />);
    });

    // Sanity: the due card is showing before any grading happens.
    expect(container!.textContent).toContain("circle back");

    const grade0Btn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "不认识",
    );
    expect(grade0Btn).toBeDefined();

    await act(async () => {
      grade0Btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0); // flush gradeReview's promise chain
    });

    // gradeReview (SM-2-lite lapse branch, srs.ts) steps dueAt forward
    // by RELEARN_STEP_MS from the grade's own `now` — confirms the
    // fixture actually exercised the real store action, not a manual
    // state poke.
    const graded = useApp.getState().learnset["expression:circle back"];
    expect(graded.intervalDays).toBe(0);
    expect(graded.dueAt).toBe(10_000 + RELEARN_STEP_MS);

    // Queue is empty right after grading — the relearn-step hint from
    // hasPendingRelearn (F5) should be showing too.
    expect(container!.textContent).toContain("今天没有待复习的词条");
    expect(container!.textContent).toContain("约 10 分钟后重新出现");
    expect(container!.textContent).not.toContain("circle back");

    // Advance past RELEARN_STEP_MS purely via wall-clock time (>=1 tick
    // of the component's own 30s interval crosses the dueAt threshold)
    // — no useApp.setState call anywhere below this line.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELEARN_STEP_MS + 30_000);
    });

    expect(container!.textContent).toContain("circle back");
    expect(container!.textContent).not.toContain("今天没有待复习的词条");
  });

  it("without the passage of time, the queue does NOT resurface the card on its own (control: the interval, not a spurious re-render, is what does it)", async () => {
    useApp.setState({
      learnset: {
        "expression:circle back": dueRecord({
          intervalDays: 0,
          dueAt: 10_000 + RELEARN_STEP_MS,
        }),
      },
    });
    mount();
    await act(async () => {
      root!.render(<DueReview cache={{}} />);
    });

    expect(container!.textContent).toContain("今天没有待复习的词条");

    // Well under the relearn step and under one 30s tick — nothing
    // should change.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(container!.textContent).toContain("今天没有待复习的词条");
    expect(container!.textContent).not.toContain("circle back");
  });

  // v0.5.1 Bit sprint: onQueueEmptied fires on the >0→0 transition a
  // grade causes — never on mounting an already-empty queue, and AGAIN
  // when a resurfaced relearn card is cleared a second time (per-
  // session, not a one-shot latch). Uses the same real grading UI as
  // the F2 tests above, so the transition is driven by the actual
  // gradeReview store write, not a synthetic state poke.
  it("onQueueEmptied fires once per queue-clearing grade, not on mount", async () => {
    const onQueueEmptied = vi.fn();
    mount();
    await act(async () => {
      root!.render(<DueReview cache={{}} onQueueEmptied={onQueueEmptied} />);
    });

    // Mount with a non-empty queue: no fire.
    expect(onQueueEmptied).not.toHaveBeenCalled();

    const grade0 = () =>
      Array.from(container!.querySelectorAll("button")).find(
        (b) => b.textContent === "不认识",
      )!;
    await act(async () => {
      grade0().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onQueueEmptied).toHaveBeenCalledTimes(1);

    // Relearn step elapses → the card resurfaces (0→1: still one call).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELEARN_STEP_MS + 30_000);
    });
    expect(onQueueEmptied).toHaveBeenCalledTimes(1);

    // Clearing it again fires again.
    await act(async () => {
      grade0().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onQueueEmptied).toHaveBeenCalledTimes(2);
  });

  it("onQueueEmptied does NOT fire when mounted with an already-empty queue", async () => {
    const onQueueEmptied = vi.fn();
    useApp.setState({ learnset: {} });
    mount();
    await act(async () => {
      root!.render(<DueReview cache={{}} onQueueEmptied={onQueueEmptied} />);
    });
    expect(container!.textContent).toContain("今天没有待复习的词条");
    expect(onQueueEmptied).not.toHaveBeenCalled();
  });

  // F3 MEDIUM (v0.5.1 Bit sprint fix round, GPT-5.6 Sol adversarial
  // review): the queue can empty WITHOUT a grade — an unenrolled
  // recent-meeting candidate falls out of composeReviewQueue's own
  // 7-day RECENT_MEETING_WINDOW_MS filter (packages/core learn/queue.ts)
  // once it ages out, and this component's 30s tick re-evaluates `now`
  // (see the F2 MEDIUM tests above), so a >0→0 transition can happen on
  // a tick alone. A learnset write from ANY other source (a suppression,
  // a cache refresh) is an equally ungraded route to the same
  // transition; `useApp.setState({ learnset: {} })` below stands in for
  // all of them without depending on wall-clock expiry math. Either way
  // must NOT count as "the user just finished a review".
  it("onQueueEmptied does NOT fire when the queue empties via a learnset change that isn't a grade (stand-in for 7-day candidate expiry)", async () => {
    const onQueueEmptied = vi.fn();
    mount();
    await act(async () => {
      root!.render(<DueReview cache={{}} onQueueEmptied={onQueueEmptied} />);
    });
    expect(container!.textContent).toContain("circle back");
    expect(onQueueEmptied).not.toHaveBeenCalled();

    // Queue empties, but NOT via gradeReview — e.g. the learnset record
    // aged out / got suppressed elsewhere, or (the real-world trigger)
    // an unenrolled recent candidate fell outside the 7-day window on a
    // tick. No grade preceded this, so no celebration.
    await act(async () => {
      useApp.setState({ learnset: {} });
    });
    expect(container!.textContent).toContain("今天没有待复习的词条");
    expect(onQueueEmptied).not.toHaveBeenCalled();
  });
});
