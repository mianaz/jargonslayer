// Minimal diagnostics ring buffer — local shim for the ported STT
// cores' `../diag/log` import (see apps/web/src/lib/diag/log.ts, the
// contract this mirrors). The extension has no diagnostics
// viewer/report bundle/toast-ref system yet (that's apps/web-only
// machinery — SettingsDialog.tsx's 诊断 block, Toast.tsx's 复制诊断
// action), so this stays a bare in-memory buffer: just enough surface
// for webSpeechSession.ts (and, once ported, webSpeech.ts) to keep
// calling `diagLog(level, tag, message, detail?)` unchanged.
//
// PRIVACY RULE (hard, same as the web contract): diagLog must NEVER
// receive transcript content or other field values — only fixed/short
// error messages, event metadata, and state transitions. This module
// does no redaction itself; every call site is responsible for
// upholding this by construction.

export type DiagLevel = "info" | "warn" | "error";

export interface DiagEntry {
  ts: number;
  level: DiagLevel;
  tag: string;
  message: string;
  detail?: string;
}

// Smaller than the web app's DIAG_MAX_ENTRIES (300) on purpose — the
// extension side panel is a much shorter-lived surface (one capture
// session at a time, no cross-session report bundle to feed), so a
// smaller cap is plenty while still bounding memory.
export const DIAG_MAX_ENTRIES = 200;

let entries: DiagEntry[] = [];

/** Append one entry to the ring buffer (oldest dropped once the buffer
 *  exceeds DIAG_MAX_ENTRIES). Same call shape as the web contract's
 *  diagLog, minus the toast-ref bookkeeping nothing here consumes. */
export function diagLog(level: DiagLevel, tag: string, message: string, detail?: string): void {
  entries.push({ ts: Date.now(), level, tag, message, detail });
  if (entries.length > DIAG_MAX_ENTRIES) {
    entries = entries.slice(entries.length - DIAG_MAX_ENTRIES);
  }
}

/** Snapshot of the current buffer, oldest first — a fresh array every
 *  call so callers can never mutate internal state through the
 *  returned reference. Test-only today (no viewer consumes this yet). */
export function getDiagEntries(): DiagEntry[] {
  return entries.slice();
}

/** Test reset hook — mirrors the web contract's clearDiag(). */
export function clearDiag(): void {
  entries = [];
}
