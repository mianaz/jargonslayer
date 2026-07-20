// AnkiConnect connector (v0.5 Wave-1 Feature 9, docs/design-explorations/
// v05-wave1-blueprint.md §1 Feature 9 + §5 A8). Localhost, no auth — POSTs
// to a locally-running Anki + AnkiConnect add-on (default port 8765,
// independently configurable because it collides with the local Whisper
// sidecar's own ws://localhost:8765 default, see types.ts's ankiConnect
// field comment).
//
// This is the MODULE + settings subcomponent only (A8): the store-side
// "fire on session save" hook is a later lead-owned integration step
// (F0b) — nothing here imports "@/lib/store" or reads Settings directly;
// every dependency (session, deck/port config, the delivery ledger) is
// passed in by the caller, so that future hook just calls
// deliverSessionNotes(session, settings.ankiConnect, ankiLedger).
//
// Wire contract verified against the canonical AnkiConnect README
// (git.sr.ht/~foosoft/anki-connect, fetched directly rather than
// guessed) for requestPermission/version/addNotes/canAddNotes' exact
// request/response shapes.

import { get, set } from "idb-keyval";
import type { Flashcard, MeetingSession } from "@jargonslayer/core/types";
import { IS_DESKTOP } from "@/lib/platform/desktop";
import { IS_IOS } from "@/lib/platform/ios";
import { getTauriFetch } from "@/lib/desktop/tauriApi";

// ---------------------------------------------------------------
// ankiInvoke — the one HTTP entry point every action below goes through.
// ---------------------------------------------------------------

/** Never dispatched on iOS — there is no local Anki app to reach, and
 *  AnkiConnectSection is hidden entirely on that platform too (defense
 *  in depth: this guard is the root-cause enforcement point regardless
 *  of which caller reaches it). */
export class AnkiIosUnsupportedError extends Error {
  constructor(message = "iOS 不支持 AnkiConnect") {
    super(message);
    this.name = "AnkiIosUnsupportedError";
  }
}

/** AnkiConnect's own envelope carried a non-null `error` string. */
export class AnkiConnectApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnkiConnectApiError";
  }
}

/** The ordinary browser fetch, arrow-wrapped so a detached reference is
 *  always safely re-invocable — mirrors llmTransport.ts's own default
 *  transport (`(...args) => fetch(...args)`), the exact same "may be
 *  passed around as a plain value" concern this function has. Equivalent
 *  to window.fetch in any real browser/webview (fetch is a
 *  WindowOrWorkerGlobalScope member) — written as the bare global instead
 *  so this stays testable under this repo's default node test
 *  environment via plain `global.fetch = mock` stubbing, no jsdom
 *  needed (see lib/history/__tests__/autoExport.test.ts's own
 *  postTaskWebhook coverage for the identical convention). */
async function resolveFetch(): Promise<typeof fetch> {
  if (IS_DESKTOP) {
    // tauriApi.ts's getTauriFetch(): the same CORS-exempt native fetch
    // the BYOK provider paths register via llmTransport.setTransport at
    // desktop bootstrap (bootstrap.ts's `deps.setTransport(deps.
    // tauriFetch)`) — called directly here instead of reusing that
    // module (llmTransport.ts is scoped to LLM provider calls only, see
    // its own header comment) since tauriApi.ts's getters are already
    // designed to be consumed directly by any feature that needs a
    // Tauri capability (captionWindow.ts/osSpeechTransport.ts/
    // openExternal.ts all do the same).
    return getTauriFetch();
  }
  return (...args: Parameters<typeof fetch>) => fetch(...args);
}

/** POST {action, version: 6, params?} to a local AnkiConnect instance
 *  and unwrap its {result, error} envelope — throws AnkiConnectApiError
 *  when `error` is non-null, AnkiIosUnsupportedError on iOS (checked
 *  before any network attempt), or lets the underlying fetch rejection
 *  propagate (connection refused / browser-blocked / timeout — see
 *  testAndAuthorize for how the foreground flow classifies those).
 *  `timeoutMs` is an optional extra beyond the three-argument contract
 *  callers normally use — testAndAuthorize's foreground probe is the
 *  one caller that needs a bounded wait. */
export async function ankiInvoke<T = unknown>(
  port: number,
  action: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<T> {
  if (IS_IOS) throw new AnkiIosUnsupportedError();
  const fetchImpl = await resolveFetch();
  const body: Record<string, unknown> = { action, version: 6 };
  if (params !== undefined) body.params = params;
  const res = await fetchImpl(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  const envelope = (await res.json()) as { result: T; error: string | null };
  if (envelope.error !== null) {
    throw new AnkiConnectApiError(envelope.error);
  }
  return envelope.result;
}

// ---------------------------------------------------------------
// testAndAuthorize — explicit foreground "测试并授权" action (A8: never
// first-prompted during a background autosave).
// ---------------------------------------------------------------

export type AnkiAuthStatusKind = "ok" | "unreachable" | "network-blocked" | "denied" | "ios-unsupported";

export interface AnkiAuthStatus {
  kind: AnkiAuthStatusKind;
  label: string;
}

const ANKI_AUTH_STATUS_LABEL: Record<AnkiAuthStatusKind, string> = {
  ok: "已连接",
  unreachable: "Anki 未运行或端口不通",
  "network-blocked": "浏览器阻止了本地网络访问（需在弹窗中允许）",
  denied: "未授权（请在 Anki 弹窗中允许）",
  "ios-unsupported": "iOS 不支持 AnkiConnect",
};

function authStatus(kind: AnkiAuthStatusKind): AnkiAuthStatus {
  return { kind, label: ANKI_AUTH_STATUS_LABEL[kind] };
}

const AUTH_PROBE_TIMEOUT_MS = 5000;

function isAbortTimeout(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** requestPermission then version, classified into the four zh outcomes
 *  the settings section shows.
 *
 *  ponytail: a browser's fetch() rejects with the SAME opaque
 *  `TypeError: Failed to fetch` whether nothing is listening on the
 *  port (Anki not running) or the browser itself silently withheld the
 *  request pending a Local Network Access decision — the platform does
 *  not expose a distinct error for either case. The only available
 *  signal is timing: a real connection-refused fails near-instantly, a
 *  browser-side hold does not. Ceiling: a slow/loaded machine could
 *  misclassify "not running" as "network-blocked". Upgrade path: none
 *  known today — revisit if Chrome ever surfaces a typed PNA rejection. */
export async function testAndAuthorize(port: number): Promise<AnkiAuthStatus> {
  if (IS_IOS) return authStatus("ios-unsupported");

  let permission: { permission: "granted" | "denied" };
  try {
    permission = await ankiInvoke<{ permission: "granted" | "denied" }>(
      port,
      "requestPermission",
      undefined,
      AUTH_PROBE_TIMEOUT_MS,
    );
  } catch (err) {
    return authStatus(isAbortTimeout(err) ? "network-blocked" : "unreachable");
  }
  if (permission.permission === "denied") return authStatus("denied");

  try {
    await ankiInvoke(port, "version");
  } catch {
    return authStatus("unreachable");
  }
  return authStatus("ok");
}

// ---------------------------------------------------------------
// deliverSessionNotes — addNotes payload + idempotent delivery.
// ---------------------------------------------------------------

export interface AnkiNotePayload {
  deckName: string;
  modelName: string;
  fields: { Front: string; Back: string };
  options: { allowDuplicate: false };
  tags: string[];
}

// Mirrors export.ts's private escapeAnkiField exactly (front/back are
// the same Anki HTML-field content either way) — duplicated rather than
// imported/exported for reuse, same self-contained posture docx.ts's
// own header comment already established for this lane grouping (L2
// owns export.ts; this lane's edit surface there is zero).
function escapeAnkiField(s: string): string {
  return s.replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
}

/** Pure projection from a session flashcard to an addNotes note object
 *  — same front/back composition buildAnkiTSV (export.ts) uses for the
 *  manual TSV export, Basic model, allowDuplicate:false, tagged
 *  "jargonslayer". Exported standalone for tests. */
export function buildAnkiNotePayload(card: Flashcard, deckName: string): AnkiNotePayload {
  return {
    deckName,
    modelName: "Basic",
    fields: {
      Front: escapeAnkiField(card.front),
      Back: escapeAnkiField(`${card.back_zh}<br>${card.back_en}<br><i>${card.example}</i>`),
    },
    options: { allowDuplicate: false },
    tags: ["jargonslayer"],
  };
}

/** Stable content identity for a note — front+back ARE the two fields
 *  actually sent, so the pair doubles as its own fingerprint. No hash:
 *  flashcard content is always short, and a content-addressed key has
 *  zero collision risk (unlike a hashed one), which is simpler AND
 *  strictly more correct here — provided the join character can never
 *  appear inside either field. A plain space would NOT hold that
 *  (front/back routinely contain spaces: front="foo bar"+back="baz"
 *  would collide with front="foo"+back="bar baz"), so this joins on a
 *  NUL character instead, which never occurs in ordinary flashcard/HTML
 *  content. Exported standalone for tests. */
export function flashcardFingerprint(note: Pick<AnkiNotePayload, "fields">): string {
  return `${note.fields.Front}\u0000${note.fields.Back}`;
}

/** Idempotency ledger — a param, not a module-global, so
 *  deliverSessionNotes stays callable from wherever the future store
 *  hook lives without that hook needing to know this module's storage
 *  details. Implementations must never throw: a ledger failure should
 *  degrade to "treat as unsent"/"delivery not recorded", never abort a
 *  save. See `ankiLedger` below for the real IDB-backed one. */
export interface AnkiDeliveryLedger {
  hasSent(sessionId: string, fingerprint: string): Promise<boolean>;
  markSent(sessionId: string, fingerprint: string): Promise<void>;
}

// One idb-keyval entry per (session, fingerprint) pair — key scheme is
// literally "sessionId + fingerprint" per the design brief, mirroring
// glossary.ts's own hasIndexedDb()-guarded get/set/console.warn
// convention (duplicated locally rather than imported — same
// established per-file convention glossary.ts and autoExport.ts each
// already follow for this exact helper).
const LEDGER_KEY_PREFIX = "jargonslayer:anki-ledger:";

function ledgerKey(sessionId: string, fingerprint: string): string {
  return `${LEDGER_KEY_PREFIX}${sessionId}\u0000${fingerprint}`;
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

/** The real, IDB-backed ledger — the concrete implementation the future
 *  store-side delivery hook passes to deliverSessionNotes. */
export const ankiLedger: AnkiDeliveryLedger = {
  async hasSent(sessionId, fingerprint) {
    if (!hasIndexedDb()) return false;
    try {
      return (await get<boolean>(ledgerKey(sessionId, fingerprint))) === true;
    } catch (err) {
      console.warn("[ankiConnect] ledger hasSent failed", err);
      return false;
    }
  },
  async markSent(sessionId, fingerprint) {
    if (!hasIndexedDb()) return;
    try {
      await set(ledgerKey(sessionId, fingerprint), true);
    } catch (err) {
      console.warn("[ankiConnect] ledger markSent failed", err);
    }
  },
};

export interface AnkiConnectDeliveryConfig {
  deckName: string;
  port: number;
}

export interface AnkiDeliveryResult {
  sent: number;
  skipped: number;
}

/** Builds addNotes payloads from session.summary.flashcards and
 *  delivers only what the ledger hasn't already marked sent — a stopped
 *  session re-saves many times (late diarization/translation/edits), so
 *  this must be safe to call repeatedly without duplicating cards.
 *  canAddNotes is an auxiliary pre-filter only (skips what Anki itself
 *  would reject, e.g. an existing duplicate) — it never marks anything
 *  sent by itself; only a non-null addNotes result per index does that.
 *  Never throws — mirrors autoExport.ts's postWebhook/
 *  exportSessionToFolder fire-and-forget contract, since this is
 *  designed to run from the same post-save path. */
export async function deliverSessionNotes(
  session: MeetingSession,
  cfg: AnkiConnectDeliveryConfig,
  ledger: AnkiDeliveryLedger,
): Promise<AnkiDeliveryResult> {
  const flashcards = session.summary?.flashcards ?? [];
  const total = flashcards.length;
  if (total === 0) return { sent: 0, skipped: 0 };

  const candidates: Array<{ fingerprint: string; note: AnkiNotePayload }> = [];
  for (const card of flashcards) {
    const note = buildAnkiNotePayload(card, cfg.deckName);
    const fingerprint = flashcardFingerprint(note);
    if (await ledger.hasSent(session.id, fingerprint)) continue;
    candidates.push({ fingerprint, note });
  }

  let toSend = candidates;
  if (candidates.length > 0) {
    try {
      const canAdd = await ankiInvoke<boolean[]>(cfg.port, "canAddNotes", {
        notes: candidates.map((c) => c.note),
      });
      toSend = candidates.filter((_, i) => canAdd[i] !== false);
    } catch (err) {
      console.warn("[ankiConnect] canAddNotes pre-filter failed, sending unfiltered", err);
    }
  }

  let sent = 0;
  if (toSend.length > 0) {
    try {
      const results = await ankiInvoke<Array<number | null>>(cfg.port, "addNotes", {
        notes: toSend.map((c) => c.note),
      });
      for (let i = 0; i < toSend.length; i++) {
        if (typeof results?.[i] === "number") {
          await ledger.markSent(session.id, toSend[i].fingerprint);
          sent++;
        }
      }
    } catch (err) {
      console.warn("[ankiConnect] deliverSessionNotes addNotes failed", err);
    }
  }

  return { sent, skipped: total - sent };
}
