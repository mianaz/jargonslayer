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

    it("falls back to a usable higher-prior sense for every affected headword", () => {
      const cases = [
        ["CAC", "CAC", "customer-acquisition-cost"],
        ["NDA", "NDA", "non-disclosure-agreement"],
        ["PR", "PR", "pull-request"],
        ["regression", "regression", "software-regression"],
        ["oral", "oral", "oral-administration"],
        ["PD", "PD", "product-development"],
        ["variance", "variance", "statistical-variance"],
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

    it("uses a business/sales sequence for plan variance and team alignment", () => {
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

      const variance = findTerm(scanSegment(tracker, "We added variance tracking."), "variance");
      expect(variance.senseId).toBe("plan-variance");
      expect(variance.gloss_zh).toBe("预算或计划差异");

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
  });
});
