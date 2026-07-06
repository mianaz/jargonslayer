import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aliasesAfterRename,
  applySpeakerUpdateToSegments,
  renameSpeakerInSegments,
  scheduleSessionSave,
  shouldApplySpeakerUpdate,
} from "../store";
import type { TranscriptSegment } from "../types";

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
