// Agent-native output layer: auto-write sessions to a user-chosen
// folder (File System Access API), webhook push, full backup.
// OWNER: worker D. Signatures are contract — store/Settings UI call
// these; do not change them.

import { del, get, set } from "idb-keyval";
import type { MeetingSession, Settings } from "../types";
import { buildMarkdownReport, buildObsidianFrontmatter } from "./export";
import * as storage from "./storage";
import * as glossary from "./glossary";

const EXPORT_DIR_KEY = "meetlingo:export-dir";

// ---------------------------------------------------------------
// File System Access API — not yet in TypeScript's stock lib.dom.d.ts
// (WICG spec, Chromium-only support). Minimal ambient augmentation so
// this file type-checks without pulling in a new @types dependency.
// ---------------------------------------------------------------

type FsPermissionMode = "read" | "readwrite";

interface FsHandlePermissionMethods {
  queryPermission(opts?: { mode?: FsPermissionMode }): Promise<PermissionState>;
  requestPermission(opts?: { mode?: FsPermissionMode }): Promise<PermissionState>;
}

declare global {
  interface FileSystemDirectoryHandle extends FsHandlePermissionMethods {}
  interface Window {
    showDirectoryPicker?: (opts?: {
      mode?: FsPermissionMode;
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function hasDirectoryPicker(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

async function getStoredHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (!hasIndexedDb()) return null;
  try {
    const handle = await get<FileSystemDirectoryHandle>(EXPORT_DIR_KEY);
    return handle ?? null;
  } catch (err) {
    console.warn("[autoExport] getStoredHandle failed", err);
    return null;
  }
}

/** Prompt the user to pick an export folder; persist the handle in
 *  IndexedDB. Returns folder name or null if cancelled/unsupported. */
export async function chooseExportFolder(): Promise<string | null> {
  if (!hasDirectoryPicker()) {
    console.warn("[autoExport] File System Access API unsupported in this browser");
    return null;
  }
  try {
    const handle = await window.showDirectoryPicker!({ mode: "readwrite" });
    if (hasIndexedDb()) {
      await set(EXPORT_DIR_KEY, handle);
    }
    return handle.name;
  } catch (err) {
    // Includes user cancelling the picker (AbortError) — not an error.
    console.warn("[autoExport] chooseExportFolder failed", err);
    return null;
  }
}

/** Name of the currently configured folder, or null. */
export async function getExportFolderName(): Promise<string | null> {
  const handle = await getStoredHandle();
  return handle?.name ?? null;
}

export async function clearExportFolder(): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await del(EXPORT_DIR_KEY);
  } catch (err) {
    console.warn("[autoExport] clearExportFolder failed", err);
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYY-MM-DD-HHmm-meetlingo`, sanitized for filesystem safety. */
function filenameBase(startedAt: number): string {
  const d = new Date(startedAt);
  const raw = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
    d.getDate(),
  )}-${pad2(d.getHours())}${pad2(d.getMinutes())}-meetlingo`;
  return raw.replace(/[^a-zA-Z0-9-]/g, "-");
}

/** Write {date}-{title}.md (+ .json with schemaVersion) into the
 *  configured folder. No-op when no folder is configured or
 *  permission was revoked. Never throws. */
export async function exportSessionToFolder(
  session: MeetingSession,
  opts: { frontmatter: boolean },
): Promise<void> {
  try {
    const handle = await getStoredHandle();
    if (!handle) return; // not configured — silent no-op

    let permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission === "prompt") {
      // Only works with a user gesture in the call stack; likely to
      // fail when invoked from a background auto-save. That's fine —
      // we just skip this export rather than throw.
      try {
        permission = await handle.requestPermission({ mode: "readwrite" });
      } catch (err) {
        console.warn("[autoExport] requestPermission failed", err);
        return;
      }
    }
    if (permission !== "granted") {
      console.warn("[autoExport] export folder permission not granted");
      return;
    }

    const base = filenameBase(session.startedAt);
    const md = opts.frontmatter
      ? `${buildObsidianFrontmatter(session)}\n\n${buildMarkdownReport(session)}`
      : buildMarkdownReport(session);
    const json = JSON.stringify(
      { schemaVersion: 1, exportedAt: Date.now(), session },
      null,
      2,
    );

    const mdHandle = await handle.getFileHandle(`${base}.md`, { create: true });
    const mdWritable = await mdHandle.createWritable();
    await mdWritable.write(md);
    await mdWritable.close();

    const jsonHandle = await handle.getFileHandle(`${base}.json`, {
      create: true,
    });
    const jsonWritable = await jsonHandle.createWritable();
    await jsonWritable.write(json);
    await jsonWritable.close();
  } catch (err) {
    console.warn("[autoExport] exportSessionToFolder failed", err);
  }
}

/** POST the session JSON to the webhook URL. Fire-and-forget with a
 *  short timeout; never throws. */
export async function postWebhook(
  session: MeetingSession,
  url: string,
): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        event: "meeting.saved",
        exportedAt: Date.now(),
        session,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.warn("[autoExport] postWebhook failed", err);
  }
}

/** Serialize sessions + glossary + settings into one backup JSON. */
export async function buildFullBackup(): Promise<string> {
  const metas = await storage.listSessions();
  const sessions = (
    await Promise.all(metas.map((m) => storage.getSession(m.id)))
  ).filter((s): s is MeetingSession => s !== null);
  const glossaryEntries = await glossary.loadCustomEntries();
  const settings = await storage.loadSettings();
  return JSON.stringify(
    {
      schemaVersion: 1,
      kind: "meetlingo-backup",
      exportedAt: Date.now(),
      sessions,
      glossary: glossaryEntries,
      settings,
    },
    null,
    2,
  );
}

interface BackupShape {
  schemaVersion?: number;
  kind?: string;
  sessions?: MeetingSession[];
  glossary?: unknown[];
  settings?: Settings;
}

/** Merge a backup file back in (dedupe by id). Returns counts. */
export async function restoreFullBackup(
  json: string,
): Promise<{ sessions: number; entries: number }> {
  let parsed: BackupShape;
  try {
    parsed = JSON.parse(json) as BackupShape;
  } catch (err) {
    throw new Error("备份文件不是有效的 JSON", { cause: err });
  }
  if (parsed.kind !== "meetlingo-backup") {
    throw new Error("不是有效的 MeetLingo 备份文件");
  }

  const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  for (const session of sessions) {
    await storage.saveSession(session);
  }

  const entries = Array.isArray(parsed.glossary) ? parsed.glossary : [];
  for (const entry of entries) {
    await glossary.upsertCustomEntry(entry as Parameters<typeof glossary.upsertCustomEntry>[0]);
  }

  // Settings are intentionally not restored silently — the user's
  // current provider/key/engine choices stay untouched. Caller may
  // surface this in its toast copy.
  return { sessions: sessions.length, entries: entries.length };
}
