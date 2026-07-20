// v0.5 Wave-1 Feature 6 (configurable live-translation engines, docs/
// design-explorations/v05-wave1-blueprint.md §1 Feature 6 + §5 A6,
// normative). Two real TranslationProvider implementations, resolved
// per Settings.translateEngine + platform, and injected into
// TranslateQueue (queue.ts) — the queue itself never talks to
// translateApi or Translator.* directly anymore.
//
// A6's activation contract (the reason `prepare()` exists as its own
// method, separate from `translate()`): Chrome's on-device Translator
// API requires a live user gesture to trigger `Translator.create()`
// the FIRST time a language pair needs its model downloaded — a plain
// async call from inside the debounced translate queue (no gesture on
// the stack) would silently never resolve. `prepare()` MUST therefore
// be called synchronously inside a real click handler (useMeeting.ts's
// start(), before any await; TranslationEngineRow.tsx's own 下载并启用
// button, from ITS OWN click) — it may kick off async work internally,
// but the `Translator.create()` call itself fires before this function
// returns. `translate()` (called later, off the debounced queue timer,
// no gesture) only ever reads from the already-primed cache; it never
// calls `create()` itself.
import { translateApi } from "../llm/client";
import { diagLog } from "../diag/log";
import { IS_TAURI } from "../platform/ios";
import type { Settings, TranslateRequest, TranslateResponse } from "@jargonslayer/core/types";

export interface TranslationLangPair {
  /** BCP-47 primary subtag of the transcript's own language, e.g. "en"
   *  — same `settings.language.split("-")[0]` idiom already used by
   *  sonioxTransport.ts/wsTransport.ts/upload.ts. */
  source: string;
  /** Settings.explainLanguage ("zh" | "en") — the translation target. */
  target: string;
}

export function langPairFromSettings(settings: Settings): TranslationLangPair {
  return { source: settings.language.split("-")[0], target: settings.explainLanguage };
}

export interface TranslationProvider {
  kind: Settings["translateEngine"];
  /** MUST be callable synchronously inside a user gesture — see this
   *  module's header comment. A no-op for providers that need no
   *  per-language-pair priming (LlmTranslationProvider). */
  prepare(langPair: TranslationLangPair): void;
  translate(
    items: TranslateRequest["segments"],
    lang: string,
  ): Promise<TranslateResponse["translations"]>;
}

// ---------------------------------------------------------------
// LLM provider — today's behavior, unchanged. `getSettings` (not a
// snapshotted Settings) mirrors TranslateQueueOptions' own field so a
// BYOK key/model typed in mid-meeting is picked up on the very next
// batch, exactly like before this abstraction existed.
// ---------------------------------------------------------------

export class LlmTranslationProvider implements TranslationProvider {
  readonly kind: Settings["translateEngine"] = "llm";

  constructor(private getSettings: () => Settings) {}

  // Stateless per call — translateApi needs no priming.
  prepare(_langPair: TranslationLangPair): void {}

  async translate(
    items: TranslateRequest["segments"],
    lang: string,
  ): Promise<TranslateResponse["translations"]> {
    const settings = this.getSettings();
    // NoKeyError/RateLimitApiError thrown by translateApi propagate
    // through unchanged — queue.ts's existing handleError branches for
    // them stay exactly as before.
    const res = await translateApi({ segments: items, lang }, settings);
    return res.translations;
  }
}

// ---------------------------------------------------------------
// Chrome Translator provider (web, on-device) — verified surface
// (docs/design-explorations/v05-wave1-blueprint.md §1 Feature 6):
// `Translator.availability({sourceLanguage,targetLanguage})` ->
// "unavailable"|"downloadable"|"downloading"|"available";
// `Translator.create({sourceLanguage,targetLanguage})` resolves once
// ready (including after any first-use model download); the resolved
// session's `.translate(text)` does the actual per-string work.
// TypeScript's bundled DOM lib doesn't declare this API yet — hand-
// rolled interfaces below, same pattern as captionWindow.ts's own
// DocumentPictureInPictureApi/WindowWithPip.
// ---------------------------------------------------------------

export type TranslatorAvailabilityState =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

interface ChromeTranslatorSession {
  translate(text: string): Promise<string>;
}

interface ChromeTranslatorApi {
  availability(opts: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<TranslatorAvailabilityState>;
  create(opts: { sourceLanguage: string; targetLanguage: string }): Promise<ChromeTranslatorSession>;
}

interface WindowWithTranslator {
  Translator?: ChromeTranslatorApi;
}

/** Top-level window ONLY — never a PiP window (A6). This module never
 *  reads off a `pipWindow` reference; Document PiP (captionWindow.ts)
 *  shares this SAME JS realm as the main page (no second worker/iframe
 *  context — see that file's own header comment), so the bare `window`
 *  global resolved here is always the top-level window regardless of
 *  whether a caption PiP happens to be open. jsdom has no Translator at
 *  all — that absence IS the "unsupported" path every caller below
 *  handles. */
function getTranslatorApi(): ChromeTranslatorApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as WindowWithTranslator).Translator;
}

export function isSystemTranslatorSupported(): boolean {
  return getTranslatorApi() !== undefined;
}

/** Read-only status probe for TranslationEngineRow's own hint — a
 *  distinct real API surface from `create()` below (this never
 *  triggers a download by itself). Returns null when the API is
 *  altogether absent (distinct from "unavailable", which means the API
 *  exists but this specific language pair isn't supported). */
export async function checkSystemTranslatorAvailability(
  pair: TranslationLangPair,
): Promise<TranslatorAvailabilityState | null> {
  const api = getTranslatorApi();
  if (!api) return null;
  try {
    return await api.availability({ sourceLanguage: pair.source, targetLanguage: pair.target });
  } catch {
    return null;
  }
}

interface SessionEntry {
  status: "pending" | "ready" | "failed";
  session?: ChromeTranslatorSession;
}

// Module-level (not per-provider-instance) cache, keyed by "source:
// target": deliberate — the underlying browser model download is a
// shared OS/browser resource, not scoped to any one Translator.create()
// call, so a Settings-screen 下载并启用 click and a later meeting's own
// prepare() call for the SAME pair should share one download instead of
// each separately re-triggering create(). Reset between tests via
// resetSystemTranslatorCacheForTests (mirrors tauriApi.ts's
// resetTauriApiCache / captionWindow.ts's resetCaptionWindowStateForTests).
const sessionCache = new Map<string, SessionEntry>();

function pairKey(pair: TranslationLangPair): string {
  return `${pair.source}:${pair.target}`;
}

/** Synchronously calls Translator.create() (MUST run inside a user
 *  gesture per A6) and caches it per lang pair — a second call for the
 *  SAME pair reuses the cached entry instead of re-triggering
 *  create(). Tracks pending/ready/failed explicitly (not just the raw
 *  promise) so translate() below can fail FAST on a still-downloading
 *  pair instead of blocking the whole batch/queue for however long a
 *  first-use model download takes. ONLY ever called from prepare() (a
 *  gesture-scoped call site) — see readSystemTranslatorEntry below for
 *  the non-creating counterpart translate() uses instead. A "failed"
 *  entry is deliberately NOT reused here — caching a rejected create()
 *  forever would permanently wedge this pair even after a transient
 *  failure (offline during download, etc.); falling through re-primes
 *  with a fresh entry, which is what makes a LATER prepare() call (a
 *  fresh Start click, or the Settings row's own 下载并启用 button) a
 *  real retry instead of replaying the same stale failure. */
function primeSystemTranslator(pair: TranslationLangPair): SessionEntry | null {
  const api = getTranslatorApi();
  if (!api) return null;
  const key = pairKey(pair);
  const existing = sessionCache.get(key);
  if (existing && existing.status !== "failed") return existing;

  const entry: SessionEntry = { status: "pending" };
  sessionCache.set(key, entry);
  api.create({ sourceLanguage: pair.source, targetLanguage: pair.target }).then(
    (session) => {
      entry.status = "ready";
      entry.session = session;
    },
    () => {
      entry.status = "failed";
    },
  );
  return entry;
}

/** Read-only counterpart — NEVER calls create(). translate() uses this
 *  exclusively: per A6, translate() (running off the debounced queue
 *  timer, no user gesture on the stack) must never be the one to
 *  trigger create(), not even indirectly by "retrying" a failed entry.
 *  A "downloading" entry still self-heals on its own here (the ORIGINAL
 *  create() call from prepare() is still in flight; its .then() flips
 *  this SAME cache entry once it settles) — only a "failed" entry stays
 *  failed until a fresh prepare() call re-primes it. */
function readSystemTranslatorEntry(pair: TranslationLangPair): SessionEntry | undefined {
  return sessionCache.get(pairKey(pair));
}

export function resetSystemTranslatorCacheForTests(): void {
  sessionCache.clear();
}

export type SystemTranslatorErrorReason = "unavailable" | "downloading";

/** Distinct classification for system-provider failures — queue.ts
 *  must never fold these into the LLM NoKeyError/RateLimitApiError
 *  branches (A6). `reason: "downloading"` means prepare() already
 *  kicked off a real create()/model-download that just hasn't settled
 *  yet — self-healing once it does; "unavailable" covers everything
 *  else (API absent, this language pair unsupported, create() itself
 *  rejected). */
export class SystemTranslatorUnavailableError extends Error {
  readonly reason: SystemTranslatorErrorReason;
  constructor(reason: SystemTranslatorErrorReason, message?: string) {
    super(message ?? "系统翻译不可用");
    this.name = "SystemTranslatorUnavailableError";
    this.reason = reason;
  }
}

export class ChromeTranslatorProvider implements TranslationProvider {
  readonly kind: Settings["translateEngine"] = "system";

  // The pair most recently passed to prepare() — translate(items, lang)
  // only ever receives the TARGET lang (interface shared with the LLM
  // provider), so this is how it recovers the matching source language
  // without ever calling create() itself.
  private lastPair: TranslationLangPair | null = null;

  prepare(pair: TranslationLangPair): void {
    this.lastPair = pair;
    primeSystemTranslator(pair);
  }

  async translate(
    items: TranslateRequest["segments"],
    lang: string,
  ): Promise<TranslateResponse["translations"]> {
    const pair = this.lastPair;
    if (!pair || pair.target !== lang) {
      throw new SystemTranslatorUnavailableError("unavailable", "系统翻译未就绪");
    }
    // Read-only — see readSystemTranslatorEntry's own doc comment for
    // why translate() must never call primeSystemTranslator itself.
    const entry = readSystemTranslatorEntry(pair);
    if (!entry) {
      throw new SystemTranslatorUnavailableError("unavailable", "系统翻译不可用");
    }
    if (entry.status === "pending") {
      // Fail fast — never block this batch (and thus the whole queue,
      // single-in-flight by design) on however long a first-use model
      // download takes. Self-heals: the NEXT retry cycle re-reads this
      // SAME cache entry, which flips to "ready" once create() settles.
      throw new SystemTranslatorUnavailableError("downloading", "系统翻译模型下载中");
    }
    if (entry.status === "failed" || !entry.session) {
      throw new SystemTranslatorUnavailableError("unavailable", "系统翻译不可用");
    }
    const session = entry.session;
    return Promise.all(items.map(async (it) => ({ id: it.id, text: await session.translate(it.text) })));
  }
}

// ---------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------

/** settings.translateEngine==="system" AND plain web (never Tauri
 *  desktop/iOS — those have no on-device Translator today) AND the API
 *  is actually present -> Chrome provider; otherwise LLM, silently
 *  (one diagLog line when the user DID ask for "system" but it isn't
 *  available here — never a toast, never a thrown error: the meeting
 *  just starts on the LLM engine instead). Takes a live getter (not a
 *  settings snapshot) so the constructed LlmTranslationProvider keeps
 *  reading FRESH settings on every batch, same as before this
 *  abstraction existed; the provider KIND itself is decided once, here,
 *  matching how engine kind is already frozen for a session
 *  (useMeeting.ts's attachEngine). */
export function resolveTranslationProvider(getSettings: () => Settings): TranslationProvider {
  const settings = getSettings();
  if (settings.translateEngine === "system") {
    if (!IS_TAURI && isSystemTranslatorSupported()) {
      return new ChromeTranslatorProvider();
    }
    diagLog("info", "translate-provider", "系统翻译不可用，已回退到 AI 模型翻译");
  }
  return new LlmTranslationProvider(getSettings);
}
