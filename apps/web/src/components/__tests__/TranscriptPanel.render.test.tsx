// @vitest-environment jsdom
//
// Render-perf regression test for the stt-vad-supervisor.md render
// split: with a realistic transcript (~200 segments) and a non-empty
// highlight matcher, one interim tick must re-commit InterimLine only
// — SegmentRow's memo must hold, i.e. its render function must not be
// invoked again at all.
//
// React.Profiler was tried first (per the design doc's instructions)
// but proved unworkable here: empirically, <Profiler>.onRender fires
// on every commit that touches its wrapped subtree REGARDLESS of a
// memoized child bailing out (Profiler itself isn't memoized, so React
// still "visits" it even when the child beneath it skips re-rendering)
// — it cannot distinguish "SegmentRow's memo held" from "SegmentRow
// re-rendered to an identical result". This test uses the sanctioned
// fallback instead: module-level render-commit counters exported from
// TranscriptPanel.tsx (renderCounters), incremented once per ACTUAL
// invocation of each component's render function — which a bailed
// memo() never triggers at all.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "../../lib/store";
import type { ExpressionCard, TermCard, TranscriptSegment } from "@jargonslayer/core/types";
import TranscriptPanel, {
  INTERIM_THROTTLE_MS,
  SCROLL_STICKY_THRESHOLD,
  TOUCH_LOOKUP_DEBOUNCE_MS,
  renderCounters,
} from "../TranscriptPanel";

const SEGMENT_COUNT = 200;
const HIGHLIGHT_TERM = "Kubernetes";

// jsdom has no matchMedia — TranscriptPanel's touch-selection action
// bar (S14.1 item 3) checks `(pointer: coarse)` on every mount, same
// jsdom gap StatusLine.test.tsx's own identical stub already documents
// (PixelDragon's reduced-motion hook). Every describe below needs this
// regardless of whether it specifically exercises the touch path —
// defaults to `matches: false` (fine/mouse pointer), the correct
// posture for every pre-existing (desktop-path) test in this file.
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

// jsdom's Range has no layout engine behind it and doesn't implement
// getBoundingClientRect at all (selectionLookupRequest calls it for
// both the desktop mouseup path and the touch action-bar path below) —
// a no-op zero rect is fine, no test asserts on the returned x/y.
// Patched once at module scope (not per-test): purely additive
// (nothing legitimate to preserve/restore), and each test file gets
// its own fresh jsdom globals under Vitest's default file isolation.
if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = function (): DOMRect {
    return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
}

function buildSegments(): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (let i = 0; i < SEGMENT_COUNT; i += 1) {
    out.push({
      id: `seg-${i}`,
      index: i,
      startedAt: 1_000_000 + i * 1000,
      endedAt: 1_000_500 + i * 1000,
      text: `This is segment number ${i} talking about ${HIGHLIGHT_TERM} clusters and deployments.`,
      engine: "demo",
    });
  }
  return out;
}

function buildTerms(): TermCard[] {
  const now = Date.now();
  const term: TermCard = {
    id: "term-1",
    term: HIGHLIGHT_TERM,
    type: "tech",
    gloss_en: "container orchestration platform",
    gloss_zh: "容器编排平台",
    normKey: HIGHLIGHT_TERM.toLowerCase(),
    firstSeenAt: now,
    lastSeenAt: now,
    count: SEGMENT_COUNT,
    source: "dictionary",
  };
  return [term];
}

const EMPTY_CARDS: ExpressionCard[] = [];

describe("TranscriptPanel render split", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => stubMatchMedia());

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
    // Reset the store's meeting-relevant slice so other test files in
    // this run (if any ever share the jsdom environment) start clean.
    useApp.setState({
      segments: [],
      cards: [],
      terms: [],
      interim: null,
      translations: {},
    });
  });

  it("one interim update re-commits InterimLine only; SegmentRow issues zero further commits", async () => {
    (
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    const segments = buildSegments();
    const terms = buildTerms();

    useApp.setState({
      segments,
      cards: EMPTY_CARDS,
      terms,
      interim: null,
      translations: {},
      status: "listening",
      focusMode: false,
    });

    // Sanity: the highlight matcher this seeds is genuinely non-empty
    // (matches HIGHLIGHT_TERM in every segment's text).
    expect(segments[0].text).toContain(HIGHLIGHT_TERM);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<TranscriptPanel />);
    });

    expect(renderCounters.segmentRow).toBe(SEGMENT_COUNT);
    // Baseline: measure ADDITIONAL commits from here.
    renderCounters.segmentRow = 0;
    renderCounters.interimLine = 0;

    await act(async () => {
      useApp.getState().setInterim({ text: "partial one" });
    });
    // Interim growth is throttled to ~8fps (INTERIM_THROTTLE_MS) —
    // wait past that window for the committed update.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 160));
    });

    expect(renderCounters.interimLine).toBeGreaterThanOrEqual(1);
    expect(renderCounters.segmentRow).toBe(0);

    // A second, larger interim tick (still one logical "update" from
    // the caller's perspective, post-throttle) must behave the same.
    renderCounters.interimLine = 0;
    await act(async () => {
      useApp.getState().setInterim({ text: "partial one two three" });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 160));
    });

    expect(renderCounters.interimLine).toBeGreaterThanOrEqual(1);
    expect(renderCounters.segmentRow).toBe(0);
  });

  // ---- 2026-07 VAD-supervisor review finding #8: matcher/handler
  // identity must survive a count-only cards/terms bump (the common
  // re-detection case) and only actually invalidate on a real
  // vocabulary change. ----

  it("finding #8: a count-only detection update (re-detecting an already-known term) triggers ZERO SegmentRow re-renders", async () => {
    (
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    const segments = buildSegments();
    const terms = buildTerms();

    useApp.setState({
      segments,
      cards: EMPTY_CARDS,
      terms,
      interim: null,
      translations: {},
      status: "listening",
      focusMode: false,
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<TranscriptPanel />);
    });
    expect(renderCounters.segmentRow).toBe(SEGMENT_COUNT);
    renderCounters.segmentRow = 0;

    // Same id/term/lastSeenAt (the matcher's ONLY inputs) — just a
    // re-detection count bump, and a NEW array/object reference (the
    // store's real update pattern), same as production would produce.
    const recountedTerms: TermCard[] = terms.map((t) => ({
      ...t,
      count: t.count + 1,
    }));
    await act(async () => {
      useApp.setState({ terms: recountedTerms });
    });

    expect(renderCounters.segmentRow).toBe(0);
  });

  it("finding #8: a genuine vocabulary change (new term text) re-renders every SegmentRow exactly once", async () => {
    (
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    const segments = buildSegments();
    const terms = buildTerms();

    useApp.setState({
      segments,
      cards: EMPTY_CARDS,
      terms,
      interim: null,
      translations: {},
      status: "listening",
      focusMode: false,
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<TranscriptPanel />);
    });
    expect(renderCounters.segmentRow).toBe(SEGMENT_COUNT);
    renderCounters.segmentRow = 0;

    // A DIFFERENT term surface — the matcher's actual output changes.
    const changedTerms: TermCard[] = terms.map((t) => ({
      ...t,
      term: "Docker",
      normKey: "docker",
    }));
    await act(async () => {
      useApp.setState({ terms: changedTerms });
    });

    expect(renderCounters.segmentRow).toBe(SEGMENT_COUNT);
  });
});

// ---- 2026-07 VAD-supervisor review finding #6: InterimLine's
// trailing-edge throttle must commit the LATEST value (not whatever
// was current when the pending timer was scheduled), and the
// auto-scroll decision it drives must read the CURRENT stickToBottom
// at fire time, not a stale one captured at schedule time. ----

describe("TranscriptPanel InterimLine throttle correctness", () => {
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
    useApp.setState({
      segments: [],
      cards: [],
      terms: [],
      interim: null,
      translations: {},
    });
  });

  function mount(): HTMLDivElement {
    (
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    stubMatchMedia();
    useApp.setState({
      segments: [],
      cards: EMPTY_CARDS,
      terms: [],
      interim: null,
      translations: {},
      status: "listening",
      focusMode: false,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    return container;
  }

  it("a burst of updates well within one throttle window commits the LATEST value, not the first", async () => {
    await act(async () => {
      mount();
      root!.render(<TranscriptPanel />);
    });

    // Three updates back-to-back (real time between them is a
    // fraction of a ms — nowhere near INTERIM_THROTTLE_MS): the FIRST
    // commits immediately (nothing pending yet), the second and third
    // land inside that same throttle window and must not install
    // competing timers — only the LATEST value may ever be committed.
    await act(async () => {
      useApp.getState().setInterim({ text: "a" });
    });
    await act(async () => {
      useApp.getState().setInterim({ text: "ab" });
    });
    await act(async () => {
      useApp.getState().setInterim({ text: "abc" });
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, INTERIM_THROTTLE_MS + 40));
    });

    const interimEl = container!.querySelector(".ts-body.italic");
    expect(interimEl?.textContent).toBe("abc");
  });

  it("scrolling up during the pending throttle window suppresses the auto-scroll snap-back, but the throttled value still commits", async () => {
    await act(async () => {
      mount();
      root!.render(<TranscriptPanel />);
    });

    const scrollEl = container!.querySelector(
      '[data-testid="transcript-panel"] > div',
    ) as HTMLDivElement;
    expect(scrollEl).toBeTruthy();
    Object.defineProperty(scrollEl, "scrollHeight", {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(scrollEl, "clientHeight", {
      value: 500,
      configurable: true,
    });

    // The mount-time effect (interim starts null) already stamped
    // lastCommitAtRef with "now", so this FIRST real update itself
    // lands inside a throttle window too — wait it out (stickToBottom
    // is still true by default) so the auto-scroll fires once,
    // snapping to the bottom, giving a known baseline to observe the
    // SECOND update's (suppressed) snap-back against.
    await act(async () => {
      useApp.getState().setInterim({ text: "first" });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, INTERIM_THROTTLE_MS + 40));
    });
    expect(scrollEl.scrollTop).toBe(1000);

    // Second update lands inside the throttle window — installs a
    // PENDING timer (not yet fired).
    await act(async () => {
      useApp.getState().setInterim({ text: "second" });
    });

    // The user scrolls up WHILE that timer is still pending — distance
    // from bottom now exceeds SCROLL_STICKY_THRESHOLD.
    await act(async () => {
      scrollEl.scrollTop = 10;
      scrollEl.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight).toBeGreaterThan(
      SCROLL_STICKY_THRESHOLD,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, INTERIM_THROTTLE_MS + 40));
    });

    // The pending commit DID fire (value staleness fix)...
    const interimEl = container!.querySelector(".ts-body.italic");
    expect(interimEl?.textContent).toBe("second");
    // ...but did NOT snap the scroll position back to the bottom
    // (scroll staleness fix) — a stale `stickToBottom=true` captured
    // when the timer was scheduled would have reset this to 1000.
    expect(scrollEl.scrollTop).toBe(10);
  });

  // Append-only transcript contract, round 3 fix #A3: a shrink (or any
  // revision that isn't a plain prefix-extension of what's displayed)
  // bypasses the throttle entirely, same as the interim===null path —
  // unlike ordinary GROWTH (the burst test above, which explicitly
  // waits INTERIM_THROTTLE_MS+40ms before asserting).
  it("a shrink (not a prefix-extension of what's displayed) commits immediately — no 125ms window showing the stale longer interim", async () => {
    await act(async () => {
      mount();
      root!.render(<TranscriptPanel />);
    });

    const interimEl = () => container!.querySelector(".ts-body.italic");

    // Establish a known "displayed" baseline — wait out the throttle
    // (same pattern as the scroll test above: the mount-time effect,
    // interim===null, already stamped lastCommitAtRef with "now", so
    // this FIRST real update is throttled too, not free).
    await act(async () => {
      useApp.getState().setInterim({ text: "hello there world" });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, INTERIM_THROTTLE_MS + 40));
    });
    expect(interimEl()?.textContent).toBe("hello there world");

    // A revision that SHRINKS ("hi" is not a prefix-extension of
    // "hello there world") — must commit immediately: no waiting, and
    // the stale longer text must never linger on screen.
    await act(async () => {
      useApp.getState().setInterim({ text: "hi" });
    });
    expect(interimEl()?.textContent).toBe("hi");
  });
});

// ---- E2E batch item 5: honest empty state gets an optional demo CTA
// (onDemo prop) — only rendered when the caller actually supplies one,
// so every pre-existing `<TranscriptPanel />` call site keeps working
// unchanged. ----

describe("TranscriptPanel — demo CTA in the empty state", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => stubMatchMedia());

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
    useApp.setState({ segments: [], status: "idle" });
  });

  it("renders btn-demo-empty when onDemo is supplied and fires it on click", async () => {
    (
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({ segments: [], status: "idle" });
    const onDemo = vi.fn();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<TranscriptPanel onDemo={onDemo} />);
    });

    const btn = container!.querySelector('[data-testid="btn-demo-empty"]');
    expect(btn).not.toBeNull();

    await act(async () => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDemo).toHaveBeenCalledTimes(1);
  });

  it("omits btn-demo-empty entirely when onDemo is not supplied", async () => {
    (
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({ segments: [], status: "idle" });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<TranscriptPanel />);
    });

    expect(container!.querySelector('[data-testid="btn-demo-empty"]')).toBeNull();
  });
});

// ---- S14.1 field fix, item 3: mobile Safari's native selection
// callout owns mouseup-equivalent gestures on touch, so LookupPopover
// needs a different trigger there — a debounced document.selectionchange
// listener + small fixed action bar, gated to coarse (touch) pointers,
// running through the SAME selectionLookupRequest → setLookup flow the
// desktop mouseup handler uses (see TranscriptPanel.tsx). ----

describe("TranscriptPanel — touch selection action bar (S14.1 item 3)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const SEGMENT_TEXT = "Let's discuss the Kubernetes rollout plan for next quarter.";
  const SELECT_SUBSTR = "Kubernetes rollout plan";

  function selectSubstring(): void {
    const tsBody = container!.querySelector(".ts-body") as HTMLElement;
    const textNode = tsBody.firstChild as Text;
    const start = SEGMENT_TEXT.indexOf(SELECT_SUBSTR);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + SELECT_SUBSTR.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function collapseSelection(): void {
    window.getSelection()?.removeAllRanges();
  }

  // selectionchange itself is debounced (TOUCH_LOOKUP_DEBOUNCE_MS) —
  // waits it out for real, same "await a real setTimeout inside act()"
  // pattern the InterimLine throttle describe block above already uses.
  async function fireSelectionChangeAndWaitDebounce(): Promise<void> {
    document.dispatchEvent(new Event("selectionchange"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, TOUCH_LOOKUP_DEBOUNCE_MS + 60));
    });
  }

  function mount(coarsePointer: boolean): void {
    (
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    stubMatchMedia(coarsePointer);
    useApp.setState({
      segments: [
        {
          id: "seg-1",
          index: 0,
          startedAt: 1000,
          endedAt: 2000,
          text: SEGMENT_TEXT,
          engine: "demo",
        },
      ],
      cards: [],
      terms: [],
      interim: null,
      translations: {},
      status: "listening",
      focusMode: false,
      lookup: null,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  afterEach(() => {
    collapseSelection();
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    vi.unstubAllGlobals();
    useApp.setState({
      segments: [],
      cards: [],
      terms: [],
      interim: null,
      translations: {},
      lookup: null,
    });
  });

  it("a coarse-pointer selection inside the transcript shows the 解释所选 action bar after the debounce", async () => {
    mount(true);
    await act(async () => {
      root!.render(<TranscriptPanel />);
    });

    selectSubstring();
    await fireSelectionChangeAndWaitDebounce();

    expect(container!.querySelector('[data-testid="touch-lookup-bar"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="btn-touch-lookup"]')?.textContent).toBe(
      "解释所选",
    );
  });

  it("tapping 解释所选 runs the same lookup flow as the desktop mouseup path, then hides the bar", async () => {
    mount(true);
    await act(async () => {
      root!.render(<TranscriptPanel />);
    });

    selectSubstring();
    await fireSelectionChangeAndWaitDebounce();
    const btn = container!.querySelector('[data-testid="btn-touch-lookup"]');
    expect(btn).not.toBeNull();

    await act(async () => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().lookup).toEqual(
      expect.objectContaining({ text: SELECT_SUBSTR, contextText: SEGMENT_TEXT }),
    );
    expect(container!.querySelector('[data-testid="touch-lookup-bar"]')).toBeNull();
  });

  it("collapsing the selection dismisses the bar, never calling setLookup", async () => {
    mount(true);
    await act(async () => {
      root!.render(<TranscriptPanel />);
    });

    selectSubstring();
    await fireSelectionChangeAndWaitDebounce();
    expect(container!.querySelector('[data-testid="touch-lookup-bar"]')).not.toBeNull();

    collapseSelection();
    await fireSelectionChangeAndWaitDebounce();

    expect(container!.querySelector('[data-testid="touch-lookup-bar"]')).toBeNull();
    expect(useApp.getState().lookup).toBeNull();
  });

  it("a fine (mouse) pointer never shows the action bar, even for the identical selection", async () => {
    mount(false);
    await act(async () => {
      root!.render(<TranscriptPanel />);
    });

    selectSubstring();
    await fireSelectionChangeAndWaitDebounce();

    expect(container!.querySelector('[data-testid="touch-lookup-bar"]')).toBeNull();
  });

  it("the desktop mouseup path still fires setLookup unchanged after the shared-helper extraction", async () => {
    mount(false);
    await act(async () => {
      root!.render(<TranscriptPanel />);
    });

    selectSubstring();
    const scrollEl = container!.querySelector('[data-testid="transcript-panel"] > div')!;
    await act(async () => {
      scrollEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, detail: 1 }));
    });

    expect(useApp.getState().lookup).toEqual(
      expect.objectContaining({ text: SELECT_SUBSTR, contextText: SEGMENT_TEXT }),
    );
  });
});
