import { describe, expect, it } from "vitest";
import { deriveSenseContext } from "../senseContext";

describe("deriveSenseContext — domainWeights", () => {
  it("returns empty maps for a totally empty input", () => {
    const result = deriveSenseContext({ inferredDomains: [], enabledPacks: null, terms: [] });
    expect(result.domainWeights).toEqual({});
    expect(result.cooccurrence).toEqual({});
  });

  it("weights every inferred domain at 1.0", () => {
    const result = deriveSenseContext({
      inferredDomains: ["biomed", "genomics"],
      enabledPacks: null,
      terms: [],
    });
    expect(result.domainWeights).toEqual({ biomed: 1.0, genomics: 1.0 });
  });

  it("weights an explicitly-enabled pack's own domain (PACK_DOMAINS) at 0.5", () => {
    const result = deriveSenseContext({
      inferredDomains: [],
      enabledPacks: ["stats"], // packs.ts's PACK_DOMAINS maps "stats" -> "stats"
      terms: [],
    });
    expect(result.domainWeights).toEqual({ stats: 0.5 });
  });

  it("enabledPacks === null (default, everything on) contributes NO pack-domain weight — only inferred domains matter", () => {
    const result = deriveSenseContext({
      inferredDomains: [],
      enabledPacks: null,
      terms: [],
    });
    expect(result.domainWeights).toEqual({});
  });

  it("a pack with no PACK_DOMAINS mapping (e.g. 'project') contributes nothing, not an error", () => {
    const result = deriveSenseContext({
      inferredDomains: [],
      enabledPacks: ["project", "meeting-flow"],
      terms: [],
    });
    expect(result.domainWeights).toEqual({});
  });

  it("an inferred domain that ALSO matches an enabled pack's domain stays at 1.0, never downgraded to 0.5", () => {
    const result = deriveSenseContext({
      inferredDomains: ["stats"],
      enabledPacks: ["stats"],
      terms: [],
    });
    expect(result.domainWeights).toEqual({ stats: 1.0 });
  });

  it("combines multiple inferred domains and multiple mapped packs into one weights object", () => {
    const result = deriveSenseContext({
      inferredDomains: ["biomed"],
      enabledPacks: ["stats", "ml-stats", "sales"],
      terms: [],
    });
    expect(result.domainWeights).toEqual({ biomed: 1.0, stats: 0.5, ml: 0.5, sales: 0.5 });
  });
});

describe("deriveSenseContext — cooccurrence", () => {
  it("computes the fraction of detected terms whose chosen sense carries each domain", () => {
    const result = deriveSenseContext({
      inferredDomains: [],
      enabledPacks: null,
      terms: [
        { senses: [{ domain: "pharma" }] },
        { senses: [{ domain: "pharma" }] },
        { senses: [{ domain: "genomics" }] },
        {}, // no senses at all — dilutes the denominator only
      ],
    });
    expect(result.cooccurrence).toEqual({ pharma: 0.5, genomics: 0.25 });
  });

  it("only the CHOSEN (first-ranked) sense counts, never the runner-up(s)", () => {
    const result = deriveSenseContext({
      inferredDomains: [],
      enabledPacks: null,
      terms: [{ senses: [{ domain: "pharma" }, { domain: "genomics" }] }],
    });
    expect(result.cooccurrence).toEqual({ pharma: 1 });
  });

  it("a term with an empty senses array contributes to the denominator only", () => {
    const result = deriveSenseContext({
      inferredDomains: [],
      enabledPacks: null,
      terms: [{ senses: [{ domain: "biomed" }] }, { senses: [] }],
    });
    expect(result.cooccurrence).toEqual({ biomed: 0.5 });
  });

  it("returns an empty map when there are no detected terms yet (no division by zero)", () => {
    const result = deriveSenseContext({ inferredDomains: [], enabledPacks: null, terms: [] });
    expect(result.cooccurrence).toEqual({});
  });

  it("returns an empty map when every detected term has no senses", () => {
    const result = deriveSenseContext({
      inferredDomains: [],
      enabledPacks: null,
      terms: [{}, {}, {}],
    });
    expect(result.cooccurrence).toEqual({});
  });
});

describe("deriveSenseContext — user-pinned sense (sense-picker plan, Lane 1)", () => {
  it("a pinned sense's domain enters domainWeights at 1.0, even with no inference and every pack on", () => {
    const result = deriveSenseContext({
      inferredDomains: [],
      enabledPacks: null,
      terms: [
        {
          senseId: "cachexia",
          pinnedSenseId: "cachexia",
          senses: [
            { senseId: "sales", domain: "sales" },
            { senseId: "cachexia", domain: "pharma" },
          ],
        },
      ],
    });
    expect(result.domainWeights).toEqual({ pharma: 1.0 });
  });

  it("a pin never downgrades an inferred 1.0 and an enabled pack's 0.5 never downgrades a pin", () => {
    const result = deriveSenseContext({
      inferredDomains: ["pharma"],
      enabledPacks: ["pharma-biotech"],
      terms: [
        {
          senseId: "cachexia",
          pinnedSenseId: "cachexia",
          senses: [{ senseId: "cachexia", domain: "pharma" }],
        },
      ],
    });
    expect(result.domainWeights).toEqual({ pharma: 1.0 });
  });

  it("a pinnedSenseId that names no sense on the card (or an unknown domain) contributes nothing, not an error", () => {
    const result = deriveSenseContext({
      inferredDomains: [],
      enabledPacks: null,
      terms: [
        { senseId: "x", pinnedSenseId: "missing", senses: [{ senseId: "x", domain: "sales" }] },
        { senseId: "y", pinnedSenseId: "y", senses: [{ senseId: "y", domain: "not-a-domain" }] },
      ],
    });
    expect(result.domainWeights).toEqual({});
  });

  it("cooccurrence counts the DISPLAYED sense's domain (senseId), falling back to senses[0] when there is no senseId", () => {
    const result = deriveSenseContext({
      inferredDomains: [],
      enabledPacks: null,
      terms: [
        // displayed sense is the runner-up in the ranked snapshot
        {
          senseId: "cachexia",
          senses: [
            { senseId: "sales", domain: "sales" },
            { senseId: "cachexia", domain: "pharma" },
          ],
        },
        // no senseId: legacy shape, senses[0] wins
        { senses: [{ domain: "sales" }] },
      ],
    });
    expect(result.cooccurrence).toEqual({ pharma: 0.5, sales: 0.5 });
  });
});
