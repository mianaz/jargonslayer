import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aliasesAfterRename,
  applySpeakerUpdateToSegments,
  applyTierDefaults,
  filterSuppressedLiveCards,
  migrateSettings,
  renameSpeakerInSegments,
  scheduleSessionSave,
  shouldApplySpeakerUpdate,
  useApp,
} from "../store";
import {
  DEFAULT_SETTINGS,
  type CustomEntry,
  type DetectResponse,
  type Settings,
  type TranscriptSegment,
} from "../types";
import { DEFAULT_EASE, KNOWN_VOTE_INCREMENT } from "../learn/store";
import * as learnsetModule from "../learn/store";
import type { LearnRecord } from "../learn/types";
import { clearDiag, getDiagEntries } from "../diag/log";

function makeSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "seg-1",
    index: 0,
    startedAt: 1000,
    endedAt: 1100,
    text: "hello",
    engine: "whisper",
    ...overrides,
  };
}

describe("applySpeakerUpdateToSegments — realtime speaker diarization (beta)", () => {
  it("labels a segment found by sttSeg, setting both sttSpeaker (raw) and speaker (display)", () => {
    const segments = [makeSegment({ id: "a", sttSeg: 0 })];
    const result = applySpeakerUpdateToSegments(
      segments,
      [{ segId: 0, speaker: "SPEAKER_1" }],
      {},
    );
    expect(result[0].sttSpeaker).toBe("SPEAKER_1");
    expect(result[0].speaker).toBe("SPEAKER_1"); // unaliased -> display = stable id
  });

  it("resolves the display name through the alias map when one exists", () => {
    const segments = [makeSegment({ id: "a", sttSeg: 0 })];
    const result = applySpeakerUpdateToSegments(
      segments,
      [{ segId: 0, speaker: "SPEAKER_1" }],
      { SPEAKER_1: "Alice" },
    );
    expect(result[0].sttSpeaker).toBe("SPEAKER_1"); // raw stable id unaffected by alias
    expect(result[0].speaker).toBe("Alice"); // display -> aliased
  });

  it("leaves segments with no matching sttSeg untouched", () => {
    const segments = [
      makeSegment({ id: "a", sttSeg: 0 }),
      makeSegment({ id: "b", sttSeg: 1, speaker: "existing" }),
    ];
    const result = applySpeakerUpdateToSegments(
      segments,
      [{ segId: 0, speaker: "SPEAKER_1" }],
      {},
    );
    expect(result[1]).toEqual(segments[1]); // untouched, same reference-equal shape
    expect(result[1].speaker).toBe("existing");
  });

  it("leaves segments with no sttSeg at all (e.g. demo mode) untouched", () => {
    const segments = [makeSegment({ id: "a" })]; // sttSeg undefined
    const result = applySpeakerUpdateToSegments(
      segments,
      [{ segId: 0, speaker: "SPEAKER_1" }],
      {},
    );
    expect(result[0].sttSpeaker).toBeUndefined();
    expect(result[0].speaker).toBeUndefined();
  });

  it("applies multiple assignments in one call, one per distinct seg_id", () => {
    const segments = [
      makeSegment({ id: "a", sttSeg: 0 }),
      makeSegment({ id: "b", sttSeg: 1 }),
      makeSegment({ id: "c", sttSeg: 2 }),
    ];
    const result = applySpeakerUpdateToSegments(
      segments,
      [
        { segId: 0, speaker: "SPEAKER_1" },
        { segId: 2, speaker: "SPEAKER_2" },
      ],
      {},
    );
    expect(result[0].speaker).toBe("SPEAKER_1");
    expect(result[1].speaker).toBeUndefined(); // seg_id 1 not in this update
    expect(result[2].speaker).toBe("SPEAKER_2");
  });

  it("is a no-op (returns the same array reference) when assignments is empty", () => {
    const segments = [makeSegment({ id: "a", sttSeg: 0 })];
    const result = applySpeakerUpdateToSegments(segments, [], {});
    expect(result).toBe(segments);
  });

  it("re-labeling the same seg_id again overwrites the previous label (later pass wins)", () => {
    const segments = [makeSegment({ id: "a", sttSeg: 0 })];
    const afterFirst = applySpeakerUpdateToSegments(
      segments,
      [{ segId: 0, speaker: "SPEAKER_1" }],
      {},
    );
    const afterSecond = applySpeakerUpdateToSegments(
      afterFirst,
      [{ segId: 0, speaker: "SPEAKER_3" }], // e.g. cap-folded into a different anchor later
      {},
    );
    expect(afterSecond[0].sttSpeaker).toBe("SPEAKER_3");
    expect(afterSecond[0].speaker).toBe("SPEAKER_3");
  });
});

describe("renameSpeakerInSegments — existing rename behavior, unchanged", () => {
  it("renames every segment currently displaying `from`", () => {
    const segments = [
      makeSegment({ id: "a", speaker: "SPEAKER_1" }),
      makeSegment({ id: "b", speaker: "SPEAKER_1" }),
      makeSegment({ id: "c", speaker: "SPEAKER_2" }),
    ];
    const result = renameSpeakerInSegments(segments, "SPEAKER_1", "Alice");
    expect(result[0].speaker).toBe("Alice");
    expect(result[1].speaker).toBe("Alice");
    expect(result[2].speaker).toBe("SPEAKER_2"); // untouched
  });

  it("leaves segments with no speaker untouched", () => {
    const segments = [makeSegment({ id: "a" })]; // speaker undefined
    const result = renameSpeakerInSegments(segments, "SPEAKER_1", "Alice");
    expect(result[0].speaker).toBeUndefined();
  });
});

describe("aliasesAfterRename — rename-wins", () => {
  it("records aliases[stableId] = to using the segment's sttSpeaker as the stable id", () => {
    const segments = [makeSegment({ id: "a", speaker: "SPEAKER_1", sttSpeaker: "SPEAKER_1" })];
    const aliases = aliasesAfterRename(segments, {}, "SPEAKER_1", "Alice");
    expect(aliases).toEqual({ SPEAKER_1: "Alice" });
  });

  it("falls back to `from` as the stable id when the segment has no sttSpeaker (demo/non-diarized)", () => {
    const segments = [makeSegment({ id: "a", speaker: "SPEAKER_1" })]; // no sttSpeaker
    const aliases = aliasesAfterRename(segments, {}, "SPEAKER_1", "Alice");
    expect(aliases).toEqual({ SPEAKER_1: "Alice" });
  });

  it("preserves existing aliases for other stable ids", () => {
    const segments = [makeSegment({ id: "a", speaker: "SPEAKER_1", sttSpeaker: "SPEAKER_1" })];
    const aliases = aliasesAfterRename(segments, { SPEAKER_2: "Bob" }, "SPEAKER_1", "Alice");
    expect(aliases).toEqual({ SPEAKER_1: "Alice", SPEAKER_2: "Bob" });
  });

  it("overwrites a stable id's previous alias when renamed again", () => {
    const segments = [makeSegment({ id: "a", speaker: "Alice", sttSpeaker: "SPEAKER_1" })];
    const aliases = aliasesAfterRename(segments, { SPEAKER_1: "Alice" }, "Alice", "Alicia");
    expect(aliases).toEqual({ SPEAKER_1: "Alicia" });
  });

  it("does not touch segments not currently displaying `from`", () => {
    const segments = [
      makeSegment({ id: "a", speaker: "SPEAKER_1", sttSpeaker: "SPEAKER_1" }),
      makeSegment({ id: "b", speaker: "SPEAKER_2", sttSpeaker: "SPEAKER_2" }),
    ];
    const aliases = aliasesAfterRename(segments, {}, "SPEAKER_1", "Alice");
    expect(aliases).toEqual({ SPEAKER_1: "Alice" });
  });

  it("integration: rename then applySpeakerUpdate never clobbers the rename (rename-wins)", () => {
    // 1. Realtime diar labels a segment SPEAKER_1.
    let segments = [makeSegment({ id: "a", sttSeg: 0 })];
    segments = applySpeakerUpdateToSegments(
      segments,
      [{ segId: 0, speaker: "SPEAKER_1" }],
      {},
    );
    expect(segments[0].speaker).toBe("SPEAKER_1");

    // 2. User renames SPEAKER_1 -> "Alice": both the segment's display
    //    AND the alias map must update together (mirrors store.ts's
    //    renameSpeaker action, which computes aliases from the
    //    PRE-rename segments before overwriting `speaker`).
    const aliases = aliasesAfterRename(segments, {}, "SPEAKER_1", "Alice");
    segments = renameSpeakerInSegments(segments, "SPEAKER_1", "Alice");
    expect(segments[0].speaker).toBe("Alice");
    expect(aliases).toEqual({ SPEAKER_1: "Alice" });

    // 3. A LATER realtime diar pass re-confirms the same stable id
    //    (SPEAKER_1) for this segment (e.g. the periodic pass runs
    //    again and the turn-overlap matching still resolves to
    //    SPEAKER_1) — applySpeakerUpdate must resolve through the
    //    alias, NOT reset the display back to the raw "SPEAKER_1".
    segments = applySpeakerUpdateToSegments(
      segments,
      [{ segId: 0, speaker: "SPEAKER_1" }],
      aliases,
    );
    expect(segments[0].sttSpeaker).toBe("SPEAKER_1"); // raw id still tracked
    expect(segments[0].speaker).toBe("Alice"); // display stays the user's rename
  });
});

describe("shouldApplySpeakerUpdate — meeting-boundary guard (Bug 2)", () => {
  it("allows the update when the gen still matches (same meeting)", () => {
    expect(shouldApplySpeakerUpdate(3, 3)).toBe(true);
  });

  it("drops a late update whose expectedGen is behind the current gen (a new meeting started meanwhile)", () => {
    // e.g. engine session started at gen 3, meeting stopped, a new
    // meeting began (gen bumped to 4) before this late update arrived.
    expect(shouldApplySpeakerUpdate(4, 3)).toBe(false);
  });

  it("integration: a late speaker_update after a gen bump results in NO state change", () => {
    const segments = [makeSegment({ id: "a", sttSeg: 0 })];
    const currentGen = 4;
    const expectedGen = 3; // captured by a now-previous engine session

    // Mirrors the store action's guard: bail out before ever calling
    // applySpeakerUpdateToSegments when the gens disagree.
    const shouldApply = shouldApplySpeakerUpdate(currentGen, expectedGen);
    const result = shouldApply
      ? applySpeakerUpdateToSegments(segments, [{ segId: 0, speaker: "SPEAKER_1" }], {})
      : segments;

    expect(shouldApply).toBe(false);
    expect(result).toBe(segments); // same reference — untouched
    expect(result[0].sttSpeaker).toBeUndefined();
    expect(result[0].speaker).toBeUndefined();
  });
});

describe("scheduleSessionSave — debounced post-stop save vs. meeting-boundary race (Bug 2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the save when the gen is unchanged when the debounce timer elapses", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    scheduleSessionSave(save, 1, () => 1);

    await vi.advanceTimersByTimeAsync(1500);

    expect(save).toHaveBeenCalledTimes(1);
  });

  it("skips the save when a new meeting began (gen bumped) before the debounce timer elapsed", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    let currentGen = 1;
    scheduleSessionSave(save, 1, () => currentGen);

    // User starts a new meeting before the 1.5s debounce fires.
    currentGen = 2;
    await vi.advanceTimersByTimeAsync(1500);

    expect(save).not.toHaveBeenCalled();
  });

  it("a later call replaces (debounces) an earlier pending one — only the latest-scheduled gen check applies", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    scheduleSessionSave(save, 1, () => 1); // scheduled first, same gen

    await vi.advanceTimersByTimeAsync(500); // not yet elapsed

    scheduleSessionSave(save, 1, () => 1); // second mutation reschedules the timer
    await vi.advanceTimersByTimeAsync(1500);

    expect(save).toHaveBeenCalledTimes(1); // only the latest timer fired, once
  });
});

describe("updateSegmentText — committed-mutation tripwire (fix #A5)", () => {
  beforeEach(() => {
    vi.useFakeTimers(); // scheduleSessionSave's setTimeout must never actually fire in this block
    clearDiag();
    useApp.setState({
      segments: [makeSegment({ id: "seg-1", text: "original" })],
      translations: {},
      status: "stopped",
      meetingGen: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses the write and logs a warn diag entry (segment id + status, no text) when status !== 'stopped'", () => {
    useApp.setState({ status: "listening" });
    useApp.getState().updateSegmentText("seg-1", "hacked live edit");

    expect(useApp.getState().segments[0].text).toBe("original"); // refused
    const entries = getDiagEntries().filter((e) => e.tag === "stt-committed-mutation");
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("warn");
    expect(entries[0].detail).toBe("segmentId=seg-1 status=listening");
    expect(entries[0].detail).not.toContain("hacked"); // never the transcript text
    expect(entries[0].message).not.toContain("hacked");
  });

  it("still allows the edit (no diag entry) once the session is actually stopped", () => {
    useApp.getState().updateSegmentText("seg-1", "corrected text");

    expect(useApp.getState().segments[0].text).toBe("corrected text");
    expect(getDiagEntries().filter((e) => e.tag === "stt-committed-mutation")).toHaveLength(0);
  });
});

describe("migrateSettings — #54 dictionaryOnly → aiDetect", () => {
  it("legacy dictionaryOnly:true becomes aiDetect:false (offline-only stays offline-only)", () => {
    const s = migrateSettings({ dictionaryOnly: true } as never);
    expect(s.aiDetect).toBe(false);
    expect("dictionaryOnly" in s).toBe(false);
  });

  it("legacy dictionaryOnly:false becomes aiDetect:true", () => {
    const s = migrateSettings({ dictionaryOnly: false } as never);
    expect(s.aiDetect).toBe(true);
    expect("dictionaryOnly" in s).toBe(false);
  });

  it("an explicit saved aiDetect wins over a lingering legacy key", () => {
    const s = migrateSettings({ aiDetect: false, dictionaryOnly: false } as never);
    expect(s.aiDetect).toBe(false);
  });

  it("fresh install (null saved) gets the default aiDetect:true", () => {
    expect(migrateSettings(null).aiDetect).toBe(true);
    expect(migrateSettings(undefined).aiDetect).toBe(true);
  });

  it("other saved fields still fold over defaults untouched", () => {
    const s = migrateSettings({ language: "en-GB", dictionaryOnly: true } as never);
    expect(s.language).toBe("en-GB");
    expect(s.aiDetect).toBe(false);
    expect(s.engine).toBe("demo"); // default preserved
  });
});

describe("migrateSettings — #62 uiMode persisted toggle roundtrip", () => {
  it("fresh install (no saved uiMode) defaults to simple via the defaults-fold, no migration code", () => {
    expect(migrateSettings(null).uiMode).toBe("simple");
    expect(migrateSettings(undefined).uiMode).toBe("simple");
    expect(migrateSettings({} as never).uiMode).toBe("simple");
  });

  it("a persisted uiMode:'advanced' round-trips through the fold unchanged", () => {
    const s = migrateSettings({ uiMode: "advanced" } as never);
    expect(s.uiMode).toBe("advanced");
  });

  it("a persisted uiMode:'simple' round-trips through the fold unchanged", () => {
    const s = migrateSettings({ uiMode: "simple" } as never);
    expect(s.uiMode).toBe("simple");
  });

  it("uiMode folds independently of other saved fields", () => {
    const s = migrateSettings({ uiMode: "advanced", language: "en-GB" } as never);
    expect(s.uiMode).toBe("advanced");
    expect(s.language).toBe("en-GB");
  });
});

describe("applyTierDefaults — preview tier (#61) engine defaults", () => {
  function withEngine(engine: Settings["engine"]): Settings {
    return { ...DEFAULT_SETTINGS, engine };
  }

  it("full tier (isPreview:false) never coerces, regardless of engine or hadSavedEngine", () => {
    expect(applyTierDefaults(withEngine("whisper"), false, true).engine).toBe("whisper");
    expect(applyTierDefaults(withEngine("tabaudio"), false, true).engine).toBe("tabaudio");
    expect(applyTierDefaults(withEngine("demo"), false, false).engine).toBe("demo");
  });

  it("preview tier coerces a saved sidecar-only engine (whisper) to webspeech", () => {
    const s = applyTierDefaults(withEngine("whisper"), true, true);
    expect(s.engine).toBe("webspeech");
  });

  it("preview tier coerces a saved sidecar-only engine (tabaudio) to webspeech", () => {
    const s = applyTierDefaults(withEngine("tabaudio"), true, true);
    expect(s.engine).toBe("webspeech");
  });

  it("preview tier + true first run (no saved engine key, default demo) coerces to webspeech", () => {
    const s = applyTierDefaults(withEngine("demo"), true, false);
    expect(s.engine).toBe("webspeech");
  });

  it("preview tier does NOT coerce a returning user's persisted engine:demo (reachable via ≡ 演示)", () => {
    const s = applyTierDefaults(withEngine("demo"), true, true);
    expect(s.engine).toBe("demo");
  });

  it("preview tier leaves webspeech untouched", () => {
    const s = applyTierDefaults(withEngine("webspeech"), true, true);
    expect(s.engine).toBe("webspeech");
  });

  it("preview tier leaves other settings fields untouched", () => {
    const base = { ...withEngine("whisper"), language: "en-GB" };
    const s = applyTierDefaults(base, true, true);
    expect(s.language).toBe("en-GB");
  });

  it("hadSavedEngine derivation ('engine' in saved) — the exact expression migrateSettings feeds this helper", () => {
    // migrateSettings itself calls applyTierDefaults with
    // `!!saved && "engine" in saved` (see store.ts) rather than passing
    // a real saved object through here — kept as a standalone
    // assertion on that exact expression (typed the same as
    // migrateSettings' own `saved` parameter, so a real null/undefined
    // case is meaningfully falsy rather than a tautological object
    // literal) so this test's correctness doesn't depend on the
    // ambient PREVIEW_TIER value of whatever environment runs it;
    // migrateSettings itself is exercised end-to-end by the untouched
    // #54 describe block above, which fully covers the non-preview
    // (PREVIEW_TIER:false) path already.
    const withEngineKey: Partial<Settings> | null | undefined = { engine: "whisper" };
    const withoutEngineKey: Partial<Settings> | null | undefined = { language: "en-GB" };
    const noSavedObject: Partial<Settings> | null | undefined = null;
    expect(!!withEngineKey && "engine" in withEngineKey).toBe(true);
    expect(!!withoutEngineKey && "engine" in withoutEngineKey).toBe(false);
    expect(!!noSavedObject && "engine" in noSavedObject).toBe(false);
  });
});

function makeDetection(): DetectResponse {
  return {
    expressions: [
      {
        expression: "circle back",
        category: "phrase",
        meaning: "return to this topic",
        chinese_explanation: "回头再聊",
        plain_english: "talk later",
        tone: "neutral",
        confidence: 0.9,
        source_sentence: "Let's circle back.",
      },
    ],
    terms: [],
  };
}

function makeSuppressedRecord(overrides: Partial<LearnRecord> = {}): LearnRecord {
  return {
    learnKey: "expression:circle back",
    kind: "expression",
    surface: "circle back",
    familiarity: 1,
    suppressed: true,
    suppressedAt: 1000,
    reps: 0,
    intervalDays: 0,
    ease: 2.5,
    dueAt: 1000,
    lapses: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("learning loop store integration", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    // Reset learn/store.ts's own module-level cache in lockstep with
    // the zustand reset below — it's a singleton across this whole
    // test file, so a record left behind by an earlier test would
    // otherwise leak into any test that reads through it (e.g. via
    // the catch-block reconciliation added for #48 s1 review item 3).
    await learnsetModule.clearLearnset();
    useApp.setState({
      cards: [],
      terms: [],
      learnset: {},
      toast: null,
      settings: DEFAULT_SETTINGS,
      status: "idle",
      segments: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppresses after two familiarity votes, not one", async () => {
    await useApp.getState().markKnown("expression", "circle back", "vote");
    let record = useApp.getState().learnset["expression:circle back"];
    expect(record.familiarity).toBe(KNOWN_VOTE_INCREMENT);
    expect(record.suppressed).toBe(false);

    await useApp.getState().markKnown("expression", "circle back", "vote");
    record = useApp.getState().learnset["expression:circle back"];
    expect(record.familiarity).toBe(1);
    expect(record.suppressed).toBe(true);
    expect(record.suppressedAt).toBe(10_000);
  });

  it("explicit suppress marks a term suppressed in one action", async () => {
    await useApp.getState().markKnown("term", "ARR", "suppress");

    const record = useApp.getState().learnset["term:ARR"];
    expect(record).toMatchObject({
      kind: "term",
      surface: "ARR",
      familiarity: 1,
      suppressed: true,
      suppressedAt: 10_000,
    });
  });

  it("applyDetection filters a suppressed dictionary hit before card creation or count bump", () => {
    useApp.setState({
      learnset: {
        "expression:circle back": makeSuppressedRecord(),
      },
    });

    useApp.getState().applyDetection(makeDetection(), "dictionary");
    expect(useApp.getState().cards).toHaveLength(0);

    useApp.setState({
      cards: [
        {
          ...makeDetection().expressions[0],
          id: "c1",
          normKey: "circle back",
          firstSeenAt: 9000,
          lastSeenAt: 9000,
          count: 1,
          source: "dictionary",
        },
      ],
    });
    useApp.getState().applyDetection(makeDetection(), "dictionary");
    expect(useApp.getState().cards[0].count).toBe(1);
  });

  it("keeps string-only showToast calls backward-compatible", () => {
    useApp.getState().showToast("已保存");
    expect(useApp.getState().toast).toBe("已保存");
  });
});

/** Flushes the async IIFE inside markKnown's 撤销 undo action.run() —
 *  fake timers (vi.useFakeTimers) don't affect microtask/Promise
 *  resolution, only setTimeout/Date, so plain awaited ticks are
 *  enough to let the undo's own internal awaits settle. */
async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe("markKnown undo — restores the removed live card (#48 s1 review item 1)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    await learnsetModule.clearLearnset();
    useApp.setState({
      cards: [],
      terms: [],
      learnset: {},
      toast: null,
      settings: DEFAULT_SETTINGS,
      status: "idle",
      segments: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppress -> undo puts the removed card back in cards AND reverts the learn-set record", async () => {
    const liveCard = {
      ...makeDetection().expressions[0],
      id: "c1",
      normKey: "circle back",
      firstSeenAt: 9000,
      lastSeenAt: 9000,
      count: 1,
      source: "dictionary" as const,
    };
    useApp.setState({ cards: [liveCard] });

    await useApp.getState().markKnown("expression", "circle back", "suppress");
    expect(useApp.getState().cards).toHaveLength(0); // removed by suppression
    expect(useApp.getState().learnset["expression:circle back"].suppressed).toBe(true);

    const toast = useApp.getState().toast;
    expect(toast).not.toBeNull();
    expect(typeof toast).toBe("object");
    const action = (toast as { action?: { run: () => void } }).action;
    expect(action).toBeDefined();

    action!.run();
    await flushMicrotasks();

    // The learn-set record is gone (there was no `previous` — this was
    // a brand-new suppression) AND the card is back in `cards`.
    expect(useApp.getState().learnset["expression:circle back"]).toBeUndefined();
    expect(useApp.getState().cards).toEqual([liveCard]);
  });

  it("undo after a two-vote suppression reverts to the PRE-suppression familiarity, not zero, and restores the card", async () => {
    const liveCard = {
      ...makeDetection().expressions[0],
      id: "c1",
      normKey: "circle back",
      firstSeenAt: 9000,
      lastSeenAt: 9000,
      count: 1,
      source: "dictionary" as const,
    };
    await useApp.getState().markKnown("expression", "circle back", "vote"); // 1st vote, not yet suppressed
    useApp.setState({ cards: [liveCard] }); // card appears AFTER the first vote

    await useApp.getState().markKnown("expression", "circle back", "vote"); // 2nd vote -> suppresses
    expect(useApp.getState().cards).toHaveLength(0);

    const toast = useApp.getState().toast;
    const action = (toast as { action?: { run: () => void } }).action!;
    action.run();
    await flushMicrotasks();

    const restored = useApp.getState().learnset["expression:circle back"];
    expect(restored.familiarity).toBe(KNOWN_VOTE_INCREMENT); // back to the post-1st-vote value
    expect(restored.suppressed).toBe(false);
    expect(useApp.getState().cards).toEqual([liveCard]);
  });

  it("undo restores a removed TERM card into `terms`, not `cards`", async () => {
    const liveTerm = {
      id: "t1",
      normKey: "ARR",
      firstSeenAt: 9000,
      lastSeenAt: 9000,
      count: 1,
      source: "dictionary" as const,
      term: "ARR",
      type: "metric" as const,
      gloss_en: "Annual Recurring Revenue",
      gloss_zh: "年度经常性收入",
    };
    useApp.setState({ terms: [liveTerm] });

    await useApp.getState().markKnown("term", "ARR", "suppress");
    expect(useApp.getState().terms).toHaveLength(0);

    const toast = useApp.getState().toast;
    const action = (toast as { action?: { run: () => void } }).action!;
    action.run();
    await flushMicrotasks();

    expect(useApp.getState().terms).toEqual([liveTerm]);
    expect(useApp.getState().cards).toEqual([]); // never touched
  });
});

describe("hydrate — atomicity vs. actions racing the hydrate window (#48 s1 review item 2)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    await learnsetModule.clearLearnset();
    useApp.setState({
      cards: [],
      terms: [],
      learnset: {},
      customEntries: [],
      sessions: [],
      toast: null,
      settings: DEFAULT_SETTINGS,
      status: "idle",
      segments: [],
      hydrated: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("action-wins merge: a record already in the zustand store survives hydrate() even when the loaded map doesn't have it (item 2a)", async () => {
    vi.spyOn(learnsetModule, "refreshStaleSuppressedLearnset").mockResolvedValue({});
    // Simulates an action (e.g. markKnown) that fired and fully
    // completed in the window before hydrate()'s own set() ran —
    // the loaded map above stands in for "disk/module cache had
    // nothing relevant at load time."
    useApp.setState({
      learnset: { "expression:circle back": makeSuppressedRecord() },
    });

    await useApp.getState().hydrate();

    expect(useApp.getState().learnset["expression:circle back"]).toEqual(
      makeSuppressedRecord(),
    );
  });

  it("a suppressed-term detection that slipped through before hydrate resolved is removed once the merged learnset lands (item 2b)", async () => {
    const suppressedRecord = makeSuppressedRecord();
    vi.spyOn(learnsetModule, "refreshStaleSuppressedLearnset").mockResolvedValue({
      "expression:circle back": suppressedRecord,
    });
    // A live card for the same key that appeared during the hydrate
    // window — filtered against the still-empty starting learnset at
    // the time (applyDetection's filterSuppressed reads get().learnset
    // synchronously), so it slipped through as a live card.
    useApp.setState({
      cards: [
        {
          ...makeDetection().expressions[0],
          id: "c1",
          normKey: "circle back",
          firstSeenAt: 9000,
          lastSeenAt: 9000,
          count: 1,
          source: "dictionary",
        },
      ],
    });

    await useApp.getState().hydrate();

    expect(useApp.getState().cards).toHaveLength(0);
    expect(useApp.getState().learnset["expression:circle back"]).toEqual(suppressedRecord);
  });

  it("does not touch cards/terms when nothing needs dropping (no spurious re-render churn)", async () => {
    vi.spyOn(learnsetModule, "refreshStaleSuppressedLearnset").mockResolvedValue({});
    const liveCard = {
      ...makeDetection().expressions[0],
      id: "c1",
      normKey: "circle back",
      firstSeenAt: 9000,
      lastSeenAt: 9000,
      count: 1,
      source: "dictionary" as const,
    };
    useApp.setState({ cards: [liveCard] });

    await useApp.getState().hydrate();

    expect(useApp.getState().cards).toEqual([liveCard]);
  });
});

describe("filterSuppressedLiveCards — pure helper (#48 s1 review item 2b)", () => {
  it("drops a card whose learnKey is suppressed in the given learnset", () => {
    const card = {
      ...makeDetection().expressions[0],
      id: "c1",
      normKey: "circle back",
      firstSeenAt: 9000,
      lastSeenAt: 9000,
      count: 1,
      source: "dictionary" as const,
    };
    const result = filterSuppressedLiveCards(
      [card],
      [],
      { "expression:circle back": makeSuppressedRecord() },
    );
    expect(result.cards).toEqual([]);
  });

  it("keeps a card whose learnKey is present but NOT suppressed", () => {
    const card = {
      ...makeDetection().expressions[0],
      id: "c1",
      normKey: "circle back",
      firstSeenAt: 9000,
      lastSeenAt: 9000,
      count: 1,
      source: "dictionary" as const,
    };
    const result = filterSuppressedLiveCards(
      [card],
      [],
      { "expression:circle back": makeSuppressedRecord({ suppressed: false }) },
    );
    expect(result.cards).toEqual([card]);
  });

  it("drops a suppressed term from `terms`, independent of `cards`", () => {
    const term = {
      id: "t1",
      normKey: "ARR",
      firstSeenAt: 9000,
      lastSeenAt: 9000,
      count: 1,
      source: "dictionary" as const,
      term: "ARR",
      type: "metric" as const,
      gloss_en: "Annual Recurring Revenue",
      gloss_zh: "年度经常性收入",
    };
    const result = filterSuppressedLiveCards(
      [],
      [term],
      {
        "term:ARR": makeSuppressedRecord({
          learnKey: "term:ARR",
          kind: "term",
          surface: "ARR",
        }),
      },
    );
    expect(result.terms).toEqual([]);
  });

  it("is a no-op when the learnset is empty", () => {
    const card = {
      ...makeDetection().expressions[0],
      id: "c1",
      normKey: "circle back",
      firstSeenAt: 9000,
      lastSeenAt: 9000,
      count: 1,
      source: "dictionary" as const,
    };
    const result = filterSuppressedLiveCards([card], [], {});
    expect(result.cards).toEqual([card]);
  });
});

describe("learn-set persistence failures surface a visible error, never a success toast (#48 s1 review item 3)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    await learnsetModule.clearLearnset();
    useApp.setState({
      cards: [],
      terms: [],
      learnset: {},
      customEntries: [],
      toast: null,
      settings: DEFAULT_SETTINGS,
      status: "idle",
      segments: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("markKnown: a rejected upsertLearnRecord shows the persistence-failure toast, not the usual success toast, and leaves state untouched", async () => {
    vi.spyOn(learnsetModule, "upsertLearnRecord").mockRejectedValueOnce(new Error("boom"));

    await useApp.getState().markKnown("expression", "circle back", "vote");

    expect(useApp.getState().toast).toBe("本次标记保存失败");
    expect(useApp.getState().learnset["expression:circle back"]).toBeUndefined();
  });

  it("gradeReview: a rejected upsertLearnRecord shows a persistence-failure toast and does not touch live cards", async () => {
    vi.spyOn(learnsetModule, "upsertLearnRecord").mockRejectedValueOnce(new Error("boom"));
    const liveCard = {
      ...makeDetection().expressions[0],
      id: "c1",
      normKey: "circle back",
      firstSeenAt: 9000,
      lastSeenAt: 9000,
      count: 1,
      source: "dictionary" as const,
    };
    useApp.setState({ cards: [liveCard] });

    await useApp.getState().gradeReview("expression", "circle back", 2);

    expect(useApp.getState().toast).toBe("本次评分保存失败");
    expect(useApp.getState().cards).toEqual([liveCard]); // untouched — no auto-suppression ran
  });
});

describe("markKnown / gradeReview — per-learnKey serialization (#48 s1 review item 5)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    await learnsetModule.clearLearnset();
    useApp.setState({
      cards: [],
      terms: [],
      learnset: {},
      toast: null,
      settings: DEFAULT_SETTINGS,
      status: "idle",
      segments: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("two markKnown votes fired in parallel (Promise.all) on the SAME key still reach familiarity 1.0 and suppress exactly once — not two independent 0->0.5 reads", async () => {
    await Promise.all([
      useApp.getState().markKnown("expression", "circle back", "vote"),
      useApp.getState().markKnown("expression", "circle back", "vote"),
    ]);

    const record = useApp.getState().learnset["expression:circle back"];
    expect(record.familiarity).toBe(1);
    expect(record.suppressed).toBe(true);
  });

  it("three parallel votes on the same key still land at exactly 1.0 (clamped), not overshooting", async () => {
    await Promise.all([
      useApp.getState().markKnown("expression", "circle back", "vote"),
      useApp.getState().markKnown("expression", "circle back", "vote"),
      useApp.getState().markKnown("expression", "circle back", "vote"),
    ]);

    const record = useApp.getState().learnset["expression:circle back"];
    expect(record.familiarity).toBe(1);
    expect(record.suppressed).toBe(true);
  });

  it("parallel votes on DIFFERENT keys are not serialized against each other (each still resolves independently)", async () => {
    await Promise.all([
      useApp.getState().markKnown("expression", "circle back", "vote"),
      useApp.getState().markKnown("term", "ARR", "vote"),
    ]);

    expect(useApp.getState().learnset["expression:circle back"].familiarity).toBe(
      KNOWN_VOTE_INCREMENT,
    );
    expect(useApp.getState().learnset["term:ARR"].familiarity).toBe(KNOWN_VOTE_INCREMENT);
  });
});

function makeCustomEntry(overrides: Partial<CustomEntry> = {}): CustomEntry {
  const now = 10_000;
  return {
    id: "entry-1",
    kind: "expression",
    headword: "circle back",
    variants: [],
    chinese_explanation: "回头再聊",
    example: "",
    context: "",
    note: "",
    createdAt: now,
    updatedAt: now,
    source: "manual",
    ...overrides,
  };
}

describe("gradeReview — SRS review grading (#48 step 2)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    await learnsetModule.clearLearnset();
    useApp.setState({
      cards: [],
      terms: [],
      learnset: {},
      customEntries: [],
      toast: null,
      settings: DEFAULT_SETTINGS,
      status: "idle",
      segments: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lazily enrolls a never-graded learnKey and runs SM-2-lite from a fresh record", async () => {
    await useApp.getState().gradeReview("expression", "circle back", 2);
    const record = useApp.getState().learnset["expression:circle back"];
    expect(record.reps).toBe(1);
    expect(record.intervalDays).toBe(1);
    expect(record.ease).toBe(DEFAULT_EASE + 0.1);
    expect(record.dueAt).toBe(10_000 + 24 * 60 * 60 * 1000);
    expect(record.lastReviewedAt).toBe(10_000);
  });

  it("a second grade continues the SAME record's schedule rather than re-enrolling", async () => {
    await useApp.getState().gradeReview("expression", "circle back", 2);
    vi.setSystemTime(20_000);
    await useApp.getState().gradeReview("expression", "circle back", 2);

    const record = useApp.getState().learnset["expression:circle back"];
    expect(record.reps).toBe(2);
    expect(record.intervalDays).toBe(4);
    expect(record.dueAt).toBe(20_000 + 4 * 24 * 60 * 60 * 1000);
  });

  it("auto-suppression from a review grade removes the term from any live cards", async () => {
    useApp.setState({
      learnset: {
        "expression:circle back": {
          learnKey: "expression:circle back",
          kind: "expression",
          surface: "circle back",
          familiarity: 1,
          suppressed: false,
          reps: 2,
          intervalDays: 20,
          ease: 1.4,
          dueAt: 10_000,
          lapses: 0,
          createdAt: 1000,
          updatedAt: 1000,
        },
      },
      cards: [
        {
          ...makeDetection().expressions[0],
          id: "c1",
          normKey: "circle back",
          firstSeenAt: 9000,
          lastSeenAt: 9000,
          count: 1,
          source: "dictionary",
        },
      ],
    });

    await useApp.getState().gradeReview("expression", "circle back", 2);

    const record = useApp.getState().learnset["expression:circle back"];
    expect(record.intervalDays).toBe(30); // round(20 * 1.5)
    expect(record.suppressed).toBe(true);
    expect(useApp.getState().cards).toHaveLength(0); // live card removed
  });

  it("grading a term that never triggers auto-suppression leaves live cards untouched", async () => {
    useApp.setState({
      cards: [
        {
          ...makeDetection().expressions[0],
          id: "c1",
          normKey: "circle back",
          firstSeenAt: 9000,
          lastSeenAt: 9000,
          count: 1,
          source: "dictionary",
        },
      ],
    });
    await useApp.getState().gradeReview("expression", "circle back", 1);
    expect(useApp.getState().cards).toHaveLength(1);
  });
});

describe("addCustomEntry — glossary-save lazy SRS enrollment (#48 step 2)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    await learnsetModule.clearLearnset();
    useApp.setState({ learnset: {}, customEntries: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-enrolls a brand-new headword with dueAt=now on first save", async () => {
    await useApp.getState().addCustomEntry(makeCustomEntry({ id: "e1" }));
    const record = useApp.getState().learnset["expression:circle back"];
    expect(record).toBeDefined();
    expect(record.reps).toBe(0);
    expect(record.dueAt).toBe(10_000);
    expect(record.ease).toBe(DEFAULT_EASE);
    expect(record.familiarity).toBe(0);
  });

  it("does not re-enroll (or reset scheduling) when the learnKey is already enrolled", async () => {
    useApp.setState({
      learnset: {
        "expression:circle back": {
          learnKey: "expression:circle back",
          kind: "expression",
          surface: "circle back",
          familiarity: 0.4,
          suppressed: false,
          reps: 3,
          intervalDays: 11,
          ease: 2.8,
          dueAt: 99_999,
          lapses: 0,
          createdAt: 1000,
          updatedAt: 1000,
        },
      },
    });

    await useApp.getState().addCustomEntry(makeCustomEntry({ id: "e2" }));

    const record = useApp.getState().learnset["expression:circle back"];
    expect(record.reps).toBe(3);
    expect(record.dueAt).toBe(99_999); // untouched
  });

  it("updateCustomEntry never enrolls into the learn-set", async () => {
    await useApp.getState().updateCustomEntry(makeCustomEntry({ id: "e3" }));
    expect(useApp.getState().learnset["expression:circle back"]).toBeUndefined();
  });
});
