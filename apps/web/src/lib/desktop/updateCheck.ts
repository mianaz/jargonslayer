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
//
// Field-fix #8 v2 (her ask, this round): the quiet on-launch check above
// used to fire unconditionally on every app start with no surfacing
// beyond TaskCenterDrawer's own 系统状态 row — field feedback was nobody
// opens that drawer to notice. This version adds (a) a 24h cadence gate
// + live-meeting skip for the quiet check (shouldCheckForAppUpdate/
// runAppUpdateAutoCheck, mirroring lib/detect/packAutoUpdate.ts's own
// shouldCheckForPackUpdates/runPackAutoUpdate shape exactly — same
// skew-tolerant "future lastCheckedAt counts as due" rule, same
// "recordCheckedAt fires on every ATTEMPT, never on a skip" contract),
// backed by a NEW persisted Settings.appUpdateCheckedAt (this store
// stays session-only, see this file's own header above) and (b) a
// dismissible AppUpdateBanner (components/AppUpdateBanner.tsx) —
// shouldShowUpdateBanner is this module's own pure gate for it,
// Settings.appUpdateDismissedVersion is the "remember this ONE version"
// persisted key. The manual TaskCenterDrawer 重新检查 button and the new
// SettingsDialog 检查更新 button both still just call checkAppUpdate()
// directly, bypassing the cadence gate entirely (spec: "the manual
// button always reports") — the gate only wraps the QUIET launch call.

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

// Shared status → zh label/color mapping — TaskCenterDrawer's own 系统状态
// update row, SettingsDialog's new 检查更新 row, and AppUpdateBanner all
// read the SAME copy rather than each hand-rolling their own (this used
// to be a TaskCenterDrawer-local const; hoisted here once a second
// consumer needed it).
export const UPDATE_STATUS_LABEL: Record<UpdateCheckStatus, { label: string; className: string }> = {
  idle: { label: "未检查", className: "text-mut" },
  checking: { label: "检查中…", className: "text-mut" },
  current: { label: "已是最新", className: "text-mut" },
  available: { label: "发现新版本", className: "text-lab-green" },
  error: { label: "检查失败", className: "text-warn-soft" },
};

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
  draft?: boolean;
  prerelease?: boolean;
}

// F9 (LOW, adversarial review): /releases/latest is documented to
// return only the latest non-draft/non-prerelease release, but this
// check must not blindly TRUST that endpoint semantics never change —
// a draft/prerelease response is explicitly ignored (see the res.ok
// branch below), and a tag_name is only ever trusted as latestVersion
// once it matches this strict vX.Y.Z shape (rejects e.g. "v0.4.2-rc1",
// "4x.1.0" — deliberately stricter than compareVersions' own tolerant
// parsing above, which exists for a different purpose: robustly
// comparing WHATEVER string it's handed, not deciding whether a raw
// GitHub tag is trustworthy enough to show/cache in the first place).
const RELEASE_TAG_RE = /^v?\d+\.\d+\.\d+$/;

export interface CheckAppUpdateDeps {
  fetchImpl: typeof fetch;
  getVersion: () => Promise<string>;
}

// Fix round v0.7.7 (F4a): a distinguishable marker for a GitHub
// rate-limit response (403/429) — thrown instead of the generic
// non-ok-status Error below so the catch block can tell "GitHub is
// throttling us" apart from every other failure shape (network down,
// malformed JSON, a draft/prerelease release, …). Only this ONE case
// feeds runAppUpdateAutoCheck's own "don't stamp appUpdateCheckedAt"
// decision (see checkAppUpdateWith's returned `rateLimited` below).
class GithubRateLimitedError extends Error {}

/** Pure(-ish) core — see this module's own header comment. Never
 *  throws: every failure (network, non-ok/non-304 status, malformed
 *  JSON, `getVersion()` itself rejecting) lands the store on
 *  status:"error" and reports `rateLimited:false` — UNLESS `quiet` is
 *  true, in which case (F4b fix, adversarial review) status is left
 *  exactly as it was found (never "error", never even the transient
 *  "checking") — a background/quiet check must never surface an alarm
 *  the user didn't ask for; a PRIOR successful check's own fields are
 *  preserved either way, quiet or not. `rateLimited:true` (F4a fix)
 *  additionally tells the caller this specific failure was GitHub
 *  actively throttling us (403/429) — see runAppUpdateAutoCheck's own
 *  doc for why that's treated as "not a completed check" rather than
 *  an ordinary failure. */
export async function checkAppUpdateWith(deps: CheckAppUpdateDeps, quiet = false): Promise<{ rateLimited: boolean }> {
  const previousState = useUpdateCheck.getState();
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
      // F9: neither ever reaches "available", nor gets cached — see
      // RELEASE_TAG_RE's own doc comment above.
      if (body.draft || body.prerelease) {
        throw new Error("最新 release 是草稿或预发布版本，本次跳过");
      }
      if (!RELEASE_TAG_RE.test(body.tag_name)) {
        throw new Error(`release tag 格式不合法：${body.tag_name}`);
      }
      latestVersion = body.tag_name;
      url = body.html_url;
      const etag = res.headers.get("etag");
      if (etag) writeCache({ etag, version: latestVersion, url });
    } else if (res.status === 403 || res.status === 429) {
      throw new GithubRateLimitedError(`更新检查请求被限流（${res.status}）`);
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
    return { rateLimited: false };
  } catch (err) {
    if (quiet) {
      useUpdateCheck.setState(previousState);
    } else {
      useUpdateCheck.setState((s) => ({ ...s, status: "error" }));
    }
    return { rateLimited: err instanceof GithubRateLimitedError };
  }
}

/** The real entry point — TaskCenterDrawer's 重新检查 button, SettingsDialog's
 *  检查更新 button (both unconditional, bypass the cadence gate below and
 *  pass no `quiet` — a manual click always reports, error included), and
 *  runAppUpdateAutoCheck's own `check` dep for the gated quiet launch
 *  check (which DOES pass `quiet:true` — see that function's own call
 *  site in page.tsx) plus TaskCenterDrawer's own quiet first-open effect
 *  (same reasoning, not user-clicked). IS_DESKTOP-gated no-op on a web
 *  build (never calls getAppVersion(), never reaches the network) — see
 *  this module's own header comment. */
export function checkAppUpdate(quiet = false): Promise<{ rateLimited: boolean }> {
  if (!IS_DESKTOP) return Promise.resolve({ rateLimited: false });
  return checkAppUpdateWith({ fetchImpl: fetch, getVersion: getAppVersion }, quiet);
}

// ---------------------------------------------------------------
// Field-fix #8 v2: 24h cadence gate for the quiet launch check —
// mirrors lib/detect/packAutoUpdate.ts's shouldCheckForPackUpdates/
// runPackAutoUpdate shape exactly (see this file's own header comment
// for why); no "enabled" toggle (this quiet check isn't opt-out, unlike
// packAutoUpdate) and no "hasInstalledPacks"-equivalent precondition.
// ---------------------------------------------------------------

export const APP_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ShouldCheckForAppUpdateInput {
  lastCheckedAt?: number;
  now: number;
}

/** Pure gate — true once >= APP_UPDATE_CHECK_INTERVAL_MS has elapsed
 *  since lastCheckedAt. A missing lastCheckedAt (never auto-checked
 *  before) counts as due immediately. Clock skew: a lastCheckedAt AHEAD
 *  of `now` must never wedge this permanently "not due" (same rationale
 *  as shouldCheckForPackUpdates' own doc comment) — treated as due right
 *  away instead of going negative and failing the interval compare
 *  forever. */
export function shouldCheckForAppUpdate(input: ShouldCheckForAppUpdateInput): boolean {
  if (input.lastCheckedAt === undefined) return true;
  if (input.lastCheckedAt > input.now) return true;
  return input.now - input.lastCheckedAt >= APP_UPDATE_CHECK_INTERVAL_MS;
}

export interface RunAppUpdateAutoCheckDeps {
  lastCheckedAt?: number;
  /** Defaults to Date.now() — overridable so a test (or a caller
   *  wanting one consistent `now` shared between the gate check and the
   *  recorded timestamp) doesn't race two separate clock reads. */
  now?: number;
  isMeetingActive: () => boolean;
  /** checkAppUpdate itself in the real caller (called as `() =>
   *  checkAppUpdate(true)` — see page.tsx's own call site — so quiet
   *  failures never surface status:"error"; F4b fix) — deliberately
   *  loose (`() => Promise<{ rateLimited: boolean } | void>` rather than
   *  importing CheckAppUpdateDeps, so a test can inject a bare fake
   *  without also faking fetch/getVersion; the `| void` keeps every
   *  pre-existing bare `async () => {}` test fake compiling unchanged. */
  check: () => Promise<{ rateLimited: boolean } | void>;
  recordCheckedAt: (checkedAt: number) => void;
}

/** The quiet launch check's own gate+run — page.tsx's hydrated-gated
 *  mount effect is the one real caller (constructs every dep from live
 *  settings/store state; see that effect's own comment for why it has
 *  to wait for hydration first). Never throws, by construction, same
 *  "checked:false on any skip, checked:true + recordCheckedAt on any
 *  actual attempt (success OR failure)" contract as runPackAutoUpdate —
 *  see that function's own doc for the full rationale — with ONE
 *  addition (F4a fix, adversarial review): a check() that reports
 *  `rateLimited:true` (GitHub 403/429) is treated as NOT a completed
 *  check either — recordCheckedAt is skipped so the NEXT launch retries
 *  instead of the transient throttle silently going quiet for the full
 *  24h cadence interval. */
export async function runAppUpdateAutoCheck(
  deps: RunAppUpdateAutoCheckDeps,
): Promise<{ checked: boolean }> {
  try {
    if (deps.isMeetingActive()) return { checked: false };
    const now = deps.now ?? Date.now();
    if (!shouldCheckForAppUpdate({ lastCheckedAt: deps.lastCheckedAt, now })) {
      return { checked: false };
    }
    let rateLimited = false;
    try {
      const result = await deps.check();
      rateLimited = result?.rateLimited ?? false;
    } catch (err) {
      // checkAppUpdate() itself already never throws (lands on
      // status:"error" internally) — this catch is only a last-resort
      // net for a test double or future change that doesn't hold that
      // contract.
      console.warn("[updateCheck] quiet check failed", err);
    }
    if (rateLimited) return { checked: false };
    try {
      deps.recordCheckedAt(now);
    } catch (err) {
      console.warn("[updateCheck] recordCheckedAt failed", err);
    }
    return { checked: true };
  } catch (err) {
    console.warn("[updateCheck] runAppUpdateAutoCheck unexpected failure", err);
    return { checked: false };
  }
}

// ---------------------------------------------------------------
// Field-fix #8 v2: non-nagging dismissible banner gate.
// ---------------------------------------------------------------

export interface ShouldShowUpdateBannerInput {
  status: UpdateCheckStatus;
  latestVersion?: string;
  dismissedVersion?: string;
}

/** Pure gate for AppUpdateBanner: shown only once an update is actually
 *  found, and only for a version the user hasn't already dismissed —
 *  dismissing remembers ONLY that exact tag, so a NEWER release found
 *  later (latestVersion !== dismissedVersion) shows the banner again. */
export function shouldShowUpdateBanner(input: ShouldShowUpdateBannerInput): boolean {
  return input.status === "available" && !!input.latestVersion && input.latestVersion !== input.dismissedVersion;
}
