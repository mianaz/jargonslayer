// Diagnostic bundle a user can copy straight into a GitHub issue: app
// version + deploy tier + a FULL settings snapshot (see
// redactSettingsObject below — genuinely every Settings field, run
// through a generic redaction policy, not a curated allow-list) +
// browser UA + theme/uiMode + the last DIAG_REPORT_ENTRIES diag.ts
// ring-buffer entries.
//
// PRIVACY RULE: same hard rule as log.ts — this module trusts every
// diag entry it's handed was already scrubbed at its call site (no
// transcript/translation/summary/profile VALUES ever reach diagLog);
// its OWN scrubbing responsibility is Settings' key material, enforced
// below by redactSettingsObject (never spreads `settings` wholesale
// into the report unredacted — every field flows through the policy
// first).

import pkg from "../../../package.json";
import { PREVIEW_TIER } from "../deployTier";
import type { Settings } from "@jargonslayer/core/types";
import { type DiagEntry, getDiagEntries } from "./log";

export const DIAG_REPORT_ENTRIES = 50;

function hasSecret(v: string | undefined): boolean {
  return !!v;
}

function capitalizeFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------
// Generic settings redaction policy ("include FULL config in debug
// log" ask): every Settings key — present today or added later — is
// classified purely by its NAME and VALUE SHAPE, so a future field
// flows into the report automatically without this file needing an
// update. In order of precedence:
//
//  1. Secret-shaped key (name matches SECRET_KEY_RE, e.g. apiKey/
//     hfToken/agentToken/…, OR is hand-listed in EXTRA_SECRET_KEYS) →
//     collapses to `has<Key>: true|false` — the key is RENAMED, the
//     value NEVER included, not even its length.
//     - webhookUrl is hand-listed here despite not matching the name
//       pattern: n8n/飞书-style webhooks routinely embed the actual
//       capability token in the URL PATH itself (the URL *is* the
//       credential) — query-string stripping alone wouldn't catch
//       that. Matches history/autoExport.ts's stripKeyMaterial, which
//       treats it identically for the same reason.
//  2. URL-shaped key (name ends in "url", e.g. whisperUrl/agentUrl/
//     baseUrl) → included, but reduced to origin + (a "/…" marker for
//     any non-root path) — query string and userinfo are dropped too,
//     just implicitly (see sanitizeUrl below: it builds the result
//     from URL.origin, which never carries them in the first place).
//     A value that doesn't parse to a real host (even after a retried
//     "https://" prefix — codex v2 review finding F3, e.g. a
//     scheme-less "api.example.com/v1?api_key=...") collapses to the
//     literal marker "(无法解析的地址，已隐去)" — never the raw string.
//  3. Plain nested settings object (taskLlm's per-domain overrides,
//     profile) → recurse this SAME policy over its own keys, so a
//     nested apiKey/url is caught exactly like a top-level one.
//  4. Array of OBJECTS (a hypothetical future "list of user-authored
//     entries" field — no current Settings field is shaped this way)
//     → collapses to `<key>Count: N`, entries never included. An array
//     of PRIMITIVES (e.g. enabledPacks — short built-in pack ids, not
//     user-authored content) is short/enum-like and included verbatim.
//  5. Everything else (booleans, enums, numbers, plain non-secret/
//     non-url strings — model names, theme, language, uiMode, a mic
//     device id, …) → verbatim.
//
// `provider` keeps ONE explicit override after the generic pass (see
// buildFullConfigSnapshot below) — a pre-existing, security-reviewed
// fix (only names a real provider once a key is actually configured;
// otherwise the default "anthropic" reads as "configured" when
// nothing was). That behavior must stay exactly as it is; everything
// else here is genuinely generic.
// ---------------------------------------------------------------

const SECRET_KEY_RE = /token|key|secret|password/i;
// Hand-listed exceptions to the name-pattern rule above — see the
// policy doc's point 1 for webhookUrl's rationale.
const EXTRA_SECRET_KEYS = new Set(["webhookUrl"]);
const URL_KEY_RE = /url$/i;
// User-authored free text (profile self-descriptions today). Not
// secret, but mildly identifying and diagnostically worthless beyond
// "is it set and how long" — a copied report lands in public GitHub
// issues, so content stays out and only the char count ships
// (`industryChars: 12`). Name-based like everything else, so a future
// free-text field must be added here deliberately.
const FREE_TEXT_KEYS = new Set(["industry", "role", "familiarDomains", "weakDomains"]);

function isSecretShapedKey(key: string): boolean {
  return SECRET_KEY_RE.test(key) || EXTRA_SECRET_KEYS.has(key);
}

function isUrlShapedKey(key: string): boolean {
  return URL_KEY_RE.test(key);
}

// Never the raw value — codex v2 review finding F3's fallback for a
// URL-shaped setting that doesn't parse to a real host even after the
// "https://" retry below.
const UNPARSEABLE_URL_MARKER = "(无法解析的地址，已隐去)";

/** Parses `value` as an absolute URL with a genuine host. `new URL()`
 *  alone is too lenient for this purpose — e.g. a bare "localhost:8765"
 *  (a user dropping the scheme by habit) "successfully" parses as an
 *  OPAQUE url with scheme "localhost:" and NO host at all, rather than
 *  throwing — so a parse only counts here if it yields a non-empty
 *  `host`. Returns null on any failure. */
function parseHostedUrl(value: string): URL | null {
  try {
    const u = new URL(value);
    return u.host ? u : null;
  } catch {
    return null;
  }
}

/** Redacts a URL-shaped setting for the report — keeps just enough to
 *  recognize which endpoint is configured, never anything that could
 *  identify a specific account/credential embedded in it:
 *   - a scheme-less or otherwise-unparseable value (codex v2 review
 *     finding F3, e.g. a pasted "api.example.com/v1?api_key=sk-live")
 *     is retried once with an "https://" prefix — recovers the common
 *     "forgot the scheme" case instead of the old behavior of leaking
 *     the raw string wholesale. If parsing still can't produce a real
 *     host even after that retry, UNPARSEABLE_URL_MARKER stands in —
 *     the raw value is NEVER returned, not even partially.
 *   - once parsed, only the ORIGIN (scheme + host [+ port]) is kept
 *     verbatim, built from `URL.origin` itself — which by spec never
 *     carries userinfo/path/query/hash, so those are dropped simply by
 *     never using the full serialization. Any path beyond the bare
 *     root ("/") collapses to the literal "/…" marker instead of being
 *     kept: a path segment can itself embed a credential (e.g.
 *     "https://host/token/sk-live" — query-string stripping alone
 *     doesn't catch that). A bare root path needs no marker — the
 *     origin alone already says everything a root path would. */
function sanitizeUrl(value: string): string {
  if (!value) return value;
  const u = parseHostedUrl(value) ?? parseHostedUrl(`https://${value}`);
  if (!u) return UNPARSEABLE_URL_MARKER;
  return u.pathname && u.pathname !== "/" ? `${u.origin}/…` : u.origin;
}

/** Redacts one settings object generically, field by field, per the
 *  policy documented above. Recurses into plain nested objects
 *  (taskLlm's per-domain configs, profile) so a field added to either
 *  in the future is covered without this function changing. */
function redactSettingsObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      out[key] = value;
      continue;
    }
    if (typeof value === "string" && isSecretShapedKey(key)) {
      out[`has${capitalizeFirst(key)}`] = hasSecret(value);
      continue;
    }
    if (typeof value === "string" && isUrlShapedKey(key)) {
      out[key] = sanitizeUrl(value);
      continue;
    }
    if (typeof value === "string" && FREE_TEXT_KEYS.has(key)) {
      out[`${key}Chars`] = value.length;
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > 0 && typeof value[0] === "object" && value[0] !== null) {
        out[`${key}Count`] = value.length;
      } else {
        out[key] = value;
      }
      continue;
    }
    if (typeof value === "object") {
      out[key] = redactSettingsObject(value as Record<string, unknown>);
      continue;
    }
    // boolean / number / plain (non-secret, non-url) string -> verbatim
    out[key] = value;
  }
  return out;
}

/** Full, generically-redacted settings snapshot — every Settings field
 *  flows through redactSettingsObject above; `provider` gets ONE
 *  explicit override afterward (Item 5, pre-existing security-review
 *  fix — see the policy doc's own note): only names a real provider
 *  once a key is actually configured. An unconfigured client's own
 *  idle `settings.provider` never actually serves a request (the
 *  Next.js route falls back to its own server-managed credential when
 *  no key header is sent — see llm/client.ts's ctxProvider/taskHeaders
 *  and anthropic.ts's resolveLlmConfig); printing it unconditionally
 *  would read as "anthropic" next to hasApiKey:false on the
 *  server-managed preview tier — misleading, since "anthropic" was
 *  never chosen by anything, just the field's default value. */
function buildFullConfigSnapshot(settings: Settings): Record<string, unknown> {
  const redacted = redactSettingsObject(settings as unknown as Record<string, unknown>);
  redacted.provider = hasSecret(settings.apiKey) ? settings.provider : "(未配置)";
  return redacted;
}

function formatEntry(e: DiagEntry): string {
  const time = new Date(e.ts).toISOString();
  const refPart = e.ref ? ` [${e.ref}]` : "";
  const detailPart = e.detail ? ` — ${e.detail}` : "";
  return `- ${time} [${e.level}] (${e.tag})${refPart} ${e.message}${detailPart}`;
}

/** Markdown-ish text — no server round-trip, built entirely from
 *  in-memory state (settings + the diag ring buffer) so it's safe to
 *  call from a toast action or the Settings dialog alike. */
export function buildDiagnosticReport(settings: Settings): string {
  const entries = getDiagEntries().slice(-DIAG_REPORT_ENTRIES);
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "(no navigator)";

  const lines = [
    "# JargonSlayer 诊断信息",
    "",
    `版本: ${pkg.version}`,
    `部署层级: ${PREVIEW_TIER ? "preview" : "full"}`,
    `浏览器: ${ua}`,
    `主题: ${settings.themeId} · 界面模式: ${settings.uiMode}`,
    "",
    "## 完整配置（已脱敏，不含任何 Key/Token 明文）",
    "```json",
    JSON.stringify(buildFullConfigSnapshot(settings), null, 2),
    "```",
    "",
    `## 最近 ${entries.length} 条诊断记录`,
    ...(entries.length > 0 ? entries.map(formatEntry) : ["（暂无记录）"]),
  ];

  return lines.join("\n");
}

/** Clipboard write for the 复制诊断/复制诊断信息 actions (Toast.tsx,
 *  SettingsDialog.tsx) — one place for the writeText + failure
 *  handling so both callers behave identically. Returns false (never
 *  throws) when the Clipboard API is unavailable or permission was
 *  denied; the caller shows its own success/failure toast. */
export async function copyDiagnosticReport(settings: Settings): Promise<boolean> {
  const text = buildDiagnosticReport(settings);
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // permission denied / unsupported browser — caller surfaces failure
  }
  return false;
}
