import { describe, expect, it } from "vitest";
import { scanDictionary } from "../../detect/dictionary";
import { mergeDetections } from "../../detect/dedupe";
import { learnKey } from "../store";

describe("learnKey detection parity", () => {
  it("matches expression normKey produced by scanDictionary + mergeDetections", () => {
    const res = scanDictionary("Let's circle back on the roadmap.");
    const { cards } = mergeDetections([], [], res, "dictionary", 0.5, 1000);

    expect(cards).toHaveLength(1);
    expect(learnKey("expression", cards[0].expression)).toBe(
      `expression:${cards[0].normKey}`,
    );
  });

  it("matches term normKey produced by scanDictionary + mergeDetections", () => {
    const res = scanDictionary("Our ARR is the north star metric.");
    const { terms } = mergeDetections([], [], res, "dictionary", 0.5, 1000);

    expect(terms.some((term) => term.term === "ARR")).toBe(true);
    const arr = terms.find((term) => term.term === "ARR");
    expect(arr).toBeDefined();
    expect(learnKey("term", arr!.term)).toBe(`term:${arr!.normKey}`);
  });
});
