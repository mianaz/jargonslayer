"use client";

// Auto-detected model dropdown fetch hook (#56 design Q2). Every
// caller must treat this as best-effort — the curated static
// DETECT_MODEL_OPTIONS/SUMMARY_MODEL_OPTIONS datalists in
// SettingsDialog.tsx stay the seed and the fallback; a successful
// fetch only AUGMENTS them. CORS is the load-bearing risk here (most
// providers besides Ollama/OpenRouter are expected to reject a
// browser-origin request outright) — a failure is a normal, quiet
// outcome, never a hard error surfaced to the user beyond a small
// inline status line (see SettingsDialog.tsx's CredentialFields).
//
// Fetch triggers (caller wires them via `enabled` + the returned
// `refresh()`):
//   - lazy on domain-block expand: caller passes enabled=true only
//     once the block is open (never on dialog open).
//   - debounced (~400ms) on provider/baseUrl change: this hook re-
//     fetches whenever `provider`/`baseUrl` change while enabled,
//     debounced so fast typing in the Base URL field doesn't fire a
//     request per keystroke.
//   - manual refresh: caller-invoked `refresh()`, which also clears
//     this pair's cache entry so a stale failure/result can't linger.
//
// Caching: module-level Map keyed `${provider}|${baseUrl}`, TTL ~10
// min. No IndexedDB persistence (Q6 scope cut) — this cache exists
// purely to avoid re-fetching every time a SettingsDialog remounts
// within the same page load; it is NOT meant to survive a reload.
import { useCallback, useEffect, useRef, useState } from "react";
import type { LlmProvider } from "../lib/types";

const CACHE_TTL_MS = 10 * 60 * 1000;
const DEBOUNCE_MS = 400;
const FETCH_TIMEOUT_MS = 6000;
// Stable, documented Anthropic Models API version — this hook never
// routes anthropic through a user baseUrl (Settings.baseUrl is
// "openai-compat only", see types.ts; the SDK itself hardcodes
// api.anthropic.com server-side too — see anthropic.ts).
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";

export type ProviderModelsStatus = "idle" | "loading" | "success" | "error";

interface CacheEntry {
  models: string[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(provider: LlmProvider, baseUrl: string): string {
  return `${provider}|${baseUrl}`;
}

interface RawModelsResponse {
  data?: { id?: string }[]; // OpenAI-compat + Anthropic both use this shape
}

/** OpenAI-compat `GET {baseUrl}/models` with `Authorization: Bearer`.
 *  URL-building mirrors anthropic.ts's server-side
 *  `${baseUrl.replace(/\/$/, "")}/chat/completions` convention exactly
 *  (same trailing-slash normalization, same base). Exported for direct
 *  unit testing — no hook-rendering harness exists in this repo (see
 *  __tests__/useProviderModels.test.ts). */
export async function fetchOpenAiCompatModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const res = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`models fetch failed (${res.status})`);
  const json = (await res.json()) as RawModelsResponse;
  return extractModelIds(json);
}

/** Anthropic `GET /v1/models` with `x-api-key` + `anthropic-version`. */
export async function fetchAnthropicModels(apiKey: string): Promise<string[]> {
  const res = await fetch(ANTHROPIC_MODELS_URL, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`models fetch failed (${res.status})`);
  const json = (await res.json()) as RawModelsResponse;
  return extractModelIds(json);
}

function extractModelIds(json: RawModelsResponse): string[] {
  if (!Array.isArray(json.data)) return [];
  return json.data
    .map((m) => (typeof m?.id === "string" ? m.id : null))
    .filter((id): id is string => !!id);
}

export interface UseProviderModelsResult {
  /** Fetched model ids, empty until a fetch has ever succeeded for
   *  this provider/baseUrl pair (including a cached prior success) —
   *  callers always merge this with their own curated static list, per
   *  the design's "fallback IS the primary UX" framing. */
  models: string[];
  status: ProviderModelsStatus;
  /** Small user-facing status line — "" when idle (nothing to say
   *  yet). Success: "✓ 已从提供方获取 N 个模型". Failure: quiet
   *  "无法自动获取模型列表，可手动输入". */
  message: string;
  /** Re-fetch NOW, bypassing (and clearing) the cache for this
   *  provider/baseUrl pair. Safe to call while a fetch is already in
   *  flight — the newest call wins (see the requestId guard below). */
  refresh: () => void;
}

/** Lazy + debounced + cached model-list fetch for one credential block
 *  (primary, or a #56 per-task domain override — this hook has no
 *  idea which). `enabled` gates every fetch (including the initial
 *  one) — pass `false` while the block is collapsed/unconfigured so
 *  nothing fires until the user actually opens it. */
export function useProviderModels(opts: {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}): UseProviderModelsResult {
  const { provider, baseUrl, apiKey, enabled } = opts;
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<ProviderModelsStatus>("idle");
  const [message, setMessage] = useState("");
  // Bumped on every fetch attempt (including refresh()) so a slower,
  // now-stale in-flight request can never clobber a newer one's result
  // — the classic "type fast, responses arrive out of order" race.
  const requestIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runFetch = useCallback(
    async (key: string, currentProvider: LlmProvider, currentBaseUrl: string, currentApiKey: string) => {
      const requestId = ++requestIdRef.current;
      setStatus("loading");
      try {
        const fetched =
          currentProvider === "anthropic"
            ? await fetchAnthropicModels(currentApiKey)
            : currentBaseUrl
              ? await fetchOpenAiCompatModels(currentBaseUrl, currentApiKey)
              : []; // openai-compat with no baseUrl yet — nothing to fetch, not an error
        if (requestId !== requestIdRef.current) return; // superseded by a newer request
        cache.set(key, { models: fetched, fetchedAt: Date.now() });
        setModels(fetched);
        if (fetched.length > 0) {
          setStatus("success");
          setMessage(`✓ 已从提供方获取 ${fetched.length} 个模型`);
        } else {
          // A 200 with zero usable ids (e.g. empty baseUrl skip above,
          // or a provider whose /models shape didn't match) is treated
          // the same as a fetch failure UX-wise — CORS/shape variance
          // across providers means "nothing came back" is common, not
          // exceptional (design Q2's "assume failure is the common
          // case").
          setStatus("error");
          setMessage("无法自动获取模型列表，可手动输入");
        }
      } catch {
        if (requestId !== requestIdRef.current) return;
        setStatus("error");
        setMessage("无法自动获取模型列表，可手动输入");
      }
    },
    [],
  );

  const fetchNow = useCallback(
    (bypassCache: boolean) => {
      if (!enabled) return;
      const key = cacheKey(provider, baseUrl);
      if (!bypassCache) {
        const cached = cache.get(key);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
          setModels(cached.models);
          setStatus(cached.models.length > 0 ? "success" : "error");
          setMessage(
            cached.models.length > 0
              ? `✓ 已从提供方获取 ${cached.models.length} 个模型`
              : "无法自动获取模型列表，可手动输入",
          );
          return;
        }
      } else {
        cache.delete(key);
      }
      void runFetch(key, provider, baseUrl, apiKey);
    },
    [enabled, provider, baseUrl, apiKey, runFetch],
  );

  // Lazy-on-enable + debounced-on-change: this single effect covers
  // both triggers from the design (they're the same code path — the
  // only difference is whether `enabled` just flipped true or
  // provider/baseUrl changed while already enabled). Debounced
  // uniformly so typing a Base URL doesn't fire on every keystroke.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!enabled) {
      setStatus("idle");
      setMessage("");
      return;
    }
    debounceRef.current = setTimeout(() => {
      fetchNow(false);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // apiKey deliberately excluded from the debounce trigger list per
    // the design ("debounced (~400ms) on provider/baseUrl change") —
    // a key edit alone doesn't refire; the user hits 刷新模型列表
    // (refresh()) once they've pasted a key, same as testConnection's
    // existing manual-trigger pattern elsewhere in Settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, provider, baseUrl]);

  const refresh = useCallback(() => {
    fetchNow(true);
  }, [fetchNow]);

  return { models, status, message, refresh };
}
