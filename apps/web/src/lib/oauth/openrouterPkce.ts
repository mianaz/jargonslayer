// OpenRouter "Connect with OpenRouter" — OAuth PKCE one-click key
// provisioning (https://openrouter.ai/docs/use-cases/oauth-pkce).
// No client_id / pre-registration required per the docs; PKCE alone
// authenticates the exchange. The docs don't state whether the
// exchange endpoint is CORS-enabled for direct browser fetch, so this
// module calls it through a same-origin proxy route
// (/api/openrouter/exchange) instead of hitting openrouter.ai
// directly from the browser — see that route for the actual POST.

import { withBase } from "../basePath";

/** Authorization endpoint the browser is redirected to. */
export const AUTH_URL = "https://openrouter.ai/auth";

/** Code -> API key exchange endpoint (called server-side by the proxy
 *  route, never directly from the browser — see module comment). */
export const EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";

// sessionStorage keys shared between the "Connect with OpenRouter"
// button (SettingsDialog.tsx) and the OAuth callback page
// (src/app/oauth/openrouter/page.tsx) — the code_verifier and state
// must survive the full-page redirect round-trip, so they live in
// sessionStorage rather than React state or the persisted zustand
// store (which holds settings, not a transient auth handshake).
export const OAUTH_VERIFIER_STORAGE_KEY = "jargonslayer_openrouter_pkce_verifier";
export const OAUTH_STATE_STORAGE_KEY = "jargonslayer_openrouter_pkce_state";

const CODE_VERIFIER_MIN_LENGTH = 43;
const CODE_VERIFIER_MAX_LENGTH = 128;

// RFC 7636 unreserved charset (base64url-safe, no padding needed).
const VERIFIER_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/** Random PKCE code verifier, 43-128 chars from the RFC 7636 unreserved
 *  charset. Length picked at the high end of the allowed range for
 *  extra entropy margin. */
export function generateCodeVerifier(length = CODE_VERIFIER_MAX_LENGTH): string {
  const clamped = Math.min(
    CODE_VERIFIER_MAX_LENGTH,
    Math.max(CODE_VERIFIER_MIN_LENGTH, length),
  );
  const bytes = new Uint8Array(clamped);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < clamped; i++) {
    out += VERIFIER_CHARSET[bytes[i] % VERIFIER_CHARSET.length];
  }
  return out;
}

function base64UrlFromBytes(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let binary = "";
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** S256 code challenge: base64url(SHA-256(ascii(verifier))), no
 *  padding — the transform OpenRouter's /auth endpoint expects when
 *  code_challenge_method=S256. */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlFromBytes(digest);
}

export interface BuildAuthUrlOptions {
  callbackUrl: string;
  codeChallenge: string;
}

/** Builds the https://openrouter.ai/auth URL the browser is redirected
 *  to: callback_url (where OpenRouter sends the user back with
 *  ?code=...), code_challenge, and code_challenge_method=S256. */
export function buildAuthUrl({ callbackUrl, codeChallenge }: BuildAuthUrlOptions): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("callback_url", callbackUrl);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface ExchangeCodeForKeyOptions {
  code: string;
  codeVerifier: string;
}

export interface ExchangeCodeForKeyResult {
  key: string;
}

/** Exchanges the authorization `code` for a user-controlled OpenRouter
 *  API key. Goes through the same-origin proxy route rather than
 *  POSTing to EXCHANGE_URL directly (see module comment re: CORS). */
export async function exchangeCodeForKey({
  code,
  codeVerifier,
}: ExchangeCodeForKeyOptions): Promise<ExchangeCodeForKeyResult> {
  const res = await fetch(withBase("/api/openrouter/exchange"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      code_challenge_method: "S256",
    }),
  });

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error("兑换 API Key 失败：响应不是合法 JSON");
  }

  if (!res.ok) {
    const message =
      json && typeof json === "object" && "error" in json && typeof json.error === "string"
        ? json.error
        : `兑换 API Key 失败（${res.status}）`;
    throw new Error(message);
  }

  if (!json || typeof json !== "object" || typeof (json as { key?: unknown }).key !== "string") {
    throw new Error("兑换 API Key 失败：响应缺少 key 字段");
  }

  return { key: (json as { key: string }).key };
}

export interface ExchangeCodeForKeyDirectOptions {
  code: string;
  codeVerifier: string;
  /** Desktop's own tauri-plugin-http fetch (native, bypasses CORS
   *  uniformly) — see this function's own doc comment for why desktop
   *  calls EXCHANGE_URL directly instead of going through
   *  exchangeCodeForKey's same-origin proxy route. */
  fetchImpl: typeof fetch;
}

/** S10 field-fix (docs/design-explorations/s10-fieldfix-blueprint.md,
 *  Chunk A) — desktop-only ADDITIVE sibling of exchangeCodeForKey above,
 *  which stays byte-identical (this function never touches it, even to
 *  share parsing logic — the near-identical body below is a deliberate
 *  duplication, not an oversight). POSTs DIRECTLY to EXCHANGE_URL
 *  instead of the same-origin `/api/openrouter/exchange` proxy route:
 *  the Q1 verdict found the proxy's own reason to exist (uncertain CORS
 *  for a plain browser `fetch` — see this module's header comment) moot
 *  for desktop, since desktop's Next build is a static export
 *  (`output: "export"`, no API routes exist to proxy through) and the
 *  injected `fetchImpl` (tauri-plugin-http's native fetch) bypasses
 *  CORS uniformly regardless. Body shape and response parsing mirror
 *  the proxy route's own forwarding (app/api/openrouter/exchange/
 *  route.ts) exactly, since that route is itself just a thin passthrough
 *  to this same EXCHANGE_URL. Returns the key STRING directly (unlike
 *  exchangeCodeForKey's `{ key }` wrapper) — openrouterDesktop.ts's own
 *  caller has no use for the extra wrapping. */
export async function exchangeCodeForKeyDirect({
  code,
  codeVerifier,
  fetchImpl,
}: ExchangeCodeForKeyDirectOptions): Promise<string> {
  const res = await fetchImpl(EXCHANGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      code_challenge_method: "S256",
    }),
  });

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error("兑换 API Key 失败：响应不是合法 JSON");
  }

  if (!res.ok) {
    const message =
      json && typeof json === "object" && "error" in json && typeof json.error === "string"
        ? json.error
        : `兑换 API Key 失败（${res.status}）`;
    throw new Error(message);
  }

  if (!json || typeof json !== "object" || typeof (json as { key?: unknown }).key !== "string") {
    throw new Error("兑换 API Key 失败：响应缺少 key 字段");
  }

  return (json as { key: string }).key;
}
