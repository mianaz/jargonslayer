// Agent-native output layer: auto-write sessions to a user-chosen
// folder (File System Access API), webhook push, full backup.
// OWNER: worker D. Signatures are contract — store/Settings UI call
// these; do not change them.

import type { MeetingSession } from "../types";

/** Prompt the user to pick an export folder; persist the handle in
 *  IndexedDB. Returns folder name or null if cancelled/unsupported. */
export async function chooseExportFolder(): Promise<string | null> {
  return null; // STUB — worker D implements.
}

/** Name of the currently configured folder, or null. */
export async function getExportFolderName(): Promise<string | null> {
  return null; // STUB
}

export async function clearExportFolder(): Promise<void> {
  // STUB
}

/** Write {date}-{title}.md (+ .json with schemaVersion) into the
 *  configured folder. No-op when no folder is configured or
 *  permission was revoked. Never throws. */
export async function exportSessionToFolder(
  session: MeetingSession,
  opts: { frontmatter: boolean },
): Promise<void> {
  void session;
  void opts; // STUB
}

/** POST the session JSON to the webhook URL. Fire-and-forget with a
 *  short timeout; never throws. */
export async function postWebhook(
  session: MeetingSession,
  url: string,
): Promise<void> {
  void session;
  void url; // STUB
}

/** Serialize sessions + glossary + settings into one backup JSON. */
export async function buildFullBackup(): Promise<string> {
  return "{}"; // STUB
}

/** Merge a backup file back in (dedupe by id). Returns counts. */
export async function restoreFullBackup(
  json: string,
): Promise<{ sessions: number; entries: number }> {
  void json;
  return { sessions: 0, entries: 0 }; // STUB
}