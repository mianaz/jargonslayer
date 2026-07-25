import { describe, expect, it } from "vitest";
import { inferDomainsFromKeywords } from "../domainKeywords";

describe("inferDomainsFromKeywords — basic matching", () => {
  it("returns [] for text with no recognizable keywords", () => {
    expect(inferDomainsFromKeywords("Let's circle back on this tomorrow.")).toEqual([]);
  });

  it("returns [] for empty text", () => {
    expect(inferDomainsFromKeywords("")).toEqual([]);
  });

  it("detects an English keyword case-insensitively", () => {
    expect(inferDomainsFromKeywords("We ran a CLINICAL TRIAL last quarter.")).toEqual(["clinical"]);
    expect(inferDomainsFromKeywords("we ran a clinical trial last quarter.")).toEqual(["clinical"]);
  });

  it("detects a Chinese keyword", () => {
    expect(inferDomainsFromKeywords("我们正在做单细胞测序分析")).toEqual(["genomics"]);
  });

  it("a keyword repeated many times in the text still only counts once toward its domain", () => {
    const text = "clinical trial clinical trial clinical trial";
    expect(inferDomainsFromKeywords(text)).toEqual(["clinical"]);
  });
});

describe("inferDomainsFromKeywords — ranking + cap", () => {
  it("ranks a domain with MORE distinct matched keywords above one with fewer", () => {
    // genomics: "genome" + "sequencing" (2 keywords) vs. stats: "p-value" (1 keyword).
    const text = "We discussed the genome, did some sequencing, and checked the p-value.";
    expect(inferDomainsFromKeywords(text)).toEqual(["genomics", "stats"]);
  });

  it("caps at 3 domains even when more than 3 are present", () => {
    const text = [
      "biomedical research",
      "clinical trial",
      "drug development",
      "genome sequencing",
      "p-value",
    ].join(" ");
    const result = inferDomainsFromKeywords(text);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("mixing an English and a Chinese keyword for the SAME domain still counts as 2 toward it", () => {
    // clinical trial (en) + 临床试验 (zh) both map to "clinical"; genome (1 keyword) -> genomics.
    const text = "clinical trial 临床试验 genome";
    expect(inferDomainsFromKeywords(text)).toEqual(["clinical", "genomics"]);
  });
});

// LOW fix (v0.6 round-2 review): only the trailing ~800 chars are
// scanned now — useMeeting.ts calls this on every finalized segment for
// a whole meeting (keyless users only), so an unbounded scan over the
// whole transcript-so-far would re-lowercase + re-run all ~70 keyword
// .includes() checks against an ever-growing string, permanently, for
// the rest of the meeting. Fails against pre-fix inferDomainsFromKeywords,
// which had no cap at all.
describe("inferDomainsFromKeywords — LOW fix: only scans a trailing window, not the whole transcript", () => {
  it("ignores a keyword that falls OUTSIDE the trailing scan window", () => {
    const stale = "clinical trial "; // a real keyword, but about to fall out of the window
    const filler = "x".repeat(900); // pushes `stale` well past the 800-char trailing cap
    expect(inferDomainsFromKeywords(stale + filler)).toEqual([]);
  });

  it("still detects a keyword that falls WITHIN the trailing scan window, no matter how long the text before it is", () => {
    const filler = "x".repeat(5000); // an hours-long meeting's worth of irrelevant prior text
    const recent = "we just started a clinical trial";
    expect(inferDomainsFromKeywords(filler + recent)).toEqual(["clinical"]);
  });
});

describe("inferDomainsFromKeywords — domain coverage", () => {
  // One known keyword per DomainTag except "general" (the catch-all —
  // nothing maps TO it by design, see the module's own doc).
  const REPRESENTATIVE_KEYWORD: Record<string, string> = {
    biomed: "biomedical",
    clinical: "clinical trial",
    pharma: "drug development",
    genomics: "genome",
    stats: "p-value",
    ml: "machine learning",
    software: "software engineering",
    infra: "infrastructure",
    finance: "revenue",
    sales: "sales pipeline",
    hr: "recruiting",
    legal: "contract",
    ops: "supply chain",
    edu: "curriculum",
    media: "content strategy",
  };

  for (const [domain, keyword] of Object.entries(REPRESENTATIVE_KEYWORD)) {
    it(`detects "${domain}" from a representative keyword ("${keyword}")`, () => {
      expect(inferDomainsFromKeywords(`We talked about ${keyword} today.`)).toContain(domain);
    });
  }

  it("never returns 'general' — there is nothing to match it to", () => {
    const text = Object.values(REPRESENTATIVE_KEYWORD).join(" ");
    expect(inferDomainsFromKeywords(text)).not.toContain("general");
  });
});
