// Exercises saveSession/listSessions/getSession/deleteSession against
// an IN-MEMORY store implementing the same 4-method KeyValueStore
// interface the real IndexedDB-backed store does — keeps this file in
// vitest's node-env (no fake-indexeddb dependency, matching
// vitest.config.ts's node posture) while still running the exact same
// code paths a real IndexedDB-backed session would.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteSession,
  getSession,
  listSessions,
  saveSession,
  type KeyValueStore,
  type LiteSession,
} from "../history";

function createMemoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
    async del(key) {
      map.delete(key);
    },
    async keys() {
      return Array.from(map.keys());
    },
  };
}

function makeSession(overrides: Partial<LiteSession> = {}): LiteSession {
  return {
    id: "s1",
    title: "英文晨会",
    startedAt: 1_000,
    endedAt: 2_000,
    engine: "webspeech",
    segments: [{ text: "Let's circle back on this.", startedAt: 1_000 }],
    cards: [],
    terms: [],
    ...overrides,
  };
}

describe("history storage", () => {
  let store: KeyValueStore;

  beforeEach(() => {
    store = createMemoryStore();
  });

  it("round-trips a saved session", async () => {
    const session = makeSession();
    await saveSession(session, store);
    expect(await getSession(session.id, store)).toEqual(session);
  });

  it("returns undefined for a session that was never saved", async () => {
    expect(await getSession("missing", store)).toBeUndefined();
  });

  it("lists sessions newest-first by startedAt", async () => {
    await saveSession(makeSession({ id: "a", startedAt: 1_000 }), store);
    await saveSession(makeSession({ id: "b", startedAt: 3_000 }), store);
    await saveSession(makeSession({ id: "c", startedAt: 2_000 }), store);

    const list = await listSessions(store);
    expect(list.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("deletes a session, leaving the rest intact", async () => {
    await saveSession(makeSession({ id: "a", startedAt: 1_000 }), store);
    await saveSession(makeSession({ id: "b", startedAt: 2_000 }), store);

    await deleteSession("a", store);

    const list = await listSessions(store);
    expect(list.map((s) => s.id)).toEqual(["b"]);
    expect(await getSession("a", store)).toBeUndefined();
  });

  it("handles a large transcript (5k segments) without dropping data", async () => {
    const segments = Array.from({ length: 5000 }, (_, i) => ({
      text: `segment number ${i}`,
      startedAt: 1_000 + i,
    }));
    const session = makeSession({ id: "big", segments });

    await saveSession(session, store);
    const loaded = await getSession("big", store);

    expect(loaded?.segments).toHaveLength(5000);
    expect(loaded?.segments[0].text).toBe("segment number 0");
    expect(loaded?.segments[4999].text).toBe("segment number 4999");
  });

  // ---------------------------------------------------------------
  // Coexistence guard (S7 blueprint §2 decision C): history.ts must
  // never touch chrome.storage — savedLookups.ts stays the sole
  // chrome.storage.local surface. Stubs `chrome` with a Proxy that
  // throws on ANY property access, then runs the full read/write
  // battery through the injected in-memory store: if any code path in
  // history.ts (regardless of which store is passed in) ever touched
  // `chrome.*`, this would throw and fail the test.
  // ---------------------------------------------------------------
  it("never touches the chrome global while saving/listing/getting/deleting", async () => {
    const throwingChrome = new Proxy(
      {},
      {
        get(): never {
          throw new Error("history.ts must never access the chrome global");
        },
      },
    );
    vi.stubGlobal("chrome", throwingChrome);
    try {
      const session = makeSession({ id: "guard" });
      await saveSession(session, store);
      await listSessions(store);
      await getSession("guard", store);
      await deleteSession("guard", store);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
