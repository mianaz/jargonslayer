// IndexedDB persistence via idb-keyval.
// OWNER: worker B. Signatures are contract — do not change them.
// Keys: "jargonslayer:settings", "jargonslayer:sessions:index" (SessionMeta[]),
//       "jargonslayer:session:<id>" (full MeetingSession).

import { del, get, set } from "idb-keyval";
import { sessionToMeta, type MeetingSession, type SessionMeta, type Settings } from "../types";

const SETTINGS_KEY = "jargonslayer:settings";
const SESSIONS_INDEX_KEY = "jargonslayer:sessions:index";
const sessionKey = (id: string) => `jargonslayer:session:${id}`;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

// One-time migration from the pre-rename "meetlingo:*" keys. Copies
// (never deletes) legacy data so a rollback stays possible.
let migrationStarted = false;
async function migrateLegacyOnce(): Promise<void> {
  if (migrationStarted || !hasIndexedDb()) return;
  migrationStarted = true;
  try {
    if (await get("jargonslayer:migrated")) return;
    const legacyIdx = await get<SessionMeta[]>("meetlingo:sessions:index");
    if (legacyIdx && legacyIdx.length > 0) {
      const newIdx = (await get<SessionMeta[]>(SESSIONS_INDEX_KEY)) ?? [];
      const existing = new Set(newIdx.map((m) => m.id));
      for (const m of legacyIdx) {
        if (existing.has(m.id)) continue;
        const s = await get<MeetingSession>(`meetlingo:session:${m.id}`);
        if (s) {
          await set(sessionKey(m.id), s);
          newIdx.push(m);
        }
      }
      await set(SESSIONS_INDEX_KEY, newIdx);
    }
    const legacySettings = await get<Settings>("meetlingo:settings");
    if (legacySettings && !(await get(SETTINGS_KEY))) {
      await set(SETTINGS_KEY, legacySettings);
    }
    await set("jargonslayer:migrated", 1);
  } catch (err) {
    console.warn("[storage] legacy migration failed", err);
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await set(SETTINGS_KEY, s);
  } catch (err) {
    console.warn("[storage] saveSettings failed", err);
  }
}

export async function loadSettings(): Promise<Settings | null> {
  if (!hasIndexedDb()) return null;
  await migrateLegacyOnce();
  try {
    const s = await get<Settings>(SETTINGS_KEY);
    return s ?? null;
  } catch (err) {
    console.warn("[storage] loadSettings failed", err);
    return null;
  }
}

async function readIndex(): Promise<SessionMeta[]> {
  try {
    const idx = await get<SessionMeta[]>(SESSIONS_INDEX_KEY);
    return idx ?? [];
  } catch (err) {
    console.warn("[storage] readIndex failed", err);
    return [];
  }
}

export async function saveSession(s: MeetingSession): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await set(sessionKey(s.id), s);
    const idx = await readIndex();
    const meta = sessionToMeta(s);
    const next = [meta, ...idx.filter((m) => m.id !== s.id)];
    await set(SESSIONS_INDEX_KEY, next);
  } catch (err) {
    console.warn("[storage] saveSession failed", err);
  }
}

export async function listSessions(): Promise<SessionMeta[]> {
  if (!hasIndexedDb()) return [];
  await migrateLegacyOnce();
  const idx = await readIndex();
  return [...idx].sort((a, b) => b.startedAt - a.startedAt);
}

export async function getSession(id: string): Promise<MeetingSession | null> {
  if (!hasIndexedDb()) return null;
  try {
    const s = await get<MeetingSession>(sessionKey(id));
    return s ?? null;
  } catch (err) {
    console.warn("[storage] getSession failed", err);
    return null;
  }
}

export async function deleteSession(id: string): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await del(sessionKey(id));
    const idx = await readIndex();
    const next = idx.filter((m) => m.id !== id);
    await set(SESSIONS_INDEX_KEY, next);
  } catch (err) {
    console.warn("[storage] deleteSession failed", err);
  }
}
