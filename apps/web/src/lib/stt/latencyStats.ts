// S10 field-fix #5 — smoothed local-Whisper transcribe latency. wsTransport.
// ts pushes one raw lag_ms sample per partial/final message that carries
// one (additive/optional field, see that file's own parse); StatusLine
// reads the smoothed value and shows a 延迟 chip once it stays above its
// own threshold. Own tiny zustand store, mirroring registry.ts's plain
// `create(() => ({...}))` shape — session-scoped, no persistence.

import { create } from "zustand";

export interface LatencyStatsState {
  lagMs: number | null;
}

export const useLatencyStats = create<LatencyStatsState>(() => ({ lagMs: null }));

// EMA smoothing (picked over a rolling window: O(1) state, no buffer to
// size/prune). Alpha tuned for "reacts within a few samples, doesn't
// flash on one slow inference" — a sustained slowdown crosses
// StatusLine's >2000ms threshold within 2-3 partials (~PARTIAL_INTERVAL_S
// apart, see whisper_server.py) rather than being averaged away over a
// long tail.
const EMA_ALPHA = 0.3;

/** Feeds one fresh lag_ms sample into the smoothed value. The first
 *  sample after a null/reset state seeds the average directly (no
 *  artificial ramp-up from 0, which would otherwise read as "instant"
 *  right after a fresh connection). */
export function pushLagSample(sampleMs: number): void {
  useLatencyStats.setState((s) => ({
    lagMs: s.lagMs === null ? sampleMs : s.lagMs + EMA_ALPHA * (sampleMs - s.lagMs),
  }));
}

/** Resets the smoothed value — a fresh meeting/engine session must
 *  never show a stale reading carried over from a previous one. Not
 *  currently wired to any caller (wsTransport.ts's own lag_ms
 *  passthrough is intentionally the smallest possible diff — see that
 *  file); StatusLine only renders the chip while status is "listening",
 *  which already keeps a stale value from ever being SHOWN post-session
 *  even though the store field itself isn't cleared. Exported for a
 *  future caller (e.g. useMeeting.ts's own per-session resets) to wire
 *  up without needing a new export later. */
export function resetLagStats(): void {
  useLatencyStats.setState({ lagMs: null });
}
