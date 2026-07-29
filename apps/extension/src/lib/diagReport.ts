// Beta-phase diagnostics audit item 2 — gives diag.ts's ring buffer its
// first real reader: a minimal Markdown bundle for the side panel's
// 复制诊断 action (sidepanel/main.ts). Extension analog of
// apps/web/src/lib/diag/report.ts, trimmed to what THIS app actually
// has: no Settings object at all (no apiKey/provider/baseUrl config —
// see storage/remotePacks.ts's own header, "this app's settings
// surface is deliberately much simpler than SettingsDialog's"), so the
// "settings snapshot" here is the installed-dict-pack sources instead.
//
// redactByKeyShape below is a PORT (not an import) of report.ts's own
// two shape rules (secret-shaped key -> presence+length only,
// url-shaped key -> origin only) — genuinely minimal, not the full
// redactSettingsObject policy (no recursion, no array/object-field
// collapsing, no （默认） tagging: none of that has a real field to
// apply to here). Not imported directly because report.ts pulls in
// apps/web's own Settings type + PREVIEW_TIER/pkg wiring, none of which
// exist in this app; @jargonslayer/core carries no DOM/report-shaped
// code today and shouldn't gain any just for this (see this file's own
// task report for the "shared-code opportunity" note).
//
// PRIVACY RULE (same contract as diag.ts's own ring buffer): nothing
// here ever includes transcript/translation content — diagLog callers
// are responsible for that at their own call sites; this module only
// ever reads the buffer back, never writes to it.

import pkg from "../../package.json";
import { type DiagEntry, getDiagEntries } from "./diag";
import { getAllPacks } from "@jargonslayer/core/detect/packs";
import { listPackSources } from "../storage/remotePacks";

export const DIAG_REPORT_ENTRIES = 50;

const SECRET_KEY_RE = /token|key|secret|password/i;
const URL_KEY_RE = /url$/i;
const UNPARSEABLE_URL_MARKER = "(无法解析的地址，已隐去)";

function capitalizeFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** Redacts one FLAT object by key NAME/VALUE SHAPE — see this file's
 *  header for why this is a minimal port of report.ts's own policy
 *  rather than an import of it. A secret-shaped key (matches
 *  SECRET_KEY_RE) collapses to `has<Key>: boolean` + `<key>Chars: n`,
 *  never its value. A url-shaped key (name ends in "url") keeps only
 *  `new URL(value).origin` — path/query/userinfo dropped by construction,
 *  same as report.ts's sanitizeUrl; an unparseable value collapses to
 *  the literal marker, never the raw string. Everything else (this
 *  app's own packId/count fields, etc.) passes through verbatim. */
export function redactByKeyShape(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && SECRET_KEY_RE.test(key)) {
      out[`has${capitalizeFirst(key)}`] = value.length > 0;
      out[`${key}Chars`] = value.length;
      continue;
    }
    if (typeof value === "string" && URL_KEY_RE.test(key)) {
      try {
        out[key] = new URL(value).origin;
      } catch {
        out[key] = UNPARSEABLE_URL_MARKER;
      }
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Pure — takes already-fetched pack sources (no IndexedDB access of
 *  its own) so it stays unit-testable without a real indexedDB global,
 *  same "gather in the async orchestrator, redact/build in a pure
 *  function" split report.ts's own buildFullConfigSnapshot(settings)
 *  established (settings there is likewise already-available, never
 *  fetched by the builder itself). Narrowed to just the two fields this
 *  function actually reads (a real RemotePackSource satisfies this
 *  structurally) rather than the full RemotePackSource/LoadedRemotePack
 *  shape, so a test can pass a minimal literal without constructing an
 *  entire fake manifest. */
export function buildSettingsSnapshot(
  sources: readonly { url: string; pack: { id: string } }[],
  builtinPackCount: number,
): Record<string, unknown> {
  return {
    builtinPackCount,
    installedPackCount: sources.length,
    installedPacks: sources.map((s) => redactByKeyShape({ url: s.url, packId: s.pack.id })),
  };
}

function formatEntry(e: DiagEntry): string {
  const time = new Date(e.ts).toISOString();
  const detailPart = e.detail ? ` — ${e.detail}` : "";
  return `- ${time} [${e.level}] (${e.tag}) ${e.message}${detailPart}`;
}

/** Markdown-ish text — pure, built entirely from already-gathered
 *  inputs (no chrome/navigator/IndexedDB access of its own), mirrors
 *  report.ts's buildDiagnosticReport(settings) shape. */
export function buildDiagnosticReport(
  version: string,
  ua: string,
  settingsSnapshot: Record<string, unknown>,
): string {
  const entries = getDiagEntries().slice(-DIAG_REPORT_ENTRIES);
  const lines = [
    "# JargonSlayer Lite 诊断信息",
    "",
    `版本: ${version}`,
    `浏览器: ${ua}`,
    "",
    "## 设置快照（已脱敏）",
    "```json",
    JSON.stringify(settingsSnapshot, null, 2),
    "```",
    "",
    `## 最近 ${entries.length} 条诊断记录`,
    ...(entries.length > 0 ? entries.map(formatEntry) : ["（暂无记录）"]),
  ];
  return lines.join("\n");
}

/** Extension version — chrome.runtime.getManifest().version when a real
 *  extension context exists (manifest.config.ts's own `version: pkg
 *  .version`, so this and the fallback below always agree), falling
 *  back to package.json's version under vitest/node (no chrome global
 *  there — see this app's vitest.config.ts header) so this function
 *  stays callable in a unit test without stubbing chrome. */
function currentVersion(): string {
  if (typeof chrome !== "undefined" && chrome.runtime?.getManifest) {
    return chrome.runtime.getManifest().version;
  }
  return pkg.version;
}

/** Full gather-and-copy for the side panel's 复制诊断 action
 *  (sidepanel/main.ts) — the one impure orchestrator in this file:
 *  reads chrome.runtime/navigator, lists installed pack sources
 *  (IndexedDB), and writes the clipboard. Never throws — mirrors
 *  report.ts's copyDiagnosticReport contract exactly (resolves false on
 *  any failure, including an unavailable/denied Clipboard API), so the
 *  caller's own success/failure toast logic is identical. */
export async function copyDiagnosticReport(): Promise<boolean> {
  try {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "(no navigator)";
    const sources = await listPackSources();
    const builtinPackCount = getAllPacks().filter((p) => !p.remote).length;
    const snapshot = buildSettingsSnapshot(sources, builtinPackCount);
    const text = buildDiagnosticReport(currentVersion(), ua, snapshot);
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // permission denied / unsupported / IDB failure — caller surfaces failure
  }
  return false;
}
