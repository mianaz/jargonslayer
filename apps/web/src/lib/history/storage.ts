// IndexedDB persistence via idb-keyval.
// OWNER: worker B. Signatures are contract — do not change them.
// Keys: "jargonslayer:settings", "jargonslayer:sessions:index" (SessionMeta[]),
//       "jargonslayer:session:<id>" (full MeetingSession).

import { del, get, set } from "idb-keyval";
import { sessionToMeta, type MeetingSession, type SessionMeta, type Settings } from "@jargonslayer/core/types";

const SETTINGS_KEY = "jargonslayer:settings";
const SESSIONS_INDEX_KEY = "jargonslayer:sessions:index";
const sessionKey = (id: string) => `jargonslayer:session:${id}`;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

// One-time migration from the pre-rename "meetlingo:*" keys. Copies
// (never deletes) legacy data so a rollback stays possible.
//
// hydrate() calls loadSettings() and listSessions() in parallel, both of
// which call this function — a boolean latch would let the second caller
// see "already started" and skip waiting, racing ahead to read the index
// before migration finished writing it. A shared promise fixes that:
// every caller (including the one that didn't create it) awaits the same
// in-flight migration.
let migrationPromise: Promise<void> | null = null;
async function migrateLegacyOnce(): Promise<void> {
  if (!hasIndexedDb()) return;
  if (!migrationPromise) {
    migrationPromise = (async () => {
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
    })();
  }
  return migrationPromise;
}

// F2 fix (Sol MEDIUM review, fieldtest-a batch): this used to catch and
// swallow every write failure, always resolving — so store.ts's
// flushSettings/updateSettings (and SettingsDialog's 「设置已保存」 toast)
// reported success even when nothing was durably written, the same
// silent-key-loss class this whole batch exists to kill. Now rethrows
// after logging, so a caller can actually tell "persisted" apart from
// "silently did nothing" — see store.ts's own flushSettings/
// updateSettings for how each of its callers now handles that (a
// fire-and-forget caller catches+diag-logs; the durable-commit
// flushSettings escape hatch propagates it to ITS OWN caller). Every
// OTHER caller of this function (autoExport.ts's restoreFullBackup) is
// audited there too. Unlike saveSession below, this does NOT switch to a
// boolean-return contract — flushSettings' signature (Promise<void>,
// already awaited by SettingsDialog's handleSave) fits a reject/try-catch
// contract more directly than threading a new boolean through every
// existing call site would.
export async function saveSettings(s: Settings): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await set(SETTINGS_KEY, s);
  } catch (err) {
    console.warn("[storage] saveSettings failed", err);
    throw err;
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

// Returns whether the session actually landed (Sol adversarial-review
// finding H1): true only when BOTH the session body write AND the
// index write completed — false on a missing IndexedDB or ANY thrown
// error, so a caller (saveCurrentSession/restoreLiveDraft in store.ts)
// can tell "persisted" apart from "silently did nothing" instead of
// unconditionally clearing the live draft and reporting success over a
// failed write. Every OTHER caller (importText.ts/importAudio.ts/
// upload.ts/autoExport.ts's restoreFullBackup) still compiles
// unchanged if it never reads the return value — see store.ts's own
// two callers for the ones that now do.
export async function saveSession(s: MeetingSession): Promise<boolean> {
  if (!hasIndexedDb()) return false;
  try {
    await set(sessionKey(s.id), s);
    const idx = await readIndex();
    const meta = sessionToMeta(s);
    const next = [meta, ...idx.filter((m) => m.id !== s.id)];
    await set(SESSIONS_INDEX_KEY, next);
    return true;
  } catch (err) {
    console.warn("[storage] saveSession failed", err);
    return false;
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
