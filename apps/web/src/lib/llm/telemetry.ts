// v0.4.5 AI-transparency telemetry (docs/design-explorations/v045-ai-
// transparency-qc.md, Part A) — one session-scoped store the four
// client.ts LLM entry points (detectApi/defineApi/translateApi/
// summarizeApi) write to on every call resolution, read by the
// StatusLine AI-status popover and the Settings → AI 检测 mirror. Own
// tiny zustand store, same plain `create(() => ({...}))` + module-level
// mutator shape as latencyStats.ts — session-scoped, NOT persisted (a
// full page reload is the reset boundary, per the design's "session =
// page load, not per-meeting" decision; translate/report legitimately
// span a meeting end, so a per-meeting reset would lie about them).
//
// Deliberately imports NOTHING from client.ts: client.ts imports THIS
// module for its wrap points, so the error-class → kind mapping lives
// on the client.ts side (it passes an already-classified `kind` here),
// keeping this module a leaf with no cycle.

import { create } from "zustand";

// FOUR buckets, not the resolver's three LlmTaskDomain values: `define`
// (选中解释) rides detect's credentials but is its own user-visible
// "agent" and gets its own honest call/failure counts — that per-agent
// transparency is exactly what the owner asked for ("一共有几个 agent").
export type LlmTelemetryDomain = "detect" | "define" | "translate" | "summary";

// Mirrors client.ts's NoKeyError / RateLimitApiError / UpstreamError
// taxonomy — the caller maps the caught class to one of these before
// calling record(), so this module never has to know the classes.
export type LlmTelemetryErrorKind = "nokey" | "ratelimit" | "upstream";

export interface LlmDomainStat {
  /** Every resolved call this session (success + failure). */
  calls: number;
  failures: number;
  /** Spans the detect-span QC (spanQc.ts) dropped as over-selected —
   *  fed by recordQcDrop, NOT counted as a call. Surfaced per-domain so
   *  the status panel can show "3 dropped" next to the agent that
   *  produced them, closing the loop the owner's whole-sentence-jargon
   *  report opened. */
  qcDropped: number;
  /** null until the first call — the panel renders this as a grey
   *  "尚未调用" dot, distinct from a green ok or amber fail. */
  lastStatus: "ok" | "fail" | null;
  lastAt: number | null;
  /** Only meaningful while lastStatus === "fail". */
  lastErrorKind?: LlmTelemetryErrorKind;
}

export type LlmTelemetryState = Record<LlmTelemetryDomain, LlmDomainStat>;

function emptyStat(): LlmDomainStat {
  return { calls: 0, failures: 0, qcDropped: 0, lastStatus: null, lastAt: null };
}

function emptyState(): LlmTelemetryState {
  return { detect: emptyStat(), define: emptyStat(), translate: emptyStat(), summary: emptyStat() };
}

export const useLlmTelemetry = create<LlmTelemetryState>(() => emptyState());

/** Record one resolved LLM call. `"ok"` on success; `{ kind }` on
 *  failure (the caller having already mapped the caught error class to
 *  a kind). Always bumps `calls`; a failure additionally bumps
 *  `failures` and stamps `lastErrorKind`. A success clears the stale
 *  error kind so the panel doesn't show a red reason next to a green
 *  dot. */
export function recordLlmCall(
  domain: LlmTelemetryDomain,
  outcome: "ok" | { kind: LlmTelemetryErrorKind },
): void {
  useLlmTelemetry.setState((s) => {
    const prev = s[domain];
    const ok = outcome === "ok";
    return {
      [domain]: {
        ...prev,
        calls: prev.calls + 1,
        failures: prev.failures + (ok ? 0 : 1),
        lastStatus: ok ? "ok" : "fail",
        lastAt: Date.now(),
        lastErrorKind: ok ? undefined : outcome.kind,
      },
    };
  });
}

/** Add `n` QC-dropped spans to a domain's tally (n may be >1 for a
 *  batch). Does not touch calls/lastStatus — a QC drop is not a call
 *  outcome, it's a post-processing filter result. No-op for n<=0 so a
 *  clean batch never churns the store. */
export function recordLlmQcDrop(domain: LlmTelemetryDomain, n: number): void {
  if (n <= 0) return;
  useLlmTelemetry.setState((s) => ({
    [domain]: { ...s[domain], qcDropped: s[domain].qcDropped + n },
  }));
}

/** Full reset — exposed for tests and a possible "重置计数" affordance;
 *  NOT wired to meeting stop (see the module header on why the reset
 *  boundary is page load). */
export function resetLlmTelemetry(): void {
  useLlmTelemetry.setState(emptyState());
}
