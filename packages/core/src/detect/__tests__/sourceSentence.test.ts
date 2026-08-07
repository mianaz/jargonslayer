// Direct coverage for detect/sourceSentence.ts — until now the module
// was exercised only transitively (dictionary.test.ts / dedupe.test.ts)
// even though it is the one shared narrowing rule three consumers across
// two workspaces depend on (detect/dictionary.ts, detect/dedupe.ts, and
// apps/web's llm/tasks/detect.ts post-filter). These tests pin the
// boundary behavior those callers assume: sentence → clause → word-safe
// window, and never inventing context for a match the text doesn't
// contain.
import { describe, expect, it } from "vitest";
import {
  MAX_SOURCE_SENTENCE_CHARS,
  narrowSourceSentence,
} from "../sourceSentence";

// Unique numbered words so a mid-word cut at a window edge would produce
// a fragment that provably isn't in the source's own word list.
function words(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}x`).join(" ");
}

describe("MAX_SOURCE_SENTENCE_CHARS", () => {
  it("stays pinned at 240 — consumers size card context around it", () => {
    expect(MAX_SOURCE_SENTENCE_CHARS).toBe(240);
  });
});

describe("narrowSourceSentence — degenerate inputs", () => {
  it("returns the trimmed source unchanged when the match is absent", () => {
    expect(narrowSourceSentence("  We should sync up. ", "runway")).toBe(
      "We should sync up.",
    );
  });

  it("returns the trimmed source unchanged for an empty match", () => {
    expect(narrowSourceSentence(" A. B. ", "  ")).toBe("A. B.");
  });

  it("returns empty for empty text", () => {
    expect(narrowSourceSentence("   ", "anything")).toBe("");
  });
});

describe("narrowSourceSentence — sentence extraction", () => {
  it("returns just the sentence containing the match, punctuation included", () => {
    const text = "Alpha beta. The quick fox jumped over it. Omega gamma.";
    expect(narrowSourceSentence(text, "fox jumped")).toBe(
      "The quick fox jumped over it.",
    );
  });

  it("matches case-insensitively but preserves the source's own casing", () => {
    const text = "Intro sentence. We should TABLE This for now. Outro.";
    expect(narrowSourceSentence(text, "table this")).toBe(
      "We should TABLE This for now.",
    );
  });

  it("runs to the end of text when the last sentence has no terminator", () => {
    const text = "Done part. so we need more runway before the raise";
    expect(narrowSourceSentence(text, "runway")).toBe(
      "so we need more runway before the raise",
    );
  });

  it("treats ? and ! as sentence boundaries too", () => {
    const text = "Really? Can we move the needle here! Sure.";
    expect(narrowSourceSentence(text, "move the needle")).toBe(
      "Can we move the needle here!",
    );
  });
});

describe("narrowSourceSentence — clause fallback for run-on sentences", () => {
  it("narrows an over-budget sentence to the comma/semicolon clause around the match", () => {
    const filler = words("w", 60); // ~300 chars, no punctuation
    const text = `${filler}, the target phrase here, ${words("v", 60)}.`;
    expect(narrowSourceSentence(text, "target phrase")).toBe(
      "the target phrase here,",
    );
  });

  it("keeps a clause-narrowed result within a short sentence untouched when the sentence fits", () => {
    // Sentence under budget → clause logic must NOT fire; commas stay.
    const text = "First bit, the target phrase here, last bit.";
    expect(narrowSourceSentence(text, "target phrase")).toBe(
      "First bit, the target phrase here, last bit.",
    );
  });
});

describe("narrowSourceSentence — bounded word-safe window", () => {
  it("cuts an unpunctuated run-on to <= budget without splitting words", () => {
    const source = `${words("a", 50)} NEEDLE0x NEEDLE1x ${words("b", 50)}`;
    const result = narrowSourceSentence(source, "NEEDLE0x NEEDLE1x");

    expect(result).toContain("NEEDLE0x NEEDLE1x");
    expect(result.length).toBeLessThanOrEqual(MAX_SOURCE_SENTENCE_CHARS);
    expect(source).toContain(result); // substring of the real transcript

    const sourceWords = new Set(source.split(/\s+/));
    for (const w of result.split(/\s+/)) {
      expect(sourceWords).toContain(w); // no fragment from a mid-word cut
    }
  });

  it("keeps the entire matched surface even when the match alone exceeds the budget", () => {
    const giant = `m${"id".repeat(150)}m`; // ~300 chars, one "word"
    const source = `${words("a", 40)} ${giant} ${words("b", 40)}`;
    const result = narrowSourceSentence(source, giant);
    expect(result).toContain(giant);
  });
});
