// Exercises saveSession/listSessions/getSession/deleteSession against
// an IN-MEMORY store implementing the same 4-method KeyValueStore
// interface the real IndexedDB-backed store does — keeps this file in
// vitest's node-env (no fake-indexeddb dependency, matching
// vitest.config.ts's node posture) while still running the exact same
// code paths a real IndexedDB-backed session would.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearDiag, getDiagEntries } from "../../lib/diag";
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

// ---------------------------------------------------------------
// F4a/F4b (real openDb retry, F8④) — a minimal, hand-built
// globalThis.indexedDB fake: just enough of the IDBOpenDBRequest/
// IDBDatabase/IDBTransaction/IDBRequest surface for history.ts's own
// openDb/idbGet/idbSet to run against, staying in this file's plain
// node-env posture (no jsdom, no fake-indexeddb dependency — see this
// file's header). `open()` fails its FIRST call, then succeeds on
// every call after — exactly enough to prove openDb() resets its
// module-level cache on failure (F4a) instead of replaying the same
// rejected promise forever.
// ---------------------------------------------------------------

interface FakeIDBRequest {
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
  onblocked?: (() => void) | null;
  result?: unknown;
  error?: Error | null;
}

function createFakeIndexedDB() {
  const backing = new Map<string, unknown>();
  let openCalls = 0;

  function makeTransaction() {
    const tx: {
      oncomplete: (() => void) | null;
      onerror: (() => void) | null;
      onabort: (() => void) | null;
      objectStore: (name: string) => {
        get(key: string): FakeIDBRequest;
        put(value: unknown, key: string): FakeIDBRequest;
        delete(key: string): FakeIDBRequest;
        getAllKeys(): FakeIDBRequest;
      };
    } = {
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore: () => ({
        get(key: string) {
          const req: FakeIDBRequest = { onsuccess: null, onerror: null };
          queueMicrotask(() => {
            req.result = backing.get(key);
            req.onsuccess?.();
          });
          return req;
        },
        put(value: unknown, key: string) {
          backing.set(key, value);
          const req: FakeIDBRequest = { onsuccess: null, onerror: null };
          queueMicrotask(() => {
            req.onsuccess?.();
            tx.oncomplete?.();
          });
          return req;
        },
        delete(key: string) {
          backing.delete(key);
          const req: FakeIDBRequest = { onsuccess: null, onerror: null };
          queueMicrotask(() => {
            req.onsuccess?.();
            tx.oncomplete?.();
          });
          return req;
        },
        getAllKeys() {
          const req: FakeIDBRequest = { onsuccess: null, onerror: null };
          queueMicrotask(() => {
            req.result = Array.from(backing.keys());
            req.onsuccess?.();
          });
          return req;
        },
      }),
    };
    return tx;
  }

  const fakeDb = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => undefined,
    transaction: () => makeTransaction(),
  };

  return {
    open(): FakeIDBRequest {
      openCalls += 1;
      const failThisCall = openCalls === 1;
      const req: FakeIDBRequest = {
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      };
      queueMicrotask(() => {
        if (failThisCall) {
          req.error = new Error("simulated indexedDB.open failure");
          req.onerror?.();
        } else {
          req.result = fakeDb;
          req.onupgradeneeded?.();
          req.onsuccess?.();
        }
      });
      return req;
    },
    get openCalls() {
      return openCalls;
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
  // F5 (codex review) — listSessions must not let a structurally
  // malformed/legacy record (a schema change, a partial write, hand
  // edits, …) break rendering, delete, or export; skipped records are
  // counted via one diagLog "warn" (count only, never content).
  // ---------------------------------------------------------------
  it("F5: skips structurally malformed records, keeps well-formed ones, and logs one diagLog warn with the skip count", async () => {
    clearDiag();
    const good = makeSession({ id: "good", startedAt: 5_000 });
    await saveSession(good, store);
    // Three different ways a record can fail to look like a LiteSession.
    await store.set("legacy-string", "not an object at all");
    await store.set("legacy-partial", { id: "legacy-partial" }); // missing startedAt/segments/cards/terms
    await store.set("legacy-wrong-types", {
      id: "legacy-wrong-types",
      startedAt: "not-a-number",
      segments: [],
      cards: [],
      terms: [],
    });

    const list = await listSessions(store);

    expect(list).toEqual([good]);
    const warnEntries = getDiagEntries().filter((e) => e.level === "warn");
    expect(warnEntries).toHaveLength(1);
    expect(warnEntries[0]).toMatchObject({ tag: "history-corrupt-record", detail: "skipped=3" });
  });

  // ---------------------------------------------------------------
  // F4 / F8④ (injected-store half) — a transient write failure must
  // not permanently wedge history: an injected store's set()
  // rejecting once must not stop a LATER call (with the SAME store)
  // from succeeding.
  // ---------------------------------------------------------------
  it("F4/F8④: an injected store's set() rejecting once does not block a later save with the same store", async () => {
    let calls = 0;
    const flakyStore: KeyValueStore = {
      ...store,
      async set(key, value) {
        calls += 1;
        if (calls === 1) throw new Error("simulated transient set() failure");
        await store.set(key, value);
      },
    };
    const session = makeSession({ id: "flaky" });

    await expect(saveSession(session, flakyStore)).rejects.toThrow(
      "simulated transient set() failure",
    );
    await saveSession(session, flakyStore);

    expect(await getSession("flaky", flakyStore)).toEqual(session);
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

  // ---------------------------------------------------------------
  // F4a/F4b (real openDb retry, F8④) — exercises the REAL default
  // store (no `store` argument, so this goes through openDb()/idbSet/
  // idbGet against the hand-built globalThis.indexedDB fake above)
  // rather than an injected in-memory one. Deliberately the LAST test
  // in this file: a successful retry here leaves history.ts's
  // module-level dbPromise cache resolved to the FAKE db for the rest
  // of this file's process lifetime, which is fine since no other test
  // here ever calls the default-store path.
  // ---------------------------------------------------------------
  it("F4a/F4b: a failed indexedDB.open() resets the cache so the NEXT call opens a fresh connection and succeeds", async () => {
    const fakeIndexedDB = createFakeIndexedDB();
    vi.stubGlobal("indexedDB", fakeIndexedDB);
    try {
      const session = makeSession({ id: "retry-me" });

      await expect(saveSession(session)).rejects.toThrow("simulated indexedDB.open failure");
      expect(fakeIndexedDB.openCalls).toBe(1);

      // F4a: dbPromise must have been reset to null on that failure —
      // this second call opens a FRESH connection instead of replaying
      // the same already-rejected promise forever.
      await saveSession(session);
      expect(fakeIndexedDB.openCalls).toBe(2);

      expect(await getSession("retry-me")).toEqual(session);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
