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
vi.mock("@/components/review/ReviewDashboard", () => ({
  __esModule: true,
  default: () => null,
  useSessionCache: () => ({ cache: EMPTY_CACHE, loading: false }),
}));
vi.mock("@/components/review/PracticeDeck", () => ({
  __esModule: true,
  default: () => null,
}));
// DueReview stub captures the onQueueEmptied prop so the test can
// invoke it exactly the way the real component would on a queue-
// emptying grade.
let capturedOnQueueEmptied: (() => void) | undefined;
vi.mock("@/components/review/DueReview", () => ({
  __esModule: true,
  default: ({ onQueueEmptied }: { onQueueEmptied?: () => void }) => {
    capturedOnQueueEmptied = onQueueEmptied;
    return null;
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
});
