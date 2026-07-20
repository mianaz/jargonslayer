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
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  describe("writeDraft / loadDraft / clearDraft — round-trip via the fixed key", () => {
    it("writes {snapshot, savedAt, startedAt} and loads it back", async () => {
      const liveDraft = await import("../liveDraft");
      const session = makeSession({ startedAt: 12_345 });

      await liveDraft.writeDraft(session);
      const loaded = await liveDraft.loadDraft();

      expect(loaded?.snapshot).toEqual(session);
      expect(loaded?.startedAt).toBe(12_345);
      expect(typeof loaded?.savedAt).toBe("number");
    });

    it("loadDraft returns null when nothing was ever written", async () => {
      const liveDraft = await import("../liveDraft");
      expect(await liveDraft.loadDraft()).toBeNull();
    });

    it("clearDraft removes an existing draft", async () => {
      const liveDraft = await import("../liveDraft");
      await liveDraft.writeDraft(makeSession());

      await liveDraft.clearDraft();

      expect(await liveDraft.loadDraft()).toBeNull();
    });

    it("clearDraft on an already-absent draft is a harmless no-op", async () => {
      const liveDraft = await import("../liveDraft");
      await expect(liveDraft.clearDraft()).resolves.toBeUndefined();
    });

    // Multi-tab caveat (deliberate v1, see this module's own header
    // comment): one fixed key means a later write always overwrites an
    // earlier one, from any tab.
    it("a later writeDraft overwrites the earlier one under the same fixed key", async () => {
      const liveDraft = await import("../liveDraft");
      await liveDraft.writeDraft(makeSession({ id: "first" }));
      await liveDraft.writeDraft(makeSession({ id: "second" }));

      const loaded = await liveDraft.loadDraft();
      expect(loaded?.snapshot.id).toBe("second");
    });

    it("writeDraft/loadDraft/clearDraft are all no-ops when indexedDB is unavailable", async () => {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
      const liveDraft = await import("../liveDraft");

      await liveDraft.writeDraft(makeSession());
      expect(await liveDraft.loadDraft()).toBeNull();
      await expect(liveDraft.clearDraft()).resolves.toBeUndefined();
      expect(memStore.size).toBe(0);
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

  describe("shouldWriteDraft — throttle + changed-guard, pure (no timers needed)", () => {
    it("true on the very first write (both lastWriteAt and lastCounts null)", async () => {
      const liveDraft = await import("../liveDraft");
      expect(liveDraft.shouldWriteDraft(10_000, null, null, { segments: 1, cards: 0 })).toBe(true);
    });

    it("false when under 10s have elapsed since the last write, even if counts changed", async () => {
      const liveDraft = await import("../liveDraft");
      const lastCounts = { segments: 1, cards: 0 };
      expect(
        liveDraft.shouldWriteDraft(10_000 + 9_999, 10_000, lastCounts, { segments: 2, cards: 0 }),
      ).toBe(false);
    });

    it("true once >= 10s have elapsed AND counts changed", async () => {
      const liveDraft = await import("../liveDraft");
      const lastCounts = { segments: 1, cards: 0 };
      expect(
        liveDraft.shouldWriteDraft(20_000, 10_000, lastCounts, { segments: 2, cards: 0 }),
      ).toBe(true);
    });

    it("false once 10s have elapsed but counts are unchanged (nothing new to persist)", async () => {
      const liveDraft = await import("../liveDraft");
      const lastCounts = { segments: 1, cards: 0 };
      expect(
        liveDraft.shouldWriteDraft(70_000, 10_000, lastCounts, { segments: 1, cards: 0 }),
      ).toBe(false);
    });

    it("a card-only count change (segments unchanged) still counts as changed", async () => {
      const liveDraft = await import("../liveDraft");
      const lastCounts = { segments: 3, cards: 0 };
      expect(liveDraft.shouldWriteDraft(20_000, 10_000, lastCounts, { segments: 3, cards: 1 })).toBe(
        true,
      );
    });
  });
});
