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
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "../../lib/store";
import type { ExpressionCard, TermCard, TranscriptSegment } from "../../lib/types";
import TranscriptPanel, { renderCounters } from "../TranscriptPanel";

const SEGMENT_COUNT = 200;
const HIGHLIGHT_TERM = "Kubernetes";

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

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
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
});
