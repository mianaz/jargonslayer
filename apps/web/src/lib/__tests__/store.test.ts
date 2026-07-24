import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSpeakerToRosterList,
  aliasesAfterRename,
  applyOpenRouterModelDefaults,
  applyPlatformEngineDefaults,
  applySpeakerUpdateToSegments,
  applyTierDefaults,
  assignSpeakerFollowingInSegments,
  assignSpeakerToSegments,
  currentSessionSnapshot,
  deriveRosterFromSegments,
  elapsedActiveMs,
  filterSuppressedLiveCards,
  isModeLegalForPlatform,
  migrateSettings,
  modeForPersistedEngine,
  pauseIntervalsForSnapshot,
  renameRosterSpeakerList,
  renameSpeakerInSegments,
  scheduleSessionSave,
  shouldApplySpeakerUpdate,
  SPEAKER_ROSTER_CAP,
  unlockSpeakerInSegments,
  useApp,
} from "../store";
import {
  DEFAULT_SETTINGS,
  sessionToMeta,
  type CustomEntry,
  type DetectResponse,
  type MeetingSession,
  type Settings,
  type STTEngineKind,
  type TranscriptSegment,
} from "@jargonslayer/core/types";
import { DEFAULT_EASE, KNOWN_VOTE_INCREMENT } from "../learn/store";
import * as learnsetModule from "../learn/store";
import * as storageModule from "../history/storage";
import * as liveDraftModule from "../history/liveDraft";
import type { LearnRecord } from "@jargonslayer/core/learn/types";
import { clearDiag, getDiagEntries } from "../diag/log";
import { segmentElapsedMs } from "../segmentElapsed";

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

describe("applySpeakerUpdateToSegments — §5 A2 manual-assignment guard (locked segments)", () => {
  it("a LOCKED segment's sttSpeaker still updates, but its display speaker does not", () => {
    const segments = [
      makeSegment({ id: "a", sttSeg: 0, speaker: "Alice", speakerLocked: true }),
    ];
    const result = applySpeakerUpdateToSegments(
      segments,
      [{ segId: 0, speaker: "SPEAKER_1" }],
      {},
    );
    expect(result[0].sttSpeaker).toBe("SPEAKER_1"); // raw truth always updates
    expect(result[0].speaker).toBe("Alice"); // display stays manual
    expect(result[0].speakerLocked).toBe(true); // lock itself is untouched here (only unlock clears it)
  });

  it("a locked segment's display stays manual even when an alias exists for the incoming stable id", () => {
    const segments = [
      makeSegment({ id: "a", sttSeg: 0, speaker: "Alice", speakerLocked: true }),
    ];
    const result = applySpeakerUpdateToSegments(
      segments,
      [{ segId: 0, speaker: "SPEAKER_1" }],
      { SPEAKER_1: "Bob" }, // an alias exists, but the lock still wins
    );
    expect(result[0].sttSpeaker).toBe("SPEAKER_1");
    expect(result[0].speaker).toBe("Alice");
  });

  it("an UNLOCKED segment (speakerLocked absent) behaves exactly as before — display updates", () => {
    const segments = [makeSegment({ id: "a", sttSeg: 0, speaker: "stale" })];
    const result = applySpeakerUpdateToSegments(
      segments,
      [{ segId: 0, speaker: "SPEAKER_1" }],
      {},
    );
    expect(result[0].speaker).toBe("SPEAKER_1");
  });

  it("an UNLOCKED segment (speakerLocked explicitly false) also updates its display", () => {
    const segments = [
      makeSegment({ id: "a", sttSeg: 0, speaker: "stale", speakerLocked: false }),
    ];
    const result = applySpeakerUpdateToSegments(
      segments,
      [{ segId: 0, speaker: "SPEAKER_1" }],
      {},
    );
    expect(result[0].speaker).toBe("SPEAKER_1");
  });

  it("mixed batch: locked segments keep their display, unlocked segments update, in the SAME call", () => {
    const segments = [
      makeSegment({ id: "locked", sttSeg: 0, speaker: "Alice", speakerLocked: true }),
      makeSegment({ id: "unlocked", sttSeg: 1, speaker: "stale" }),
    ];
    const result = applySpeakerUpdateToSegments(
      segments,
      [
        { segId: 0, speaker: "SPEAKER_1" },
        { segId: 1, speaker: "SPEAKER_2" },
      ],
      {},
    );
    expect(result[0].speaker).toBe("Alice");
    expect(result[0].sttSpeaker).toBe("SPEAKER_1");
    expect(result[1].speaker).toBe("SPEAKER_2");
    expect(result[1].sttSpeaker).toBe("SPEAKER_2");
  });
});

describe("unlockSpeakerInSegments — 跟随识别 (§5 A2)", () => {
  it("clears speakerLocked and recomputes display from aliases[sttSpeaker]", () => {
    const segments = [
      makeSegment({ id: "a", sttSpeaker: "SPEAKER_1", speaker: "Alice", speakerLocked: true }),
    ];
    const result = unlockSpeakerInSegments(segments, "a", { SPEAKER_1: "Bob" });
    expect(result[0].speakerLocked).toBe(false);
    expect(result[0].speaker).toBe("Bob");
  });

  it("falls back to the raw sttSpeaker itself when unaliased", () => {
    const segments = [
      makeSegment({ id: "a", sttSpeaker: "SPEAKER_1", speaker: "Alice", speakerLocked: true }),
    ];
    const result = unlockSpeakerInSegments(segments, "a", {});
    expect(result[0].speaker).toBe("SPEAKER_1");
  });

  it("keeps the PRIOR display speaker when the segment has no sttSpeaker at all (nothing to follow back to)", () => {
    const segments = [makeSegment({ id: "a", speaker: "Alice", speakerLocked: true })]; // no sttSpeaker
    const result = unlockSpeakerInSegments(segments, "a", { SPEAKER_1: "Bob" });
    expect(result[0].speaker).toBe("Alice");
    expect(result[0].speakerLocked).toBe(false);
  });

  it("leaves other segments untouched", () => {
    const segments = [
      makeSegment({ id: "a", speaker: "Alice", speakerLocked: true }),
      makeSegment({ id: "b", speaker: "Carol", speakerLocked: true }),
    ];
    const result = unlockSpeakerInSegments(segments, "a", {});
    expect(result[1]).toEqual(segments[1]);
  });

  it("is a no-op for an unknown segmentId", () => {
    const segments = [makeSegment({ id: "a", speaker: "Alice", speakerLocked: true })];
    const result = unlockSpeakerInSegments(segments, "missing", {});
    expect(result[0]).toEqual(segments[0]);
  });
});

describe("assignSpeakerToSegments — bulk per-segment assignment", () => {
  it("sets speaker + speakerLocked:true on every segment whose id is in segmentIds", () => {
    const segments = [
      makeSegment({ id: "a" }),
      makeSegment({ id: "b" }),
      makeSegment({ id: "c" }),
    ];
    const result = assignSpeakerToSegments(segments, ["a", "c"], "Alice");
    expect(result[0]).toMatchObject({ speaker: "Alice", speakerLocked: true });
    expect(result[1]).toEqual(segments[1]); // untouched
    expect(result[2]).toMatchObject({ speaker: "Alice", speakerLocked: true });
  });

  it("single assign (one-element array) works identically to bulk", () => {
    const segments = [makeSegment({ id: "a" })];
    const result = assignSpeakerToSegments(segments, ["a"], "Alice");
    expect(result[0]).toMatchObject({ speaker: "Alice", speakerLocked: true });
  });

  it("overwrites an existing (even locked) assignment — explicit bulk action wins", () => {
    const segments = [makeSegment({ id: "a", speaker: "Old", speakerLocked: true })];
    const result = assignSpeakerToSegments(segments, ["a"], "New");
    expect(result[0].speaker).toBe("New");
    expect(result[0].speakerLocked).toBe(true);
  });
});

describe("assignSpeakerFollowingInSegments — 应用到本句及之后 (exact range)", () => {
  it("assigns the target segment AND every segment after it, by arrival order", () => {
    const segments = [
      makeSegment({ id: "a", index: 0 }),
      makeSegment({ id: "b", index: 1 }),
      makeSegment({ id: "c", index: 2 }),
    ];
    const result = assignSpeakerFollowingInSegments(segments, "b", "Alice");
    expect(result[0]).toEqual(segments[0]); // BEFORE the target: untouched
    expect(result[1]).toMatchObject({ speaker: "Alice", speakerLocked: true });
    expect(result[2]).toMatchObject({ speaker: "Alice", speakerLocked: true });
  });

  it("assigning the FIRST segment assigns the entire array", () => {
    const segments = [
      makeSegment({ id: "a", index: 0 }),
      makeSegment({ id: "b", index: 1 }),
    ];
    const result = assignSpeakerFollowingInSegments(segments, "a", "Alice");
    expect(result.every((s) => s.speaker === "Alice" && s.speakerLocked)).toBe(true);
  });

  it("assigning the LAST segment assigns ONLY that one segment", () => {
    const segments = [
      makeSegment({ id: "a", index: 0 }),
      makeSegment({ id: "b", index: 1 }),
    ];
    const result = assignSpeakerFollowingInSegments(segments, "b", "Alice");
    expect(result[0]).toEqual(segments[0]);
    expect(result[1]).toMatchObject({ speaker: "Alice", speakerLocked: true });
  });

  it("is a no-op for an unknown segmentId", () => {
    const segments = [makeSegment({ id: "a" })];
    const result = assignSpeakerFollowingInSegments(segments, "missing", "Alice");
    expect(result).toBe(segments); // same reference — untouched
  });
});

describe("addSpeakerToRosterList — roster invariants (§5 A1: trimmed-unique, 200 cap)", () => {
  it("auto-numbers 说话人 1 on an empty roster when name is omitted", () => {
    const { roster, name } = addSpeakerToRosterList([]);
    expect(name).toBe("说话人 1");
    expect(roster).toEqual(["说话人 1"]);
  });

  it("auto-numbering skips an already-taken name (说话人 1 taken -> next is 说话人 2)", () => {
    const { roster, name } = addSpeakerToRosterList(["说话人 1"]);
    expect(name).toBe("说话人 2");
    expect(roster).toEqual(["说话人 1", "说话人 2"]);
  });

  it("auto-numbering skips a GAP correctly — smallest untaken N, not just highest+1", () => {
    const { name } = addSpeakerToRosterList(["说话人 1", "说话人 3"]);
    expect(name).toBe("说话人 2");
  });

  it("auto-numbering also skips a name a user free-typed that happens to match the pattern", () => {
    const { name } = addSpeakerToRosterList(["说话人 1", "说话人 2"]);
    expect(name).toBe("说话人 3");
  });

  it("trims a provided name before adding", () => {
    const { roster, name } = addSpeakerToRosterList([], "  Alice  ");
    expect(name).toBe("Alice");
    expect(roster).toEqual(["Alice"]);
  });

  it("a blank/whitespace-only provided name falls back to auto-numbering", () => {
    const { name } = addSpeakerToRosterList([], "   ");
    expect(name).toBe("说话人 1");
  });

  it("does not add a duplicate — a name already in the roster is a no-op on the roster, but the resolved name is still returned", () => {
    const { roster, name } = addSpeakerToRosterList(["Alice"], "Alice");
    expect(name).toBe("Alice");
    expect(roster).toEqual(["Alice"]); // unchanged, not duplicated
  });

  it("cap: refuses to grow past SPEAKER_ROSTER_CAP, but still returns the resolved name", () => {
    const full = Array.from({ length: SPEAKER_ROSTER_CAP }, (_, i) => `说话人 ${i + 1}`);
    const { roster, name } = addSpeakerToRosterList(full, "One More");
    expect(roster).toHaveLength(SPEAKER_ROSTER_CAP);
    expect(roster).toBe(full); // unchanged reference — refused, not silently truncated
    expect(name).toBe("One More");
  });

  it("two consecutive omitted-name calls each get distinct auto-numbers", () => {
    const first = addSpeakerToRosterList([]);
    const second = addSpeakerToRosterList(first.roster);
    expect(first.name).toBe("说话人 1");
    expect(second.name).toBe("说话人 2");
    expect(second.roster).toEqual(["说话人 1", "说话人 2"]);
  });
});

describe("renameRosterSpeakerList", () => {
  it("renames the matching entry, trimming the new name", () => {
    const result = renameRosterSpeakerList(["说话人 1", "说话人 2"], "说话人 1", "  Alice  ");
    expect(result).toEqual(["Alice", "说话人 2"]);
  });

  it("refuses (returns null) a blank result", () => {
    expect(renameRosterSpeakerList(["Alice"], "Alice", "   ")).toBeNull();
  });

  it("refuses (returns null) a no-op rename (from === cleaned)", () => {
    expect(renameRosterSpeakerList(["Alice"], "Alice", "Alice")).toBeNull();
  });

  it("refuses (returns null) a collision with a DIFFERENT existing entry", () => {
    expect(renameRosterSpeakerList(["Alice", "Bob"], "Alice", "Bob")).toBeNull();
  });

  it("leaves other entries untouched on a successful rename", () => {
    const result = renameRosterSpeakerList(["Alice", "Bob", "Carol"], "Bob", "Robert");
    expect(result).toEqual(["Alice", "Robert", "Carol"]);
  });
});

describe("deriveRosterFromSegments — legacy-session roster fallback (§5 A2)", () => {
  it("collects unique non-empty speaker values, first-seen order", () => {
    const segments = [
      makeSegment({ id: "a", speaker: "Alice" }),
      makeSegment({ id: "b", speaker: "Bob" }),
      makeSegment({ id: "c", speaker: "Alice" }), // repeat
    ];
    expect(deriveRosterFromSegments(segments)).toEqual(["Alice", "Bob"]);
  });

  it("excludes segments with no speaker", () => {
    const segments = [makeSegment({ id: "a" }), makeSegment({ id: "b", speaker: "Alice" })];
    expect(deriveRosterFromSegments(segments)).toEqual(["Alice"]);
  });

  it("an empty segments array derives an empty roster", () => {
    expect(deriveRosterFromSegments([])).toEqual([]);
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

describe("applySpeakerUpdate (store action) — post-stop diarization linger re-save + meeting-boundary guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a late update arriving after doStop (status already 'stopped') re-persists — the saved session gains the labels", async () => {
    const saveSpy = vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
    useApp.setState({
      status: "stopped",
      meetingGen: 5,
      segments: [makeSegment({ id: "a", sttSeg: 0 })],
      speakerAliases: {},
      activeSessionId: null,
    });

    useApp.getState().applySpeakerUpdate([{ segId: 0, speaker: "SPEAKER_1" }], ["SPEAKER_1"], 5);

    // Live state updates immediately...
    expect(useApp.getState().segments[0].speaker).toBe("SPEAKER_1");
    expect(saveSpy).not.toHaveBeenCalled(); // ...but the re-save is debounced, not immediate
    await vi.advanceTimersByTimeAsync(1500);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    const saved = saveSpy.mock.calls[0][0] as MeetingSession;
    expect(saved.segments[0].speaker).toBe("SPEAKER_1");
  });

  it("does not schedule a re-save while the meeting is still live (status !== 'stopped')", async () => {
    const saveSpy = vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    useApp.setState({
      status: "listening",
      meetingGen: 5,
      segments: [makeSegment({ id: "a", sttSeg: 0 })],
      speakerAliases: {},
    });

    useApp.getState().applySpeakerUpdate([{ segId: 0, speaker: "SPEAKER_1" }], ["SPEAKER_1"], 5);
    await vi.advanceTimersByTimeAsync(1500);

    expect(saveSpy).not.toHaveBeenCalled();
  });

  // sessionGen is captured per attach (useMeeting.ts's attachEngine
  // parameter, threaded through onSpeakerUpdate) — a speaker_update
  // that lingers (see wsTransport.ts's POST_STOP_LINGER_MS) past the
  // point a NEW meeting has already started must never land on it.
  it("rejects a lingering update whose gen belongs to a previous meeting — no state change and no re-save scheduled", async () => {
    const saveSpy = vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    useApp.setState({
      status: "stopped",
      meetingGen: 6, // a NEW meeting already started (bumped past the old engine session's gen)
      segments: [makeSegment({ id: "a", sttSeg: 0 })],
      speakerAliases: {},
    });

    useApp.getState().applySpeakerUpdate([{ segId: 0, speaker: "SPEAKER_1" }], ["SPEAKER_1"], 5); // stale gen

    expect(useApp.getState().segments[0].speaker).toBeUndefined(); // untouched
    await vi.advanceTimersByTimeAsync(1500);
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

describe("addFinal — v0.5 Wave-1 Feature 1 live latch", () => {
  beforeEach(() => {
    useApp.setState({
      segments: [],
      activeSpeaker: null,
      // Isolates this from personal-glossary detection entirely — see
      // this describe block's own header note above on why that's safe
      // either way (this file never seeds the glossary cache).
      settings: { ...DEFAULT_SETTINGS, autoDetect: false },
    });
  });

  it("a speaker-less final gets the latched roster name stamped and marked locked", () => {
    useApp.getState().setActiveSpeaker("Alice");
    const seg = useApp.getState().addFinal("hello");
    expect(seg.speaker).toBe("Alice");
    expect(seg.speakerLocked).toBe(true);
  });

  it("no latch set: a speaker-less final is unaffected — today's behavior, byte-identical", () => {
    const seg = useApp.getState().addFinal("hello");
    expect(seg.speaker).toBeUndefined();
    expect(seg.speakerLocked).toBeUndefined();
  });

  it("a final that already arrives with an engine-reported speaker (opts.speaker) is NEVER touched by the latch, even when one is set", () => {
    useApp.getState().setActiveSpeaker("Alice");
    const seg = useApp.getState().addFinal("hello", { speaker: "SPEAKER_1" });
    expect(seg.speaker).toBe("SPEAKER_1");
    expect(seg.speakerLocked).toBeUndefined();
  });

  it("switching the latch changes which name the NEXT final gets — earlier finals are untouched", () => {
    useApp.getState().setActiveSpeaker("Alice");
    const first = useApp.getState().addFinal("one");
    useApp.getState().setActiveSpeaker("Bob");
    const second = useApp.getState().addFinal("two");
    expect(first.speaker).toBe("Alice");
    expect(second.speaker).toBe("Bob");
  });

  it("clearing the latch (setActiveSpeaker(null)) stops stamping subsequent finals", () => {
    useApp.getState().setActiveSpeaker("Alice");
    useApp.getState().addFinal("one");
    useApp.getState().setActiveSpeaker(null);
    const second = useApp.getState().addFinal("two");
    expect(second.speaker).toBeUndefined();
    expect(second.speakerLocked).toBeUndefined();
  });
});

describe("speaker roster + assignment store actions (v0.5 Wave-1 Feature 1) — available at any status, post-stop re-save", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useApp.setState({
      status: "listening",
      meetingGen: 1,
      segments: [
        makeSegment({ id: "a", index: 0 }),
        makeSegment({ id: "b", index: 1 }),
      ],
      speakerAliases: {},
      speakerRoster: [],
      activeSpeaker: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("addSpeakerToRoster adds and returns the resolved (auto-numbered) name", () => {
    const name = useApp.getState().addSpeakerToRoster();
    expect(name).toBe("说话人 1");
    expect(useApp.getState().speakerRoster).toEqual(["说话人 1"]);
  });

  it("addSpeakerToRoster with a name trims and adds it", () => {
    const name = useApp.getState().addSpeakerToRoster("  Alice  ");
    expect(name).toBe("Alice");
    expect(useApp.getState().speakerRoster).toEqual(["Alice"]);
  });

  it("renameRosterSpeaker updates the roster AND delegates to renameSpeaker (segments + aliases rewrite)", () => {
    useApp.setState({
      speakerRoster: ["SPEAKER_1"],
      segments: [makeSegment({ id: "a", speaker: "SPEAKER_1" })],
    });
    useApp.getState().renameRosterSpeaker("SPEAKER_1", "Alice");
    expect(useApp.getState().speakerRoster).toEqual(["Alice"]);
    expect(useApp.getState().segments[0].speaker).toBe("Alice"); // renameSpeaker's own rewrite
  });

  it("renameRosterSpeaker is a no-op (roster AND segments untouched) on a collision", () => {
    useApp.setState({
      speakerRoster: ["Alice", "Bob"],
      segments: [makeSegment({ id: "a", speaker: "Alice" })],
    });
    useApp.getState().renameRosterSpeaker("Alice", "Bob");
    expect(useApp.getState().speakerRoster).toEqual(["Alice", "Bob"]);
    expect(useApp.getState().segments[0].speaker).toBe("Alice");
  });

  it("assignSegmentsSpeaker (bulk) sets speaker + speakerLocked on the given ids, WHILE status is 'listening' (not gated to stopped)", () => {
    useApp.getState().assignSegmentsSpeaker(["a", "b"], "Alice");
    const s = useApp.getState();
    expect(s.status).toBe("listening"); // never touched
    expect(s.segments[0]).toMatchObject({ speaker: "Alice", speakerLocked: true });
    expect(s.segments[1]).toMatchObject({ speaker: "Alice", speakerLocked: true });
  });

  it("assignSegmentsSpeaker single assign = a one-element array", () => {
    useApp.getState().assignSegmentsSpeaker(["a"], "Alice");
    expect(useApp.getState().segments[0].speaker).toBe("Alice");
    expect(useApp.getState().segments[1].speaker).toBeUndefined();
  });

  it("assignSpeakerFollowing assigns from segmentId through the end", () => {
    useApp.setState({
      segments: [
        makeSegment({ id: "a", index: 0 }),
        makeSegment({ id: "b", index: 1 }),
        makeSegment({ id: "c", index: 2 }),
      ],
    });
    useApp.getState().assignSpeakerFollowing("b", "Alice");
    const s = useApp.getState().segments;
    expect(s[0].speaker).toBeUndefined();
    expect(s[1].speaker).toBe("Alice");
    expect(s[2].speaker).toBe("Alice");
  });

  it("setActiveSpeaker sets and clears the live latch", () => {
    useApp.getState().setActiveSpeaker("Alice");
    expect(useApp.getState().activeSpeaker).toBe("Alice");
    useApp.getState().setActiveSpeaker(null);
    expect(useApp.getState().activeSpeaker).toBeNull();
  });

  it("unlockSegmentSpeaker (跟随识别) clears the lock and recomputes display from the alias map", () => {
    useApp.setState({
      segments: [
        makeSegment({ id: "a", sttSpeaker: "SPEAKER_1", speaker: "Alice", speakerLocked: true }),
      ],
      speakerAliases: { SPEAKER_1: "Bob" },
    });
    useApp.getState().unlockSegmentSpeaker("a");
    const s = useApp.getState().segments[0];
    expect(s.speakerLocked).toBe(false);
    expect(s.speaker).toBe("Bob");
  });

  it("assignSegmentsSpeaker schedules a debounced post-stop re-save when the meeting has already ended", async () => {
    const saveSpy = vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
    useApp.setState({ status: "stopped", activeSessionId: null });

    useApp.getState().assignSegmentsSpeaker(["a"], "Alice");
    expect(saveSpy).not.toHaveBeenCalled(); // debounced, not immediate
    await vi.advanceTimersByTimeAsync(1500);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    const saved = saveSpy.mock.calls[0][0] as MeetingSession;
    expect(saved.segments[0].speaker).toBe("Alice");
  });

  it("does NOT schedule a re-save while the meeting is still live", async () => {
    const saveSpy = vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    useApp.getState().assignSegmentsSpeaker(["a"], "Alice");
    await vi.advanceTimersByTimeAsync(1500);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("addSpeakerToRoster ALSO schedules a post-stop re-save — a bare add with no assignment yet must still survive (speakerRoster is always-persisted)", async () => {
    const saveSpy = vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
    useApp.setState({ status: "stopped", activeSessionId: null });

    useApp.getState().addSpeakerToRoster("Alice");
    await vi.advanceTimersByTimeAsync(1500);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    const saved = saveSpy.mock.calls[0][0] as MeetingSession;
    expect(saved.speakerRoster).toEqual(["Alice"]);
  });
});

describe("beginMeeting / loadSession / newMeeting reset the roster + latch + correctionBusy (v0.5 Wave-1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("beginMeeting resets speakerRoster/activeSpeaker/correctionBusy for a fresh meeting", () => {
    useApp.setState({
      speakerRoster: ["Alice"],
      activeSpeaker: "Alice",
      correctionBusy: true,
    });
    useApp.getState().beginMeeting();
    const s = useApp.getState();
    expect(s.speakerRoster).toEqual([]);
    expect(s.activeSpeaker).toBeNull();
    expect(s.correctionBusy).toBe(false);
  });

  it("newMeeting resets the same three fields", () => {
    useApp.setState({
      speakerRoster: ["Alice"],
      activeSpeaker: "Alice",
      correctionBusy: true,
    });
    useApp.getState().newMeeting();
    const s = useApp.getState();
    expect(s.speakerRoster).toEqual([]);
    expect(s.activeSpeaker).toBeNull();
    expect(s.correctionBusy).toBe(false);
  });

  it("loadSession resets activeSpeaker/correctionBusy and restores speakerRoster from the session", async () => {
    const session: MeetingSession = {
      id: "sess-1",
      title: "t",
      startedAt: 1000,
      endedAt: 2000,
      engine: "whisper",
      segments: [makeSegment({ id: "s1" })],
      cards: [],
      terms: [],
      speakerRoster: ["Alice", "Bob"],
    };
    vi.spyOn(storageModule, "getSession").mockResolvedValue(session);
    useApp.setState({ activeSpeaker: "Carol", correctionBusy: true });

    await useApp.getState().loadSession("sess-1");

    const s = useApp.getState();
    expect(s.speakerRoster).toEqual(["Alice", "Bob"]);
    expect(s.activeSpeaker).toBeNull();
    expect(s.correctionBusy).toBe(false);
  });

  it("loadSession derives the roster from unique segment.speaker values for a LEGACY session (no speakerRoster key at all)", async () => {
    const session: MeetingSession = {
      id: "sess-legacy",
      title: "t",
      startedAt: 1000,
      endedAt: 2000,
      engine: "whisper",
      segments: [
        makeSegment({ id: "s1", speaker: "SPEAKER_1" }),
        makeSegment({ id: "s2", speaker: "SPEAKER_2" }),
        makeSegment({ id: "s3", speaker: "SPEAKER_1" }),
      ],
      cards: [],
      terms: [],
      // no speakerRoster key — legacy data, saved before this feature existed
    };
    vi.spyOn(storageModule, "getSession").mockResolvedValue(session);

    await useApp.getState().loadSession("sess-legacy");

    expect(useApp.getState().speakerRoster).toEqual(["SPEAKER_1", "SPEAKER_2"]);
  });

  it("loadSession does NOT re-derive a roster for a NEW session whose roster is genuinely empty — presence (even []) wins over the legacy fallback", async () => {
    const session: MeetingSession = {
      id: "sess-new-empty",
      title: "t",
      startedAt: 1000,
      endedAt: 2000,
      engine: "whisper",
      segments: [makeSegment({ id: "s1", speaker: "SPEAKER_1" })], // has a diarized speaker...
      cards: [],
      terms: [],
      speakerRoster: [], // ...but the roster itself was saved genuinely empty
    };
    vi.spyOn(storageModule, "getSession").mockResolvedValue(session);

    await useApp.getState().loadSession("sess-new-empty");

    expect(useApp.getState().speakerRoster).toEqual([]); // NOT derived from segments
  });
});

describe("saveCurrentSession / currentSessionSnapshot persist speakerRoster (v0.5 Wave-1 Feature 1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saveCurrentSession always persists speakerRoster, even [] for a meeting that never touched it", async () => {
    const saveSpy = vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
    useApp.setState({
      segments: [makeSegment({ id: "s1" })],
      startedAt: 1000,
      speakerRoster: [],
      activeSessionId: null,
    });

    await useApp.getState().saveCurrentSession();

    const saved = saveSpy.mock.calls[0][0] as MeetingSession;
    expect(saved.speakerRoster).toEqual([]);
  });

  it("saveCurrentSession persists the exact live roster", async () => {
    const saveSpy = vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
    useApp.setState({
      segments: [makeSegment({ id: "s1" })],
      startedAt: 1000,
      speakerRoster: ["Alice", "Bob"],
      activeSessionId: null,
    });

    await useApp.getState().saveCurrentSession();

    const saved = saveSpy.mock.calls[0][0] as MeetingSession;
    expect(saved.speakerRoster).toEqual(["Alice", "Bob"]);
  });

  it("currentSessionSnapshot includes the live roster", () => {
    useApp.setState({
      segments: [makeSegment({ id: "s1" })],
      startedAt: 1000,
      speakerRoster: ["Alice"],
    });
    expect(currentSessionSnapshot()?.speakerRoster).toEqual(["Alice"]);
  });

  it("round-trip: save then load returns the exact same roster", async () => {
    vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
    let stored: MeetingSession | undefined;
    vi.spyOn(storageModule, "saveSession").mockImplementation(async (session) => {
      stored = session;
      return true;
    });
    useApp.setState({
      segments: [makeSegment({ id: "s1" })],
      startedAt: 1000,
      speakerRoster: ["Alice", "Bob"],
      activeSessionId: null,
    });
    await useApp.getState().saveCurrentSession();
    expect(stored).toBeDefined();

    vi.spyOn(storageModule, "getSession").mockResolvedValue(stored!);
    await useApp.getState().loadSession(stored!.id);

    expect(useApp.getState().speakerRoster).toEqual(["Alice", "Bob"]);
  });
});

describe("saveCurrentSession clears the live draft (crash/refresh recovery, v0.5 closeout)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears the liveDraft on every normal save — a meeting that ends normally must never leave a draft behind", async () => {
    vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
    const clearSpy = vi.spyOn(liveDraftModule, "clearDraft").mockResolvedValue(undefined);
    useApp.setState({
      segments: [makeSegment({ id: "s1" })],
      startedAt: 1000,
      activeSessionId: null,
    });

    await useApp.getState().saveCurrentSession();

    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it("H3 fix (Sol adversarial review): clears using THIS meeting's own draftId (deriveDraftId(meetingGen, startedAt))", async () => {
    vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
    const clearSpy = vi.spyOn(liveDraftModule, "clearDraft").mockResolvedValue(undefined);
    useApp.setState({
      segments: [makeSegment({ id: "s1" })],
      startedAt: 1000,
      meetingGen: 4,
      activeSessionId: null,
    });

    await useApp.getState().saveCurrentSession();

    expect(clearSpy).toHaveBeenCalledWith(liveDraftModule.deriveDraftId(4, 1000));
  });

  describe("H1 fix — a failed underlying save keeps the draft and reports failure honestly", () => {
    it("resolves null, shows 保存失败 toast, and does NOT clear the draft (or touch sessions/activeSessionId) when storage.saveSession fails", async () => {
      vi.spyOn(storageModule, "saveSession").mockResolvedValue(false);
      const clearSpy = vi.spyOn(liveDraftModule, "clearDraft").mockResolvedValue(undefined);
      const listSpy = vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
      useApp.setState({
        segments: [makeSegment({ id: "s1" })],
        startedAt: 1000,
        activeSessionId: null,
        sessions: [],
      });

      const id = await useApp.getState().saveCurrentSession();

      expect(id).toBeNull();
      expect(useApp.getState().toast).toBe("保存失败，会议草稿已保留");
      expect(clearSpy).not.toHaveBeenCalled();
      expect(listSpy).not.toHaveBeenCalled();
      expect(useApp.getState().activeSessionId).toBeNull();
    });
  });
});

describe("restoreLiveDraft — materializes a RecoveryBanner draft into history (v0.5 closeout)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeDraftSession(overrides: Partial<MeetingSession> = {}): MeetingSession {
    return {
      id: "draft-1",
      title: "会议 2026-07-01 09:00",
      startedAt: 1000,
      endedAt: 2000,
      engine: "webspeech",
      segments: [makeSegment({ id: "d1" })],
      cards: [],
      terms: [],
      speakerRoster: [],
      ...overrides,
    };
  }

  it("the draft snapshot is a session the history layer's own sessionToMeta accepts (session-shape check, mirrors storage.test.ts)", () => {
    expect(sessionToMeta(makeDraftSession())).toMatchObject({
      id: "draft-1",
      startedAt: 1000,
      endedAt: 2000,
      segmentCount: 1,
      cardCount: 0,
      termCount: 0,
      hasSummary: false,
    });
  });

  it("H4 fix (Sol adversarial review): saves the snapshot's CONTENT under a FRESH id — never reuses the incoming one (every live-draft snapshot's own id is the shared 'unsaved' fallback, see currentSessionSnapshot)", async () => {
    const saveSpy = vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
    vi.spyOn(liveDraftModule, "clearDraft").mockResolvedValue(undefined);
    const snapshot = makeDraftSession();

    await useApp.getState().restoreLiveDraft(snapshot, "gen1:1000");

    expect(saveSpy).toHaveBeenCalledTimes(1);
    const saved = saveSpy.mock.calls[0][0] as MeetingSession;
    expect(saved).toMatchObject({ ...snapshot, id: expect.any(String) });
    expect(saved.id).not.toBe(snapshot.id);
  });

  it("H4 fix: two separate recoveries mint DISTINCT ids — a second crash-recovery does not overwrite the first recovered session in storage", async () => {
    const saveSpy = vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
    vi.spyOn(liveDraftModule, "clearDraft").mockResolvedValue(undefined);

    // Both drafts carry the SAME "unsaved" id, exactly like every
    // never-saved live draft does (currentSessionSnapshot's own
    // fallback) — the fix must not trust that shared incoming id.
    await useApp.getState().restoreLiveDraft(makeDraftSession({ id: "unsaved" }), "gen1:1000");
    await useApp.getState().restoreLiveDraft(makeDraftSession({ id: "unsaved" }), "gen2:2000");

    expect(saveSpy).toHaveBeenCalledTimes(2);
    const firstId = (saveSpy.mock.calls[0][0] as MeetingSession).id;
    const secondId = (saveSpy.mock.calls[1][0] as MeetingSession).id;
    expect(firstId).not.toBe(secondId);
  });

  it("refreshes the sessions list from storage so the restored meeting shows up in 历史 immediately", async () => {
    vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    const metas = [
      {
        id: "draft-1",
        title: "t",
        startedAt: 1000,
        endedAt: 2000,
        segmentCount: 1,
        cardCount: 0,
        termCount: 0,
        hasSummary: false,
      },
    ];
    vi.spyOn(storageModule, "listSessions").mockResolvedValue(metas);
    vi.spyOn(liveDraftModule, "clearDraft").mockResolvedValue(undefined);

    await useApp.getState().restoreLiveDraft(makeDraftSession(), "gen1:1000");

    expect(useApp.getState().sessions).toEqual(metas);
  });

  it("clears the draft, passing through the SAME draftId it was given, once materialized (H3 fix)", async () => {
    vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
    const clearSpy = vi.spyOn(liveDraftModule, "clearDraft").mockResolvedValue(undefined);

    await useApp.getState().restoreLiveDraft(makeDraftSession(), "gen1:1000");

    expect(clearSpy).toHaveBeenCalledWith("gen1:1000");
  });

  it("shows the recovery toast and resolves true on success (H1 fix)", async () => {
    vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
    vi.spyOn(liveDraftModule, "clearDraft").mockResolvedValue(undefined);

    const ok = await useApp.getState().restoreLiveDraft(makeDraftSession(), "gen1:1000");

    expect(ok).toBe(true);
    expect(useApp.getState().toast).toBe("已恢复，可在历史记录中查看");
  });

  it("does NOT touch the live segments/cards/activeSessionId/status/meetingGen — the draft may belong to a DIFFERENT (older) meeting than the one currently LIVE in this tab (new-meeting-while-banner scenario)", async () => {
    vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
    vi.spyOn(liveDraftModule, "clearDraft").mockResolvedValue(undefined);
    const liveSegments = [makeSegment({ id: "live-only" })];
    // A brand-new meeting is genuinely LIVE right now — not just "viewing
    // a different saved session" — while an OLDER crashed meeting's
    // draft is what's being restored.
    useApp.setState({
      status: "listening",
      meetingGen: 7,
      segments: liveSegments,
      activeSessionId: null,
      cards: [],
    });

    await useApp.getState().restoreLiveDraft(makeDraftSession({ id: "totally-different-draft" }), "gen1:1000");

    expect(useApp.getState().segments).toBe(liveSegments);
    expect(useApp.getState().activeSessionId).toBeNull();
    expect(useApp.getState().status).toBe("listening");
    expect(useApp.getState().meetingGen).toBe(7);
  });

  describe("H1 fix — a failed underlying save keeps the draft and reports failure honestly", () => {
    it("resolves false, shows 恢复失败 toast, and does NOT clear the draft (or touch the sessions list) when storage.saveSession fails", async () => {
      vi.spyOn(storageModule, "saveSession").mockResolvedValue(false);
      const clearSpy = vi.spyOn(liveDraftModule, "clearDraft").mockResolvedValue(undefined);
      const listSpy = vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);

      const ok = await useApp.getState().restoreLiveDraft(makeDraftSession(), "gen1:1000");

      expect(ok).toBe(false);
      expect(useApp.getState().toast).toBe("恢复失败，请重试");
      expect(clearSpy).not.toHaveBeenCalled();
      expect(listSpy).not.toHaveBeenCalled();
    });
  });
});

describe("updateCard / updateTerm — v0.5 Wave-1 Feature 7 inline card edit (committed-mutation tripwire + post-stop re-save)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearDiag();
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
      terms: [
        {
          id: "t1",
          normKey: "ARR",
          firstSeenAt: 9000,
          lastSeenAt: 9000,
          count: 1,
          source: "dictionary",
          term: "ARR",
          type: "metric",
          gloss_en: "Annual Recurring Revenue",
          gloss_zh: "年度经常性收入",
        },
      ],
      segments: [makeSegment({ id: "seg-1" })],
      status: "stopped",
      meetingGen: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("updateCard refuses the write and logs a warn diag entry when status !== 'stopped'", () => {
    useApp.setState({ status: "listening" });
    useApp.getState().updateCard("c1", { meaning: "hacked" });

    expect(useApp.getState().cards[0].meaning).toBe("return to this topic"); // refused
    const entries = getDiagEntries().filter((e) => e.tag === "stt-committed-mutation");
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("warn");
    expect(entries[0].detail).toBe("cardId=c1 status=listening");
  });

  it("updateCard patches the matching card by id, leaving others untouched, once stopped", () => {
    useApp.getState().updateCard("c1", {
      expression: "loop back",
      meaning: "revisit",
      chinese_explanation: "回头",
      plain_english: "come back to it",
    });
    const card = useApp.getState().cards[0];
    expect(card.expression).toBe("loop back");
    expect(card.meaning).toBe("revisit");
    expect(card.chinese_explanation).toBe("回头");
    expect(card.plain_english).toBe("come back to it");
    expect(card.id).toBe("c1"); // identity preserved
  });

  it("updateCard on an unknown id is a no-op", () => {
    useApp.getState().updateCard("missing", { meaning: "x" });
    expect(useApp.getState().cards[0].meaning).toBe("return to this topic");
  });

  it("updateTerm refuses the write outside 'stopped'", () => {
    useApp.setState({ status: "paused" });
    useApp.getState().updateTerm("t1", { gloss_en: "hacked" });
    expect(useApp.getState().terms[0].gloss_en).toBe("Annual Recurring Revenue");
    expect(getDiagEntries().filter((e) => e.tag === "stt-committed-mutation")).toHaveLength(1);
  });

  it("updateTerm patches the matching term by id, once stopped", () => {
    useApp.getState().updateTerm("t1", {
      term: "NRR",
      gloss_en: "Net Recurring Revenue",
      gloss_zh: "净经常性收入",
    });
    const term = useApp.getState().terms[0];
    expect(term.term).toBe("NRR");
    expect(term.gloss_en).toBe("Net Recurring Revenue");
    expect(term.gloss_zh).toBe("净经常性收入");
    expect(term.id).toBe("t1");
  });

  it("updateCard schedules a debounced post-stop re-save", async () => {
    const saveSpy = vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
    useApp.setState({ activeSessionId: null });

    useApp.getState().updateCard("c1", { meaning: "revisit" });
    expect(saveSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    const saved = saveSpy.mock.calls[0][0] as MeetingSession;
    expect(saved.cards[0].meaning).toBe("revisit");
  });
});

describe("setCorrectionBusy — v0.5 Wave-1 Feature 2", () => {
  afterEach(() => {
    useApp.setState({ correctionBusy: false });
  });

  it("defaults to false", () => {
    expect(useApp.getState().correctionBusy).toBe(false);
  });

  it("toggles true/false via the setter", () => {
    useApp.getState().setCorrectionBusy(true);
    expect(useApp.getState().correctionBusy).toBe(true);
    useApp.getState().setCorrectionBusy(false);
    expect(useApp.getState().correctionBusy).toBe(false);
  });
});

describe("elapsedActiveMs — pure pause/resume elapsed-time math (B2)", () => {
  it("returns 0 when there's no meeting (startedAt: null), regardless of the other params", () => {
    expect(elapsedActiveMs(null, 999_999, 12_345, 500)).toBe(0);
    expect(elapsedActiveMs(null, 0, 0, null)).toBe(0);
  });

  it("not paused (pauseStartedAt: null): elapsed = now - startedAt - pausedAccumMs", () => {
    expect(elapsedActiveMs(1000, 5000, 0, null)).toBe(4000);
    expect(elapsedActiveMs(1000, 10_000, 3_000, null)).toBe(6_000); // one prior pause already folded in
  });

  it("currently paused: frozen at pauseStartedAt, ignoring `now` entirely", () => {
    const frozen = elapsedActiveMs(1000, 5000, 0, 4000); // paused at t=4000
    expect(frozen).toBe(3000); // 4000 - 1000 - 0
    // `now` ticking further makes no difference while still paused.
    expect(elapsedActiveMs(1000, 999_999, 0, 4000)).toBe(frozen);
  });

  it("a prior pause's accumulated duration is excluded even while paused again", () => {
    // Meeting started at 0, one earlier pause already folded pausedAccumMs
    // to 2000ms, now paused AGAIN at t=10_000.
    expect(elapsedActiveMs(0, 999_999, 2_000, 10_000)).toBe(8_000);
  });

  it("clamps to 0 rather than going negative on pathological inputs", () => {
    expect(elapsedActiveMs(5000, 5000, 10_000, null)).toBe(0);
  });

  it("is DST-agnostic — pure epoch-ms subtraction, no wall-clock/timezone-aware math", () => {
    // 2026 US spring-forward DST boundary. Date.UTC values straddle it,
    // but since this helper only ever subtracts raw epoch ms, the
    // result is exactly the millisecond delta regardless of the local
    // timezone the test happens to run in — a wall-clock-aware
    // implementation (e.g. one that built Date objects and diffed
    // hours/minutes) could otherwise misfire by +/- 1h right here.
    const before = Date.UTC(2026, 2, 8, 1, 30, 0); // 2026-03-08T01:30:00Z
    const after = Date.UTC(2026, 2, 8, 3, 30, 0); // 2026-03-08T03:30:00Z
    expect(elapsedActiveMs(before, after, 0, null)).toBe(2 * 60 * 60 * 1000);
  });
});

describe("pauseMeeting / resumeMeeting — store actions (B2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    useApp.setState({
      status: "listening",
      startedAt: 0,
      pausedAccumMs: 0,
      pauseStartedAt: null,
      pauseIntervals: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pauseMeeting sets status:'paused' and stamps pauseStartedAt to now, leaving pausedAccumMs untouched", () => {
    useApp.getState().pauseMeeting();
    expect(useApp.getState().status).toBe("paused");
    expect(useApp.getState().pauseStartedAt).toBe(10_000);
    expect(useApp.getState().pausedAccumMs).toBe(0);
  });

  it("resumeMeeting folds the pause duration into pausedAccumMs, flips back to listening, and clears pauseStartedAt", () => {
    useApp.getState().pauseMeeting(); // pauseStartedAt = 10_000
    vi.setSystemTime(13_500); // paused for 3.5s
    useApp.getState().resumeMeeting();

    const s = useApp.getState();
    expect(s.status).toBe("listening");
    expect(s.pauseStartedAt).toBeNull();
    expect(s.pausedAccumMs).toBe(3_500);
  });

  it("a second pause/resume cycle accumulates on top of the prior pausedAccumMs", () => {
    useApp.getState().pauseMeeting(); // t=10_000
    vi.setSystemTime(12_000);
    useApp.getState().resumeMeeting(); // +2000 -> pausedAccumMs=2000

    vi.setSystemTime(20_000);
    useApp.getState().pauseMeeting(); // t=20_000
    vi.setSystemTime(21_500);
    useApp.getState().resumeMeeting(); // +1500 -> pausedAccumMs=3500

    expect(useApp.getState().pausedAccumMs).toBe(3_500);
  });

  it("resumeMeeting tolerates pauseStartedAt already being null (defensive ?? Date.now() fallback) without NaN/throw", () => {
    useApp.setState({ pauseStartedAt: null, pausedAccumMs: 1_000 });
    useApp.getState().resumeMeeting();
    expect(useApp.getState().pausedAccumMs).toBe(1_000); // (now - now) folded in — unchanged
    expect(useApp.getState().status).toBe("listening");
    expect(Number.isNaN(useApp.getState().pausedAccumMs)).toBe(false);
  });

  it("beginMeeting resets pausedAccumMs/pauseStartedAt for a fresh meeting", () => {
    useApp.setState({ pausedAccumMs: 5_000, pauseStartedAt: 9_000 });
    useApp.getState().beginMeeting();
    expect(useApp.getState().pausedAccumMs).toBe(0);
    expect(useApp.getState().pauseStartedAt).toBeNull();
  });

  it("newMeeting resets pausedAccumMs/pauseStartedAt too", () => {
    useApp.setState({ pausedAccumMs: 5_000, pauseStartedAt: 9_000 });
    useApp.getState().newMeeting();
    expect(useApp.getState().pausedAccumMs).toBe(0);
    expect(useApp.getState().pauseStartedAt).toBeNull();
  });

  // Transcript-timestamp fix: pauseIntervals records each completed
  // pause's own {start,end} — pausedAccumMs alone (a running total)
  // can't tell a later per-segment elapsed mapping which pauses
  // happened BEFORE a given segment (see segmentElapsed.ts).
  it("resumeMeeting appends the completed {start,end} interval to pauseIntervals", () => {
    useApp.getState().pauseMeeting(); // pauseStartedAt = 10_000
    vi.setSystemTime(13_500);
    useApp.getState().resumeMeeting();

    expect(useApp.getState().pauseIntervals).toEqual([{ start: 10_000, end: 13_500 }]);
  });

  it("a second pause/resume cycle appends a second interval, preserving the first", () => {
    useApp.getState().pauseMeeting(); // t=10_000
    vi.setSystemTime(12_000);
    useApp.getState().resumeMeeting();

    vi.setSystemTime(20_000);
    useApp.getState().pauseMeeting();
    vi.setSystemTime(21_500);
    useApp.getState().resumeMeeting();

    expect(useApp.getState().pauseIntervals).toEqual([
      { start: 10_000, end: 12_000 },
      { start: 20_000, end: 21_500 },
    ]);
  });

  it("resumeMeeting does not append a bogus interval when pauseStartedAt was already null (same defensive tolerance as pausedAccumMs)", () => {
    useApp.setState({ pauseStartedAt: null, pausedAccumMs: 1_000, pauseIntervals: [] });
    useApp.getState().resumeMeeting();
    expect(useApp.getState().pauseIntervals).toEqual([]);
  });

  it("beginMeeting resets pauseIntervals for a fresh meeting", () => {
    useApp.setState({ pauseIntervals: [{ start: 1, end: 2 }] });
    useApp.getState().beginMeeting();
    expect(useApp.getState().pauseIntervals).toEqual([]);
  });

  it("newMeeting resets pauseIntervals too", () => {
    useApp.setState({ pauseIntervals: [{ start: 1, end: 2 }] });
    useApp.getState().newMeeting();
    expect(useApp.getState().pauseIntervals).toEqual([]);
  });
});

describe("saveCurrentSession / loadSession / currentSessionSnapshot — elapsed-time basis persistence (transcript-timestamp fix)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saveCurrentSession always persists pauseIntervals, even [] for a never-paused meeting — presence (even empty) distinguishes 'known: zero pauses' from a legacy session's absence", async () => {
    const saveSpy = vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
    useApp.setState({
      segments: [makeSegment({ id: "s1", startedAt: 1000, endedAt: 1100 })],
      startedAt: 1000,
      pauseIntervals: [],
      pauseStartedAt: null,
      activeSessionId: null,
    });

    await useApp.getState().saveCurrentSession();

    expect(saveSpy).toHaveBeenCalledTimes(1);
    const saved = saveSpy.mock.calls[0][0] as MeetingSession;
    expect(saved.pauseIntervals).toEqual([]);
  });

  it("saveCurrentSession persists the exact pauseIntervals recorded during the meeting", async () => {
    const saveSpy = vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
    vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
    const pauseIntervals = [{ start: 1200, end: 1500 }];
    useApp.setState({
      segments: [makeSegment({ id: "s1", startedAt: 1000, endedAt: 1100 })],
      startedAt: 1000,
      pauseIntervals,
      pauseStartedAt: null,
      activeSessionId: null,
    });

    await useApp.getState().saveCurrentSession();

    const saved = saveSpy.mock.calls[0][0] as MeetingSession;
    expect(saved.pauseIntervals).toEqual(pauseIntervals);
  });

  it("currentSessionSnapshot includes the live pauseIntervals", () => {
    useApp.setState({
      segments: [makeSegment({ id: "s1", startedAt: 1000, endedAt: 1100 })],
      startedAt: 1000,
      pauseIntervals: [{ start: 1050, end: 1060 }],
      pauseStartedAt: null,
    });
    const snap = currentSessionSnapshot();
    expect(snap?.pauseIntervals).toEqual([{ start: 1050, end: 1060 }]);
  });

  // codex v2 review finding F5: ending (or exporting) WHILE paused
  // must not persist an unclosed pause interval — see
  // pauseIntervalsForSnapshot's own doc in store.ts.
  describe("F5 — a still-open pause is closed in the PERSISTED/exported snapshot only, never in live state", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(20_000);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("saveCurrentSession (End-from-paused) appends a closing interval ending at save time, without mutating live pauseIntervals/pauseStartedAt", async () => {
      const saveSpy = vi.spyOn(storageModule, "saveSession").mockResolvedValue(true);
      vi.spyOn(storageModule, "listSessions").mockResolvedValue([]);
      useApp.setState({
        segments: [makeSegment({ id: "s1", startedAt: 1000, endedAt: 1100 })],
        startedAt: 1000,
        pauseIntervals: [{ start: 5000, end: 8000 }], // one already-completed pause
        pauseStartedAt: 15_000, // still open — e.g. End clicked while paused
        activeSessionId: null,
      });

      await useApp.getState().saveCurrentSession();

      const saved = saveSpy.mock.calls[0][0] as MeetingSession;
      expect(saved.pauseIntervals).toEqual([
        { start: 5000, end: 8000 },
        { start: 15_000, end: 20_000 }, // closed at save time (fake now)
      ]);
      // Snapshot-local: live state is untouched by building the snapshot.
      expect(useApp.getState().pauseIntervals).toEqual([{ start: 5000, end: 8000 }]);
      expect(useApp.getState().pauseStartedAt).toBe(15_000);
    });

    it("currentSessionSnapshot (export/copy mid-pause) closes the open interval the same way, also without mutating live state", () => {
      useApp.setState({
        segments: [makeSegment({ id: "s1", startedAt: 1000, endedAt: 1100 })],
        startedAt: 1000,
        pauseIntervals: [],
        pauseStartedAt: 12_000,
      });

      const snap = currentSessionSnapshot();

      expect(snap?.pauseIntervals).toEqual([{ start: 12_000, end: 20_000 }]);
      expect(useApp.getState().pauseIntervals).toEqual([]);
      expect(useApp.getState().pauseStartedAt).toBe(12_000);
    });

    it("a non-terminal snapshot taken mid-pause does not corrupt a LATER resumeMeeting() in the same meeting", () => {
      useApp.setState({
        segments: [makeSegment({ id: "s1", startedAt: 1000, endedAt: 1100 })],
        startedAt: 1000,
        pauseIntervals: [],
        pauseStartedAt: 12_000,
      });

      currentSessionSnapshot(); // e.g. an export button clicked mid-pause

      vi.setSystemTime(25_000);
      useApp.getState().resumeMeeting();

      // Exactly ONE interval — the snapshot must not have pre-closed it
      // (which would otherwise leave resumeMeeting appending a SECOND,
      // overlapping one on top).
      expect(useApp.getState().pauseIntervals).toEqual([{ start: 12_000, end: 25_000 }]);
      expect(useApp.getState().pauseStartedAt).toBeNull();
      expect(useApp.getState().status).toBe("listening");
    });

    it("segmentElapsedMs on the reloaded session excludes the closed-at-save window — the persisted array is complete, not just present", () => {
      const pauseIntervals = pauseIntervalsForSnapshot([], 12_000, 20_000);
      // A hypothetical segment landing inside what USED to be an open
      // (uncloseable-by-the-old-array) pause window: fully excluded,
      // identical to a segment stamped right at the pause's own start —
      // proving the window doesn't silently count as active time.
      const atPauseStart = segmentElapsedMs(1000, 12_000, pauseIntervals);
      const midOpenWindow = segmentElapsedMs(1000, 16_000, pauseIntervals);
      expect(midOpenWindow).toBe(atPauseStart);
    });
  });

  it("loadSession resolves the elapsed basis for a session already carrying pauseIntervals (post-fix save), and resets any leftover live pause state from a previous meeting", async () => {
    const session: MeetingSession = {
      id: "sess-1",
      title: "t",
      startedAt: 5000,
      endedAt: 9000,
      engine: "whisper",
      segments: [makeSegment({ id: "s1", startedAt: 5200 })],
      cards: [],
      terms: [],
      pauseIntervals: [{ start: 6000, end: 6500 }],
    };
    vi.spyOn(storageModule, "getSession").mockResolvedValue(session);
    // Leftover live pause state the store hadn't cleared from whatever
    // it was doing before — loadSession must reset it regardless.
    useApp.setState({ pausedAccumMs: 42_000, pauseStartedAt: 99_000 });

    await useApp.getState().loadSession("sess-1");

    const s = useApp.getState();
    expect(s.status).toBe("stopped");
    expect(s.startedAt).toBe(5000); // session.startedAt — pauseIntervals is present, not legacy
    expect(s.pauseIntervals).toEqual([{ start: 6000, end: 6500 }]);
    expect(s.pausedAccumMs).toBe(0);
    expect(s.pauseStartedAt).toBeNull();
  });

  it("loadSession falls back to segments[0].startedAt for a legacy session lacking pauseIntervals, with no pause exclusion, and never crashes/goes negative", async () => {
    const session: MeetingSession = {
      id: "sess-legacy",
      title: "t",
      startedAt: 500, // pre-fix session.startedAt (meeting-start, ahead of the first segment)
      endedAt: 9000,
      engine: "whisper",
      segments: [makeSegment({ id: "s1", startedAt: 1000 })],
      cards: [],
      terms: [],
      // no pauseIntervals key at all — legacy data, saved before this fix
    };
    vi.spyOn(storageModule, "getSession").mockResolvedValue(session);

    await useApp.getState().loadSession("sess-legacy");

    const s = useApp.getState();
    expect(s.startedAt).toBe(1000); // segments[0].startedAt, NOT session.startedAt (500)
    expect(s.pauseIntervals).toEqual([]);
  });

  it("loadSession's session-not-found path is unaffected by the elapsed-basis change", async () => {
    vi.spyOn(storageModule, "getSession").mockResolvedValue(null);
    const genBefore = useApp.getState().meetingGen;

    await useApp.getState().loadSession("missing");

    expect(useApp.getState().toast).toBe("会话不存在或已删除");
    expect(useApp.getState().meetingGen).toBe(genBefore); // unchanged — no session applied
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
    const applied = useApp.getState().updateSegmentText("seg-1", "hacked live edit");

    expect(applied).toBe(false); // Finding 3 fix: refusal is now reported to the caller
    expect(useApp.getState().segments[0].text).toBe("original"); // refused
    const entries = getDiagEntries().filter((e) => e.tag === "stt-committed-mutation");
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("warn");
    expect(entries[0].detail).toBe("segmentId=seg-1 status=listening");
    expect(entries[0].detail).not.toContain("hacked"); // never the transcript text
    expect(entries[0].message).not.toContain("hacked");
  });

  it("refuses while 'paused' too — not only 'listening'/'connecting'", () => {
    useApp.setState({ status: "paused" });
    const applied = useApp.getState().updateSegmentText("seg-1", "hacked during pause");

    expect(applied).toBe(false);
    expect(useApp.getState().segments[0].text).toBe("original");
    expect(getDiagEntries().filter((e) => e.tag === "stt-committed-mutation")).toHaveLength(1);
  });

  it("still allows the edit (no diag entry) once the session is actually stopped", () => {
    const applied = useApp.getState().updateSegmentText("seg-1", "corrected text");

    expect(applied).toBe(true); // Finding 3 fix: success is now reported to the caller
    expect(useApp.getState().segments[0].text).toBe("corrected text");
    expect(getDiagEntries().filter((e) => e.tag === "stt-committed-mutation")).toHaveLength(0);
  });

  // Finding 3 fix (pre-merge review): the SECOND refusal branch (blank/
  // whitespace-only text) had no return-value coverage at all before —
  // it must ALSO report false, not just the status tripwire above.
  it("refuses (returns false) a blank/whitespace-only text even while stopped, without mutating the segment", () => {
    const applied = useApp.getState().updateSegmentText("seg-1", "   ");

    expect(applied).toBe(false);
    expect(useApp.getState().segments[0].text).toBe("original");
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
    expect(applyTierDefaults(withEngine("tabaudio-cloud"), false, true).engine).toBe("tabaudio-cloud");
    expect(applyTierDefaults(withEngine("appaudio"), false, true).engine).toBe("appaudio");
    expect(applyTierDefaults(withEngine("osspeech"), false, true).engine).toBe("osspeech");
    expect(applyTierDefaults(withEngine("soniox"), false, true).engine).toBe("soniox");
    expect(applyTierDefaults(withEngine("deepgram"), false, true).engine).toBe("deepgram");
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

  it("preview tier leaves a saved BYOK cloud engine (tabaudio-cloud) selectable — v0.5 Wave-1 F4 / §5 A4 + BYOK preview D3 (docs/design-explorations/byok-preview-blueprint.md): survives UNCONDITIONALLY, same as full tier — a keyless pick fails honestly at start, not this coercion's job", () => {
    const s = applyTierDefaults(withEngine("tabaudio-cloud"), true, true);
    expect(s.engine).toBe("tabaudio-cloud");
  });

  it("preview tier coerces a saved sidecar-only engine (appaudio) to webspeech — S9/D7: structural coverage only, since applyPlatformEngineDefaults would already have coerced a stored appaudio away on a real (web) preview build before this function ever sees it", () => {
    const s = applyTierDefaults(withEngine("appaudio"), true, true);
    expect(s.engine).toBe("webspeech");
  });

  it("preview tier leaves a saved BYOK cloud engine (soniox) selectable — BYOK preview D3: survives UNCONDITIONALLY, same as full tier (superseded the old v0.4 S4 blueprint decision E lock)", () => {
    const s = applyTierDefaults(withEngine("soniox"), true, true);
    expect(s.engine).toBe("soniox");
  });

  it("preview tier leaves a saved BYOK cloud engine (deepgram) selectable — BYOK preview D3: survives UNCONDITIONALLY, same posture as soniox (superseded the old v0.4.7 Lane D lock)", () => {
    const s = applyTierDefaults(withEngine("deepgram"), true, true);
    expect(s.engine).toBe("deepgram");
  });

  it("preview tier coerces a saved osspeech to webspeech — S11: structural coverage only, since applyPlatformEngineDefaults would already have coerced a stored osspeech away to tabaudio on a real (web) preview build before this function ever sees it", () => {
    const s = applyTierDefaults(withEngine("osspeech"), true, true);
    expect(s.engine).toBe("webspeech");
  });

  // S14.1 field fix (real owner report on the hosted preview): this
  // used to coerce ONLY on a true first run (hadSavedEngine:false) —
  // a returning user's own persisted engine:"demo" (from ≡ 演示)
  // survived untouched, on the theory that they'd deliberately left it
  // mid-demo. In the field that theory broke: 开始监听 silently
  // replayed the demo forever after, with no obvious way to tell why.
  // Now unconditional regardless of hadSavedEngine — see
  // applyTierDefaults' own doc comment for the root-cause half of this
  // fix (useMeeting.ts's startDemo no longer persists engine:"demo" at
  // all, so this coercion only ever redirects a STALE pre-fix value).
  it.each([true, false])(
    "preview tier coerces engine:demo to webspeech unconditionally — hadSavedEngine=%s",
    (hadSavedEngine) => {
      const s = applyTierDefaults(withEngine("demo"), true, hadSavedEngine);
      expect(s.engine).toBe("webspeech");
    },
  );

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

// BYOK preview (docs/design-explorations/byok-preview-blueprint.md D3):
// applyTierDefaults' optional 4th param (`sonioxPreviewLane`) is now
// VESTIGIAL — soniox/deepgram/tabaudio-cloud all survive preview
// UNCONDITIONALLY (see the describe block above), so this argument can
// no longer change the outcome for any engine. Kept in the function
// signature (same posture as `_hadSavedEngine` — see applyTierDefaults'
// own doc comment, store.ts) purely so every existing 4-arg call below
// keeps compiling; these tests now pin the "the 4th arg is provably
// inert" claim directly (both `true` and `false` produce the identical
// result), guarding against an accidental re-wiring silently
// reintroducing the old lane-only carve-out.
describe("applyTierDefaults — soniox preview lane (4th param, vestigial per BYOK preview D3)", () => {
  function withEngine(engine: Settings["engine"]): Settings {
    return { ...DEFAULT_SETTINGS, engine };
  }

  it.each([true, false])(
    "soniox SURVIVES coercion regardless of the 4th arg (%s) — D3 replaced the lane-only carve-out with unconditional survival",
    (laneArg) => {
      expect(applyTierDefaults(withEngine("soniox"), true, true, laneArg).engine).toBe("soniox");
    },
  );

  it.each([true, false])(
    "deepgram ALSO now survives regardless of the 4th arg (%s) — D3 extends survival to every byok engine, not just the two the old carve-out covered",
    (laneArg) => {
      expect(applyTierDefaults(withEngine("deepgram"), true, true, laneArg).engine).toBe("deepgram");
    },
  );

  it.each([true, false])(
    "tabaudio-cloud SURVIVES coercion regardless of the 4th arg (%s)",
    (laneArg) => {
      expect(applyTierDefaults(withEngine("tabaudio-cloud"), true, true, laneArg).engine).toBe(
        "tabaudio-cloud",
      );
    },
  );

  it.each([true, false])(
    "tabaudio (local-sidecar, never byokOnly) keeps coercing to webspeech regardless of the 4th arg (%s) — this param was never sidecar-relevant, before or after D3",
    (laneArg) => {
      expect(applyTierDefaults(withEngine("tabaudio"), true, true, laneArg).engine).toBe("webspeech");
    },
  );
});

// S14.1 field fix, other half: useMeeting.ts's startDemo now calls
// updateSettings({engine:"demo"}, {persist:false}) — see that call
// site's own doc comment. These pin the store-action contract it
// relies on directly, independent of the pure applyTierDefaults
// coercion tested above (which only ever cleans up an ALREADY-stale
// persisted value; this is what stops a fresh one from being written).
describe("updateSettings — persist opt-out (S14.1 演示 fix)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useApp.setState({ settings: DEFAULT_SETTINGS });
  });

  it("opts.persist:false updates live settings but never calls storage.saveSettings", () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" } });
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    useApp.getState().updateSettings({ engine: "demo" }, { persist: false });

    expect(useApp.getState().settings.engine).toBe("demo");
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("every other call site (opts omitted) persists exactly as before", () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" } });
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    useApp.getState().updateSettings({ aiDetect: false });

    expect(useApp.getState().settings.aiDetect).toBe(false);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ engine: "webspeech", aiDetect: false }),
    );
  });

  it("opts.persist:true is identical to omitting opts — persists", () => {
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    useApp.getState().updateSettings({ engine: "demo" }, { persist: true });

    expect(useApp.getState().settings.engine).toBe("demo");
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });
});

// Quit-time settings durability (field fix — real desktop/Tauri report:
// an API key saved shortly before quitting the app was lost).
// updateSettings' own persist is fire-and-forget (see store.ts's
// pendingSettingsSave doc) — flushSettings is the durable-commit escape
// hatch a caller can actually await (SettingsDialog's 保存 handler does
// exactly this before closing/toasting; hydrate()'s own quit-time
// pagehide/visibilitychange listener calls it unawaited — see WebKit bug
// 199854, mirrors useMeeting.ts's own live-draft flush). These pin the
// promise-chaining contract directly; the DOM-side listener wiring
// itself is covered separately in store.quitFlush.test.ts (jsdom).
describe("flushSettings — durable-commit guarantee for the quit-time flush", () => {
  beforeEach(() => {
    // F1 fix (Sol + Opus review, BLOCK): flushSettings is now a guarded
    // no-op pre-hydration (see store.ts's own doc) — every test below
    // simulates a caller reachable only post-hydration in the real app
    // (SettingsDialog's 保存, the quit-time listeners once hydrate()
    // resolves), same posture store.quitFlush.test.ts's own tests take.
    useApp.setState({ hydrated: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: false });
  });

  it("resolves only after storage.saveSettings resolves, writing the CURRENT live settings", async () => {
    let resolveWrite: (() => void) | undefined;
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockImplementation(
      () => new Promise<void>((resolve) => { resolveWrite = resolve; }),
    );
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" } });

    let landed = false;
    const flushed = useApp.getState().flushSettings().then(() => { landed = true; });

    // The underlying write hasn't resolved yet — flushSettings must not
    // have settled either, no matter how many microtask ticks pass.
    await Promise.resolve();
    await Promise.resolve();
    expect(landed).toBe(false);
    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ engine: "webspeech" }));

    resolveWrite!();
    await flushed;
    expect(landed).toBe(true);
  });

  it("supersedes/awaits an ALREADY in-flight updateSettings write — resolves only once BOTH have landed", async () => {
    let resolveFirst: (() => void) | undefined;
    const saveSpy = vi
      .spyOn(storageModule, "saveSettings")
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(undefined); // flushSettings' own fresh write

    useApp.getState().updateSettings({ engine: "webspeech" }); // fires the first (still-pending) write

    let landed = false;
    const flushed = useApp.getState().flushSettings().then(() => { landed = true; });

    await Promise.resolve();
    await Promise.resolve();
    expect(landed).toBe(false); // the EARLIER write is still in flight

    resolveFirst!();
    await flushed;
    expect(landed).toBe(true);
    expect(saveSpy).toHaveBeenCalledTimes(2); // updateSettings' write + flushSettings' own write
  });

  it("is safe to call with nothing changed since the last write (idempotent)", async () => {
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    await useApp.getState().flushSettings();
    await useApp.getState().flushSettings();

    expect(saveSpy).toHaveBeenCalledTimes(2);
    for (const call of saveSpy.mock.calls) {
      expect(call[0]).toEqual(useApp.getState().settings);
    }
  });
});

// F1 fix (Sol + Opus review, BLOCK — fieldtest-a batch): hydrate()
// installs the quit-time pagehide/visibilitychange listeners BEFORE the
// async `await Promise.all([storage.loadSettings(), ...])` resolves and
// `hydrated:true` is set — during that window get().settings is still
// DEFAULT_SETTINGS, so a pre-hydration pagehide/visibilitychange used to
// overwrite the user's real saved settings blob with defaults. Guarding
// inside flushSettings itself (rather than only at the listener install
// site) covers the listeners AND any other early caller — this pins the
// direct call-level contract; store.quitFlush.test.ts pins the actual
// pagehide dispatch racing hydrate() (needs a real DOM event, and is
// "exactly how this was missed": every pre-existing test there awaits
// hydrate() first).
describe("flushSettings — F1 pre-hydration guard (BLOCK fix)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: false });
  });

  it("is a guarded no-op — never calls storage.saveSettings — while hydrated is still false", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" }, hydrated: false });
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    await useApp.getState().flushSettings();

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("resumes writing once hydrated flips true (the listeners stay installed the whole time, unchanged)", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" }, hydrated: false });
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    await useApp.getState().flushSettings();
    expect(saveSpy).not.toHaveBeenCalled();

    useApp.setState({ hydrated: true });
    await useApp.getState().flushSettings();

    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ engine: "webspeech" }));
  });
});

// F2 fix (Sol MEDIUM review — fieldtest-a batch): storage.saveSettings
// now propagates a write failure instead of always resolving (see that
// function's own doc) — these pin the two halves of the caller-audit:
// (a) updateSettings' fire-and-forget persist branch must swallow the
// rejection (no unhandled rejection) AND must not leave
// pendingSettingsSave itself rejected, since flushSettings/the next
// updateSettings chain onto it; (b) flushSettings' OWN write failure
// must reach ITS caller (SettingsDialog's handleSave — see that
// component's own test for the toast/close half) while ALSO not
// poisoning pendingSettingsSave for whichever save runs next.
describe("updateSettings / flushSettings — F2 fix: a failed write doesn't poison later saves", () => {
  beforeEach(() => {
    useApp.setState({ hydrated: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: false });
  });

  it("updateSettings' fire-and-forget persist swallows a rejected write — no unhandled rejection", async () => {
    vi.spyOn(storageModule, "saveSettings").mockRejectedValueOnce(new Error("quota exceeded"));
    const onUnhandledRejection = vi.fn();
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      useApp.getState().updateSettings({ engine: "webspeech" });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(onUnhandledRejection).not.toHaveBeenCalled();
  });

  it("a failed updateSettings write does not poison pendingSettingsSave — a later flushSettings still resolves", async () => {
    const saveSpy = vi
      .spyOn(storageModule, "saveSettings")
      .mockRejectedValueOnce(new Error("quota exceeded")) // updateSettings' own fire-and-forget write
      .mockResolvedValueOnce(undefined); // flushSettings' own later write

    useApp.getState().updateSettings({ engine: "webspeech" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await expect(useApp.getState().flushSettings()).resolves.toBeUndefined();
    expect(saveSpy).toHaveBeenCalledTimes(2);
  });

  it("flushSettings propagates a write failure to its own caller (rejects)", async () => {
    vi.spyOn(storageModule, "saveSettings").mockRejectedValueOnce(new Error("disk full"));

    await expect(useApp.getState().flushSettings()).rejects.toThrow("disk full");
  });

  it("a flushSettings rejection does not poison pendingSettingsSave — a later flushSettings still resolves", async () => {
    const saveSpy = vi
      .spyOn(storageModule, "saveSettings")
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);

    await expect(useApp.getState().flushSettings()).rejects.toThrow("disk full");
    await expect(useApp.getState().flushSettings()).resolves.toBeUndefined();
    expect(saveSpy).toHaveBeenCalledTimes(2);
  });
});

// Demo-overlay stash (field-test round, extends S14.1): the two describe
// blocks above pin S14.1's OWN single write (startDemo's persist:false)
// and the general updateSettings/flushSettings persist contract in
// isolation — neither covers the leak S14.1 left open: an ORDINARY
// persist:true save (or the quit-time flushSettings/pagehide flush)
// firing while a demo is live merges + persists the WHOLE settings
// object, re-baking engine:"demo" back into storage. These pin
// beginDemoOverlay/endDemoOverlay + the settingsForPersist chokepoint
// that closes it — see AppState.demoOverlayPrevEngine's own doc, store.ts,
// for the full design. store.quitFlush.test.ts pins the pagehide/
// visibilitychange half specifically (needs a real DOM event).
describe("demo-overlay stash (field-test round, extends S14.1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useApp.setState({ settings: DEFAULT_SETTINGS, demoOverlayPrevEngine: null, hydrated: false });
  });

  it("beginDemoOverlay stashes the real engine and flips live engine to demo, without persisting", () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" } });
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    useApp.getState().beginDemoOverlay();

    expect(useApp.getState().settings.engine).toBe("demo");
    expect(useApp.getState().demoOverlayPrevEngine).toBe("webspeech");
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("beginDemoOverlay is idempotent — a second call while already overlaid doesn't re-stash the live \"demo\" value over the real one", () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" } });
    useApp.getState().beginDemoOverlay();

    useApp.getState().beginDemoOverlay();

    expect(useApp.getState().demoOverlayPrevEngine).toBe("webspeech");
    expect(useApp.getState().settings.engine).toBe("demo");
  });

  it("an ordinary persist:true save during the overlay writes the STASHED engine to storage — live state stays demo", () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" } });
    useApp.getState().beginDemoOverlay();
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    useApp.getState().updateSettings({ aiDetect: false });

    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ engine: "webspeech", aiDetect: false }),
    );
    expect(useApp.getState().settings.engine).toBe("demo");
  });

  it("flushSettings during the overlay writes the stashed engine", async () => {
    // F1 fix: flushSettings is a guarded no-op pre-hydration now.
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "tabaudio" }, hydrated: true });
    useApp.getState().beginDemoOverlay();
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    await useApp.getState().flushSettings();

    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ engine: "tabaudio" }));
    expect(useApp.getState().settings.engine).toBe("demo");
  });

  it("an explicit engine pick during the overlay clears the stash and persists the pick", () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" } });
    useApp.getState().beginDemoOverlay();
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    useApp.getState().updateSettings({ engine: "whisper" });

    expect(useApp.getState().demoOverlayPrevEngine).toBeNull();
    expect(useApp.getState().settings.engine).toBe("whisper");
    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ engine: "whisper" }));
  });

  it("endDemoOverlay restores the live engine and never touches storage", () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" } });
    useApp.getState().beginDemoOverlay();
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    useApp.getState().endDemoOverlay();

    expect(useApp.getState().settings.engine).toBe("webspeech");
    expect(useApp.getState().demoOverlayPrevEngine).toBeNull();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("endDemoOverlay is a safe no-op when no overlay is active", () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" }, demoOverlayPrevEngine: null });
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    useApp.getState().endDemoOverlay();

    expect(useApp.getState().settings.engine).toBe("webspeech");
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("stashing \"demo\" itself (a fresh install's first-ever ≡ 演示) still restores correctly through endDemoOverlay", () => {
    // DEFAULT_SETTINGS.engine is "demo" — a brand-new user's first demo
    // stashes "demo" as the "real" prior value, which IS correct (they
    // never picked anything else yet). Exercises the exact gap
    // endDemoOverlay's own doc comment calls out: updateSettings' overlay
    // supersession only clears the stash for a patch whose engine !==
    // "demo", so restoring a stash that IS "demo" needs endDemoOverlay's
    // own explicit clear, not that side effect.
    useApp.setState({ settings: DEFAULT_SETTINGS, demoOverlayPrevEngine: null });
    useApp.getState().beginDemoOverlay();
    expect(useApp.getState().demoOverlayPrevEngine).toBe("demo");

    useApp.getState().endDemoOverlay();

    expect(useApp.getState().demoOverlayPrevEngine).toBeNull();
    expect(useApp.getState().settings.engine).toBe("demo");
  });

  it("fresh-default case (no overlay): an ordinary save persists engine:\"demo\" unchanged, exactly as today", () => {
    expect(DEFAULT_SETTINGS.engine).toBe("demo");
    useApp.setState({ settings: DEFAULT_SETTINGS, demoOverlayPrevEngine: null });
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    useApp.getState().updateSettings({ aiDetect: false });

    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ engine: "demo", aiDetect: false }));
  });
});

describe("applyPlatformEngineDefaults — S9/D7 desktop tabaudio<->appaudio coercion", () => {
  function withEngine(engine: Settings["engine"]): Settings {
    return { ...DEFAULT_SETTINGS, engine };
  }

  it("desktop coerces a stored tabaudio to appaudio (WKWebView has no getDisplayMedia picker to fail into)", () => {
    const s = applyPlatformEngineDefaults(withEngine("tabaudio"), true);
    expect(s.engine).toBe("appaudio");
  });

  it("desktop coerces a stored tabaudio-cloud to appaudio too — v0.5 Wave-1 F4 / §5 A4, same D7 rationale as tabaudio itself (WKWebView has no tab-share picker, cloud backend or not; tabaudio-cloud is web-only for v0.5)", () => {
    const s = applyPlatformEngineDefaults(withEngine("tabaudio-cloud"), true);
    expect(s.engine).toBe("appaudio");
  });

  it("web coerces a stored appaudio to tabaudio (appaudio is Tauri-only, D6)", () => {
    const s = applyPlatformEngineDefaults(withEngine("appaudio"), false);
    expect(s.engine).toBe("tabaudio");
  });

  it("web coerces a stored osspeech to tabaudio (S11: osspeech is Tauri-only, identical D6 rationale)", () => {
    const s = applyPlatformEngineDefaults(withEngine("osspeech"), false);
    expect(s.engine).toBe("tabaudio");
  });

  // S10 field-fix #1: desktop's WKWebView has no SpeechRecognition API at
  // all, so a persisted webspeech must not be left selectable — coerced
  // to whisper (the local mic engine), NOT appaudio (system audio would
  // be the wrong substitute for a MIC engine).
  it("desktop coerces a stored webspeech to whisper (WKWebView has no SpeechRecognition API — S10 #1), leaving other fields untouched", () => {
    const s = applyPlatformEngineDefaults({ ...withEngine("webspeech"), language: "en-GB" }, true);
    expect(s.engine).toBe("whisper");
    expect(s.language).toBe("en-GB");
  });

  it("web leaves a stored webspeech untouched (webspeech works fine in a real browser)", () => {
    const s = applyPlatformEngineDefaults(withEngine("webspeech"), false);
    expect(s.engine).toBe("webspeech");
  });

  it("desktop leaves every other engine untouched, including appaudio and osspeech themselves", () => {
    for (const engine of ["whisper", "appaudio", "osspeech", "soniox", "deepgram", "demo"] as const) {
      expect(applyPlatformEngineDefaults(withEngine(engine), true).engine).toBe(engine);
    }
  });

  it("web leaves every other engine untouched, including tabaudio and tabaudio-cloud themselves", () => {
    for (const engine of [
      "webspeech",
      "whisper",
      "tabaudio",
      "tabaudio-cloud",
      "soniox",
      "deepgram",
      "demo",
    ] as const) {
      expect(applyPlatformEngineDefaults(withEngine(engine), false).engine).toBe(engine);
    }
  });

  it("leaves other settings fields untouched across a real coercion", () => {
    const base = { ...withEngine("tabaudio"), language: "en-GB" };
    const s = applyPlatformEngineDefaults(base, true);
    expect(s.engine).toBe("appaudio");
    expect(s.language).toBe("en-GB");
  });
});

// S13 (docs/design-explorations/s13-ios-blueprint.md, §6): iOS's
// ENGINE_OPTIONS is osspeech-only (engineOptions.ts) — the 3rd (isIos)
// argument is additive, defaulting false, so every 2-arg call above
// keeps compiling AND keeps working (isIos simply never coerces for
// them) — same additive shape engineOptionGate's own osspeechCaps
// argument already established.
describe("applyPlatformEngineDefaults — S13 iOS osspeech-only coercion (3rd, isIos argument)", () => {
  function withEngine(engine: Settings["engine"]): Settings {
    return { ...DEFAULT_SETTINGS, engine };
  }

  it.each(
    ["webspeech", "whisper", "tabaudio", "tabaudio-cloud", "appaudio", "soniox", "deepgram"] as const,
  )("iOS coerces a stored %s to osspeech (iOS v1's ENGINE_OPTIONS is osspeech-only)", (engine) => {
    const s = applyPlatformEngineDefaults(withEngine(engine), false, true);
    expect(s.engine).toBe("osspeech");
  });

  it("iOS leaves a stored osspeech untouched", () => {
    const s = applyPlatformEngineDefaults(withEngine("osspeech"), false, true);
    expect(s.engine).toBe("osspeech");
  });

  it("iOS leaves a stored demo untouched (demo is a scripted preview, not a picker engine)", () => {
    const s = applyPlatformEngineDefaults(withEngine("demo"), false, true);
    expect(s.engine).toBe("demo");
  });

  it("iOS coercion is checked BEFORE isDesktop's own branches — isDesktop is always false alongside isIos:true in practice (D4), but a stored appaudio/osspeech must land on osspeech, not fall through to the !isDesktop web branches (which would otherwise coerce to tabaudio, an engine iOS never offers)", () => {
    expect(applyPlatformEngineDefaults(withEngine("appaudio"), false, true).engine).toBe("osspeech");
    expect(applyPlatformEngineDefaults(withEngine("osspeech"), false, true).engine).toBe("osspeech");
  });

  it("omitting the 3rd argument entirely (a caller not yet updated for S13) never applies iOS coercion — additive/backward-compatible", () => {
    const s = applyPlatformEngineDefaults(withEngine("webspeech"), false);
    expect(s.engine).toBe("webspeech");
  });

  it("leaves other settings fields untouched across a real iOS coercion", () => {
    const base = { ...withEngine("whisper"), language: "en-GB" };
    const s = applyPlatformEngineDefaults(base, false, true);
    expect(s.engine).toBe("osspeech");
    expect(s.language).toBe("en-GB");
  });
});

describe("migrateSettings — S9/D7 platform coercion composes with applyTierDefaults (platform runs first)", () => {
  // Ambient test env is a web build (IS_DESKTOP false, see
  // platform/desktop.ts) — migrateSettings itself always feeds the
  // REAL IS_DESKTOP/PREVIEW_TIER (both import-time consts, same
  // limitation this repo's other IS_DESKTOP-gated suites already
  // document — see e.g. SettingsDialog.test.tsx's own header comment on
  // the 更换模型 describe block), so only the web-branch composition is
  // exercisable end-to-end here; the desktop branch and every isPreview
  // combination are already fully covered directly above via the pure
  // applyPlatformEngineDefaults/applyTierDefaults functions with an
  // explicit boolean, which is the entire reason both were extracted as
  // pure helpers in the first place.
  it("a stored appaudio (e.g. a full-tier backup restored from a desktop export) is coerced to tabaudio on a real (web) migrateSettings call", () => {
    const s = migrateSettings({ engine: "appaudio" } as Partial<Settings>);
    expect(s.engine).toBe("tabaudio");
  });
});

// Field-test fix (v0.4.4, real user report): an EXISTING user who
// connected OpenRouter before this fix shipped (baseUrl=openrouter.ai
// persisted alongside a bare Anthropic-flavored detectModel/
// summaryModel) must have that pairing repaired the moment the app
// hydrates their old settings — not just a brand-new OAuth connect
// going forward (that's the openrouterDesktop.ts/page.tsx side, see
// openrouterModelDefaults.test.ts). RED against the pre-fix store.ts
// (no applyOpenRouterModelDefaults call in migrateSettings at all):
// the "an existing OpenRouter user's stored bare model gets remapped
// on hydrate" case below would have kept detectModel === "claude-
// haiku-4-5" forever, since nothing else in the persisted-settings
// fold ever touches it.
describe("applyOpenRouterModelDefaults — field-test fix: bare Anthropic model + OpenRouter baseUrl", () => {
  function withOpenRouter(overrides: Partial<Settings> = {}): Settings {
    return {
      ...DEFAULT_SETTINGS,
      provider: "openai-compat",
      baseUrl: "https://openrouter.ai/api/v1",
      ...overrides,
    };
  }

  it("remaps a bare (pre-fix) detectModel/summaryModel to the DeepSeek OpenRouter defaults", () => {
    const s = applyOpenRouterModelDefaults(
      withOpenRouter({ detectModel: "claude-haiku-4-5", summaryModel: "claude-sonnet-5" }),
    );
    expect(s.detectModel).toBe("deepseek/deepseek-v4-flash");
    expect(s.summaryModel).toBe("deepseek/deepseek-v4-pro");
  });

  it("is idempotent — running it again on the already-remapped result is a no-op", () => {
    const once = applyOpenRouterModelDefaults(
      withOpenRouter({ detectModel: "claude-haiku-4-5", summaryModel: "claude-sonnet-5" }),
    );
    const twice = applyOpenRouterModelDefaults(once);
    expect(twice).toEqual(once);
  });

  it("never touches a user's own deliberate custom OpenRouter slug", () => {
    const s = applyOpenRouterModelDefaults(
      withOpenRouter({ detectModel: "openai/gpt-5.4", summaryModel: "anthropic/claude-opus-4.8" }),
    );
    expect(s.detectModel).toBe("openai/gpt-5.4");
    expect(s.summaryModel).toBe("anthropic/claude-opus-4.8");
  });

  it("never touches an Anthropic-direct user's models, even bare ones — gated on baseUrl host, not the model shape alone", () => {
    const s = applyOpenRouterModelDefaults({
      ...DEFAULT_SETTINGS,
      provider: "anthropic",
      baseUrl: "",
      detectModel: "claude-haiku-4-5",
      summaryModel: "claude-sonnet-5",
    });
    expect(s.detectModel).toBe("claude-haiku-4-5");
    expect(s.summaryModel).toBe("claude-sonnet-5");
  });

  // R2 ripple fix (v0.4.4): DEFAULT_SETTINGS.baseUrl is now the
  // OpenRouter URL — an explicit provider:"anthropic" settings object
  // whose baseUrl HAPPENS to still read as the OpenRouter host (e.g. a
  // legacy/partial blob that folded in the new default) must still
  // never get remapped. RED against the pre-fix hostname-only gate:
  // this would have remapped detectModel/summaryModel to the DeepSeek
  // slugs despite provider being explicitly "anthropic".
  it("never touches an Anthropic-direct user's models even when baseUrl itself reads as the OpenRouter host (provider gate, not baseUrl alone)", () => {
    const s = applyOpenRouterModelDefaults({
      ...DEFAULT_SETTINGS,
      provider: "anthropic",
      baseUrl: "https://openrouter.ai/api/v1",
      detectModel: "claude-haiku-4-5",
      summaryModel: "claude-sonnet-5",
    });
    expect(s.detectModel).toBe("claude-haiku-4-5");
    expect(s.summaryModel).toBe("claude-sonnet-5");
  });

  it("never touches a DeepSeek-direct/other openai-compat user's models — exact hostname match, not a substring", () => {
    const s = applyOpenRouterModelDefaults(
      withOpenRouter({
        baseUrl: "https://api.deepseek.com",
        detectModel: "deepseek-chat",
        summaryModel: "deepseek-chat",
      }),
    );
    expect(s.detectModel).toBe("deepseek-chat");
    expect(s.summaryModel).toBe("deepseek-chat");
  });

  it("a malformed baseUrl never throws — treated as not-OpenRouter", () => {
    expect(() =>
      applyOpenRouterModelDefaults(withOpenRouter({ baseUrl: "not a url" })),
    ).not.toThrow();
  });

  it("leaves every other settings field untouched", () => {
    const s = applyOpenRouterModelDefaults(
      withOpenRouter({ detectModel: "claude-haiku-4-5", language: "en-GB" }),
    );
    expect(s.language).toBe("en-GB");
  });
});

describe("migrateSettings — field-test fix composes the OpenRouter model remap with the existing folds (end-to-end)", () => {
  it("an existing OpenRouter user's stored bare model gets remapped on hydrate", () => {
    const s = migrateSettings({
      provider: "openai-compat",
      baseUrl: "https://openrouter.ai/api/v1",
      detectModel: "claude-haiku-4-5",
      summaryModel: "claude-sonnet-5",
    } as Partial<Settings>);
    expect(s.detectModel).toBe("deepseek/deepseek-v4-flash");
    expect(s.summaryModel).toBe("deepseek/deepseek-v4-pro");
  });

  // R2 field fix (v0.4.4): DEFAULT_SETTINGS is now provider:"openai-
  // compat" + baseUrl the OpenRouter URL (was "anthropic"/"") — a
  // brand-new install's models are already slash-shaped DeepSeek
  // OpenRouter slugs, so applyOpenRouterModelDefaults' own remap is a
  // no-op here regardless (see remapOpenRouterModelDefaults' own
  // isBareModelId check) — untouched, just for a different reason than
  // before this fix.
  it("a brand-new install (no saved settings at all) gets the new global DeepSeek defaults, untouched by the OpenRouter gate (already slash-shaped)", () => {
    expect(migrateSettings(null).detectModel).toBe("deepseek/deepseek-v4-flash");
    expect(migrateSettings(null).summaryModel).toBe("deepseek/deepseek-v4-pro");
  });

  it("an Anthropic-direct user's stored models are never touched by hydrate", () => {
    const s = migrateSettings({
      provider: "anthropic",
      detectModel: "claude-haiku-4-5",
      summaryModel: "claude-sonnet-5",
    } as Partial<Settings>);
    expect(s.detectModel).toBe("claude-haiku-4-5");
    expect(s.summaryModel).toBe("claude-sonnet-5");
  });
});

// v0.5 Wave-1 Feature 5 / §5 A3 (BLOCKER) — total, platform-aware `mode`
// back-derivation from a persisted `engine`. modeForPersistedEngine is
// exercised directly (explicit `platform` argument) rather than only
// through the real migrateSettings, mirroring applyPlatformEngineDefaults/
// applyTierDefaults' own established "pure function, explicit param"
// test discipline immediately above — this test env's IS_DESKTOP/IS_IOS
// are fixed (web) import-time consts, so desktop/iOS can't be exercised
// through the real migrateSettings at all.
describe("modeForPersistedEngine — full migration matrix (every STTEngineKind × web/desktop/ios)", () => {
  // [legacyEngine, expected mode on web, on desktop, on iOS] — computed
  // by actually running the SAME pipeline migrateSettings composes
  // (applyPlatformEngineDefaults -> applyTierDefaults -> the mapper),
  // full tier (isPreview:false) so only the platform coercion (not the
  // preview lock) is in play, matching a full-tier returning user.
  const MATRIX: [STTEngineKind, Settings["mode"], Settings["mode"], Settings["mode"]][] = [
    ["demo", "mic", "mic", "mic"],
    ["webspeech", "mic", "mic", "mic"],
    ["whisper", "mic", "mic", "mic"],
    ["tabaudio", "tab", "system-audio", "mic"],
    ["tabaudio-cloud", "tab", "system-audio", "mic"],
    ["soniox", "mic", "mic", "mic"],
    ["deepgram", "mic", "mic", "mic"],
    ["appaudio", "tab", "system-audio", "mic"],
    ["osspeech", "tab", "system-audio", "mic"],
    ["import", "import", "import", "import"],
    ["browser-whisper", "import", "import", "import"],
  ];

  function deriveMode(
    legacyEngine: STTEngineKind,
    isDesktop: boolean,
    isIos: boolean,
  ): Settings["mode"] {
    const platformSettings = applyPlatformEngineDefaults(
      { ...DEFAULT_SETTINGS, engine: legacyEngine },
      isDesktop,
      isIos,
    );
    const tierSettings = applyTierDefaults(platformSettings, false, true);
    const platform = isIos ? "ios" : isDesktop ? "desktop" : "web";
    return modeForPersistedEngine(legacyEngine, tierSettings.engine, platform);
  }

  it.each(MATRIX)("%s -> web:%s desktop:%s ios:%s", (engine, web, desktop, ios) => {
    expect(deriveMode(engine, false, false)).toBe(web);
    expect(deriveMode(engine, true, false)).toBe(desktop);
    expect(deriveMode(engine, false, true)).toBe(ios);
  });

  it("NEVER derives 'url' for any legacy engine on any platform", () => {
    for (const [engine] of MATRIX) {
      for (const [isDesktop, isIos] of [
        [false, false],
        [true, false],
        [false, true],
      ] as const) {
        expect(deriveMode(engine, isDesktop, isIos)).not.toBe("url");
      }
    }
  });

  // A3: "Parakeet is a whisperModel value, not a kind — test asserts
  // whisper+Parakeet -> mic". whisperModel must never influence mode
  // derivation — only the engine KIND does.
  it("whisper + Parakeet model still derives mic (whisperModel is not a kind)", () => {
    const platformSettings = applyPlatformEngineDefaults(
      { ...DEFAULT_SETTINGS, engine: "whisper", whisperModel: "parakeet-tdt-0.6b-v3" },
      false,
      false,
    );
    const tierSettings = applyTierDefaults(platformSettings, false, true);
    expect(modeForPersistedEngine("whisper", tierSettings.engine, "web")).toBe("mic");
  });

  it("an unrecognized/future engine value falls back to 'mic' (platform default), never crashes", () => {
    const garbage = "some-future-engine" as STTEngineKind;
    expect(modeForPersistedEngine(undefined, garbage, "web")).toBe("mic");
    expect(modeForPersistedEngine(undefined, garbage, "desktop")).toBe("mic");
    expect(modeForPersistedEngine(undefined, garbage, "ios")).toBe("mic");
  });

  it("a fresh install (no raw engine at all) derives from whatever DEFAULT_SETTINGS.engine legally resolves to", () => {
    expect(modeForPersistedEngine(undefined, DEFAULT_SETTINGS.engine, "web")).toBe("mic");
  });
});

// Finding 4 fix (pre-merge review): isModeLegalForPlatform is the pure
// predicate migrateSettings now ALSO consults (in addition to
// isValidMode) before trusting a persisted `mode` string outright —
// exercised directly (explicit `platform` argument), same "pure
// function, explicit param" discipline as modeForPersistedEngine's own
// matrix immediately above, for the identical reason (this test env's
// IS_DESKTOP/IS_IOS are fixed web consts).
describe("isModeLegalForPlatform — platform-legality matrix (Finding 4)", () => {
  const MODES: Settings["mode"][] = ["system-audio", "tab", "mic", "import", "url"];
  // [mode, legal on web, legal on desktop, legal on ios]
  const MATRIX: [Settings["mode"], boolean, boolean, boolean][] = [
    ["system-audio", false, true, false],
    ["tab", true, false, false],
    ["mic", true, true, true],
    ["import", true, true, true],
    ["url", true, true, true],
  ];

  it.each(MATRIX)("%s -> web:%s desktop:%s ios:%s", (mode, web, desktop, ios) => {
    expect(isModeLegalForPlatform(mode, "web")).toBe(web);
    expect(isModeLegalForPlatform(mode, "desktop")).toBe(desktop);
    expect(isModeLegalForPlatform(mode, "ios")).toBe(ios);
  });

  it("every mode is legal on at least one platform (the matrix above is exhaustive over Settings['mode'])", () => {
    for (const mode of MODES) {
      expect(
        isModeLegalForPlatform(mode, "web") ||
          isModeLegalForPlatform(mode, "desktop") ||
          isModeLegalForPlatform(mode, "ios"),
      ).toBe(true);
    }
  });
});

describe("migrateSettings — mode back-derivation end-to-end (§5 A3, real web build)", () => {
  it("an explicit, VALID saved mode round-trips unchanged (wins over back-derivation)", () => {
    const s = migrateSettings({ mode: "tab", engine: "whisper" } as Partial<Settings>);
    expect(s.mode).toBe("tab"); // NOT back-derived from engine:"whisper" (which would be "mic")
  });

  // Finding 4 fix (pre-merge review, cross-platform-restore): a
  // syntactically VALID mode that is nonetheless ILLEGAL on THIS
  // platform (ambient test env = web, where "system-audio" is
  // desktop-only) must NOT survive migration as a stale, unavailable
  // intent — it re-derives from the (already platform-legal) engine
  // exactly like the no-saved-mode path below.
  it("a platform-ILLEGAL saved mode ('system-audio' restored on web) is re-derived from the engine, not blindly kept", () => {
    const s = migrateSettings({ mode: "system-audio", engine: "tabaudio" } as Partial<Settings>);
    expect(s.mode).not.toBe("system-audio");
    expect(s.mode).toBe("tab"); // back-derived from tabaudio, web-legal
  });

  it("a platform-LEGAL saved mode ('tab' restored on web) still round-trips unchanged, even though 'system-audio' above does not", () => {
    const s = migrateSettings({ mode: "tab", engine: "tabaudio" } as Partial<Settings>);
    expect(s.mode).toBe("tab");
  });

  it("an absent saved mode is back-derived from the persisted engine", () => {
    const s = migrateSettings({ engine: "tabaudio" } as Partial<Settings>);
    expect(s.mode).toBe("tab");
  });

  it("an INVALID/garbage saved mode string is treated as absent, not blindly trusted (runtime-validated)", () => {
    const s = migrateSettings({ mode: "not-a-real-mode", engine: "whisper" } as never);
    expect(s.mode).toBe("mic"); // back-derived, the garbage string never survives
  });

  it("mode is NEVER derived as 'url', even for a raw engine value that maps oddly", () => {
    const s = migrateSettings({ engine: "import" } as Partial<Settings>);
    expect(s.mode).toBe("import");
    expect(s.mode).not.toBe("url");
  });

  it("a fresh install (null saved) gets a derived mode, not left undefined", () => {
    expect(migrateSettings(null).mode).toBe("mic");
    expect(migrateSettings(undefined).mode).toBe("mic");
  });

  it("mode back-derivation runs AFTER platform/tier coercion — a web build with a raw appaudio derives mode from its web-legal substitute (tabaudio)", () => {
    const s = migrateSettings({ engine: "appaudio" } as Partial<Settings>);
    expect(s.engine).toBe("tabaudio"); // platform coercion (existing behavior)
    expect(s.mode).toBe("tab"); // derived from the COERCED (legal) engine
  });

  it("import/browser-whisper derive mode from the RAW engine, unaffected by other folds", () => {
    expect(migrateSettings({ engine: "import" } as Partial<Settings>).mode).toBe("import");
    expect(migrateSettings({ engine: "browser-whisper" } as Partial<Settings>).mode).toBe("import");
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
    packId: "personal",
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

// S14 floating caption — captionMode is a plain, non-persisted UI flag
// (same posture as focusMode, see the AppState field's own doc
// comment): Header.tsx's ≡ menu writes it on a desktop build, page.tsx
// reads it to swap its whole layout for FloatingCaption. No storage.
// saveSettings involvement to verify here (unlike `settings.*` fields)
// — it's plain zustand state, so the setter itself is the whole
// contract.
describe("setCaptionMode — non-persisted UI flag (S14)", () => {
  afterEach(() => {
    useApp.setState({ captionMode: false });
  });

  it("defaults to false", () => {
    expect(useApp.getState().captionMode).toBe(false);
  });

  it("toggles true/false via the setter", () => {
    useApp.getState().setCaptionMode(true);
    expect(useApp.getState().captionMode).toBe(true);

    useApp.getState().setCaptionMode(false);
    expect(useApp.getState().captionMode).toBe(false);
  });
});
