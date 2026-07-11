import { describe, expect, it } from "vitest";
import { buildHighlightMatcher, MAX_HIGHLIGHT_PER_KIND } from "../highlight";
import type { ExpressionCard, TermCard } from "@jargonslayer/core/types";

function makeCard(overrides: Partial<ExpressionCard> = {}): ExpressionCard {
  return {
    id: "c1",
    expression: "circle back",
    category: "phrase",
    meaning: "revisit later",
    chinese_explanation: "回头再聊",
    plain_english: "discuss again later",
    tone: "neutral",
    confidence: 0.9,
    source_sentence: "Let's circle back on this later.",
    normKey: "circle back",
    firstSeenAt: 1000,
    lastSeenAt: 1000,
    count: 1,
    source: "llm",
    ...overrides,
  };
}

function makeTerm(overrides: Partial<TermCard> = {}): TermCard {
  return {
    id: "t1",
    term: "KPI",
    type: "metric",
    gloss_en: "Key Performance Indicator",
    gloss_zh: "关键绩效指标",
    normKey: "KPI",
    firstSeenAt: 1000,
    lastSeenAt: 1000,
    count: 1,
    source: "llm",
    ...overrides,
  };
}

/** Run the matcher's regex against `text` once and resolve every hit,
 *  returning the matched literals in order alongside their resolved
 *  hit (or undefined if unresolved). Mirrors HighlightedText's loop. */
function matchAll(
  matcher: ReturnType<typeof buildHighlightMatcher>,
  text: string,
) {
  if (!matcher.regex) return [];
  const regex = matcher.regex;
  regex.lastIndex = 0;
  const out: { matched: string; hit: ReturnType<typeof matcher.resolve> }[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    out.push({ matched: match[0], hit: matcher.resolve(match[0]) });
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  return out;
}

describe("buildHighlightMatcher — longest-surface-first", () => {
  it("a multi-word expression beats its own substring", () => {
    const cards = [
      makeCard({ id: "short", expression: "circle" }),
      makeCard({ id: "long", expression: "circle back" }),
    ];
    const matcher = buildHighlightMatcher(cards, []);
    const hits = matchAll(matcher, "Let's circle back tomorrow.");
    expect(hits).toHaveLength(1);
    expect(hits[0].matched.toLowerCase()).toBe("circle back");
    expect(hits[0].hit).toEqual({ kind: "expression", id: "long" });
  });
});

describe("buildHighlightMatcher — expression inflection", () => {
  // NOTE: the old matcher's inflection suffix only ever applies to the
  // LAST word of a multi-word expression (see buildHighlightMatcher's
  // doc comment and src/lib/detect/__tests__/dedupe.test.ts's "AS
  // IMPLEMENTED" case, which documents the same last-word-only rule for
  // a sibling piece of logic). "raise eyebrows" -> "raised eyebrows"
  // inflects the FIRST word ("raise" -> "raised"), which this matcher
  // never covers — the dictionary instead lists "raised eyebrows" as an
  // explicit separate variant (dictionary.ts) rather than relying on
  // the matcher's suffix. "touch base" -> "touch bases" is a real
  // example of the last-word suffix this matcher does support.
  it('"touch bases" resolves to expression "touch base" (last-word inflection)', () => {
    const cards = [makeCard({ id: "tb", expression: "touch base" })];
    const matcher = buildHighlightMatcher(cards, []);
    const hits = matchAll(matcher, "Let's touch bases before the demo.");
    expect(hits).toHaveLength(1);
    expect(hits[0].matched).toBe("touch bases");
    expect(hits[0].hit).toEqual({ kind: "expression", id: "tb" });
  });
});

describe("buildHighlightMatcher — term all-caps guard", () => {
  it('term "KPI": matched "KPI" and "KPIs" resolve, matched "kpi" does not', () => {
    const terms = [makeTerm({ id: "kpi", term: "KPI" })];
    const matcher = buildHighlightMatcher([], terms);

    const upper = matchAll(matcher, "Our KPI improved this quarter.");
    expect(upper).toHaveLength(1);
    expect(upper[0].matched).toBe("KPI");
    expect(upper[0].hit).toEqual({ kind: "term", id: "kpi" });

    const plural = matchAll(matcher, "Several KPIs are tracked.");
    expect(plural).toHaveLength(1);
    expect(plural[0].matched).toBe("KPIs");
    expect(plural[0].hit).toEqual({ kind: "term", id: "kpi" });

    const lower = matchAll(matcher, "That is a good kpi to track.");
    expect(lower).toHaveLength(1);
    expect(lower[0].matched).toBe("kpi");
    expect(lower[0].hit).toBeUndefined();

    const lowerPlural = matchAll(matcher, "Several kpis are tracked.");
    expect(lowerPlural).toHaveLength(1);
    expect(lowerPlural[0].matched).toBe("kpis");
    expect(lowerPlural[0].hit).toBeUndefined();
  });

  it('term "IT": "its" and "it" do not resolve', () => {
    const terms = [makeTerm({ id: "it-dept", term: "IT", type: "acronym" })];
    const matcher = buildHighlightMatcher([], terms);

    const its = matchAll(matcher, "The team lost its way.");
    const itHit = its.find((h) => h.matched.toLowerCase() === "its");
    expect(itHit?.hit).toBeUndefined();

    const rawIt = matchAll(matcher, "Can you fix it later?");
    const rawItHit = rawIt.find((h) => h.matched.toLowerCase() === "it");
    expect(rawItHit?.hit).toBeUndefined();
  });

  it('term "REST": "rest" does not resolve, "REST" does', () => {
    const terms = [makeTerm({ id: "rest-api", term: "REST", type: "tech" })];
    const matcher = buildHighlightMatcher([], terms);

    const lower = matchAll(matcher, "Let's take a rest before continuing.");
    expect(lower[0].hit).toBeUndefined();

    const upper = matchAll(matcher, "We built a REST API for this.");
    const restHit = upper.find((h) => h.matched === "REST");
    expect(restHit?.hit).toEqual({ kind: "term", id: "rest-api" });
  });
});

describe("buildHighlightMatcher — mixed-case term stays case-insensitive", () => {
  it('"Kubernetes" resolves case-insensitively ("kubernetes" matches)', () => {
    const terms = [
      makeTerm({ id: "k8s", term: "Kubernetes", type: "tech" }),
    ];
    const matcher = buildHighlightMatcher([], terms);
    const hits = matchAll(matcher, "We deployed it on kubernetes yesterday.");
    const hit = hits.find((h) => h.matched.toLowerCase() === "kubernetes");
    expect(hit?.hit).toEqual({ kind: "term", id: "k8s" });
  });
});

describe("buildHighlightMatcher — term never resolves via ed/ing", () => {
  it('term "Zoom" does not resolve for matched "Zoomed"', () => {
    const terms = [makeTerm({ id: "zoom", term: "Zoom", type: "product" })];
    const matcher = buildHighlightMatcher([], terms);
    // The term's own regex part only ever appends an optional "s", so
    // "Zoomed" is not even matched by the combined regex in isolation —
    // call resolve() directly to pin down that even a hypothetical
    // "Zoomed" literal (e.g. produced by some other pattern) never
    // resolves to the term.
    expect(matcher.resolve("Zoomed")).toBeUndefined();
    expect(matcher.resolve("zoomed")).toBeUndefined();

    // Sanity: the regex itself does not even produce "Zoomed" as a term
    // match from surrounding text (no ed/ing suffix support for terms).
    const hits = matchAll(matcher, "We zoomed into the details.");
    const zoomedHit = hits.find((h) => h.matched.toLowerCase() === "zoomed");
    expect(zoomedHit).toBeUndefined();
  });
});

describe("buildHighlightMatcher — per-kind recency budget", () => {
  it("31 terms: the oldest term's surface no longer matches, 30 newest do; expressions unaffected", () => {
    const terms: TermCard[] = [];
    for (let i = 0; i < MAX_HIGHLIGHT_PER_KIND + 1; i++) {
      terms.push(
        makeTerm({
          id: `term-${i}`,
          term: `Term${i}`,
          lastSeenAt: 1000 + i, // higher i = more recent
        }),
      );
    }
    const cards = [makeCard({ id: "expr-1", expression: "circle back" })];
    const matcher = buildHighlightMatcher(cards, terms);

    // Oldest term (index 0, lastSeenAt 1000) is evicted.
    const oldest = matchAll(matcher, "Discussing Term0 today.");
    const oldestHit = oldest.find((h) => h.matched === "Term0");
    expect(oldestHit).toBeUndefined();

    // The 30 newest (indices 1..30) all resolve.
    for (let i = 1; i <= MAX_HIGHLIGHT_PER_KIND; i++) {
      const hits = matchAll(matcher, `Discussing Term${i} today.`);
      const hit = hits.find((h) => h.matched === `Term${i}`);
      expect(hit?.hit).toEqual({ kind: "term", id: `term-${i}` });
    }

    // Expression matching is unaffected by the term flood.
    const exprHits = matchAll(matcher, "Let's circle back later.");
    const exprHit = exprHits.find((h) => h.matched.toLowerCase() === "circle back");
    expect(exprHit?.hit).toEqual({ kind: "expression", id: "expr-1" });
  });
});

describe("buildHighlightMatcher — cross-kind surface collision", () => {
  it("expression wins when an expression and a term share the same surface", () => {
    const cards = [makeCard({ id: "expr-sync", expression: "sync up" })];
    const terms = [makeTerm({ id: "term-sync", term: "sync up", type: "tech" })];
    const matcher = buildHighlightMatcher(cards, terms);
    const hits = matchAll(matcher, "Let's sync up tomorrow.");
    expect(hits).toHaveLength(1);
    expect(hits[0].hit?.kind).toBe("expression");
    expect(hits[0].hit).toEqual({ kind: "expression", id: "expr-sync" });
  });
});

describe("buildHighlightMatcher — empty inputs", () => {
  it("returns a null regex when there are no cards and no terms", () => {
    const matcher = buildHighlightMatcher([], []);
    expect(matcher.regex).toBeNull();
  });
});

describe("buildHighlightMatcher — routing", () => {
  it("resolve returns the correct kind+id for an expression and a term in the same text", () => {
    const cards = [makeCard({ id: "expr-1", expression: "circle back" })];
    const terms = [makeTerm({ id: "term-1", term: "ARR", type: "metric" })];
    const matcher = buildHighlightMatcher(cards, terms);
    const hits = matchAll(matcher, "Let's circle back on the ARR numbers.");

    const exprHit = hits.find((h) => h.matched.toLowerCase() === "circle back");
    expect(exprHit?.hit).toEqual({ kind: "expression", id: "expr-1" });

    const termHit = hits.find((h) => h.matched === "ARR");
    expect(termHit?.hit).toEqual({ kind: "term", id: "term-1" });
  });
});
