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

describe("/review page — Bit celebration wiring (v0.5.1 Bit sprint)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
});
