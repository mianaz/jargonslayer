import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type MeetingSession, type Settings } from "@jargonslayer/core/types";

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
    title: "Weekly sync",
    startedAt: 1000,
    endedAt: 2000,
    engine: "demo",
    segments: [],
    cards: [],
    terms: [],
    ...overrides,
  };
}

const sampleSettings: Settings = { ...DEFAULT_SETTINGS };

describe("storage.ts", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  describe("saveSession upserts index", () => {
    it("saveSession writes the full session and adds a SessionMeta to the index, resolving true", async () => {
      const storage = await import("../storage");
      const session = makeSession();
      await expect(storage.saveSession(session)).resolves.toBe(true);

      const stored = await storage.getSession("s1");
      expect(stored).toEqual(session);

      const list = await storage.listSessions();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: "s1",
        title: "Weekly sync",
        startedAt: 1000,
        endedAt: 2000,
        segmentCount: 0,
        cardCount: 0,
        termCount: 0,
        hasSummary: false,
      });
    });

    it("saving the SAME session id twice upserts (replaces), does not duplicate the index entry", async () => {
      const storage = await import("../storage");
      await storage.saveSession(makeSession({ title: "First" }));
      await storage.saveSession(makeSession({ title: "Updated title" }));

      const list = await storage.listSessions();
      expect(list).toHaveLength(1);
      expect(list[0].title).toBe("Updated title");
    });

    it("saveSession is a no-op AND resolves false when indexedDB is unavailable (Sol adversarial-review fix H1)", async () => {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
      const storage = await import("../storage");
      await expect(storage.saveSession(makeSession())).resolves.toBe(false);
      expect(memStore.size).toBe(0);
    });

    it("saveSession resolves false when the underlying write throws, without silently claiming success (H1 fix)", async () => {
      const storage = await import("../storage");
      const { set } = await import("idb-keyval");
      vi.mocked(set).mockRejectedValueOnce(new Error("write failed"));

      await expect(storage.saveSession(makeSession())).resolves.toBe(false);
    });
  });

  describe("listSessions sorts desc", () => {
    it("sorts sessions by startedAt descending (most recent first)", async () => {
      const storage = await import("../storage");
      await storage.saveSession(makeSession({ id: "old", startedAt: 1000 }));
      await storage.saveSession(makeSession({ id: "newest", startedAt: 3000 }));
      await storage.saveSession(makeSession({ id: "mid", startedAt: 2000 }));

      const list = await storage.listSessions();
      expect(list.map((m) => m.id)).toEqual(["newest", "mid", "old"]);
    });

    it("returns [] when indexedDB is unavailable", async () => {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
      const storage = await import("../storage");
      expect(await storage.listSessions()).toEqual([]);
    });
  });

  describe("deleteSession removes both", () => {
    it("removes the session body AND its index entry", async () => {
      const storage = await import("../storage");
      await storage.saveSession(makeSession({ id: "a" }));
      await storage.saveSession(makeSession({ id: "b" }));

      await storage.deleteSession("a");

      expect(await storage.getSession("a")).toBeNull();
      const list = await storage.listSessions();
      expect(list.map((m) => m.id)).toEqual(["b"]);
    });
  });

  describe("saveSettings / loadSettings", () => {
    it("round-trips settings", async () => {
      const storage = await import("../storage");
      await storage.saveSettings(sampleSettings);
      expect(await storage.loadSettings()).toEqual(sampleSettings);
    });

    it("loadSettings returns null when nothing saved", async () => {
      const storage = await import("../storage");
      expect(await storage.loadSettings()).toBeNull();
    });
  });

  describe("legacy migration", () => {
    function seedLegacyData() {
      memStore.set("meetlingo:sessions:index", [
        {
          id: "legacy-1",
          title: "Legacy meeting",
          startedAt: 500,
          endedAt: 600,
          segmentCount: 0,
          cardCount: 0,
          termCount: 0,
          hasSummary: false,
        },
      ]);
      memStore.set("meetlingo:session:legacy-1", makeSession({ id: "legacy-1", title: "Legacy meeting" }));
      memStore.set("meetlingo:settings", sampleSettings);
    }

    it("seeds legacy meetlingo:* keys and populates jargonslayer:* keys once, sets the migration marker", async () => {
      seedLegacyData();
      const storage = await import("../storage");

      const list = await storage.listSessions();
      expect(list.map((m) => m.id)).toEqual(["legacy-1"]);

      const migratedSession = await storage.getSession("legacy-1");
      expect(migratedSession).toMatchObject({ id: "legacy-1", title: "Legacy meeting" });

      const settings = await storage.loadSettings();
      expect(settings).toEqual(sampleSettings);

      expect(memStore.get("jargonslayer:migrated")).toBe(1);
    });

    it("a second call is a no-op (does not re-run the migration or duplicate index entries)", async () => {
      seedLegacyData();
      const storage = await import("../storage");

      await storage.listSessions(); // triggers migration once
      const setSpy = vi.mocked((await import("idb-keyval")).set);
      setSpy.mockClear();

      await storage.listSessions(); // second call: migrationStarted guard should short-circuit
      // migrateLegacyOnce should not have written anything new the 2nd time.
      const migrationRelatedCalls = setSpy.mock.calls.filter(
        ([key]) => key === "jargonslayer:sessions:index" || key === "jargonslayer:migrated",
      );
      expect(migrationRelatedCalls).toHaveLength(0);

      const list = await storage.listSessions();
      expect(list).toHaveLength(1); // still just the one migrated session, not duplicated
    });

    it("does not overwrite settings that are already present at the new key", async () => {
      seedLegacyData();
      const newSettings: Settings = { ...sampleSettings, engine: "whisper" };
      memStore.set("jargonslayer:settings", newSettings);

      const storage = await import("../storage");
      const settings = await storage.loadSettings();
      expect(settings).toEqual(newSettings); // new key wins, legacy ignored
    });

    it("race: two concurrent callers (loadSettings + listSessions, as hydrate() fires them) both wait for the SAME in-flight migration — the second caller does not read the index before migration finishes", async () => {
      seedLegacyData();
      const storage = await import("../storage");

      // Both calls kick off migrateLegacyOnce() in the same microtask tick,
      // mirroring hydrate()'s Promise.all([loadSettings(), listSessions()]).
      // A boolean latch would let the second call see "already started" and
      // read the (still unmigrated) index immediately; a shared promise
      // makes it await the first call's in-flight migration instead.
      const [settings, list] = await Promise.all([
        storage.loadSettings(),
        storage.listSessions(),
      ]);

      expect(settings).toEqual(sampleSettings);
      expect(list.map((m) => m.id)).toEqual(["legacy-1"]);

      // A third, later call sees the already-migrated data too.
      const list2 = await storage.listSessions();
      expect(list2.map((m) => m.id)).toEqual(["legacy-1"]);
    });
  });
});
