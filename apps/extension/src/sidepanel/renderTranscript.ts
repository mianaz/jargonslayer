// Renders the live transcript — finalized segments + one trailing
// interim line — S7 blueprint §4 (captureController's onTranscriptChange).
// Same vanilla-DOM convention as render.ts/renderLocked.ts: a pure
// function of its input, no module state, returns ONE detached root
// node the caller swaps in wholesale (main.ts does
// `mount.replaceChildren(renderTranscript(segments, interim))` on every
// change — simplest-correct re-render, matching accumulator's own
// "small N" posture rather than incremental DOM patching).

import type { LiteSegment } from "../storage/history";

const EMPTY_HINT_TEXT = "开始聆听后，识别到的文字会显示在这里。";

export function renderTranscript(segments: LiteSegment[], interim: string): HTMLElement {
  const container = document.createElement("div");
  container.className = "js-transcript-body";

  if (segments.length === 0 && !interim) {
    const empty = document.createElement("p");
    empty.className = "js-empty-hint";
    empty.textContent = EMPTY_HINT_TEXT;
    container.appendChild(empty);
    return container;
  }

  for (const segment of segments) {
    container.appendChild(renderSegmentLine(segment));
  }

  if (interim) {
    const line = document.createElement("p");
    line.className = "js-transcript-line js-transcript-interim";
    line.textContent = interim;
    container.appendChild(line);
  }

  return container;
}

function renderSegmentLine(segment: LiteSegment): HTMLElement {
  const line = document.createElement("p");
  line.className = "js-transcript-line";
  line.textContent = segment.text;
  return line;
}
