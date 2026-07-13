// Hand-rolled IndexedDB helper (S7 blueprint §2 decision C) + the
// LiteSession history store built on top of it. Chosen over
// chrome.storage.local (savedLookups.ts's mechanism) because history
// holds growing transcripts: storage.local caps at 10MB and its
// whole-key read-modify-write doesn't scale the way savedLookups' own
// small array does. IndexedDB in an extension page uses the origin's
// disk-backed quota — no unlimitedStorage needed. The get/set/keys/del
// surface below is deliberately idb-keyval-shaped so a future swap to
// that dependency (if ever wanted) is a drop-in — v1 ships with zero
// new npm dependencies (S6's no-remote-code posture).
//
// Coexistence (S7 blueprint §2 decision C): savedLookups.ts's
// chrome.storage.local key and this module's IndexedDB database are
// separate surfaces. This module MUST NEVER reference the `chrome`
// global — see storage/__tests__/history.test.ts's coexistence guard.

import type { ExpressionCard, TermCard } from "@jargonslayer/core/types";
import { diagLog } from "../lib/diag";

const DB_NAME = "jargonslayer-extension";
const DB_VERSION = 1;
const STORE_NAME = "history";

// ---------------------------------------------------------------
// Minimal IndexedDB get/set/keys/del surface — one object store, no
// indexes, each op its own transaction. Opens the database once
// (module-level cached promise) and reuses the connection thereafter.
// ---------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      // F4a: reset the module-level cache on failure too — otherwise a
      // single transient open error (quota hiccup, a corrupt DB on this
      // profile, …) would leave every future openDb() call awaiting
      // this SAME already-rejected promise, bricking history for the
      // rest of the document's lifetime instead of letting the next
      // call retry with a fresh indexedDB.open().
      req.onerror = () => {
        dbPromise = null;
        reject(req.error ?? new Error("indexedDB.open failed"));
      };
      // F4b: another open panel/tab holding an older-version connection
      // can block this upgrade indefinitely — onsuccess/onerror never
      // fire on their own in that case, which would otherwise hang
      // openDb() (and every idbGet/Set/Del/Keys call awaiting it)
      // forever. Same cache reset as onerror, for the same reason.
      req.onblocked = () => {
        dbPromise = null;
        reject(new Error("indexedDB upgrade blocked by another open panel"));
      };
    });
  }
  return dbPromise;
}

async function idbGet(key: string): Promise<unknown> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    // F4c: an abort (e.g. a quota error, or another connection's
    // version-change forcing this tx out) doesn't always also fire
    // onerror — without this, stop()'s awaited saveSession() could hang
    // forever on a transaction that already died.
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

async function idbDel(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    // F4c: see idbSet's identical handler for why onabort must settle
    // this too.
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

async function idbKeys(): Promise<string[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error);
  });
}

/** get/set/keys/del — idb-keyval-shaped, so the real IndexedDB-backed
 *  store and a test's in-memory store are interchangeable. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

const idbStore: KeyValueStore = { get: idbGet, set: idbSet, del: idbDel, keys: idbKeys };

// ---------------------------------------------------------------
// LiteSession (S7 blueprint §2 decision C) — its own light type,
// mirroring core field names, same discipline as savedLookups.ts's
// SavedLookup vs core's CustomEntry. Deliberately omits summary/
// diarization/SRS/pauseIntervals — dictionary-only Lite capture
// produces none of those. Saved automatically on 停止聆听 (Chunk 6).
// ---------------------------------------------------------------

export interface LiteSegment {
  text: string;
  startedAt: number;
}

export interface LiteSession {
  id: string;
  title: string;
  startedAt: number;
  endedAt: number;
  engine: "webspeech";
  segments: LiteSegment[];
  cards: ExpressionCard[];
  terms: TermCard[];
}

/** Persist a session, keyed by its own id. Overwrites a prior save
 *  with the same id (Chunk 6 always saves once, on stop, so this is
 *  effectively insert-only in practice). `store` defaults to the real
 *  IndexedDB-backed store; tests inject an in-memory one instead. */
export async function saveSession(
  session: LiteSession,
  store: KeyValueStore = idbStore,
): Promise<void> {
  await store.set(session.id, session);
}

// F5: legacy/malformed records (a schema change, a partial write, hand
// edits during dev, …) must never break rendering, delete, or export —
// this is a structural shape check only (not a full schema validation),
// matching the fields renderHistorySection/exportSession actually read.
function isLiteSessionShape(value: unknown): value is LiteSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.startedAt === "number" &&
    Array.isArray(v.segments) &&
    Array.isArray(v.cards) &&
    Array.isArray(v.terms)
  );
}

/** All saved sessions, newest-first (by startedAt). Records that don't
 *  structurally look like a LiteSession (F5) are skipped rather than
 *  thrown on or passed through — one diagLog "warn" for the whole
 *  batch (count only, never record content). */
export async function listSessions(store: KeyValueStore = idbStore): Promise<LiteSession[]> {
  const keys = await store.keys();
  const records = await Promise.all(keys.map((key) => store.get(key)));
  const sessions: LiteSession[] = [];
  let skipped = 0;
  for (const record of records) {
    if (record == null) continue; // deleted between keys() and get() — not a corrupt record
    if (isLiteSessionShape(record)) {
      sessions.push(record);
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    diagLog("warn", "history-corrupt-record", "跳过结构不正确的历史记录", `skipped=${skipped}`);
  }
  return sessions.sort((a, b) => b.startedAt - a.startedAt);
}

/** A single saved session by id, or undefined if it was never saved
 *  (or was already deleted). */
export async function getSession(
  id: string,
  store: KeyValueStore = idbStore,
): Promise<LiteSession | undefined> {
  return (await store.get(id)) as LiteSession | undefined;
}

export async function deleteSession(id: string, store: KeyValueStore = idbStore): Promise<void> {
  await store.del(id);
}
