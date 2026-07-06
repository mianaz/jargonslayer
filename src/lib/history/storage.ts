// IndexedDB persistence via idb-keyval.
// OWNER: worker B. Signatures are contract — do not change them.
// Keys: "meetlingo:settings", "meetlingo:sessions:index" (SessionMeta[]),
//       "meetlingo:session:<id>" (full MeetingSession).

import { del, get, set } from "idb-keyval";
import { sessionToMeta, type MeetingSession, type SessionMeta, type Settings } from "../types";

const SETTINGS_KEY = "meetlingo:settings";
const SESSIONS_INDEX_KEY = "meetlingo:sessions:index";
const sessionKey = (id: string) => `meetlingo:session:${id}`;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
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
