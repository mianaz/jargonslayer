// Agent-native output layer: auto-write sessions to a user-chosen
// folder (File System Access API), webhook push, full backup.
// OWNER: worker D. Signatures are contract — store/Settings UI call
// these; do not change them.

import { del, get, set } from "idb-keyval";
import { DEFAULT_SETTINGS, type MeetingSession, type Settings } from "@jargonslayer/core/types";
import { buildMarkdownReport, buildObsidianFrontmatter } from "./export";
import * as storage from "./storage";
import * as glossary from "./glossary";
import * as learnset from "../learn/store";
import type { LearnRecord } from "@jargonslayer/core/learn/types";

const EXPORT_DIR_KEY = "jargonslayer:export-dir";

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
    let handle = await get<FileSystemDirectoryHandle>(EXPORT_DIR_KEY);
    if (!handle) {
      // Pre-rename key migration (copy, don't delete).
      handle = await get<FileSystemDirectoryHandle>("meetlingo:export-dir");
      if (handle) await set(EXPORT_DIR_KEY, handle);
    }
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

/** `YYYY-MM-DD-HHmm-jargonslayer`, sanitized for filesystem safety. */
function filenameBase(startedAt: number): string {
  const d = new Date(startedAt);
  const raw = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
    d.getDate(),
  )}-${pad2(d.getHours())}${pad2(d.getMinutes())}-jargonslayer`;
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

/** POST a task lifecycle event (#58 task center) to the webhook URL —
 *  same fire-and-forget/timeout contract as postWebhook above, but
 *  envelopes a task-registry snapshot under `event: "task.*"` instead
 *  of a full session. Reuses the SAME webhookUrl setting (design
 *  decision 5: "the event bus doubles as the connector hook", no new
 *  config surface) — call sites live in src/lib/tasks/registry.ts.
 *  `task` is typed structurally (not against TaskState) so this module
 *  never has to import from lib/tasks — registry.ts already imports
 *  FROM here, and a one-way dependency keeps that clean. */
export async function postTaskWebhook(
  task: {
    id: string;
    kind: string;
    label: string;
    stage: string;
    progress?: number;
    status: string;
    error?: string;
    sessionId?: string;
    createdAt: number;
    updatedAt: number;
  },
  event: "task.started" | "task.done" | "task.error",
  url: string,
): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        event,
        exportedAt: Date.now(),
        task,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.warn("[autoExport] postTaskWebhook failed", err);
  }
}

/** Every field on Settings that can hold BYOK key material — kept in
 *  one place so the export-time strip below and any future audit stay
 *  in sync (see #57's plaintext-key audit). taskLlm's per-domain
 *  overrides (#56) each carry their own optional apiKey too. */
function stripKeyMaterial(settings: Settings): Settings {
  const { taskLlm, ...rest } = settings;
  const strippedTaskLlm = taskLlm
    ? (Object.fromEntries(
        Object.entries(taskLlm).map(([domain, cfg]) => [
          domain,
          cfg ? { ...cfg, apiKey: undefined } : cfg,
        ]),
      ) as Settings["taskLlm"])
    : taskLlm;
  return {
    ...rest,
    apiKey: "",
    hfToken: "",
    // v0.4 S4 (blueprint decision E): Soniox BYOK key — same hand-listed
    // strip as the other BYOK/pairing fields here (types.ts's own
    // sonioxKey doc comment points back at this exact line).
    sonioxKey: "",
    agentToken: "",
    // Webhook URLs routinely embed capability tokens in the path
    // (n8n/飞书 style) — credential-like, stripped with the rest
    // (Codex v0.2.3 review, LOW).
    webhookUrl: "",
    taskLlm: strippedTaskLlm,
  };
}

/** Serialize sessions + glossary + learn-set + settings into one backup
 *  JSON. `includeKeys: false` (the Settings dialog's default-checked
 *  "不包含 API Key" option) strips apiKey/taskLlm[*].apiKey/hfToken/
 *  sonioxKey/agentToken from the embedded settings — everything else
 *  round-trips as-is.
 *
 *  `learnset` (#48 step 4): the learn-set's `Record<string,
 *  LearnRecord>` (see learn/store.ts) as a fourth top-level field,
 *  KEEPING schemaVersion 1 — the key is optional so an old backup file
 *  (pre-#48) restores exactly as before (see restoreFullBackup below,
 *  which tolerates its absence). Losing the learn-set on restore means
 *  re-teaching the app every known term, which is why this ships in
 *  the same release as #48 step 1 (known-term suppression). */
export async function buildFullBackup(
  opts: { includeKeys?: boolean } = {},
): Promise<string> {
  const { includeKeys = true } = opts;
  const metas = await storage.listSessions();
  const sessions = (
    await Promise.all(metas.map((m) => storage.getSession(m.id)))
  ).filter((s): s is MeetingSession => s !== null);
  const glossaryEntries = await glossary.loadCustomEntries();
  const learnsetRecords = await learnset.loadLearnset();
  const rawSettings = await storage.loadSettings();
  const settings = rawSettings && !includeKeys ? stripKeyMaterial(rawSettings) : rawSettings;
  return JSON.stringify(
    {
      schemaVersion: 1,
      kind: "jargonslayer-backup",
      exportedAt: Date.now(),
      sessions,
      glossary: glossaryEntries,
      learnset: learnsetRecords,
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
  // #48 step 4: absent on any pre-#48 backup — every read site below
  // tolerates absence (0 count / no restore writes / learn-set left
  // untouched), never assumes the key exists.
  learnset?: Record<string, unknown>;
  settings?: Settings;
}

/** Parse-and-validate a backup JSON string, throwing the same zh-ready
 *  errors both call sites (the confirmation-step preview and the real
 *  restore below) need to surface identically. Not exported — callers
 *  that only need counts (no writes) use previewBackup below instead,
 *  so the shape check lives in exactly one place either way. */
function parseBackup(json: string): BackupShape {
  let parsed: BackupShape;
  try {
    parsed = JSON.parse(json) as BackupShape;
  } catch (err) {
    throw new Error("备份文件不是有效的 JSON", { cause: err });
  }
  if (parsed.kind !== "jargonslayer-backup" && parsed.kind !== "meetlingo-backup") {
    throw new Error("不是有效的 JargonSlayer 备份文件");
  }
  return parsed;
}

/** Parse-and-validate only — no writes. Used by the Settings dialog's
 *  import confirmation step to show counts ("N 场会议 / N 条词典 /
 *  是否包含设置/Key") before the user commits to restoring. hasApiKey
 *  inspects the file's OWN settings.apiKey rather than trusting
 *  whatever the exporter's "不包含 API Key" checkbox happened to be set
 *  to at export time (a file could have been hand-edited, or exported
 *  by an older build) — the confirm copy should describe what this
 *  FILE actually contains, not what a checkbox once claimed. */
export function previewBackup(json: string): {
  sessions: number;
  entries: number;
  learnset: number;
  hasSettings: boolean;
  hasApiKey: boolean;
} {
  const parsed = parseBackup(json);
  const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  const entries = Array.isArray(parsed.glossary) ? parsed.glossary : [];
  const learnsetCount =
    parsed.learnset && typeof parsed.learnset === "object"
      ? Object.keys(parsed.learnset).length
      : 0;
  return {
    sessions: sessions.length,
    entries: entries.length,
    learnset: learnsetCount,
    hasSettings: !!parsed.settings,
    hasApiKey: !!parsed.settings?.apiKey,
  };
}

/** Merge a backup file back in: sessions and glossary entries are
 *  upserted by id (dedupe — an id already present locally is
 *  overwritten by the backup's copy, everything else local is kept),
 *  settings (if present in the file) REPLACE the current settings
 *  wholesale via storage.saveSettings — the caller is expected to
 *  re-hydrate the live store afterward (store.hydrate() already runs
 *  the restored blob through migrateSettings, so a backup taken on an
 *  older schema still comes out with every current field populated).
 *  Returns counts for the caller's toast/confirmation copy.
 *
 *  `learnset` (#48 step 4): upserted by `learnKey` the same way
 *  glossary entries are upserted by `id` above — a key already present
 *  locally is overwritten by the backup's copy, everything else local
 *  is kept. A backup with no `learnset` key (any pre-#48 file) simply
 *  contributes zero records — the current learn-set is left completely
 *  untouched, never cleared. */
// Keys that must never be trusted as either a learn-set dict key or a
// record's own `learnKey` field (Codex/#48 s1 review item 4): a
// hostile or hand-edited backup could otherwise smuggle one of these
// through Object.entries/JSON.parse (both of which DO produce a
// literal own data property named e.g. "__proto__" — unlike bracket
// ASSIGNMENT (`obj[key] = v`), object-literal/spread semantics don't
// trigger the real prototype setter, but this module treats the check
// as defense-in-depth regardless of whether today's call sites happen
// to be spread-based) rather than actually polluting Object.prototype.
const DANGEROUS_LEARNSET_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Validate one untrusted learn-set record from a backup file before
 *  it's ever upserted (Codex/#48 s1 review item 4). Malformed records
 *  are DROPPED — never partially trusted. The one exception: a
 *  suppressed:true record with no (finite) suppressedAt is REPAIRED
 *  (stamped with `now`) rather than dropped outright, since a missing
 *  suppressedAt alone doesn't invalidate the record's substance — it
 *  would just make it permanently unrecoverable by the 90-day
 *  stale-suppression sweep (learn/store.ts's
 *  sweepStaleSuppressedLearnset, which requires suppressedAt to ever
 *  un-suppress a record). Exported for direct tests, same pattern as
 *  sanitizeRestoredSettings below. */
export function sanitizeRestoredLearnRecord(
  raw: unknown,
  now: number = Date.now(),
): LearnRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.learnKey !== "string" || r.learnKey.length === 0) return null;
  if (DANGEROUS_LEARNSET_KEYS.has(r.learnKey)) return null;
  if (typeof r.surface !== "string" || r.surface.length === 0) return null;
  if (r.kind !== "expression" && r.kind !== "term") return null;
  if (typeof r.suppressed !== "boolean") return null;

  const requiredFinite = ["familiarity", "reps", "intervalDays", "ease", "dueAt", "lapses", "createdAt", "updatedAt"] as const;
  for (const field of requiredFinite) {
    if (typeof r[field] !== "number" || !Number.isFinite(r[field])) return null;
  }

  const finiteOrAbsent = (v: unknown): v is number | undefined =>
    v === undefined || (typeof v === "number" && Number.isFinite(v));
  if (!finiteOrAbsent(r.lastReviewedAt)) return null;
  if (!finiteOrAbsent(r.suppressedAt)) return null;

  const suppressedAt =
    r.suppressed === true && r.suppressedAt === undefined
      ? now
      : (r.suppressedAt as number | undefined);

  return {
    learnKey: r.learnKey,
    kind: r.kind,
    surface: r.surface,
    familiarity: r.familiarity as number,
    suppressed: r.suppressed,
    suppressedAt,
    reps: r.reps as number,
    intervalDays: r.intervalDays as number,
    ease: r.ease as number,
    dueAt: r.dueAt as number,
    lastReviewedAt: r.lastReviewedAt as number | undefined,
    lapses: r.lapses as number,
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
  };
}

export async function restoreFullBackup(
  json: string,
): Promise<{ sessions: number; entries: number; learnset: number; settingsRestored: boolean }> {
  const parsed = parseBackup(json);

  const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  for (const session of sessions) {
    await storage.saveSession(session);
  }

  const entries = Array.isArray(parsed.glossary) ? parsed.glossary : [];
  for (const entry of entries) {
    await glossary.upsertCustomEntry(entry as Parameters<typeof glossary.upsertCustomEntry>[0]);
  }

  // #48 s1 review item 4: validate every learn-set record before it's
  // ever upserted — malformed/hostile entries are dropped, only
  // accepted ones are counted (see sanitizeRestoredLearnRecord above).
  const learnsetEntries =
    parsed.learnset && typeof parsed.learnset === "object" ? Object.entries(parsed.learnset) : [];
  let learnsetAccepted = 0;
  for (const [dictKey, rawRecord] of learnsetEntries) {
    if (DANGEROUS_LEARNSET_KEYS.has(dictKey)) continue;
    const record = sanitizeRestoredLearnRecord(rawRecord);
    if (!record) continue;
    await learnset.upsertLearnRecord(record);
    learnsetAccepted += 1;
  }

  let settingsRestored = false;
  if (parsed.settings && typeof parsed.settings === "object") {
    // Cast: the sanitizer returns a Partial (unknown keys dropped),
    // and the caller immediately re-hydrates, whose migrateSettings
    // fold fills every missing field from DEFAULT_SETTINGS.
    await storage.saveSettings(sanitizeRestoredSettings(parsed.settings) as Settings);
    settingsRestored = true;
  }

  return {
    sessions: sessions.length,
    entries: entries.length,
    learnset: learnsetAccepted,
    settingsRestored,
  };
}

/** Restored settings are UNTRUSTED input (Codex v0.2.3 review,
 *  MEDIUM): a hand-crafted backup could otherwise smuggle
 *  subscriptionDirect:true plus an attacker agentUrl/agentToken, and
 *  every later detect/define call would ship meeting text to that
 *  host. Two defenses, exported for direct tests:
 *  1. allow-list keys — only fields the current Settings shape knows
 *     (DEFAULT_SETTINGS keys + the deliberately-optional taskLlm)
 *     survive; unknown/attacker-added keys are dropped rather than
 *     persisted forever by the hydrate spread.
 *  2. machine-local pairing/kill-switch fields are force-reset:
 *     subscriptionDirect off, agentUrl back to default, agentToken
 *     cleared. This is semantically right even for honest backups —
 *     the connection code is per-sidecar-RUN (printed on each start),
 *     so a restored token is stale on this machine by definition. */
export function sanitizeRestoredSettings(raw: Partial<Settings>): Partial<Settings> {
  const allowed = new Set([...Object.keys(DEFAULT_SETTINGS), "taskLlm"]);
  const picked: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (allowed.has(k)) picked[k] = v;
  }
  picked.subscriptionDirect = false;
  picked.agentUrl = DEFAULT_SETTINGS.agentUrl;
  picked.agentToken = "";
  return picked as Partial<Settings>;
}
