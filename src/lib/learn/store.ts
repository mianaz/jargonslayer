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

export function learnKey(kind: LearnKind, surface: string): string {
  return `${kind}:${kind === "term" ? termNormKey(surface) : expressionNormKey(surface)}`;
}

export function getCachedLearnset(): Record<string, LearnRecord> {
  return cache;
}

export async function loadLearnset(): Promise<Record<string, LearnRecord>> {
  if (!hasIndexedDb()) return {};
  try {
    const map = await get<Record<string, LearnRecord>>(LEARNSET_KEY);
    cache = map ?? {};
  } catch (err) {
    console.warn("[learnset] load failed", err);
    cache = {};
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
    await persist(next);
  }
  return cache;
}

async function persist(next: Record<string, LearnRecord>): Promise<void> {
  cache = next;
  if (!hasIndexedDb()) return;
  try {
    await set(LEARNSET_KEY, next);
  } catch (err) {
    console.warn("[learnset] persist failed", err);
  }
}

export async function upsertLearnRecord(
  record: LearnRecord,
): Promise<Record<string, LearnRecord>> {
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
  } catch (err) {
    console.warn("[learnset] clear failed", err);
  }
}
