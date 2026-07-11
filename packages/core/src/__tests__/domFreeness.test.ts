// #53 core extraction — DOM-freeness proof. This suite runs under
// plain node (no jsdom — see vitest.config.ts's `environment: "node"`,
// which this whole package uses unconditionally, unlike apps/web's
// per-file jsdom opt-in via a docblock pragma comment on individual
// test files that need it). Two things are asserted:
// NOTE: deliberately not spelling out that pragma literally in this
// comment — Vitest's docblock detection scans a test file's raw text
// for it anywhere, not just in a leading docblock, so writing it out
// here would silently switch THIS file's own environment to jsdom.
//  1. `document`/`window` are genuinely absent from this runtime, so
//     the second assertion below actually proves something.
//  2. EVERY module this package exports (its "./*" wildcard subpath
//     map in package.json — i.e. everything a consumer could import as
//     @jargonslayer/core/<path>) loads cleanly here AND runs a
//     representative call: no top-level react/next/zustand/idb-keyval
//     import, and no code path that reaches for `document`/`window`,
//     since any of those would throw or fail to resolve in this
//     DOM-free environment.
// This is a supplement to (not a replacement for) the grep check in
// PLAN-v0.4 S1's verification matrix — grep catches source text, this
// catches anything that only breaks at actual module-evaluation/call
// time.
import { describe, expect, it } from "vitest";
import * as types from "../types";
import * as dictionaryData from "../detect/dictionary-data";
import * as dictionary from "../detect/dictionary";
import * as dedupe from "../detect/dedupe";
import * as packs from "../detect/packs";
import * as remotePacksRegistry from "../detect/remotePacksRegistry";
import * as glossaryLookup from "../history/glossaryLookup";
import * as learnTypes from "../learn/types";
import * as srs from "../learn/srs";
import * as queue from "../learn/queue";
import * as keys from "../learn/keys";
import * as prompts from "../llm/prompts";
import * as profileHint from "../llm/profileHint";

describe("core package is DOM-free", () => {
  it("this test environment genuinely has no document/window globals", () => {
    // Accessed via globalThis (not the bare identifiers) on purpose:
    // this package's tsconfig.json deliberately omits the "dom" lib
    // (see that file's comment) so a bare `document`/`window`
    // reference anywhere else in this package fails typecheck as an
    // undefined name — this is the one file allowed to ask "does this
    // global exist at all", so it must not need "dom" lib itself.
    const g = globalThis as Record<string, unknown>;
    expect(typeof g.document).toBe("undefined");
    expect(typeof g.window).toBe("undefined");
  });

  it("every core entry point loaded (static import above) with a truthy module object", () => {
    for (const m of [
      types,
      dictionaryData,
      dictionary,
      dedupe,
      packs,
      remotePacksRegistry,
      glossaryLookup,
      learnTypes,
      srs,
      queue,
      keys,
      prompts,
      profileHint,
    ]) {
      expect(m).toBeTruthy();
    }
  });

  it("a representative call into each module runs without a DOM (spot-check, not full behavior coverage — see each module's own test file for that)", () => {
    expect(() => dictionary.scanDictionary("circle back")).not.toThrow();
    expect(() => packs.getAllPacks()).not.toThrow();
    expect(() => remotePacksRegistry.getLoadedRemotePacks()).not.toThrow();
    expect(() => glossaryLookup.findEntryBySurface("x")).not.toThrow();
    expect(() => keys.learnKey("term", "ARR")).not.toThrow();
    expect(() => dedupe.normalizeKey("Circle Back")).not.toThrow();
    expect(() => queue.dueLearnRecords({}, Date.now())).not.toThrow();
    expect(() =>
      srs.schedule(
        {
          learnKey: "expression:circle back",
          kind: "expression",
          surface: "circle back",
          familiarity: 0,
          suppressed: false,
          reps: 0,
          intervalDays: 0,
          ease: 2.5,
          dueAt: Date.now(),
          lapses: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        2,
        Date.now(),
      ),
    ).not.toThrow();
    expect(() => prompts.buildDetectSystemPrompt("zh")).not.toThrow();
    expect(() => profileHint.renderProfileHint({ enabled: false })).not.toThrow();
    expect(() => types.newId()).not.toThrow();
    expect(dictionaryData.EXTRA_EXPRESSIONS.length).toBeGreaterThan(0);
    expect(learnTypes).toBeTruthy(); // type-only module — no runtime exports to call
  });
});
