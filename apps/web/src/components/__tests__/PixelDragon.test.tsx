// @vitest-environment jsdom
//
// v0.5.1 Bit sprint, Lane A: costume rendering, idle-life micro-anims
// (wing flutter + ember puff), the one-shot celebration overlay, and
// the static BitCameo export. createRoot/act + real zustand store
// (mirrors StatusLine.test.tsx's/DueReview.render.test.tsx's own
// createRoot/act pattern — no @testing-library/react in this repo's
// test stack). Costume-resolution tests seed the REAL store via
// setState, same posture as CardsPanel.test.tsx's own bitCostume test
// for the sibling EmptyState cameo.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "../../lib/store";
import { BURST_MS } from "../../lib/pixelDragon";
import PixelDragon, { BitCameo, CELEBRATE_MS } from "../PixelDragon";

// jsdom has no matchMedia — PixelDragon's prefers-reduced-motion hook
// calls it unconditionally on every mount (same gap StatusLine.test.tsx's
// own identical stub already documents).
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

describe("PixelDragon — costume rendering (resolveBitCostume threaded through)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    setActEnv();
    stubMatchMedia(false);
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
    useApp.setState((s) => ({
      settings: { ...s.settings, bitCostume: "auto", themeId: "terminal" },
      status: "idle",
    }));
  });

  it("themeId grimoire + bitCostume auto renders the wizard hat's gilt band", async () => {
    useApp.setState((s) => ({
      settings: { ...s.settings, bitCostume: "auto", themeId: "grimoire" },
    }));
    await act(async () => {
      root!.render(<PixelDragon />);
    });
    // wizard's awake gilt band/star: [5,5,7,1,GILT] / [8,3,1,1,GILT] —
    // GILT="#e0bc4a", not used anywhere in the base dragon geometry.
    expect(container!.querySelectorAll('rect[fill="#e0bc4a"]').length).toBeGreaterThan(0);
  });

  it("bitCostume none renders no costume layer regardless of theme", async () => {
    useApp.setState((s) => ({
      settings: { ...s.settings, bitCostume: "none", themeId: "grimoire" },
    }));
    await act(async () => {
      root!.render(<PixelDragon />);
    });
    expect(container!.querySelectorAll('rect[fill="#e0bc4a"]').length).toBe(0);
  });

  it("a manual costume override wins over the theme's auto costume", async () => {
    useApp.setState((s) => ({
      settings: { ...s.settings, bitCostume: "hero", themeId: "grimoire" },
    }));
    await act(async () => {
      root!.render(<PixelDragon />);
    });
    // no wizard gilt...
    expect(container!.querySelectorAll('rect[fill="#e0bc4a"]').length).toBe(0);
    // ...hero's headband RED="#e7484c" instead.
    expect(container!.querySelectorAll('rect[fill="#e7484c"]').length).toBeGreaterThan(0);
  });
});

describe("PixelDragon — idle life (wing flutter + ember puff)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

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
    useApp.setState({ status: "idle" });
  });

  it("renders the wing-flutter cross-fade + ember markup while idle with motion allowed", async () => {
    setActEnv();
    stubMatchMedia(false);
    useApp.setState({ status: "idle" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<PixelDragon />);
    });

    expect(container!.querySelector(".bit-wing-folded")).not.toBeNull();
    expect(container!.querySelector(".bit-wing-raised")).not.toBeNull();
    expect(container!.querySelector(".bit-ember")).not.toBeNull();
  });

  it("omits the flutter + ember markup under prefers-reduced-motion", async () => {
    setActEnv();
    stubMatchMedia(true);
    useApp.setState({ status: "idle" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<PixelDragon />);
    });

    expect(container!.querySelector(".bit-wing-folded")).toBeNull();
    expect(container!.querySelector(".bit-wing-raised")).toBeNull();
    expect(container!.querySelector(".bit-ember")).toBeNull();
  });
});

describe("PixelDragon — celebration (bitCelebrateNonce)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    setActEnv();
    stubMatchMedia(false);
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
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

  it("does not celebrate on mount, even though the nonce is already non-zero", async () => {
    useApp.setState({ bitCelebrateNonce: 5 });
    await act(async () => {
      root!.render(<PixelDragon />);
    });
    expect(container!.querySelector(".bit-hop")).toBeNull();
  });

  it("plays a one-shot celebration on nonce increment, then self-restores", async () => {
    await act(async () => {
      root!.render(<PixelDragon />);
    });
    expect(container!.querySelector(".bit-hop")).toBeNull();

    await act(async () => {
      useApp.getState().celebrateBit();
    });
    expect(container!.querySelector(".bit-hop")).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CELEBRATE_MS + 50);
    });
    expect(container!.querySelector(".bit-hop")).toBeNull();
  });

  // F5 LOW, accept-document (v0.5.1 Bit sprint fix round): two
  // celebrateBit() calls batched into the SAME React snapshot (React
  // 18's automatic batching — no await between them here) present as
  // ONE nonce jump of +2, not two separate +1 renders; the celebration
  // effect only ever reacts to "did the snapshot's nonce grow", so this
  // coalesces into exactly one celebration sequence. This is ACCEPTED,
  // deliberate behavior (two simultaneous "just finished a review"
  // moments playing one combined celebration is correct UX — nobody
  // wants two overlapping hops) — pinned here, not treated as a bug.
  it("two celebrateBit() calls batched into one render coalesce into exactly one celebration sequence", async () => {
    await act(async () => {
      root!.render(<PixelDragon />);
    });
    expect(container!.querySelector(".bit-hop")).toBeNull();

    await act(async () => {
      useApp.getState().celebrateBit();
      useApp.getState().celebrateBit();
    });
    // the store really did jump by 2 in one snapshot...
    expect(useApp.getState().bitCelebrateNonce).toBe(2);
    // ...but exactly ONE celebration sequence is playing, not two
    // stacked/queued instances.
    expect(container!.querySelectorAll(".bit-hop").length).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CELEBRATE_MS + 50);
    });
    expect(container!.querySelector(".bit-hop")).toBeNull();

    // No second celebration was queued behind the first — a further
    // full CELEBRATE_MS window confirms nothing re-triggers on its own.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CELEBRATE_MS + 50);
    });
    expect(container!.querySelector(".bit-hop")).toBeNull();
  });

  it("celebrating mid-listening pauses the signal meter, then self-restores it (must not fight a live session)", async () => {
    useApp.setState({ status: "listening" });
    await act(async () => {
      root!.render(<PixelDragon />);
    });
    expect(container!.querySelector(".bit-signal")).not.toBeNull();

    await act(async () => {
      useApp.getState().celebrateBit();
    });
    // celebrating throws WINGS_SPREAD open — the listening signal meter
    // (sized to WINGS_RAISED) pauses rather than misaligning on top of it.
    expect(container!.querySelector(".bit-signal")).toBeNull();
    expect(container!.querySelector(".bit-hop")).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CELEBRATE_MS + 50);
    });
    // still listening under the hood the whole time (status never
    // changed) — the signal meter resumes on its own.
    expect(container!.querySelector(".bit-signal")).not.toBeNull();
    expect(container!.querySelector(".bit-hop")).toBeNull();
  });
});

describe("PixelDragon — burst/celebration particle isolation (F4, v0.5.1 Bit sprint fix round)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    setActEnv();
    stubMatchMedia(false);
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    useApp.setState({ status: "idle", cards: [], terms: [], bitCelebrateNonce: 0 });
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
    useApp.setState({ status: "idle", cards: [], terms: [], bitCelebrateNonce: 0 });
  });

  function sparkCount(): number {
    return container!.querySelectorAll("rect.bit-spark").length;
  }

  async function fireBurst(): Promise<void> {
    // a card-count increase is what the component's own cardCount effect
    // watches to dispatch cardIncrease (the burst pose trigger) — no
    // internal helper is exposed, so this drives it the same way the
    // real app does (a new card landing).
    await act(async () => {
      useApp.setState((s) => ({ cards: [...s.cards, {} as never] }));
    });
  }

  // Both effects used to own ONE shared `particles` state and each
  // cleared it WHOLESALE on its own timeout — a celebration starting
  // near a burst's end had its sparks deleted the moment the burst's
  // own (much shorter, 600ms) timer fired. The fix's discriminator: if
  // the burst's own timeout wipes the celebration's sparks too,
  // sparkCount() reads back exactly 0 right after — regardless of the
  // seed-dependent exact counts either source generates.
  it("a celebration started mid-burst survives the burst's own BURST_MS timeout firing", async () => {
    await act(async () => {
      root!.render(<PixelDragon />);
    });

    await fireBurst();
    expect(sparkCount()).toBeGreaterThan(0);

    // celebrate well before the burst's own 600ms timer elapses
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BURST_MS - 200);
    });
    await act(async () => {
      useApp.getState().celebrateBit();
    });
    expect(container!.querySelector(".bit-hop")).not.toBeNull();

    // cross the burst's own BURST_MS deadline (total elapsed since burst
    // start is now 600+50ms) while staying well under the celebration's
    // own CELEBRATE_MS=2500ms budget (only 250ms of it has elapsed).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(container!.querySelector(".bit-hop")).not.toBeNull(); // still celebrating
    expect(sparkCount()).toBeGreaterThan(0); // celebration sparks survived
  });

  // The reverse order: celebration starts first, a burst fires mid-
  // celebration, and the BURST's own (shorter) timeout is what fires
  // first — must not wipe the celebration's already-longer-running
  // sparks either.
  it("a burst fired mid-celebration is cleared by its own timeout without touching the celebration's sparks", async () => {
    await act(async () => {
      root!.render(<PixelDragon />);
    });

    await act(async () => {
      useApp.getState().celebrateBit();
    });
    expect(container!.querySelector(".bit-hop")).not.toBeNull();
    expect(sparkCount()).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await fireBurst();

    // cross the burst's own BURST_MS deadline (started at t=100, so
    // firing by t=100+BURST_MS) while staying well under the
    // celebration's own CELEBRATE_MS=2500ms budget (elapsed so far:
    // 100 + BURST_MS + 50 ≈ 750ms).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BURST_MS + 50);
    });
    expect(container!.querySelector(".bit-hop")).not.toBeNull(); // still celebrating
    expect(sparkCount()).toBeGreaterThan(0); // celebration sparks survived
  });
});

describe("BitCameo — static preview render", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  async function mount(el: React.ReactElement): Promise<void> {
    setActEnv();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(el);
    });
  }

  it("renders the sleep pose (with its zzz aura) and no costume layer by default", async () => {
    await mount(<BitCameo pose="sleep" />);
    expect(container!.querySelector("svg")).not.toBeNull();
    expect(container!.querySelector(".bit-zzz")).not.toBeNull();
    expect(container!.querySelectorAll('rect[fill="#e0bc4a"]').length).toBe(0);
  });

  it("renders the awake pose with a costume's awake layer on top", async () => {
    await mount(<BitCameo pose="awake" costume="hero" />);
    expect(container!.querySelector(".bit-sway")).not.toBeNull();
    expect(container!.querySelectorAll('rect[fill="#e7484c"]').length).toBeGreaterThan(0);
  });

  it("renders the sleep pose with that costume's own sleep layer", async () => {
    await mount(<BitCameo pose="sleep" costume="wizard" />);
    expect(container!.querySelectorAll('rect[fill="#e0bc4a"]').length).toBeGreaterThan(0);
  });

  it("omits any costume layer when costume is explicitly null", async () => {
    await mount(<BitCameo pose="awake" costume={null} />);
    expect(container!.querySelectorAll('rect[fill="#e7484c"]').length).toBe(0);
  });
});
