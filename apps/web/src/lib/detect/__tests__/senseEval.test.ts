// Sense-picker plan, Lane 0 — the sense-picking evaluation harness.
//
// Replays every script in __fixtures__/senseEvalCorpus.ts through the
// SAME pipeline the app runs live for dictionary mode, segment by
// segment, in the same order:
//   1. sense context (useMeeting.ts's resolveSenseContext: keyword
//      fallback + deriveSenseContext over the terms so far) is applied
//      SYNCHRONOUSLY before the scan — the S5 fix's ordering;
//   2. scanDictionary(text, enabledPacks, { activeDomains }) with the
//      DomainTracker's snapshot from EARLIER segments (scheduler.ts);
//   3. tracker.observe(result) — activation only affects later segments;
//   4. mergeDetections(...) — the card the user actually sees, including
//      dedupe.ts's AMBIGUOUS_MARGIN swap hysteresis.
// Then it compares each expectation against the merged CARD.
//
// What it guards:
//   - KNOWN_WRONG pins today's misses. Every check NOT in that list must
//     be correct: a later lane that breaks a case the picker gets right
//     today fails here. A case that starts passing prints a note so the
//     list can shrink (it never fails for improving).
//   - flip count (a card's displayed sense changing across segments)
//     may not grow: "a card whose meaning oscillates is worse than one
//     that is simply wrong" (dedupe.ts).
//   - every expected headword is detected — an undetected headword is a
//     mis-authored script, not a picker result.
//
// SENSE_EVAL_REPORT=1 prints the full per-check table and the per-tag
// breakdown for tuning sessions.

import { afterAll, describe, expect, it } from "vitest";
import { scanDictionary, setSenseContext } from "@jargonslayer/core/detect/dictionary";
import { createDomainTracker } from "@jargonslayer/core/detect/domainSignal";
import { mergeDetections, termNormKey } from "@jargonslayer/core/detect/dedupe";
import type { ExpressionCard, TermCard } from "@jargonslayer/core/types";
import { deriveSenseContext } from "../senseContext";
import { inferDomainsFromKeywords } from "../domainKeywords";
import { SENSE_EVAL_CORPUS, type SenseEvalScript } from "../__fixtures__/senseEvalCorpus";

interface CheckResult {
  key: string; // `${scriptId}#${segIdx}#${headword}`
  scriptId: string;
  segIdx: number;
  headword: string;
  expected: string;
  actual: string | undefined; // undefined = card missing
  ambiguous: boolean;
  tags: string[];
}

interface ScriptRun {
  checks: CheckResult[];
  flips: number;
}

function runScript(script: SenseEvalScript): ScriptRun {
  const tracker = createDomainTracker();
  const enabledPacks = script.enabledPacks ?? null;
  let cards: ExpressionCard[] = [];
  let terms: TermCard[] = [];
  const transcript: string[] = [];
  const lastSenseByKey = new Map<string, string | undefined>();
  let flips = 0;
  const checks: CheckResult[] = [];

  script.segments.forEach((seg, segIdx) => {
    transcript.push(seg.text);
    // useMeeting.ts resolveSenseContext, keyless path: no LLM inference
    // ever lands in dictionary mode, so the keyword guess is the only
    // inferred-domain source.
    setSenseContext(
      deriveSenseContext({
        inferredDomains: inferDomainsFromKeywords(transcript.join(" ")),
        enabledPacks,
        terms,
      }),
    );
    const res = scanDictionary(seg.text, enabledPacks, { activeDomains: tracker.activeDomains() });
    tracker.observe(res);
    const merged = mergeDetections(cards, terms, res, "dictionary", 0, 1_000 * (segIdx + 1));
    cards = merged.cards;
    terms = merged.terms;

    for (const t of terms) {
      if (t.senseId === undefined) continue;
      const prev = lastSenseByKey.get(t.normKey);
      if (prev !== undefined && prev !== t.senseId) flips += 1;
      lastSenseByKey.set(t.normKey, t.senseId);
    }

    for (const [headword, expected] of Object.entries(seg.expect ?? {})) {
      const card = terms.find((t) => t.normKey === termNormKey(headword));
      checks.push({
        key: `${script.id}#${segIdx}#${headword}`,
        scriptId: script.id,
        segIdx,
        headword,
        expected,
        actual: card?.senseId,
        ambiguous: card?.ambiguous === true,
        tags: script.tags,
      });
    }
  });

  return { checks, flips };
}

// ---------------------------------------------------------------------
// Baseline, measured 2026-09-23 against v0.7.8's picker. Each key is a
// check the picker gets WRONG today. Lanes 2–6 of the plan exist to
// shrink this list; a key that starts passing is reported below so it
// can be removed. Adding a key here is only legitimate for a NEW script
// whose miss is understood and accepted as the current baseline.
//
// Baseline (v0.7.8 picker, 33 scripts / 41 checks): 7 wrong = 17.1 %
// wrong-sense on detected checks; 5 of the 7 carry `ambiguous` (71 %
// honest failures); 6 of the 7 are cold-start (segment 0 or the segment
// right after); 2 flips, both CORRECTIONS toward the expected sense
// (cac-cachexia-cold #1→#2, pd-pharma-warm #0→#2). Plan targets:
// wrongSenseRate < 10 %, ambiguousAndWrong ≥ 60 %.
const KNOWN_WRONG: ReadonlySet<string> = new Set<string>([
  // cold start: the pharma sense has prior 0.3 and no evidence yet; the
  // IND/BLA in the SAME later segment only activate pharma for the
  // segment after (tracker activation is for later segments).
  "cac-cachexia-cold#0#CAC",
  "cac-cachexia-cold#1#CAC",
  // topic shift: sales stays active at 1.0 forever (monotonic tracker),
  // pharma's later 1.0 ties it and the 0.15 swap hysteresis holds the
  // old sense (Lane 3).
  "cac-topic-shift-sales-to-pharma#4#CAC",
  // the field-test reproduction: IND/BLA in the same sentence are not
  // visible to the picker for THIS segment (Lane 2, sentence cues).
  "nda-same-sentence-ind-bla#0#NDA",
  "nda-same-sentence-ind-bla#1#NDA",
  // cold start with same-segment evidence (PK, IND) — same cause.
  "pd-pharma-warm#0#PD",
  // no context at all: the 0.8 iso-standards prior wins by design.
  "iso-stock-option-cold#0#ISO",
]);
// Both baseline flips are corrections (see above). A lane that adds a
// wrong-direction flip still grows this number and fails; a lane that
// gets the first pick right shrinks it — lower the constant then.
const BASELINE_FLIPS = 2;

const results = SENSE_EVAL_CORPUS.map((script) => ({ script, run: runScript(script) }));
const allChecks = results.flatMap((r) => r.run.checks);
const totalFlips = results.reduce((n, r) => n + r.run.flips, 0);

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

function printReport(): void {
  const rows = allChecks.map((c) => ({
    check: c.key,
    expected: c.expected,
    actual: c.actual ?? "(not detected)",
    ok: c.actual === c.expected ? "✓" : "✗",
    ambiguous: c.ambiguous ? "?" : "",
  }));
  console.table(rows);
  const wrong = allChecks.filter((c) => c.actual !== undefined && c.actual !== c.expected);
  const detected = allChecks.filter((c) => c.actual !== undefined);
  const ambiguous = detected.filter((c) => c.ambiguous);
  const summary: Record<string, string | number> = {
    scripts: SENSE_EVAL_CORPUS.length,
    checks: allChecks.length,
    notDetected: allChecks.length - detected.length,
    wrongSense: wrong.length,
    wrongSenseRate: pct(wrong.length, detected.length),
    ambiguousRate: pct(ambiguous.length, detected.length),
    ambiguousAndWrong: pct(wrong.filter((c) => c.ambiguous).length, wrong.length),
    coldStartWrong: wrong.filter((c) => c.segIdx === 0).length,
    flips: totalFlips,
  };
  console.table([summary]);
  const tags = new Set(allChecks.flatMap((c) => c.tags));
  const byTag = [...tags].sort().map((tag) => {
    const inTag = detected.filter((c) => c.tags.includes(tag));
    const wrongInTag = inTag.filter((c) => c.actual !== c.expected);
    return { tag, checks: inTag.length, wrong: wrongInTag.length, wrongRate: pct(wrongInTag.length, inTag.length) };
  });
  console.table(byTag);
}

if (process.env.SENSE_EVAL_REPORT) printReport();

afterAll(() => {
  // The sense context is module-global in core; leave nothing behind.
  setSenseContext(null);
});

describe("sense-picking eval corpus (sense-picker plan, Lane 0)", () => {
  it("every expected headword is detected — an undetected headword is a mis-authored script", () => {
    const missing = allChecks.filter((c) => c.actual === undefined).map((c) => c.key);
    expect(missing).toEqual([]);
  });

  it("every check the picker gets right today stays right (KNOWN_WRONG pins the baseline misses)", () => {
    const regressions = allChecks
      .filter((c) => c.actual !== undefined && c.actual !== c.expected && !KNOWN_WRONG.has(c.key))
      .map((c) => `${c.key}: expected ${c.expected}, got ${c.actual}`);
    expect(regressions).toEqual([]);
  });

  it("reports (never fails on) KNOWN_WRONG entries that now pass, so the baseline list can shrink", () => {
    const nowRight = allChecks.filter((c) => KNOWN_WRONG.has(c.key) && c.actual === c.expected).map((c) => c.key);
    if (nowRight.length > 0) {
      console.info(`[senseEval] ${nowRight.length} KNOWN_WRONG entries now pass — remove them:\n  ${nowRight.join("\n  ")}`);
    }
    const stale = [...KNOWN_WRONG].filter((k) => !allChecks.some((c) => c.key === k));
    expect(stale, "KNOWN_WRONG names checks that no longer exist in the corpus").toEqual([]);
  });

  it("a card's displayed sense never oscillates more than the baseline allows", () => {
    expect(totalFlips).toBeLessThanOrEqual(BASELINE_FLIPS);
  });
});
