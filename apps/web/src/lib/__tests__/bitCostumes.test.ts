// F2 HIGH (v0.5.1 Bit sprint fix round, GPT-5.6 Sol adversarial review):
// isBitCostumeId used `v in BIT_COSTUMES` — the `in` operator walks the
// WHOLE prototype chain, so "__proto__"/"constructor"/"toString" all
// read as "present" via Object.prototype's own inherited members, even
// though none of them are BIT_COSTUMES' own keys. THEME_COSTUME[themeId]
// inside resolveBitCostume has the identical hole. A hostile string from
// either input (Settings.bitCostume via a restored backup, or a themeId)
// then resolves to an inherited value (Object.prototype itself for
// "__proto__", the Object constructor function for "constructor") instead
// of null, which explodes downstream (BIT_COSTUMES[id] returns a
// non-CostumeLayers object with no .awake/.sleep/.bellyup — Rects' own
// `px.map` then throws on the undefined layer). Object.hasOwn is the
// fix: it only ever answers for the object's OWN keys, never the
// prototype chain.

import { describe, expect, it } from "vitest";
import { BIT_COSTUMES, THEME_COSTUME, isBitCostumeId, resolveBitCostume } from "../bitCostumes";

const HOSTILE_STRINGS = ["__proto__", "constructor", "toString"] as const;

describe("isBitCostumeId — prototype-property hole (F2)", () => {
  it("rejects inherited Object.prototype member names", () => {
    for (const s of HOSTILE_STRINGS) {
      expect(isBitCostumeId(s)).toBe(false);
    }
  });

  it("still accepts every real costume id (own keys, unaffected by the fix)", () => {
    for (const id of Object.keys(BIT_COSTUMES)) {
      expect(isBitCostumeId(id)).toBe(true);
    }
  });

  it("rejects an unknown-but-plausible id and non-string input", () => {
    expect(isBitCostumeId("nonexistent")).toBe(false);
    expect(isBitCostumeId(undefined)).toBe(false);
    expect(isBitCostumeId(42)).toBe(false);
  });
});

describe("resolveBitCostume — hostile setting/themeId strings (F2)", () => {
  it("a hostile `setting` (Settings.bitCostume) resolves to null, not an inherited value", () => {
    for (const s of HOSTILE_STRINGS) {
      expect(resolveBitCostume(s, "terminal")).toBeNull();
    }
  });

  it('resolveBitCostume("auto", "constructor") resolves to null, not the inherited Object constructor', () => {
    expect(resolveBitCostume("auto", "constructor")).toBeNull();
  });

  it('resolveBitCostume("auto", "__proto__") resolves to null, not Object.prototype itself', () => {
    expect(resolveBitCostume("auto", "__proto__")).toBeNull();
  });

  it("a hostile themeId under \"auto\" never yields a BIT_COSTUMES key that BIT_COSTUMES[...] would mis-resolve", () => {
    for (const s of HOSTILE_STRINGS) {
      const id = resolveBitCostume("auto", s);
      expect(id).toBeNull();
    }
  });

  it("legitimate resolution is unaffected by the fix: auto + a builtin theme still maps through THEME_COSTUME", () => {
    expect(resolveBitCostume("auto", "grimoire")).toBe("wizard");
    expect(resolveBitCostume("auto", "8bit")).toBe("hero");
    // terminal/custom themes stay bare (absent from THEME_COSTUME).
    expect(resolveBitCostume("auto", "terminal")).toBeNull();
  });

  it("legitimate resolution is unaffected by the fix: none / a real manual override", () => {
    expect(resolveBitCostume("none", "grimoire")).toBeNull();
    expect(resolveBitCostume("hero", "grimoire")).toBe("hero");
  });
});

describe("THEME_COSTUME — own-key lookup only (F2, direct index check)", () => {
  it("has no inherited-name collision for the hostile strings (Object.hasOwn view)", () => {
    for (const s of HOSTILE_STRINGS) {
      expect(Object.hasOwn(THEME_COSTUME, s)).toBe(false);
    }
  });
});
