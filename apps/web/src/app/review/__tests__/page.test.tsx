// @vitest-environment jsdom
//
// /review page — Bit celebration wiring (v0.5.1 Bit sprint). After the
// lead integration refactor the >0→0 queue-transition logic lives in
// DueReview itself (onQueueEmptied prop — see DueReview.test.tsx for
// the transition semantics); this page's whole job is wiring that
// callback to the store's celebrateBit nonce. createRoot/act pattern
// (no @testing-library/react in this repo's test stack).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "@/lib/store";

const EMPTY_CACHE = {};
// F8 fix round: ReviewDashboard stub captures onStartReview so the test
// can invoke it exactly the way the real CTA would.
let capturedOnStartReview: (() => void) | undefined;
vi.mock("@/components/review/ReviewDashboard", () => ({
  __esModule: true,
  default: ({ onStartReview }: { onStartReview?: () => void }) => {
    capturedOnStartReview = onStartReview;
    return null;
  },
  useSessionCache: () => ({ cache: EMPTY_CACHE, loading: false }),
}));
vi.mock("@/components/review/PracticeDeck", () => ({
  __esModule: true,
  default: () => null,
}));
// DueReview stub captures the onQueueEmptied prop so the test can
// invoke it exactly the way the real component would on a queue-
// emptying grade. F8 fix round: also renders id="due-queue" (the real
// DueReview carries that id on both of its own top-level returns — see
// its own comment) so a test can prove onStartReview's scroll target
// actually exists once this stub remounts.
let capturedOnQueueEmptied: (() => void) | undefined;
vi.mock("@/components/review/DueReview", () => ({
  __esModule: true,
  default: ({ onQueueEmptied }: { onQueueEmptied?: () => void }) => {
    capturedOnQueueEmptied = onQueueEmptied;
    return <div id="due-queue" data-testid="due-review-stub" />;
  },
}));
vi.mock("@/components/Toast", () => ({
  __esModule: true,
  default: () => null,
}));

import ReviewPage from "../page";

// jsdom has no matchMedia — PixelDragon's prefers-reduced-motion hook
// calls it unconditionally on every mount (same stub as
// PixelDragon.test.tsx's own). PixelDragon itself is deliberately NOT
// mocked in this file (unlike ReviewDashboard/PracticeDeck/DueReview/
// Toast above) — F1 (v0.5.1 Bit sprint fix round) mounts the real
// mascot on this route, so this stub now applies to every test here,
// not just the celebration-render one below.
function stubMatchMedia(matches = false): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

describe("/review page — Bit celebration wiring (v0.5.1 Bit sprint)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    stubMatchMedia(false);
    useApp.setState({ hydrated: true, bitCelebrateNonce: 0 });
    capturedOnQueueEmptied = undefined;
    capturedOnStartReview = undefined;
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
    vi.unstubAllGlobals();
    useApp.setState({ bitCelebrateNonce: 0 });
  });

  it("passes an onQueueEmptied handler to DueReview that bumps celebrateBit once per call", async () => {
    await act(async () => {
      root!.render(<ReviewPage />);
    });

    expect(capturedOnQueueEmptied).toBeTypeOf("function");
    // Mounting alone must not celebrate.
    expect(useApp.getState().bitCelebrateNonce).toBe(0);

    await act(async () => {
      capturedOnQueueEmptied!();
    });
    expect(useApp.getState().bitCelebrateNonce).toBe(1);

    // A second completed session celebrates again (nonce, not a latch).
    await act(async () => {
      capturedOnQueueEmptied!();
    });
    expect(useApp.getState().bitCelebrateNonce).toBe(2);
  });

  // F1 HIGH (v0.5.1 Bit sprint fix round, GPT-5.6 Sol adversarial
  // review): PixelDragon only ever mounted inside the main page's
  // StatusLine — this route bumped the nonce (proven above) with no
  // mounted mascot anywhere to render it, so a review-triggered
  // celebration was invisible. The test above only proves the STORE
  // wiring; this one renders the REAL PixelDragon (not mocked, unlike
  // its heavy siblings above) and asserts actual celebration markup —
  // the wings-spread + bit-hop layer — appears on THIS route.
  it("invoking onQueueEmptied renders a celebrating PixelDragon on the /review route", async () => {
    await act(async () => {
      root!.render(<ReviewPage />);
    });
    expect(container!.querySelector(".bit-hop")).toBeNull();

    await act(async () => {
      capturedOnQueueEmptied!();
    });
    expect(container!.querySelector(".bit-hop")).not.toBeNull();
  });

  // F8 fix round (MEDIUM): the 开始复习 CTA used to be a bare
  // getElementById("due-queue") scroll — inert once the user had
  // switched to 翻卡浏览, since DueReview (the only element carrying that
  // id) unmounts there. This page now owns the fix: onStartReview flips
  // `mode` back to "due" FIRST (so DueReview actually remounts), THEN
  // scrolls on the next animation frame. The rAF callback is captured
  // and invoked directly here instead of waiting on a real frame, for a
  // deterministic test.
  it("F8: onStartReview flips the mode tab back to 到期复习 and scrolls #due-queue once it remounts", async () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
    Element.prototype.scrollIntoView = vi.fn();

    await act(async () => {
      root!.render(<ReviewPage />);
    });

    const browseTab = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "翻卡浏览",
    ) as HTMLButtonElement;
    await act(async () => {
      browseTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // 翻卡浏览 active: DueReview (id="due-queue") is unmounted.
    expect(container!.querySelector("#due-queue")).toBeNull();
    expect(browseTab.className).toContain("bg-panel3");

    expect(capturedOnStartReview).toBeTypeOf("function");
    await act(async () => {
      capturedOnStartReview!();
    });

    // Mode flipped back to 到期复习 — DueReview stub (id="due-queue") is
    // mounted again, and the tab's own active styling follows it.
    expect(browseTab.className).not.toContain("bg-panel3");
    const dueQueue = container!.querySelector("#due-queue");
    expect(dueQueue).not.toBeNull();
    expect(rafSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      rafSpy.mock.calls[0][0](0);
    });

    expect(dueQueue!.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });

    rafSpy.mockRestore();
  });

  // TestFlight feedback (我的词典并入学习中心): GlossaryPanel moved off
  // the meeting screen onto this route's own top-level tab switcher.
  // GlossaryPanel is deliberately NOT mocked here (glossary.ts degrades
  // to in-memory/no-persist when indexedDB is undefined, same as this
  // jsdom test env) — this proves the real component mounts, not just
  // a stub.
  it("switches between the review flow and GlossaryPanel via the center tab", async () => {
    await act(async () => {
      root!.render(<ReviewPage />);
    });
    expect(container!.querySelector('[data-testid="glossary-panel"]')).toBeNull();

    await act(async () => {
      container!
        .querySelector('[data-testid="center-tab-glossary"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.querySelector('[data-testid="glossary-panel"]')).not.toBeNull();

    await act(async () => {
      container!
        .querySelector('[data-testid="center-tab-review"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.querySelector('[data-testid="glossary-panel"]')).toBeNull();
  });
});
