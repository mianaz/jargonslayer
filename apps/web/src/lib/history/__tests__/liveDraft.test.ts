import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingSession } from "@jargonslayer/core/types";

const memStore = new Map<string, unknown>();

vi.mock("idb-keyval", () => ({
  get: vi.fn(async (key: string) => memStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    memStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    memStore.delete(key);
  }),
}));

function makeSession(overrides: Partial<MeetingSession> = {}): MeetingSession {
  return {
    id: "s1",
    title: "会议",
    startedAt: 5000,
    endedAt: 6000,
    engine: "webspeech",
    segments: [{ id: "seg-1", index: 0, startedAt: 5000, endedAt: 5500, text: "hi", engine: "webspeech" }],
    cards: [],
    terms: [],
    ...overrides,
  };
}

describe("liveDraft.ts", () => {
  beforeEach(() => {
    memStore.clear();
    // vi.resetModules() means EVERY dynamically-imported module (below,
    // per test) is a fresh instance — including diag/log.ts's own
    // module-local `entries` array, so it starts empty each test without
    // needing an explicit clearDiag() call (a STATIC top-level import of
    // diag/log here would instead capture the pre-reset instance, and
    // silently diverge from whatever liveDraft.ts's own dynamic import
    // of it resolves to below).
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  describe("writeDraft / loadDraft / clearDraft — round-trip via the fixed key", () => {
    it("writes {draftId, snapshot, savedAt, startedAt} and loads it back", async () => {
      const liveDraft = await import("../liveDraft");
      const session = makeSession({ startedAt: 12_345 });

      await liveDraft.writeDraft("gen1:12345", session);
      const loaded = (await liveDraft.loadDraft()).draft;

      expect(loaded?.draftId).toBe("gen1:12345");
      expect(loaded?.snapshot).toEqual(session);
      expect(loaded?.startedAt).toBe(12_345);
      expect(typeof loaded?.savedAt).toBe("number");
    });

    it("loadDraft returns null when nothing was ever written", async () => {
      const liveDraft = await import("../liveDraft");
      expect((await liveDraft.loadDraft()).draft).toBeNull();
    });

    it("clearDraft removes an existing draft when the draftId matches (Sol adversarial-review fix: compare-and-delete)", async () => {
      const liveDraft = await import("../liveDraft");
      await liveDraft.writeDraft("gen1:1000", makeSession());

      await liveDraft.clearDraft("gen1:1000");

      expect((await liveDraft.loadDraft()).draft).toBeNull();
    });

    it("clearDraft no-ops when the draftId does NOT match — the stored draft survives untouched", async () => {
      const liveDraft = await import("../liveDraft");
      const session = makeSession();
      await liveDraft.writeDraft("gen1:1000", session);

      await liveDraft.clearDraft("gen2:9999");

      const loaded = (await liveDraft.loadDraft()).draft;
      expect(loaded?.draftId).toBe("gen1:1000");
      expect(loaded?.snapshot).toEqual(session);
    });

    it("clearDraft on an already-absent draft is a harmless no-op", async () => {
      const liveDraft = await import("../liveDraft");
      await expect(liveDraft.clearDraft("gen1:1000")).resolves.toBeUndefined();
    });

    it("writeDraft/loadDraft/clearDraft are all no-ops when indexedDB is unavailable", async () => {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
      const liveDraft = await import("../liveDraft");

      await liveDraft.writeDraft("gen1:1000", makeSession());
      expect((await liveDraft.loadDraft()).draft).toBeNull();
      await expect(liveDraft.clearDraft("gen1:1000")).resolves.toBeUndefined();
      expect(memStore.size).toBe(0);
    });
  });

  // Sol adversarial-review fix (H3): the OLD "one fixed key, later write
  // always overwrites" behavior is now identity-aware — a later write
  // only overwrites when it's the SAME meeting's own continuation; a
  // DIFFERENT, still-unresolved meeting's draft buffer-skips instead of
  // being clobbered.
  describe("writeDraft — same-meeting continuation vs. cross-meeting buffer-skip (H3 fix)", () => {
    it("a later writeDraft under the SAME draftId overwrites the earlier one (this meeting's own continuation)", async () => {
      const liveDraft = await import("../liveDraft");
      await liveDraft.writeDraft("gen1:1000", makeSession({ id: "first" }));
      await liveDraft.writeDraft("gen1:1000", makeSession({ id: "second" }));

      const loaded = (await liveDraft.loadDraft()).draft;
      expect(loaded?.snapshot.id).toBe("second");
    });

    it("a later writeDraft under a DIFFERENT draftId buffer-skips — the disk still holds the FIRST (unresolved) draft", async () => {
      const liveDraft = await import("../liveDraft");
      await liveDraft.writeDraft("gen1:1000", makeSession({ id: "old-meeting" }));

      await liveDraft.writeDraft("gen2:2000", makeSession({ id: "new-meeting" }));

      const loaded = (await liveDraft.loadDraft()).draft;
      expect(loaded?.draftId).toBe("gen1:1000");
      expect(loaded?.snapshot.id).toBe("old-meeting");
    });

    it("buffer-skipping a cross-meeting write logs a diag note (not a thrown error — this is routine, expected behavior)", async () => {
      const liveDraft = await import("../liveDraft");
      // Dynamically imported AFTER the same resetModules() as liveDraft
      // itself, so this is the SAME diag/log module instance liveDraft's
      // own diagLog() call writes into (see beforeEach's own doc above).
      const { getDiagEntries } = await import("../../diag/log");
      await liveDraft.writeDraft("gen1:1000", makeSession({ id: "old-meeting" }));

      await liveDraft.writeDraft("gen2:2000", makeSession({ id: "new-meeting" }));

      const entries = getDiagEntries().filter((e) => e.tag === "live-draft");
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe("info");
    });

    it("once the old draft is cleared, a write under a NEW draftId succeeds (buffer-skip is not permanent)", async () => {
      const liveDraft = await import("../liveDraft");
      await liveDraft.writeDraft("gen1:1000", makeSession({ id: "old-meeting" }));
      await liveDraft.clearDraft("gen1:1000");

      await liveDraft.writeDraft("gen2:2000", makeSession({ id: "new-meeting" }));

      const loaded = (await liveDraft.loadDraft()).draft;
      expect(loaded?.draftId).toBe("gen2:2000");
      expect(loaded?.snapshot.id).toBe("new-meeting");
    });
  });

  describe("isDraftableMeeting — status/engine gate", () => {
    it("true for connecting/listening/paused on a real engine", async () => {
      const liveDraft = await import("../liveDraft");
      expect(liveDraft.isDraftableMeeting("connecting", "webspeech")).toBe(true);
      expect(liveDraft.isDraftableMeeting("listening", "webspeech")).toBe(true);
      expect(liveDraft.isDraftableMeeting("paused", "webspeech")).toBe(true);
    });

    it("false for idle/stopped regardless of engine", async () => {
      const liveDraft = await import("../liveDraft");
      expect(liveDraft.isDraftableMeeting("idle", "webspeech")).toBe(false);
      expect(liveDraft.isDraftableMeeting("stopped", "webspeech")).toBe(false);
    });

    // "demo never drafts" (task spec item 1: a scripted preview has
    // nothing real to lose) — even while actively "listening".
    it("false for engine:'demo' regardless of status", async () => {
      const liveDraft = await import("../liveDraft");
      expect(liveDraft.isDraftableMeeting("listening", "demo")).toBe(false);
      expect(liveDraft.isDraftableMeeting("paused", "demo")).toBe(false);
      expect(liveDraft.isDraftableMeeting("connecting", "demo")).toBe(false);
    });
  });

  describe("deriveDraftId — meetingGen + startedAt identity (H3/H4 fix)", () => {
    it("is stable for the same (meetingGen, startedAt) pair", async () => {
      const liveDraft = await import("../liveDraft");
      expect(liveDraft.deriveDraftId(3, 123_456)).toBe(liveDraft.deriveDraftId(3, 123_456));
    });

    it("differs when meetingGen differs (same startedAt)", async () => {
      const liveDraft = await import("../liveDraft");
      expect(liveDraft.deriveDraftId(1, 1000)).not.toBe(liveDraft.deriveDraftId(2, 1000));
    });

    it("differs when startedAt differs (same meetingGen)", async () => {
      const liveDraft = await import("../liveDraft");
      expect(liveDraft.deriveDraftId(1, 1000)).not.toBe(liveDraft.deriveDraftId(1, 2000));
    });

    it("formats a stable sentinel for startedAt:null (no meeting started yet) that can't collide with a real meeting's numeric startedAt", async () => {
      const liveDraft = await import("../liveDraft");
      expect(liveDraft.deriveDraftId(0, null)).toBe(liveDraft.deriveDraftId(0, null));
      expect(liveDraft.deriveDraftId(0, null)).not.toBe(liveDraft.deriveDraftId(0, 0));
    });
  });

  describe("computeDraftSignature — cheap dirty signature (M1 fix, replaces shouldWriteDraft)", () => {
    it("emits counts + a content hash, stable for identical snapshots (Sol rounds 2+3: count/sum signatures kept colliding — the hash is over the actual mutable content)", async () => {
      const liveDraft = await import("../liveDraft");
      const session = makeSession({
        segments: [
          { id: "a", index: 0, startedAt: 0, endedAt: 1, text: "hi", engine: "webspeech", speaker: "Alice" },
          { id: "b", index: 1, startedAt: 1, endedAt: 2, text: "there team", engine: "webspeech" },
        ],
        cards: [{ id: "c1" } as MeetingSession["cards"][number]],
        terms: [],
        translations: { a: "你好" },
      });
      const sig = liveDraft.computeDraftSignature(session);
      // Shape: segs|cards|terms|hash — counts human-readable, hash opaque.
      expect(sig).toMatch(/^2\|1\|0\|-?\d+$/);
      // Deterministic: identical snapshot → identical signature.
      expect(liveDraft.computeDraftSignature(structuredClone(session))).toBe(sig);
    });

    it("changes on an EQUAL-LENGTH text edit and an equal-length speaker swap (Sol round-3 M — the classes aggregate char counts missed)", async () => {
      const liveDraft = await import("../liveDraft");
      const base = makeSession({
        segments: [
          { id: "a", index: 0, startedAt: 0, endedAt: 1, text: "their idea", engine: "webspeech", speaker: "Ann" },
        ],
        translations: { a: "你好" },
      });
      const editedSameLen = structuredClone(base);
      editedSameLen.segments[0].text = "there idea"; // same length
      const swappedSpeaker = structuredClone(base);
      swappedSpeaker.segments[0].speaker = "Bob"; // same length as Ann
      const retransSameLen = structuredClone(base);
      retransSameLen.translations = { a: "妳好" }; // same length as 你好
      expect(liveDraft.computeDraftSignature(editedSameLen)).not.toBe(liveDraft.computeDraftSignature(base));
      expect(liveDraft.computeDraftSignature(swappedSpeaker)).not.toBe(liveDraft.computeDraftSignature(base));
      expect(liveDraft.computeDraftSignature(retransSameLen)).not.toBe(liveDraft.computeDraftSignature(base));
    });

    it("does NOT collide when a new segment is one char shorter than the old tail (the exact Sol re-verify counterexample to the additive sum)", async () => {
      const liveDraft = await import("../liveDraft");
      const seg = (id: string, index: number, text: string): MeetingSession["segments"][number] =>
        ({ id, index, startedAt: index, endedAt: index + 1, text, engine: "webspeech" });
      const before = makeSession({ segments: [seg("a", 0, "hello team")] }); // len 10
      const after = makeSession({ segments: [seg("a", 0, "hello team"), seg("b", 1, "nine char")] }); // +1 seg, tail len 9
      expect(liveDraft.computeDraftSignature(after)).not.toBe(liveDraft.computeDraftSignature(before));
    });

    it("changes on a speaker RENAME (roster verbatim in the signature) and a same-key re-translation (translated chars)", async () => {
      const liveDraft = await import("../liveDraft");
      const base = makeSession({
        segments: [
          { id: "a", index: 0, startedAt: 0, endedAt: 1, text: "hi", engine: "webspeech", speaker: "Alice" },
        ],
        translations: { a: "你好" },
        speakerRoster: ["Alice"],
      });
      const renamed = { ...base, speakerRoster: ["Alicia"] };
      const retranslated = { ...base, translations: { a: "妳好啊" } };
      expect(liveDraft.computeDraftSignature(renamed)).not.toBe(liveDraft.computeDraftSignature(base));
      expect(liveDraft.computeDraftSignature(retranslated)).not.toBe(liveDraft.computeDraftSignature(base));
    });

    it("changes when a translation is added with no new segment/card (the exact gap the old count-based check missed)", async () => {
      const liveDraft = await import("../liveDraft");
      const before = makeSession({ translations: undefined });
      const after = makeSession({ translations: { "seg-1": "你好" } });
      expect(liveDraft.computeDraftSignature(after)).not.toBe(liveDraft.computeDraftSignature(before));
    });

    it("changes when a speaker gets assigned with no new segment/card", async () => {
      const liveDraft = await import("../liveDraft");
      const before = makeSession();
      const after = makeSession({
        segments: [{ ...before.segments[0], speaker: "Alice" }],
      });
      expect(liveDraft.computeDraftSignature(after)).not.toBe(liveDraft.computeDraftSignature(before));
    });

    it("is identical for an unchanged snapshot (same content twice)", async () => {
      const liveDraft = await import("../liveDraft");
      const session = makeSession();
      expect(liveDraft.computeDraftSignature(session)).toBe(liveDraft.computeDraftSignature({ ...session }));
    });
  });
});
