// Learn-set persistence + sync cache. Mirrors history/glossary.ts because
// live detection needs synchronous point lookups after one startup hydrate.

import { del, get, set } from "idb-keyval";
import { expressionNormKey, termNormKey } from "../detect/dedupe";
import type { LearnKind, LearnRecord } from "./types";

const LEARNSET_KEY = "jargonslayer:learnset";
export const REFRESH_MS = 90 * 24 * 60 * 60 * 1000;
export const KNOWN_VOTE_SUPPRESS_THRESHOLD = 2;
export const KNOWN_VOTE_INCREMENT = 1 / KNOWN_VOTE_SUPPRESS_THRESHOLD;
export const KNOWN_SUPPRESS_FAMILIARITY = 1;
export const DEFAULT_EASE = 2.5;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

let cache: Record<string, LearnRecord> = {};

// ---------------------------------------------------------------
// Load-state tracking (Codex/#48 s1 review item 3): a transient
// IndexedDB read failure must not silently enable a destructive
// whole-map write later. Before this, a failed get() left `cache` at
// {} with no record of the failure — the NEXT upsertLearnRecord would
// persist `{oneRecord}` as the COMPLETE map, permanently deleting
// everything that failed to load. "failed" gates persist() below;
// "loaded" is reached either by a successful read OR by there being
// no IndexedDB to read from at all (a legitimate, non-destructive
// steady state — cache stays whatever it already is, in-memory-only).
// ---------------------------------------------------------------
type LearnsetLoadState = "uninitialized" | "loaded" | "failed";
let loadState: LearnsetLoadState = "uninitialized";

/** Test/diagnostic hook — not used by any production call site. */
export function getLearnsetLoadState(): LearnsetLoadState {
  return loadState;
}

/** Thrown by persist()/upsertLearnRecord()/removeLearnRecord() on a
 *  write failure (the idb `set()` itself rejected) OR when a write is
 *  refused outright because the last read of the persisted map failed
 *  and a reload attempt (see upsertLearnRecord/removeLearnRecord)
 *  couldn't recover it either — writing a whole-map snapshot built
 *  only from whatever survived in memory would otherwise silently
 *  delete every record this process never got a chance to read. This
 *  module stays pure of UI: callers (store.ts's actions) catch this
 *  and turn it into a visible toast. */
export class LearnsetPersistError extends Error {
  constructor(message = "学习记录保存失败") {
    super(message);
    this.name = "LearnsetPersistError";
  }
}

export function learnKey(kind: LearnKind, surface: string): string {
  return `${kind}:${kind === "term" ? termNormKey(surface) : expressionNormKey(surface)}`;
}

export function getCachedLearnset(): Record<string, LearnRecord> {
  return cache;
}

export async function loadLearnset(): Promise<Record<string, LearnRecord>> {
  if (!hasIndexedDb()) {
    // Nothing to read — this is a legitimate steady state (in-memory
    // only), not a failure, so it must not gate persist() below.
    loadState = "loaded";
    return cache;
  }
  try {
    const map = await get<Record<string, LearnRecord>>(LEARNSET_KEY);
    // Action-wins merge (#48 s1 review item 2a): a mutation may have
    // run concurrently with this read (e.g. store.ts's hydrate()
    // awaits this alongside other startup I/O, and an action can fire
    // before hydrate resolves) and already written straight into
    // `cache` — that in-memory write is NEWER than whatever this read
    // captured from disk at the time it started, so it must survive
    // rather than being clobbered by the disk snapshot.
    cache = { ...(map ?? {}), ...cache };
    loadState = "loaded";
  } catch (err) {
    console.warn("[learnset] load failed", err);
    loadState = "failed";
    // Deliberately do NOT reset cache to {} here — a transient read
    // failure must not make the NEXT mutation's whole-map persist()
    // call look like "there was never anything on disk" (see
    // persist()'s loadState gate below).
  }
  return cache;
}

export function sweepStaleSuppressedLearnset(
  records: Record<string, LearnRecord>,
  now: number,
): Record<string, LearnRecord> {
  let changed = false;
  const next: Record<string, LearnRecord> = {};
  for (const [key, record] of Object.entries(records)) {
    if (
      record.suppressed &&
      record.suppressedAt !== undefined &&
      now - record.suppressedAt >= REFRESH_MS
    ) {
      next[key] = {
        ...record,
        suppressed: false,
        dueAt: now,
        updatedAt: now,
      };
      changed = true;
    } else {
      next[key] = record;
    }
  }
  return changed ? next : records;
}

export async function refreshStaleSuppressedLearnset(
  now: number = Date.now(),
): Promise<Record<string, LearnRecord>> {
  const next = sweepStaleSuppressedLearnset(cache, now);
  if (next !== cache) {
    try {
      await persist(next);
    } catch (err) {
      // Best-effort background maintenance sweep — cache is already
      // updated in memory (persist() assigns cache = next before it
      // can throw); it just didn't make it to disk this time. Must
      // never throw out of here: store.ts's hydrate() awaits this
      // directly and a throw would break app startup entirely.
      console.warn("[learnset] refreshStaleSuppressedLearnset persist failed", err);
    }
  }
  return cache;
}

async function persist(next: Record<string, LearnRecord>): Promise<void> {
  cache = next;
  if (!hasIndexedDb()) return;
  if (loadState === "failed") {
    // Refuse the destructive whole-map overwrite (#48 s1 review item
    // 3, option b): we never got a good read of what's actually on
    // disk, so writing `next` (built only from whatever survived in
    // memory) could silently delete every record this process never
    // saw. upsertLearnRecord/removeLearnRecord already get one
    // automatic reload attempt before reaching here (option a) — this
    // only fires when that reload attempt ALSO failed.
    throw new LearnsetPersistError(
      "同步失败，已跳过保存以防覆盖",
    );
  }
  try {
    await set(LEARNSET_KEY, next);
  } catch (err) {
    console.warn("[learnset] persist failed", err);
    loadState = "failed";
    throw new LearnsetPersistError();
  }
}

/** Before any mutation writes a whole-map snapshot, make sure we've
 *  actually seen what's on disk at least once — if the last load
 *  attempt failed, re-attempt it here (merging any pending in-memory
 *  writes on top, action-wins, same as loadLearnset's own contract)
 *  so this write's base reflects reality rather than a possibly-
 *  incomplete cache. Never throws — loadLearnset already catches its
 *  own failures; if the reattempt fails again, persist() below is
 *  what actually refuses the write. */
async function ensureLoadedBeforeWrite(): Promise<void> {
  if (loadState === "failed") {
    await loadLearnset();
  }
}

export async function upsertLearnRecord(
  record: LearnRecord,
): Promise<Record<string, LearnRecord>> {
  await ensureLoadedBeforeWrite();
  await persist({ ...cache, [record.learnKey]: record });
  return cache;
}

export function makeInitialLearnRecord(
  kind: LearnKind,
  surface: string,
  now: number,
): LearnRecord {
  return {
    learnKey: learnKey(kind, surface),
    kind,
    surface,
    familiarity: 0,
    suppressed: false,
    reps: 0,
    intervalDays: 0,
    ease: DEFAULT_EASE,
    dueAt: now,
    lapses: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function removeLearnRecord(key: string): Promise<Record<string, LearnRecord>> {
  await ensureLoadedBeforeWrite();
  const next = { ...cache };
  delete next[key];
  await persist(next);
  return cache;
}

export async function clearLearnset(): Promise<void> {
  cache = {};
  if (!hasIndexedDb()) return;
  try {
    await del(LEARNSET_KEY);
    // A successful delete proves IndexedDB is reachable again — clear
    // the failed-load gate so the next write isn't refused needlessly.
    loadState = "loaded";
  } catch (err) {
    console.warn("[learnset] clear failed", err);
  }
}
