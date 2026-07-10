// Learn-set persistence + sync cache. Mirrors history/glossary.ts because
// live detection needs synchronous point lookups after one startup hydrate.

import { del, get, set } from "idb-keyval";
import { expressionNormKey, termNormKey } from "../detect/dedupe";
import type { LearnKind, LearnRecord } from "./types";

const LEARNSET_KEY = "jargonslayer:learnset";

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
