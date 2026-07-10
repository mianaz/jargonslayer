// Diagnostics ring buffer — surfaces the structural error choke points
// (DetectionScheduler, TranslateQueue, llm/client.ts, STT engine
// status/notice, window error/unhandledrejection, task registry) that
// used to only ever reach console.warn/console.error and were
// invisible to a normal user. See report.ts (the copyable bundle) and
// SettingsDialog.tsx's 诊断 block (the viewer) for the consumers; see
// Toast.tsx for how an error-level entry's `ref` reaches the user via
// a toast suffix + 复制诊断 action.
//
// PRIVACY RULE (hard): diagLog must NEVER receive transcript content,
// translations, summaries, or profile/glossary FIELD VALUES — only
// fixed/short error messages, event metadata, and engine/queue STATE
// TRANSITIONS (e.g. "AI 检测暂时不可用，词典检测继续运行", an HTTP status
// code, a provider/model id). This module does no redaction itself —
// it is a bare ring buffer, not a filter — every call site is
// responsible for upholding this by construction. (report.ts carries
// the companion contract for Settings key material.)

export type DiagLevel = "info" | "warn" | "error";

export interface DiagEntry {
  ts: number;
  level: DiagLevel;
  tag: string;
  message: string;
  detail?: string;
  ref?: string;
}

export const DIAG_MAX_ENTRIES = 300;

// Tag-blocker MEDIUM 5: per-entry size cap — a single oversized
// message/detail (e.g. an unbounded upstream string a call site failed
// to trim) would otherwise let one entry balloon the ring buffer/
// report far past what DIAG_MAX_ENTRIES' entry-COUNT cap bounds.
// Applied at insertion so every consumer (getDiagEntries, report.ts)
// sees the already-truncated value.
export const DIAG_MAX_FIELD_CHARS = 2000;
const TRUNCATE_SUFFIX = "…[truncated]";

function truncateField(v: string): string;
function truncateField(v: string | undefined): string | undefined;
function truncateField(v: string | undefined): string | undefined {
  if (v === undefined || v.length <= DIAG_MAX_FIELD_CHARS) return v;
  return v.slice(0, DIAG_MAX_FIELD_CHARS) + TRUNCATE_SUFFIX;
}

let entries: DiagEntry[] = [];

const REF_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const REF_LENGTH = 4;

/** Short, human-copyable error reference (e.g. "JS-K3F9") a user can
 *  read off a toast/settings row and paste into a bug report — see
 *  Toast.tsx and SettingsDialog.tsx. Not cryptographically unique (4
 *  base36 chars, ~1.7M combinations) — a same-session collision is
 *  only ever a cosmetic mix-up (two entries sharing a ref), never a
 *  correctness issue, since refs are a lookup aid, not an identity
 *  key. Falls back to Math.random when crypto.getRandomValues isn't
 *  available, mirroring types.ts's newId() defensive pattern. */
export function newErrorRef(): string {
  const bytes = new Uint8Array(REF_LENGTH);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < REF_LENGTH; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let code = "";
  for (let i = 0; i < REF_LENGTH; i++) code += REF_CHARS[bytes[i] % REF_CHARS.length];
  return `JS-${code}`;
}

/** Append one entry to the ring buffer (oldest dropped once the buffer
 *  exceeds DIAG_MAX_ENTRIES entries). `level: "error"` entries
 *  automatically get a newErrorRef() — callers that need a ref-
 *  carrying toast (see useMeeting.ts's scheduler/queue/STT wiring)
 *  read it straight off the returned entry, so the toast's ref and
 *  this entry's ref are always the exact same value. `info`/`warn`
 *  entries carry no ref — nothing surfaces a toast for them today, and
 *  a ref with nothing for a user to point it at would just be noise
 *  in the diagnostics viewer. */
export function diagLog(
  level: DiagLevel,
  tag: string,
  message: string,
  detail?: string,
): DiagEntry {
  const entry: DiagEntry = {
    ts: Date.now(),
    level,
    tag,
    message: truncateField(message),
    detail: truncateField(detail),
    ref: level === "error" ? newErrorRef() : undefined,
  };
  entries.push(entry);
  if (entries.length > DIAG_MAX_ENTRIES) {
    entries = entries.slice(entries.length - DIAG_MAX_ENTRIES);
  }
  return entry;
}

/** Snapshot of the current buffer, oldest first (insertion order) — a
 *  fresh array every call so callers can never mutate internal state
 *  through the returned reference. */
export function getDiagEntries(): DiagEntry[] {
  return entries.slice();
}

/** Settings dialog's 清空 button + test reset hook. */
export function clearDiag(): void {
  entries = [];
}
