// S5 fix (v0.6 round-2 review) — resolveSenseContext, the pure
// derivation useMeeting.ts's onFinal (synchronous, per-segment) and its
// reactive effect (async, cross-segment triggers) both now share for
// dictionary.ts's setSenseContext. Unit-tested directly without
// mounting useMeeting() itself — this repo has no hook-render test
// harness (see useMeeting.contextTrigger.test.ts's identical header
// note, which established the "import the exported pure helper
// straight from useMeeting.ts" pattern this file follows).
//
// deriveSenseContext's own domainWeights/cooccurrence WEIGHTING formula
// is already covered by lib/detect/__tests__/senseContext.test.ts — the
// only NEW behavior resolveSenseContext itself adds on top is the
// effectiveDomains fallback (empty inferredDomains -> keyword guess),
// which is what these tests pin.

import { describe, expect, it } from "vitest";
import { resolveSenseContext } from "../useMeeting";

describe("resolveSenseContext", () => {
  it("empty inferredDomains falls back to the keyword guess over the joined segment text", () => {
    const result = resolveSenseContext({
      segments: [{ text: "Let's discuss the clinical trial timeline." }],
      terms: [],
      enabledPacks: null,
      inferredDomains: [],
    });
    expect(result.domainWeights?.clinical).toBe(1.0);
  });

  it("non-empty inferredDomains wins outright — the keyword guess is never even consulted", () => {
    const result = resolveSenseContext({
      // Text alone would keyword-guess "clinical" — a real (even if
      // unrelated) inferredDomains value must still take priority.
      segments: [{ text: "Let's discuss the clinical trial timeline." }],
      terms: [],
      enabledPacks: null,
      inferredDomains: ["finance"],
    });
    expect(result.domainWeights?.finance).toBe(1.0);
    expect(result.domainWeights?.clinical).toBeUndefined();
  });

  it("no keyword hit and no inferredDomains -> an empty domainWeights map, not a crash", () => {
    const result = resolveSenseContext({
      segments: [{ text: "hey how's it going" }],
      terms: [],
      enabledPacks: null,
      inferredDomains: [],
    });
    expect(result.domainWeights).toEqual({});
  });

  it("delegates enabledPacks/terms straight through to deriveSenseContext (cooccurrence still computed)", () => {
    const result = resolveSenseContext({
      segments: [{ text: "no keyword signal here" }],
      terms: [{ senses: [{ domain: "finance" }] }, { senses: [{ domain: "finance" }] }],
      enabledPacks: null,
      inferredDomains: [],
    });
    expect(result.cooccurrence?.finance).toBe(1);
  });
});
