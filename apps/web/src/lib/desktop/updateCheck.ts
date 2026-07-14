// S10 field-fix #8 — update check v1: an on-demand (drawer button +
// quiet first-open) check against the GitHub releases API, NOT an
// auto-installer (tauri-plugin-updater needs its own minisign keypair +
// latest.json pipeline — queued as later infra, see the blueprint's #8
// row). Own small zustand store, mirroring registry.ts's plain
// `create(() => ({...}))` shape — session-scoped, no persist middleware
// — deliberately NOT store.ts's own persisted-Settings shape (that file
// stays untouched by this task). Named checkAppUpdate (not checkUpdates)
// to avoid colliding with SettingsDialog's existing, unrelated
// checkUpdates() dictionary-source refresher.
//
// Pure-core/IS_DESKTOP-guarded-wrapper split mirrors audiocapCaps.ts's
// own probeCapabilitiesWith/probeAudiocapCaps precedent: checkAppUpdate
// WithDeps takes every effectful dependency injected (fetch + the
// version getter), so it's directly unit-testable with fakes; checkApp
// Update() is the thin real entry point, IS_DESKTOP-gated so a web
// build never calls getAppVersion() (which throws synchronously outside
// a desktop build, per tauriApi.ts's own contract) or reaches the
// network.

import { create } from "zustand";
import { IS_DESKTOP } from "../platform/desktop";
import { getAppVersion } from "./tauriApi";

const RELEASES_URL = "https://api.github.com/repos/mianaz/jargonslayer/releases/latest";
const ETAG_CACHE_KEY = "js-update-etag-cache";

export type UpdateCheckStatus = "idle" | "checking" | "current" | "available" | "error";

export interface UpdateCheckState {
  status: UpdateCheckStatus;
  currentVersion: string;
  latestVersion?: string;
  url?: string;
  checkedAt?: number;
}

export const useUpdateCheck = create<UpdateCheckState>(() => ({
  status: "idle",
  currentVersion: "",
}));

interface ReleaseCache {
  etag: string;
  version: string;
  url: string;
}

/** Best-effort ETag+body cache, mirrors lib/theme/displayStorage.ts's
 *  own try/catch-everywhere convention (localStorage can throw in
 *  private browsing / with storage disabled) — a cache miss/failure
 *  just means the next check pays for a full 200 instead of a 304,
 *  never a hard failure. */
function readCache(): ReleaseCache | null {
  try {
    const raw = window.localStorage.getItem(ETAG_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReleaseCache> | null;
    if (
      !parsed ||
      typeof parsed.etag !== "string" ||
      typeof parsed.version !== "string" ||
      typeof parsed.url !== "string"
    ) {
      return null;
    }
    return { etag: parsed.etag, version: parsed.version, url: parsed.url };
  } catch {
    return null;
  }
}

function writeCache(cache: ReleaseCache): void {
  try {
    window.localStorage.setItem(ETAG_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // non-fatal — see readCache's own doc comment
  }
}

/** Tolerant semver-ish compare, major.minor.patch only: strips a
 *  leading v/V (git tags here are "v0.4.2"; getAppVersion() returns the
 *  bare "0.4.1" form) and any -prerelease/+build suffix, treats
 *  missing/non-numeric components as 0 rather than throwing/NaN-ing —
 *  a malformed tag must degrade to "not newer", never crash the check.
 *  Returns >0 when `a` is newer than `b`, <0 when older, 0 when equal
 *  down to the triple. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const core = v.trim().replace(/^[vV]/, "").split(/[-+]/)[0];
    const parts = core.split(".");
    const at = (i: number): number => {
      const n = Number.parseInt(parts[i] ?? "", 10);
      return Number.isFinite(n) ? n : 0;
    };
    return [at(0), at(1), at(2)];
  };
  const [aMajor, aMinor, aPatch] = parse(a);
  const [bMajor, bMinor, bPatch] = parse(b);
  if (aMajor !== bMajor) return aMajor - bMajor;
  if (aMinor !== bMinor) return aMinor - bMinor;
  return aPatch - bPatch;
}

interface GithubRelease {
  tag_name: string;
  html_url: string;
}

export interface CheckAppUpdateDeps {
  fetchImpl: typeof fetch;
  getVersion: () => Promise<string>;
}

/** Pure(-ish) core — see this module's own header comment. Never
 *  throws: every failure (network, non-ok/non-304 status, malformed
 *  JSON, `getVersion()` itself rejecting) lands the store on
 *  status:"error", preserving whatever currentVersion/latestVersion/url
 *  a PRIOR successful check already found rather than blanking them. */
export async function checkAppUpdateWith(deps: CheckAppUpdateDeps): Promise<void> {
  useUpdateCheck.setState({ status: "checking" });
  try {
    const currentVersion = await deps.getVersion();
    const cache = readCache();
    const headers: Record<string, string> = {};
    if (cache?.etag) headers["If-None-Match"] = cache.etag;

    const res = await deps.fetchImpl(RELEASES_URL, { headers });

    let latestVersion: string;
    let url: string;
    if (res.status === 304 && cache) {
      latestVersion = cache.version;
      url = cache.url;
    } else if (res.ok) {
      const body = (await res.json()) as GithubRelease;
      latestVersion = body.tag_name;
      url = body.html_url;
      const etag = res.headers.get("etag");
      if (etag) writeCache({ etag, version: latestVersion, url });
    } else {
      throw new Error(`更新检查请求失败（${res.status}）`);
    }

    useUpdateCheck.setState({
      status: compareVersions(latestVersion, currentVersion) > 0 ? "available" : "current",
      currentVersion,
      latestVersion,
      url,
      checkedAt: Date.now(),
    });
  } catch {
    useUpdateCheck.setState((s) => ({ ...s, status: "error" }));
  }
}

/** The real entry point — TaskCenterDrawer's 重新检查 button and its own
 *  quiet first-open effect. IS_DESKTOP-gated no-op on a web build (never
 *  calls getAppVersion(), never reaches the network) — see this
 *  module's own header comment. */
export function checkAppUpdate(): Promise<void> {
  if (!IS_DESKTOP) return Promise.resolve();
  return checkAppUpdateWith({ fetchImpl: fetch, getVersion: getAppVersion });
}
