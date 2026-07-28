// @vitest-environment jsdom
//
// Bit mascot behavior train (chamber B): BitCelebrationOverlay owns its
// OWN mount/unmount lifecycle keyed off store.bitCelebrateNonce — unlike
// PixelDragon's internal `celebrating` render-override on an
// already-mounted instance (see PixelDragon.test.tsx's own celebration
// describe block), this component mounts a PixelDragon instance only
// while the celebration plays, and only when status === "stopped".
// createRoot/act + fake timers, mirroring PixelDragon.test.tsx's own
// celebration coverage.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "@/lib/store";
import { CELEBRATE_MS } from "@/components/PixelDragon";
import BitCelebrationOverlay from "../BitCelebrationOverlay";

// jsdom has no matchMedia — PixelDragon's prefers-reduced-motion hook
// (and this component's own reduced-motion gate) call it unconditionally
// (same gap StatusLine.test.tsx/PixelDragon.test.tsx already document).
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

function setActEnv(): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

describe("BitCelebrationOverlay — mounts on bitCelebrateNonce bump, only while stopped", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    setActEnv();
    stubMatchMedia(false);
    vi.useFakeTimers();
    useApp.setState({ bitCelebrateNonce: 0, status: "idle" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    vi.unstubAllGlobals();
    vi.useRealTimers();
    useApp.setState({ bitCelebrateNonce: 0, status: "idle" });
  });

  function overlay(): Element | null {
    return container!.querySelector('[data-testid="bit-celebration-overlay"]');
  }

  it("renders nothing on mount, even with an already-nonzero nonce", async () => {
    useApp.setState({ bitCelebrateNonce: 5, status: "stopped" });
    await act(async () => {
      root!.render(<BitCelebrationOverlay />);
    });
    expect(overlay()).toBeNull();
  });

  it("mounts on a nonce bump while stopped, then auto-dismisses after CELEBRATE_MS", async () => {
    useApp.setState({ status: "stopped" });
    await act(async () => {
      root!.render(<BitCelebrationOverlay />);
    });
    expect(overlay()).toBeNull();

    await act(async () => {
      useApp.getState().celebrateBit();
    });
    expect(overlay()).not.toBeNull();
    // F1 (bit-train fix round): the overlay mounting isn't enough on its
    // own — PixelDragon.tsx's own celebrating-state render override
    // (`.bit-hop`, applied to the awake body group only while
    // `celebrating` is true) must actually be playing inside it, not a
    // static folded dragon that never saw its own nonce delta.
    expect(overlay()!.querySelector(".bit-hop")).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CELEBRATE_MS + 50);
    });
    expect(overlay()).toBeNull();
  });

  it("F2: unmounts immediately when status leaves stopped, before the auto-dismiss timer expires", async () => {
    useApp.setState({ status: "stopped" });
    await act(async () => {
      root!.render(<BitCelebrationOverlay />);
    });

    await act(async () => {
      useApp.getState().celebrateBit();
    });
    expect(overlay()).not.toBeNull();

    // Interrupt halfway through the auto-dismiss window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CELEBRATE_MS / 2);
      useApp.setState({ status: "connecting" });
    });
    expect(overlay()).toBeNull();

    // Sol r2/r3: a generic clearTimeout spy can be satisfied by
    // PixelDragon's own unmount cleanup, so prove the clearing
    // BEHAVIORALLY instead: start a SECOND celebration, then cross the
    // first timer's original deadline — a stale (uncleared) timer would
    // fire there and kill the second celebration early.
    await act(async () => {
      useApp.setState({ status: "stopped" });
      useApp.getState().celebrateBit();
    });
    expect(overlay()).not.toBeNull();

    await act(async () => {
      // Just past the FIRST timer's deadline (armed at t=0, we are at
      // t=CELEBRATE_MS/2; advance CELEBRATE_MS/2 + 50ms).
      await vi.advanceTimersByTimeAsync(CELEBRATE_MS / 2 + 50);
    });
    expect(overlay()).not.toBeNull(); // stale timer must be dead

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CELEBRATE_MS);
    });
    expect(overlay()).toBeNull(); // second celebration's own timer works
  });

  it("never mounts while a meeting is live (listening) — celebrations only fire post-meeting", async () => {
    useApp.setState({ status: "listening" });
    await act(async () => {
      root!.render(<BitCelebrationOverlay />);
    });

    await act(async () => {
      useApp.getState().celebrateBit();
    });
    expect(overlay()).toBeNull();
  });

  it("respects prefers-reduced-motion — never mounts the overlay", async () => {
    stubMatchMedia(true);
    useApp.setState({ status: "stopped" });
    await act(async () => {
      root!.render(<BitCelebrationOverlay />);
    });

    await act(async () => {
      useApp.getState().celebrateBit();
    });
    expect(overlay()).toBeNull();
  });
});
