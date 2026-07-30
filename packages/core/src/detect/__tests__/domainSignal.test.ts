import { describe, expect, it } from "vitest";
import { mergeDetections } from "../dedupe";
import { packTermsForBias, scanDictionary } from "../dictionary";
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
});
