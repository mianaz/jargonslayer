import { beforeEach, describe, expect, it } from "vitest";
import { mergeDetections } from "../dedupe";
import { packTermsForBias, scanDictionary, setSenseContext } from "../dictionary";
import {
  createDomainTracker,
  DOMAIN_ACTIVATION_THRESHOLD,
  type DomainTracker,
} from "../domainSignal";

function scanSegment(tracker: DomainTracker, text: string) {
  const result = scanDictionary(text, null, { activeDomains: tracker.activeDomains() });
  tracker.observe(result);
  return result;
}

function termNames(result: ReturnType<typeof scanDictionary>): string[] {
  return result.terms.map((term) => term.term);
}

function findTerm(result: ReturnType<typeof scanDictionary>, headword: string) {
  const term = result.terms.find((candidate) => candidate.term === headword);
  expect(term, `expected a "${headword}" term card`).toBeDefined();
  return term!;
}

function activatePharma(tracker: DomainTracker): void {
  const result = scanSegment(tracker, "The IND / BLA / PK plans are ready.");
  expect(termNames(result)).toEqual(expect.arrayContaining(["IND", "BLA", "PK"]));
  expect(tracker.activeDomains()).toContain("pharma");
}

function activateMl(tracker: DomainTracker): void {
  scanSegment(tracker, "We use self-supervised learning for cell painting.");
  scanSegment(tracker, "Knowledge distillation reduced the model size.");
  expect(tracker.activeDomains()).toContain("ml");
}

beforeEach(() => {
  setSenseContext(null);
});

describe("meeting domain signal", () => {
  it("uses the field-validated two-headword activation threshold", () => {
    expect(DOMAIN_ACTIVATION_THRESHOLD).toBe(2);
  });

  it("activates ML from two unambiguous segments, then emits precision and recall", () => {
    const tracker = createDomainTracker();

    expect(termNames(scanSegment(tracker, "We use self-supervised learning for cell painting."))).toContain(
      "self-supervised learning",
    );
    expect(tracker.activeDomains()).not.toContain("ml");

    expect(termNames(scanSegment(tracker, "Knowledge distillation reduced the model size."))).toContain(
      "knowledge distillation",
    );
    expect(tracker.activeDomains()).toContain("ml");

    const metrics = scanSegment(
      tracker,
      "Higher the precision and higher the recall, better is the model.",
    );
    expect(termNames(metrics)).toEqual(expect.arrayContaining(["precision", "recall"]));
  });

  it("does not activate ML from one cachexia-side random forest mention, so attention stays suppressed", () => {
    const tracker = createDomainTracker();

    expect(termNames(scanSegment(tracker, "A random forest came up in the Q&A."))).toContain(
      "random forest",
    );
    expect(tracker.activeDomains()).not.toContain("ml");

    expect(termNames(scanSegment(tracker, "Attention guides the visual cortex."))).not.toContain("attention");
    expect(termNames(scanSegment(tracker, "Thank you for your attention."))).not.toContain("attention");
  });

  it("activates pharma without activating ML, leaving attention suppressed", () => {
    const tracker = createDomainTracker();

    const pharma = scanSegment(tracker, "The IND, BLA, and PK plans are ready.");
    expect(termNames(pharma)).toEqual(expect.arrayContaining(["IND", "BLA", "PK"]));
    expect(tracker.activeDomains()).toContain("pharma");
    expect(tracker.activeDomains()).not.toContain("ml");

    expect(termNames(scanSegment(tracker, "Attention to detail matters here."))).not.toContain("attention");
  });

  it("keeps an activated domain active through unrelated segments", () => {
    const tracker = createDomainTracker();
    scanSegment(tracker, "Self-supervised learning gave us a baseline.");
    scanSegment(tracker, "Knowledge distillation made deployment easier.");

    for (let i = 0; i < 20; i++) {
      scanSegment(tracker, `Let us circle back on agenda item ${i}.`);
    }

    expect(tracker.activeDomains()).toContain("ml");
  });

  it("keeps cross-domain modern-usage common words on their explicit-enable rule", () => {
    expect(
      termNames(scanDictionary("The agent can coordinate the workflow.", ["modern-usage"])),
    ).toContain("agent");
    expect(termNames(scanDictionary("The agent can coordinate the workflow.", null))).not.toContain(
      "agent",
    );
  });

  it("applies the same domain gate to recognizer-bias terms", () => {
    expect(packTermsForBias(["ml-stats"]).some((term) => term.term === "precision")).toBe(false);
    expect(
      packTermsForBias(["ml-stats"], new Set(["ml"])).some((term) => term.term === "precision"),
    ).toBe(true);
  });

  it("retains dictionary provenance from emitted result through its card", () => {
    const result = scanDictionary("Let us circle back after the random forest review.", null);
    expect(result.expressions.find((expression) => expression.expression === "circle back")?.pack).toBe(
      "core",
    );
    expect(result.terms.find((term) => term.term === "random forest")?.pack).toBe("ml-stats");

    const merged = mergeDetections([], [], result, "dictionary", 0.55, 1);
    expect(merged.terms.find((term) => term.term === "random forest")?.pack).toBe("ml-stats");
  });

  describe("field-test multi-sense outcomes", () => {
    it("uses prior pharma evidence to resolve CAC as Cancer-Associated Cachexia", () => {
      const tracker = createDomainTracker();
      activatePharma(tracker);

      const result = scanSegment(tracker, "Cancer Associated Cachexia, or CAC, causes weight loss.");
      const cac = findTerm(result, "CAC");
      expect(cac.senseId).toBe("cancer-associated-cachexia");
      expect(cac.gloss_zh).toBe("癌症相关恶病质");
      expect(cac.gloss_zh).not.toBe("获客成本");
    });

    it("uses prior pharma evidence to resolve NDA as New Drug Application", () => {
      const tracker = createDomainTracker();
      activatePharma(tracker);

      const result = scanSegment(
        tracker,
        "IND are investigational, new drug application or NDA or BLA.",
      );
      const nda = findTerm(result, "NDA");
      expect(nda.senseId).toBe("new-drug-application");
      expect(nda.gloss_en).toBe("New Drug Application");
    });

    it("uses prior pharma evidence to resolve oral as route of administration", () => {
      const tracker = createDomainTracker();
      activatePharma(tracker);

      const oral = findTerm(
        scanSegment(tracker, "We can give patients an oral treatment."),
        "oral",
      );
      expect(oral.senseId).toBe("oral-administration");
      expect(oral.gloss_zh).toBe("口服给药");
    });

    it("uses prior ML evidence to resolve PR as a Precision-Recall curve", () => {
      const tracker = createDomainTracker();
      activateMl(tracker);

      const pr = findTerm(
        scanSegment(tracker, "The PR curve for the corum improves."),
        "PR",
      );
      expect(pr.senseId).toBe("precision-recall");
      expect(pr.gloss_zh).toBe("精确率-召回率曲线");
    });

    it("uses prior ML evidence to resolve regression as statistical regression", () => {
      const tracker = createDomainTracker();
      activateMl(tracker);

      const regression = findTerm(
        scanSegment(tracker, "We see other regression targets, including age."),
        "regression",
      );
      expect(regression.senseId).toBe("statistical-regression");
      expect(regression.gloss_en).not.toMatch(/previously-working feature/);
    });

    // Review finding: statistical-regression used to be tagged domain
    // "ml" ONLY (PACK_DOMAINS: ml-stats -> "ml"), so a plain stats talk
    // with zero ML vocabulary — evidence from the SEPARATE "stats" pack
    // (PACK_DOMAINS: stats -> "stats") — never boosted it, and the
    // domain-agnostic 0.6 prior on software-regression won instead.
    it("uses prior STATS evidence (no ML vocabulary at all) to resolve regression as statistical regression", () => {
      const tracker = createDomainTracker();
      const stats = scanSegment(tracker, "The p-value and confidence interval are significant.");
      expect(termNames(stats)).toEqual(expect.arrayContaining(["p-value", "confidence interval"]));
      expect(tracker.activeDomains()).toContain("stats");
      expect(tracker.activeDomains()).not.toContain("ml");

      const regression = findTerm(scanSegment(tracker, "We fit a regression to predict the outcome."), "regression");
      expect(regression.senseId).toBe("statistical-regression");
      expect(regression.gloss_en).not.toMatch(/previously-working feature/);
    });

    it("falls back to a usable higher-prior sense for every affected headword", () => {
      // "variance" is deliberately excluded from this loop: unlike its
      // nine siblings here, it is a commonWord (see the compiledPacks
      // suite) — a bare scan with zero active domains and no bypass is
      // correctly SUPPRESSED entirely (no card at all), not just
      // defaulted to a sense. Its own prior-fallback ordering is
      // covered separately right below, the same way an explicit
      // dictionary lookup actually observes it (bypassCommonWordSuppression).
      const cases = [
        ["CAC", "CAC", "customer-acquisition-cost"],
        ["NDA", "NDA", "non-disclosure-agreement"],
        ["PR", "PR", "pull-request"],
        ["regression", "regression", "software-regression"],
        ["oral", "oral", "oral-administration"],
        ["PD", "PD", "product-development"],
        ["alignment", "alignment", "team-alignment"],
        ["ISO", "ISO", "iso-standards"],
        ["SAM", "SAM", "serviceable-addressable-market"],
      ] as const;

      for (const [text, headword, expectedSenseId] of cases) {
        const tracker = createDomainTracker();
        expect(tracker.activeDomains().size).toBe(0);
        const term = findTerm(scanSegment(tracker, text), headword);
        expect(term.senseId).toBe(expectedSenseId);
        expect(term.gloss_en.trim()).not.toBe("");
        expect(term.gloss_zh.trim()).not.toBe("");
      }
    });

    it("falls back to statistical-variance (higher prior) once commonWord suppression is bypassed", () => {
      // Mirrors how the real 划词 explicit-lookup caller always scans
      // (bypassCommonWordSuppression: true) — with no domain context at
      // all, the higher-prior sense (0.6 statistical vs 0.4 plan) wins.
      const res = scanDictionary("variance", null, { bypassCommonWordSuppression: true });
      const variance = findTerm(res, "variance");
      expect(variance.senseId).toBe("statistical-variance");
    });

    it("still resolves plan-variance once its own domain is active and suppression is bypassed", () => {
      // Same sales-domain evidence as the business/sales sequence test
      // below, but scanned the way an explicit 划词 lookup on "variance"
      // actually would (bypassCommonWordSuppression) — confirms the
      // multi-sense ranking itself is unaffected by the commonWord gate,
      // it only decides whether a card shows up AT ALL in ordinary
      // (non-bypassed) transcript detection.
      const res = scanDictionary("We added variance tracking.", null, {
        activeDomains: new Set(["sales"]),
        bypassCommonWordSuppression: true,
      });
      const variance = findTerm(res, "variance");
      expect(variance.senseId).toBe("plan-variance");
      expect(variance.gloss_zh).toBe("预算或计划差异");
    });

    it("uses a business/sales sequence for team alignment (plan-variance is covered separately)", () => {
      const tracker = createDomainTracker();
      const business = scanSegment(
        tracker,
        "COGS and EBITDA are the two dashboard metrics under review.",
      );
      expect(termNames(business)).toEqual(expect.arrayContaining(["COGS", "EBITDA"]));
      expect(tracker.activeDomains()).toContain("sales");

      const pd = findTerm(
        scanSegment(tracker, "PD Data Sciences met with the commercial team."),
        "PD",
      );
      expect(pd.senseId).toBe("product-development");
      expect(pd.gloss_zh).toBe("产品开发部门");

      // "variance" itself is NOT asserted here: its commonWord gate is
      // keyed to its OWN entry pack's domain ("stats" — see
      // shouldIncludeCommonWord, dictionary.ts), independent of which
      // SENSE would eventually win. A sales-only meeting with zero
      // stats vocabulary never activates "stats", so the term is
      // correctly suppressed outright — same restored-commonWord
      // behavior compiledPacks.test.ts pins, not a sense-selection
      // question. See the standalone bypass-suppression test above for
      // plan-variance's own sense-ranking coverage.

      const alignment = findTerm(
        scanSegment(tracker, "After the meeting, the team was aligned."),
        "alignment",
      );
      expect(alignment.senseId).toBe("team-alignment");
      expect(alignment.gloss_zh).toBe("团队对目标和方向达成一致");
    });

    it("resolves the sibling SAM collision from prior genomics evidence", () => {
      const tracker = createDomainTracker();
      const genomics = scanSegment(tracker, "The FASTQ and VCF files are ready.");
      expect(termNames(genomics)).toEqual(expect.arrayContaining(["FASTQ", "VCF"]));
      expect(tracker.activeDomains()).toContain("genomics");

      const sam = findTerm(
        scanSegment(tracker, "We wrote the aligned reads to SAM format."),
        "SAM",
      );
      expect(sam.senseId).toBe("sequence-alignment-map");
      expect(sam.gloss_zh).toBe("序列比对信息格式");
    });

    // Review finding (audit follow-up): iso-standards was tagged domain
    // "ops" ONLY, but no pack maps to "ops" in PACK_DOMAINS — that tag
    // can never win the tracker's 1.0 domain match on its own. The
    // roadmap's own "ninth trap ... any GMP/audit talk" scenario is a
    // compensation conversation (RSU/NSO -> "finance" active, boosting
    // the sibling incentive-stock-option sense) happening INSIDE a
    // GMP/audit meeting (IND/BLA -> "pharma" active) — without a
    // reachable altDomains tag, "finance"'s clean domain match used to
    // beat iso-standards' own 0.8 prior outright.
    it("keeps ISO as ISO-standards (not the stock-option sense) in a GMP/audit talk that also mentions compensation", () => {
      const tracker = createDomainTracker();
      const pharma = scanSegment(tracker, "The IND and BLA filings are under GMP audit.");
      expect(termNames(pharma)).toEqual(expect.arrayContaining(["IND", "BLA"]));
      expect(tracker.activeDomains()).toContain("pharma");

      const finance = scanSegment(tracker, "Compensation includes RSU and NSO grants.");
      expect(termNames(finance)).toEqual(expect.arrayContaining(["RSU", "NSO"]));
      expect(tracker.activeDomains()).toContain("finance");

      const iso = findTerm(scanSegment(tracker, "Every ISO certificate needs renewal this quarter."), "ISO");
      expect(iso.senseId).toBe("iso-standards");
      expect(iso.gloss_zh).toBe("国际标准化组织");
    });
  });

  // v0.7.9 detection audit: entry-level `domains` evidence — the pack-
  // level PACK_DOMAINS map deliberately leaves cross-domain packs
  // (modern-usage) unmapped, which used to mean an AI meeting saturated
  // with unambiguous modern-usage vocabulary never activated "ml" at
  // all, so the pack's own commonWord entries (agent, harness, wrapper,
  // compute, checkpoint…) could NEVER fire under the default all-on
  // pack state. Entries now carry their own evidence/unlock domains.
  describe("entry-level domain evidence (modern-usage AI meetings)", () => {
    it("two unambiguous modern-usage AI terms activate ml, unlocking the pack's own common words in later segments", () => {
      const tracker = createDomainTracker();

      const first = scanSegment(tracker, "Our RAG pipeline needs a bigger context window.");
      expect(termNames(first)).toEqual(expect.arrayContaining(["RAG", "context window"]));
      expect(tracker.activeDomains()).toContain("ml");

      const second = scanSegment(tracker, "The agent runs inside the harness with limited compute.");
      expect(termNames(second)).toEqual(expect.arrayContaining(["agent", "harness", "compute"]));
    });

    it("one modern-usage AI term is not enough — agent/harness stay suppressed below the threshold", () => {
      const tracker = createDomainTracker();
      scanSegment(tracker, "Our RAG pipeline is slow.");
      expect(tracker.activeDomains()).not.toContain("ml");

      const res = scanSegment(tracker, "The agent asked about the harness.");
      expect(termNames(res)).not.toContain("agent");
      expect(termNames(res)).not.toContain("harness");
    });

    it("an unambiguous evidence term carries its domains on the wire; a commonWord entry never does", () => {
      const tracker = createDomainTracker();
      const first = scanSegment(tracker, "Our RAG pipeline needs a bigger context window.");
      expect(findTerm(first, "RAG").domains).toEqual(["ml"]);

      const second = scanSegment(tracker, "The agent runs inside the harness.");
      expect(findTerm(second, "agent").domains).toBeUndefined();
      expect(findTerm(second, "harness").domains).toBeUndefined();
    });

    it("commonWord hits never count toward activating a SECOND domain (everyday senses are not evidence)", () => {
      const tracker = createDomainTracker();
      // Activate ml the legitimate way…
      scanSegment(tracker, "Our RAG pipeline needs a bigger context window.");
      // …then have commonWord entries with sales/finance unlock lists
      // fire; their own hits must not creep toward activating those.
      scanSegment(tracker, "The agent uses leverage on the checkpoint.");
      scanSegment(tracker, "That unicorn has leverage too.");
      expect(tracker.activeDomains()).not.toContain("sales");
      expect(tracker.activeDomains()).not.toContain("finance");
    });

    it("unambiguous core business metrics activate sales, strengthening multi-sense picks like team alignment", () => {
      const tracker = createDomainTracker();
      const biz = scanSegment(tracker, "Our ARR is up but the GTM plan needs work.");
      expect(termNames(biz)).toEqual(expect.arrayContaining(["ARR", "GTM"]));
      expect(tracker.activeDomains()).toContain("sales");

      const alignment = findTerm(
        scanSegment(tracker, "After the meeting, the team was aligned."),
        "alignment",
      );
      expect(alignment.senseId).toBe("team-alignment");
    });

    it("a funding conversation activates finance, unlocking finance-consumer common words", () => {
      const tracker = createDomainTracker();
      const funding = scanSegment(tracker, "After the Series B we cleaned up the P&L.");
      expect(termNames(funding)).toEqual(expect.arrayContaining(["Series B", "P&L"]));
      expect(tracker.activeDomains()).toContain("finance");

      const res = scanSegment(tracker, "Watch out for dilution of your shares.");
      expect(termNames(res)).toContain("dilution");
    });

    it("modern-usage common words STILL fire via the explicit-enable path with no active domain (unchanged behavior)", () => {
      const res = scanDictionary("The agent can coordinate the workflow.", ["modern-usage"]);
      expect(termNames(res)).toContain("agent");
    });
  });

  describe("createDomainTracker — entry-level domains mechanics", () => {
    it("counts a term toward EVERY listed domain", () => {
      const tracker = createDomainTracker();
      tracker.observe({
        terms: [
          { term: "aaa", type: "other", gloss_en: "", gloss_zh: "x", domains: ["ml", "software"] },
          { term: "bbb", type: "other", gloss_en: "", gloss_zh: "x", domains: ["ml", "software"] },
        ],
      });
      expect(tracker.activeDomains()).toContain("ml");
      expect(tracker.activeDomains()).toContain("software");
    });

    it("ignores unrecognized domain strings from the loosely-typed wire field", () => {
      const tracker = createDomainTracker();
      tracker.observe({
        terms: [
          { term: "aaa", type: "other", gloss_en: "", gloss_zh: "x", domains: ["not-a-domain"] },
          { term: "bbb", type: "other", gloss_en: "", gloss_zh: "x", domains: ["also-bogus"] },
        ],
      });
      expect(tracker.activeDomains().size).toBe(0);
    });

    it("entry-level domains take precedence over the pack fallback; a term with neither contributes nothing", () => {
      const tracker = createDomainTracker();
      tracker.observe({
        terms: [
          // pack maps to pharma, but the entry says stats — entry wins.
          { term: "aaa", type: "other", gloss_en: "", gloss_zh: "x", pack: "pharma-biotech", domains: ["stats"] },
          { term: "bbb", type: "other", gloss_en: "", gloss_zh: "x", pack: "pharma-biotech", domains: ["stats"] },
          { term: "ccc", type: "other", gloss_en: "", gloss_zh: "x" },
        ],
      });
      expect(tracker.activeDomains()).toContain("stats");
      expect(tracker.activeDomains()).not.toContain("pharma");
    });

    it("the same headword repeated only ever counts once per domain", () => {
      const tracker = createDomainTracker();
      for (let i = 0; i < 5; i++) {
        tracker.observe({
          terms: [{ term: "RAG", type: "other", gloss_en: "", gloss_zh: "x", domains: ["ml"] }],
        });
      }
      expect(tracker.activeDomains()).not.toContain("ml");
    });
  });
});
