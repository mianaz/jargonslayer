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

/** ankiInvoke's own round trip exceeded `timeoutMs` with no response —
 *  M3 fix (Sol review 2026-07-20, v0.5 closeout): a hung AnkiConnect
 *  round trip (dead process, stuck localhost socket) used to leave
 *  ankiInvoke's own returned promise pending FOREVER — deliverSessionNotes'
 *  per-session queue below awaits exactly that promise, so an unbounded
 *  hang here starved every later save for that session permanently.
 *  Named (rather than a bare DOMException) so a caller/log can tell
 *  this apart from a real AnkiConnectApiError or network rejection. */
export class AnkiInvokeTimeoutError extends Error {
  constructor(action: string, timeoutMs: number) {
    super(`AnkiConnect "${action}" 超时（${timeoutMs}ms 未响应）`);
    this.name = "AnkiInvokeTimeoutError";
  }
}

// M3 default round-trip ceiling: every ankiInvoke call is now bounded —
// testAndAuthorize's own foreground probe still passes its tighter
// AUTH_PROBE_TIMEOUT_MS (5000ms) explicitly below; every other caller
// (deliverSessionNotesImpl's canAddNotes/addNotes, previously fully
// unbounded) gets this ceiling for free via ankiInvoke's own default
// parameter.
const DEFAULT_ANKI_INVOKE_TIMEOUT_MS = 30000;

/** Settles no later than `timeoutMs` after being created, regardless of
 *  whether `promise` itself ever does — see AnkiInvokeTimeoutError's
 *  own doc above for why ankiInvoke needs this on top of the fetch's
 *  own AbortSignal.timeout (belt and braces: a transport that doesn't
 *  honor AbortSignal — unclear for Tauri's own fetch shim — would
 *  otherwise still hang this function's returned promise forever
 *  despite the signal). Always clears its own timer the instant
 *  `promise` settles either way, so a normal (fast) call never leaves a
 *  live timer behind. */
function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, action: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AnkiInvokeTimeoutError(action, timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
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
 *  before any network attempt), AnkiInvokeTimeoutError when no response
 *  lands within `timeoutMs` (M3: every call is now bounded, defaulting
 *  to DEFAULT_ANKI_INVOKE_TIMEOUT_MS — not just the ones that pass an
 *  explicit value), or lets the underlying fetch rejection propagate
 *  (connection refused / browser-blocked — see testAndAuthorize for how
 *  the foreground flow classifies those). `timeoutMs` stays a caller
 *  override — testAndAuthorize's foreground probe passes its own
 *  tighter AUTH_PROBE_TIMEOUT_MS below. */
export async function ankiInvoke<T = unknown>(
  port: number,
  action: string,
  params?: Record<string, unknown>,
  timeoutMs: number = DEFAULT_ANKI_INVOKE_TIMEOUT_MS,
): Promise<T> {
  if (IS_IOS) throw new AnkiIosUnsupportedError();
  const fetchImpl = await resolveFetch();
  const body: Record<string, unknown> = { action, version: 6 };
  if (params !== undefined) body.params = params;
  const call = (async (): Promise<T> => {
    const res = await fetchImpl(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const envelope = (await res.json()) as { result: T; error: string | null };
    if (envelope.error !== null) {
      throw new AnkiConnectApiError(envelope.error);
    }
    return envelope.result;
  })();
  return raceWithTimeout(call, timeoutMs, action);
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
async function deliverSessionNotesImpl(
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

// ---------------------------------------------------------------
// deliverSessionNotes — per-session in-flight serialization (Sol review
// follow-up, v0.5 Wave-1: "anki per-session delivery serialization") +
// bounded coalescing (M3, Sol review 2026-07-20, v0.5 closeout).
// ---------------------------------------------------------------

// Race window the serialization half closes: deliverSessionNotesImpl's
// candidates loop above reads ledger.hasSent for every card FIRST; the
// matching ledger.markSent write only happens much later, after the
// addNotes network round trip resolves. The ledger is idempotent ACROSS
// separate, sequential saves, but two overlapping deliverSessionNotes
// calls for the SAME session (rapid double-save, or a save landing
// while a slow AnkiConnect roundtrip is still in flight) both run that
// read phase before either has written anything — both see "not sent"
// and both send, duplicating notes despite the ledger. Chaining a
// session's calls one after another closes the window: a queued call's
// own ledger read cannot start until the call ahead of it has fully
// settled (reads AND writes). Keyed per session id (not one global
// lock) so unrelated sessions are never made to wait on each other.
//
// M3 fix: the chain alone was UNBOUNDED — with ankiInvoke previously
// having no timeout, one hung round trip plus repeated post-stop
// re-saves (deliverSessionNotesImpl's own doc: "a stopped session
// re-saves many times") grew this chain forever, each link's closure
// retaining a full MeetingSession snapshot. ankiInvoke is now bounded
// regardless (see its own DEFAULT_ANKI_INVOKE_TIMEOUT_MS above), AND at
// most ONE delivery is ever QUEUED (not yet running) per session at a
// time: a call arriving while one is already queued overwrites that
// queued snapshot in place (`pendingDeliveries` below) instead of
// adding a new chain link — latest wins. The link that's already IN
// FLIGHT (dequeued, actually running deliverSessionNotesImpl) is never
// touched; it always runs to completion. Every coalesced caller (the
// ones whose snapshot got overwritten before its turn came) shares the
// ONE delivery that actually executes in its place — nobody ever awaits
// a network round trip that was superseded before it started.
const sessionQueues = new Map<string, Promise<void>>();

interface PendingDelivery {
  session: MeetingSession;
  cfg: AnkiConnectDeliveryConfig;
  ledger: AnkiDeliveryLedger;
  // One waiter per coalesced caller — all resolved/rejected together
  // once THIS slot's delivery (whichever snapshot is current when its
  // turn comes) actually settles.
  waiters: Array<{
    resolve: (result: AnkiDeliveryResult) => void;
    reject: (err: unknown) => void;
  }>;
}

const pendingDeliveries = new Map<string, PendingDelivery>();

/** Runs whatever snapshot is CURRENTLY queued for `sessionId` (may have
 *  been overwritten several times since it was first queued — see
 *  PendingDelivery's own doc above) and settles every coalesced waiter
 *  with the same outcome. Dequeues itself FIRST, before awaiting
 *  anything, so a caller arriving once this is under way correctly
 *  starts a NEW queued slot rather than mutating one that's already
 *  running. */
async function runPendingDelivery(sessionId: string): Promise<void> {
  const pending = pendingDeliveries.get(sessionId);
  pendingDeliveries.delete(sessionId);
  if (!pending) return;
  try {
    const result = await deliverSessionNotesImpl(pending.session, pending.cfg, pending.ledger);
    for (const waiter of pending.waiters) waiter.resolve(result);
  } catch (err) {
    for (const waiter of pending.waiters) waiter.reject(err);
  }
}

/** Runs deliverSessionNotesImpl only after any in-flight delivery for
 *  the same session has settled — see the race-window comment above.
 *  A rejected prior delivery is swallowed before chaining off it
 *  (`.catch(() => undefined)`) so one failed call can never poison the
 *  chain for every later delivery of that session; the promise returned
 *  to THIS call's own caller still rejects normally when its own run
 *  fails (runPendingDelivery's own try/catch routes that rejection to
 *  this call's waiter, never by throwing back into the chain). The
 *  queue entry clears itself once settled (re-checked by identity
 *  first, in case a newer call already replaced it), so this map never
 *  leaks/grows for the life of the tab.
 *
 *  M3 coalescing (see the section header comment above): a call that
 *  finds one already queued for this session just adds itself as a
 *  waiter on that SAME slot (after overwriting the slot's snapshot) —
 *  it never extends sessionQueues itself. Only the first caller to find
 *  nothing queued does that. */
export async function deliverSessionNotes(
  session: MeetingSession,
  cfg: AnkiConnectDeliveryConfig,
  ledger: AnkiDeliveryLedger,
): Promise<AnkiDeliveryResult> {
  const { id: sessionId } = session;
  return new Promise<AnkiDeliveryResult>((resolve, reject) => {
    const waiter = { resolve, reject };
    const existing = pendingDeliveries.get(sessionId);
    if (existing) {
      existing.session = session;
      existing.cfg = cfg;
      existing.ledger = ledger;
      existing.waiters.push(waiter);
      return;
    }
    pendingDeliveries.set(sessionId, { session, cfg, ledger, waiters: [waiter] });
    const prior = sessionQueues.get(sessionId) ?? Promise.resolve();
    const chained = prior.catch(() => undefined).then(() => runPendingDelivery(sessionId));
    sessionQueues.set(sessionId, chained);
    chained.then(() => {
      if (sessionQueues.get(sessionId) === chained) sessionQueues.delete(sessionId);
    });
  });
}
