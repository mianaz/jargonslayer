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
import { translateApi, NoKeyError, RateLimitApiError } from "../llm/client";
import { getTransport } from "../llm/llmTransport";
import { IS_IOS } from "../platform/ios";
import { IS_DESKTOP } from "../platform/desktop";
import { getInvoke } from "../desktop/tauriApi";
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
// DeepL provider (v0.7 wave 2A, BYOK) — a plain HTTP call, unlike the
// system providers below: no per-language-pair priming/model download
// exists for DeepL, so prepare() is a no-op and translate() reads
// CURRENT settings.deeplKey/language fresh every call, same "always
// fresh" contract as LlmTranslationProvider above. Routed through
// llmTransport.ts's getTransport() (native fetch on desktop/iOS, CORS-
// free) rather than the global fetch directly — on plain web (no Tauri
// transport) a DeepL call CORS-fails, surfacing as an ordinary batch
// failure through queue.ts's generic-error retry path; disabling the
// option in that case is UI-side, not this provider's job.
// ---------------------------------------------------------------

export class DeepLTranslationProvider implements TranslationProvider {
  readonly kind: Settings["translateEngine"] = "deepl";

  constructor(private getSettings: () => Settings) {}

  // Stateless per call — nothing to prime.
  prepare(_langPair: TranslationLangPair): void {}

  async translate(
    items: TranslateRequest["segments"],
    lang: string,
  ): Promise<TranslateResponse["translations"]> {
    const settings = this.getSettings();
    const key = settings.deeplKey.trim();
    if (!key) throw new NoKeyError();

    const base = key.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
    const res = await getTransport()(`${base}/v2/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `DeepL-Auth-Key ${key}` },
      body: JSON.stringify({
        text: items.map((i) => i.text),
        source_lang: langPairFromSettings(settings).source.toUpperCase(),
        target_lang: lang === "zh" ? "ZH" : "EN-US",
        model_type: "latency_optimized",
        split_sentences: "0", // keeps DeepL's positional response 1:1 with `items` — see the length check below
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 403) throw new NoKeyError();
    if (res.status === 429 || res.status === 456) throw new RateLimitApiError(); // 456 = DeepL quota exceeded
    if (!res.ok) throw new Error(`DeepL translate failed (${res.status})`);

    const body = (await res.json()) as { translations?: { text: string }[] };
    const translations = body.translations ?? [];
    // DeepL's response is POSITIONAL (no ids) — a length mismatch must
    // fail the WHOLE batch rather than zip a shifted array (a silent
    // off-by-one would mistranslate every row); segments simply stay
    // English-only, same failed-soft contract as every other provider's
    // own thrown errors.
    if (translations.length !== items.length) {
      throw new Error(
        `DeepL response length mismatch: got ${translations.length}, expected ${items.length}`,
      );
    }
    return items.map((it, i) => ({ id: it.id, text: translations[i].text }));
  }
}

// ---------------------------------------------------------------
// 有道 (Youdao) provider (v0.7.1 translation train-2, BYOK, native-
// only) — mirrors DeepLTranslationProvider's shape above (live
// getSettings, no-op prepare, getTransport()+AbortSignal.timeout), but
// 有道's API is per-STRING rather than batch: one POST per item, fired
// together via Promise.all (callers batch ≤6 items already). HTTP is
// ALWAYS 200 here — errors ride the JSON body's errorCode instead (see
// YOUDAO_NOKEY_CODES/YOUDAO_RATE_LIMIT_CODES below), unlike DeepL's
// ordinary HTTP status codes. Not exposed on plain web (openapi.youdao.
// com has no Access-Control-Allow-Origin on any probed Origin — see
// docs/design-explorations/v071-translation-train2-blueprint.md's own
// 有道 API contract section) — that carve-out is UI-side (
// TranslationEngineRow.tsx's YOUDAO_WEB_DISABLED_REASON), not this
// provider's job, same split DeepL's own CORS limit already uses.
// ---------------------------------------------------------------

const YOUDAO_NOKEY_CODES = new Set([
  "108",
  "111",
  "112",
  "201",
  "202",
  "110",
  "205",
  "203",
  "401",
]);
const YOUDAO_RATE_LIMIT_CODES = new Set(["411", "412"]);

/** `q.length<=20 ? q : q.slice(0,10) + q.length + q.slice(-10)` — raw
 *  pre-encoding string, UTF-16 `String.length` (有道's own signing spec,
 *  verified against live probes — see this module's header above). */
export function youdaoTruncateForSign(q: string): string {
  if (q.length <= 20) return q;
  return q.slice(0, 10) + String(q.length) + q.slice(-10);
}

async function youdaoSign(
  appKey: string,
  q: string,
  salt: string,
  curtime: string,
  appSecret: string,
): Promise<string> {
  const raw = appKey + youdaoTruncateForSign(q) + salt + curtime + appSecret;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** BCP-47 primary subtag ("en"/"zh") -> 有道's own language code —
 *  "zh-CHS" is 有道's simplified-Chinese code, everything else (this app
 *  only ever passes "en" or "zh" — see langPairFromSettings) maps to
 *  plain "en". */
function youdaoLangCode(bcp: string): string {
  return bcp === "zh" ? "zh-CHS" : "en";
}

async function translateOneWithYoudao(
  text: string,
  opts: { appKey: string; appSecret: string; from: string; to: string },
): Promise<string> {
  const salt = crypto.randomUUID();
  const curtime = String(Math.floor(Date.now() / 1000));
  const sign = await youdaoSign(opts.appKey, text, salt, curtime, opts.appSecret);

  const res = await getTransport()("https://openapi.youdao.com/api", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      q: text,
      from: opts.from,
      to: opts.to,
      appKey: opts.appKey,
      salt,
      sign,
      signType: "v3",
      curtime,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`有道翻译失败 (HTTP ${res.status})`);

  let body: { errorCode?: string; translation?: string[] };
  try {
    body = await res.json();
  } catch {
    throw new Error("有道翻译失败（响应解析失败）");
  }

  const code = body.errorCode ?? "";
  if (code === "0") {
    // R2-4 fix (v0.7.1 train-2 round-2 review, REVERTING the round-1 F1
    // "throw on empty" change below): errorCode "0" ("成功") with a
    // missing/empty translation[0] resolves to "" here, PER-ITEM.
    // Throwing used to reject the WHOLE Promise.all in translate()
    // below on just one empty item, discarding up to 5 OTHER valid
    // results in the same batch and re-billing all 6 on gapfill.ts's
    // retry — a bigger amplification than the empty-result problem it
    // was meant to fix. The actual root-fix for that infinite-loop risk
    // lives in gapfill.ts instead (its own F1: any id that lands ""
    // is quarantined into giveUpIds and never re-selected/re-billed) —
    // the live queue already tolerates a "" translation the same way
    // for every other engine, so this is no less safe than any other
    // provider's own soft-empty result.
    return body.translation?.[0] ?? "";
  }
  if (YOUDAO_NOKEY_CODES.has(code)) throw new NoKeyError();
  if (YOUDAO_RATE_LIMIT_CODES.has(code)) throw new RateLimitApiError();
  throw new Error(`有道翻译失败 (${code})`);
}

export class YoudaoTranslationProvider implements TranslationProvider {
  readonly kind: Settings["translateEngine"] = "youdao";

  constructor(private getSettings: () => Settings) {}

  // Stateless per call — nothing to prime.
  prepare(_langPair: TranslationLangPair): void {}

  async translate(
    items: TranslateRequest["segments"],
    lang: string,
  ): Promise<TranslateResponse["translations"]> {
    const settings = this.getSettings();
    const appKey = settings.youdaoAppKey.trim();
    const appSecret = settings.youdaoAppSecret.trim();
    if (!appKey || !appSecret) throw new NoKeyError();

    const from = youdaoLangCode(langPairFromSettings(settings).source);
    const to = youdaoLangCode(lang);

    // One request per item, in parallel — a single item's NoKeyError/
    // RateLimitApiError still fails the whole batch (Promise.all rejects
    // on the first rejection), same failed-soft-at-the-batch-level
    // contract as every other provider's own thrown errors. An empty
    // ("成功" with no text) result does NOT reject, though (R2-4 fix
    // above) — it resolves "" in its own positional slot, same as any
    // other item.
    const results = await Promise.all(items.map((it) => translateOneWithYoudao(it.text, { appKey, appSecret, from, to })));
    return items.map((it, i) => ({ id: it.id, text: results[i] }));
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
// Native system-translate provider — desktop (macOS 26+, v0.6) AND iOS
// (S13) share this SAME on-device, no-LLM-key provider: the Rust side
// (owned by concurrent lanes, not this module) exposes a closed
// 4-command surface, byte-identical invoke names + wire shapes on both
// platforms (desktop: systranslate.rs spawns a child process; iOS: the
// os-speech plugin's in-process TranslationSession, bridged through
// osspeech_ios.rs — see that file's own header comment on keeping
// invoke names wire-identical across platforms, the same pattern its
// os_speech commands already use), so ONE provider class below serves
// both — ALL through tauriApi.ts's getInvoke() (the only module that
// ever imports `@tauri-apps/*` — see its own header comment):
//   invoke("system_translate_probe", {source,target})
//     -> {osSupported: boolean; status: "installed"|"supported"|"unsupported"}
//   invoke("system_translate_prepare", {source,target}) -> number   (spawns/warms
//     the native child, returns its generation — S1 fix, v0.6 round-2 review)
//   invoke("system_translate", {items:{id,text}[],source,target}) -> {id,text}[]  (order-preserving)
//   invoke("system_translate_stop", {generation: number|null}) -> void
// ---------------------------------------------------------------

// Single gate for both platforms' identical native surface above —
// desktop and iOS builds are mutually exclusive (IS_DESKTOP/IS_IOS never
// both true), so this is never ambiguous about which side actually owns
// the call at runtime; every call site below reads this instead of
// IS_DESKTOP alone.
const NATIVE_SYSTEM_TRANSLATE = IS_DESKTOP || IS_IOS;

export interface SystemTranslateProbeResult {
  osSupported: boolean;
  status: "installed" | "supported" | "unsupported";
}

const SYSTEM_TRANSLATE_UNSUPPORTED: SystemTranslateProbeResult = { osSupported: false, status: "unsupported" };

// Module-level, keyed by pairKey — separate from ChromeTranslatorProvider's
// own sessionCache above (different question, different platform; the two
// never coexist since native (IS_DESKTOP/IS_IOS) and plain-web are mutually
// exclusive builds). Shared by TranslationEngineRow's own read-only hint,
// store.ts's runTranslateEngineMigration, and warmSystemTranslateProbeForStartup
// below — single source of truth so a probe fired from any caller benefits
// the others.
const systemProbeCache = new Map<string, SystemTranslateProbeResult>();
const systemProbeInFlight = new Map<string, Promise<SystemTranslateProbeResult>>();

/** Synchronous snapshot of the last SUCCESSFULLY-resolved probe for
 *  `pair` — null before probeSystemTranslateSupport() has ever resolved
 *  for real (a failed probe is deliberately not cached, same policy as
 *  osspeechCaps.ts's own probeOsSpeechCapabilitiesWith — see that
 *  function's own doc). Read by TranslationEngineRow's own hint and
 *  store.ts's runTranslateEngineMigration — resolveTranslationProvider
 *  no longer reads this (see its own doc comment: the privacy taste-veto
 *  fix means it never conditions the returned provider on probe state). */
export function getSystemTranslateProbeSnapshot(pair: TranslationLangPair): SystemTranslateProbeResult | null {
  return systemProbeCache.get(pairKey(pair)) ?? null;
}

/** Runs system_translate_probe for `pair`, caching a successful result.
 *  Single-flighted per pair (a Settings-row mount racing a meeting
 *  Start's own background warm-up share one round trip). Never throws —
 *  outside a desktop/iOS build, or on any invoke()/getInvoke() failure
 *  (including the SYNCHRONOUS throw tauriApi.ts's getInvoke() raises
 *  outside a Tauri build), resolves the fail-closed SYSTEM_TRANSLATE_
 *  UNSUPPORTED shape instead, deliberately NOT cached so a later call
 *  gets to retry for real. */
export function probeSystemTranslateSupport(pair: TranslationLangPair): Promise<SystemTranslateProbeResult> {
  const key = pairKey(pair);
  const cached = systemProbeCache.get(key);
  if (cached) return Promise.resolve(cached);
  const inFlight = systemProbeInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = (async (): Promise<SystemTranslateProbeResult> => {
    try {
      const invoke = await getInvoke();
      const result = await invoke<SystemTranslateProbeResult>("system_translate_probe", {
        source: pair.source,
        target: pair.target,
      });
      systemProbeCache.set(key, result);
      return result;
    } catch {
      return SYSTEM_TRANSLATE_UNSUPPORTED;
    } finally {
      systemProbeInFlight.delete(key);
    }
  })();
  systemProbeInFlight.set(key, promise);
  return promise;
}

export function resetSystemTranslateProbeCacheForTests(): void {
  systemProbeCache.clear();
  systemProbeInFlight.clear();
}

/** err instanceof Error ? err.message : String(err) — same idiom this
 *  app already repeats per-module (jobsBridge.ts, provisionRunner.ts,
 *  bootstrap.ts) rather than a shared helper. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// S1 fix (v0.6 round-2 review): the generation the most recent
// SUCCESSFUL system_translate_prepare call returned — read by
// stopSystemTranslator below so a stop can only ever kill the exact
// child it was issued for. stopSystemTranslator() is fire-and-forget on
// the JS side (and even now that useMeeting.ts's own teardown paths
// await it, the Rust-side invoke itself can still resolve arbitrarily
// late), so without this a stop issued when one meeting ends could
// resolve AFTER a brand-new meeting's own prepare() has already
// registered its own child, killing the WRONG one. Module-level rather
// than per-provider-instance for the same reason sessionCache/
// systemProbeCache above are: only one DesktopSystemTranslationProvider
// is ever live across the whole app at a time (one meeting at a time),
// so "the generation the last prepare() call warmed" and "this specific
// instance's own generation" are always the same value in practice.
let lastDesktopTranslateGeneration: number | null = null;

export function resetSystemTranslateGenerationForTests(): void {
  lastDesktopTranslateGeneration = null;
}

// Despite the name (kept to avoid touching every existing test/call
// site — see this module's section header comment above), this class
// now serves BOTH native platforms: desktop (macOS 26+) AND iOS, gated
// identically via NATIVE_SYSTEM_TRANSLATE below. Same 4 invoke commands
// either way, so no per-platform branching lives inside this class
// itself.
export class DesktopSystemTranslationProvider implements TranslationProvider {
  readonly kind: Settings["translateEngine"] = "system";

  // Mirrors ChromeTranslatorProvider's own lastPair field/rationale —
  // translate(items, lang) only ever receives the TARGET lang.
  private lastPair: TranslationLangPair | null = null;

  // FT-11 fix (field reproduction, six real transcripts — an entire
  // meeting landed ZERO translations): the OLD `prepareFailed` boolean
  // was a latch only a FRESH prepare() call could ever clear, but
  // prepare() runs EXACTLY ONCE per meeting (the Start click — see this
  // module's own header). One transient prepare failure therefore meant
  // every LATER translate() threw 'unavailable' without ever touching
  // the native side again, for the rest of the meeting. `prepared`
  // replaces that latch with a memoized "the child is warm" promise
  // that is evicted on rejection (see ensurePrepared below) instead of
  // staying cached — so the queue's own retry (SYSTEM_UNAVAILABLE_
  // PAUSE_MS, queue.ts) gets a genuine re-attempt, no second Start/
  // prepare() call required.
  private prepared: Promise<void> | null = null;

  // Optional live-settings getter, passed by resolveTranslationProvider
  // — lets translate() below notice a mid-meeting explainLanguage/
  // language edit (Settings changed without restarting the meeting) and
  // re-prepare for the NEW pair instead of latching onto whatever
  // prepare() captured at Start. The native side already tears down and
  // respawns its --translate child on a pair change (system_translate_
  // prepare's own reuse check, systranslate.rs) — this just makes the JS
  // side actually ask it to. Undefined in unit tests that construct this
  // provider directly and only ever exercise one pair.
  constructor(private getSettings?: () => Settings) {}

  prepare(pair: TranslationLangPair): void {
    this.lastPair = pair;
    // prepare() itself stays callable synchronously inside the caller's
    // own user gesture (this module's A6 header contract) even though
    // ensurePrepared kicks off async work — it never awaits it. A
    // Tauri invoke has no gesture requirement of its own (unlike
    // Chrome's Translator API — see this module's header comment), so a
    // LATER, non-gesture re-prepare from translate() itself (below) is
    // perfectly legal on this path.
    void this.ensurePrepared(pair);
  }

  /** Memoized "the native --translate child is warm for `pair`" promise
   *  — a later call while this is still pending, or already resolved,
   *  reuses the SAME promise rather than firing a redundant
   *  system_translate_prepare invoke. A REJECTED prepare must NOT stay
   *  cached (that caching was the FT-11 latch): the rejection handler
   *  below evicts it immediately, so the very next caller — prepare()
   *  again, OR translate() itself, no second Start click required —
   *  gets a real retry instead of a replay of the same stale failure. */
  private ensurePrepared(pair: TranslationLangPair): Promise<void> {
    if (!this.prepared) {
      this.prepared = (async () => {
        const invoke = await getInvoke();
        const generation = await invoke<number>("system_translate_prepare", {
          source: pair.source,
          target: pair.target,
        });
        // S1 fix: stash the generation this call warmed (or reused) so a
        // LATER stopSystemTranslator() call can scope its kill to it —
        // see lastDesktopTranslateGeneration's own doc comment above.
        if (typeof generation === "number") lastDesktopTranslateGeneration = generation;
      })();
      // Evict only if this exact promise is still the cached one. A
      // mid-meeting pair change clears `prepared` and installs a new
      // one; without the identity check, the OLD promise's late
      // rejection would then evict its healthy replacement.
      const inflight = this.prepared;
      inflight.catch(() => {
        if (this.prepared === inflight) this.prepared = null;
      });
    }
    return this.prepared;
  }

  async translate(
    items: TranslateRequest["segments"],
    lang: string,
  ): Promise<TranslateResponse["translations"]> {
    const previousPair = this.lastPair;
    if (!previousPair) {
      throw new SystemTranslatorUnavailableError("unavailable", "系统翻译未就绪");
    }
    // Refresh from live settings (when resolveTranslationProvider wired
    // one in — see the constructor's own doc) rather than trusting
    // whatever prepare() captured at Start: a mid-meeting
    // explainLanguage/language edit must self-heal on the very next
    // batch, not throw '系统翻译未就绪' for the rest of the meeting.
    const pair = this.getSettings ? langPairFromSettings(this.getSettings()) : previousPair;
    if (pair.target !== lang) {
      throw new SystemTranslatorUnavailableError("unavailable", "系统翻译未就绪");
    }
    if (pair.source !== previousPair.source || pair.target !== previousPair.target) {
      // The pair changed since the last call — whatever `prepared`
      // currently caches (ready OR still-failing) belongs to the OLD
      // pair and must not be reused for this one.
      this.prepared = null;
    }
    this.lastPair = pair;

    try {
      await this.ensurePrepared(pair);
    } catch {
      throw new SystemTranslatorUnavailableError("unavailable", "系统翻译不可用");
    }

    return this.runNativeTranslate(items, pair, true);
  }

  /** The actual system_translate round trip + error classification,
   *  split out of translate() so the "no --translate child is running"
   *  branch below can retry it exactly ONCE through a fresh
   *  ensurePrepared() call — FT-11's second, aggravating latch: the Rust
   *  ready-timeout branch (systranslate.rs) can return Err WITHOUT
   *  killing the child, clearing the `running` slot while a healthy
   *  child sits registered, which is exactly the message system_
   *  translate throws next. `allowChildRetry` is false on the retry
   *  attempt itself, so a child that dies again immediately still fails
   *  fast instead of looping. */
  private async runNativeTranslate(
    items: TranslateRequest["segments"],
    pair: TranslationLangPair,
    allowChildRetry: boolean,
  ): Promise<TranslateResponse["translations"]> {
    let res: { id: string; text: string }[];
    try {
      const invoke = await getInvoke();
      res = await invoke<{ id: string; text: string }[]>("system_translate", {
        items,
        source: pair.source,
        target: pair.target,
      });
    } catch (err) {
      const message = errorMessage(err);
      if (allowChildRetry && message.includes("no --translate child is running")) {
        this.prepared = null;
        try {
          await this.ensurePrepared(pair);
        } catch {
          throw new SystemTranslatorUnavailableError("unavailable", "系统翻译不可用");
        }
        return this.runNativeTranslate(items, pair, false);
      }
      // "not-installed" (the language pair's model isn't downloaded on
      // this device) self-heals once the user downloads it — desktop
      // points at 系统设置 (no headless download trigger exists there
      // either); iOS has no 系统设置 equivalent for this at all, so it
      // points at the system 「翻译」App instead, the only place iOS
      // itself exposes a download for. Either way queue.ts's existing
      // "downloading" branch pauses+retries instead of giving up;
      // everything else (child dead, IPC failure, any other native
      // error) is treated as a flat unavailable. Deliberately NOT
      // retried like the child-dead case above — respawning cannot
      // install a missing language pack.
      if (message.includes("not-installed")) {
        throw new SystemTranslatorUnavailableError(
          "downloading",
          IS_IOS ? "系统翻译语言包未安装——请在系统「翻译」App 中下载该语言" : "系统翻译语言包未安装，下载中",
        );
      }
      throw new SystemTranslatorUnavailableError("unavailable", "系统翻译不可用");
    }

    // Map back by id, not by array position (defensive even though the
    // native side preserves order) — a missing id just leaves that ONE
    // item untranslated rather than failing the whole batch, same
    // failed-soft contract queue.ts already applies to the LLM route's
    // own partial responses.
    const byId = new Map(res.map((r) => [r.id, r.text]));
    const out: TranslateResponse["translations"] = [];
    for (const it of items) {
      const text = byId.get(it.id);
      if (text !== undefined) out.push({ id: it.id, text });
    }
    return out;
  }
}

/** Best-effort teardown of the native Apple-translate child — mirrors
 *  stt/osSpeech.ts's own invoke("stop_os_speech") idiom: safe/idempotent
 *  to call even when no system-translate child was ever spawned this
 *  meeting (translateEngine !== "system", or prepare() never ran), so
 *  callers don't need to track whether "system" was actually the
 *  resolved provider. No-op outside a desktop/iOS build (NATIVE_SYSTEM_
 *  TRANSLATE false).
 *
 *  S1 fix (v0.6 round-2 review): now RETURNS its promise (used to be
 *  `void`-only fire-and-forget) — useMeeting.ts's own teardown paths
 *  (runStopFlow/doStop) await it now, so a stop is fully applied before
 *  those flows move on. Passes lastDesktopTranslateGeneration along so
 *  the Rust side can scope the kill to the exact child this call was
 *  issued for — even awaited, the underlying invoke() can still resolve
 *  arbitrarily late relative to a BRAND NEW meeting's own prepare() (a
 *  slow IPC round trip, a caller that doesn't await this after all —
 *  the component-unmount cleanup below still can't, since React effect
 *  cleanups aren't async), so scoping by generation is what actually
 *  closes "a delayed stop from the previous meeting kills the next
 *  meeting's translator", not the await alone.
 *
 *  Scope (do NOT call this from just anywhere an engine.stop() happens
 *  to live): this provider — like translateQueueRef itself — is a
 *  per-MEETING resource, primed once by start()'s own prepare() call and
 *  otherwise untouched across a pause/resume cycle (resume() never
 *  re-resolves/re-primes a provider, even when it tears down and
 *  reattaches a FRESH STT engine instance — see resume()'s own
 *  kind-mismatch branch). So this belongs ONLY next to a genuine
 *  meeting-END teardown (useMeeting.ts's doStop()/runStopFlow(), plus
 *  the component-unmount safety net) — never next to pause()'s own
 *  teardown-pause engine.stop() call, which would permanently kill
 *  translation for the rest of a meeting the user only meant to pause. */
export function stopSystemTranslator(): Promise<void> {
  if (!NATIVE_SYSTEM_TRANSLATE) return Promise.resolve();
  return (async () => {
    try {
      const invoke = await getInvoke();
      await invoke("system_translate_stop", { generation: lastDesktopTranslateGeneration });
    } catch {
      // best-effort — mirrors osSpeech.ts/appAudio.ts's own stop_* calls
    }
  })();
}

// ---------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------

/** Startup warm-up (v0.6 round-2 review, HIGH-1 fix): warms
 *  systemProbeCache (memory-only) at app launch so TranslationEngineRow's
 *  own Settings-row hint (and store.ts's runTranslateEngineMigration) has
 *  a cached answer ready the first time either reads it, rather than
 *  only ever being warmed by TranslationEngineRow's own mount effect —
 *  which never fires unless the user opens Settings first (SettingsDialog.tsx's
 *  own `if (!open) return null` gate). resolveTranslationProvider itself no
 *  longer reads this cache at all (see that function's own doc comment —
 *  the privacy taste-veto fix means it never conditions the returned
 *  provider on probe state), so this is purely a UI-hint/migration warm-up
 *  now, not a resolution-correctness one. Called once from page.tsx's own
 *  mount effect, right after hydrate() resolves. Fire-and-forget, same
 *  posture as every other startup probe in that effect (checkAppUpdate/
 *  initIos) — a failed/slow probe changes nothing here. */
export function warmSystemTranslateProbeForStartup(settings: Settings): void {
  if (NATIVE_SYSTEM_TRANSLATE && settings.translateEngine === "system") {
    void probeSystemTranslateSupport(langPairFromSettings(settings));
  }
}

/** settings.translateEngine==="system" ALWAYS resolves to the system-kind
 *  provider for this platform now — NATIVE_SYSTEM_TRANSLATE (desktop macOS
 *  26+ OR iOS) -> DesktopSystemTranslationProvider, otherwise ->
 *  ChromeTranslatorProvider (plain web). This used to gate the native
 *  branch on a cached system_translate_probe (osSupported/status), falling
 *  back to LlmTranslationProvider on a cold or negative cache — a flagged
 *  privacy taste-veto, closed deliberately (v0.7 wave 2A): a user who
 *  opted into on-device-only translation must never have that silently
 *  swapped for a cloud LLM call. A genuinely unsupported/still-priming
 *  system translator now surfaces through SystemTranslatorUnavailableError
 *  once translate() actually runs instead (both provider classes above
 *  already throw it when there's no ready session/native child — see their
 *  own translate() methods), and queue.ts's existing pause+self-heal branch
 *  for that error (SYSTEM_UNAVAILABLE_PAUSE_MS, unchanged) handles it the
 *  same way a cold cache used to be papered over. The system_translate_probe
 *  cache itself is unaffected by this — TranslationEngineRow's own hint and
 *  store.ts's runTranslateEngineMigration still read/warm it, just no longer
 *  this function. Takes a live getter (not a settings snapshot) so the
 *  constructed LlmTranslationProvider/DeepLTranslationProvider keep reading
 *  FRESH settings on every batch, same as before this abstraction existed;
 *  the provider KIND itself is decided once, here, matching how engine kind
 *  is already frozen for a session (useMeeting.ts's attachEngine). */
export function resolveTranslationProvider(getSettings: () => Settings): TranslationProvider {
  const settings = getSettings();
  if (settings.translateEngine === "system") {
    // getSettings passed straight through so DesktopSystemTranslationProvider
    // can notice a mid-meeting explainLanguage/language change and
    // re-prepare (FT-11 fix — see that class's own constructor doc).
    // ChromeTranslatorProvider needs no equivalent: its own translate()
    // already reads whatever pair prepare() most recently primed the
    // module-level session cache for, keyed by pairKey, not a fixed field.
    return NATIVE_SYSTEM_TRANSLATE
      ? new DesktopSystemTranslationProvider(getSettings)
      : new ChromeTranslatorProvider();
  }
  if (settings.translateEngine === "deepl") {
    return new DeepLTranslationProvider(getSettings);
  }
  if (settings.translateEngine === "youdao") {
    return new YoudaoTranslationProvider(getSettings);
  }
  return new LlmTranslationProvider(getSettings);
}
