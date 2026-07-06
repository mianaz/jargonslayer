// IndexedDB persistence via idb-keyval.
// OWNER: worker B. Signatures are contract — do not change them.
// Keys: "meetlingo:settings", "meetlingo:sessions:index" (SessionMeta[]),
//       "meetlingo:session:<id>" (full MeetingSession).

import type { MeetingSession, SessionMeta, Settings } from "../types";

export async function saveSettings(s: Settings): Promise<void> {
  void s; // STUB — worker B implements.
}

export async function loadSettings(): Promise<Settings | null> {
  return null; // STUB
}

export async function saveSession(s: MeetingSession): Promise<void> {
  void s; // STUB
}

export async function listSessions(): Promise<SessionMeta[]> {
  return []; // STUB — newest first
}

export async function getSession(id: string): Promise<MeetingSession | null> {
  void id;
  return null; // STUB
}

export async function deleteSession(id: string): Promise<void> {
  void id; // STUB
}
