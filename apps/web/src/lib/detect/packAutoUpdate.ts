// Round-2 dict-pack auto-update — installed dictionary packs used to
// only refresh when someone remembered to press SettingsDialog's own
// 词典源 「检查全部更新」 button. This module adds a quiet, once-a-day,
// online-gated background check that reuses that EXACT SAME update
// path (remotePacks.ts's checkUpdates()) — there is no second fetch/
// validate/persist mechanism here, only the gate deciding WHEN to call
// it and the glue recording when it last ran.
//
// Pure-core/effectful-deps-injected split, mirroring lib/desktop/
// updateCheck.ts's own checkAppUpdateWith(deps) precedent:
// shouldCheckForPackUpdates is a fully pure gate (no I/O, unit-tested
// directly with plain inputs); runPackAutoUpdate takes every side-
// effecting dependency injected (checkUpdates/isMeetingActive/
// recordCheckedAt) so it's directly testable with fakes, never a real
// fetch/IndexedDB/store. Constructing the REAL deps (remotePacks.ts's
// checkUpdates/listPackSources, the store's settings/status/
// updateSettings, navigator.onLine, diagLog) and actually wiring this
// into app startup is app/dictPackAutoUpdateTrigger.ts's job — this
// module stays a leaf with no app-internal imports of its own.

export const PACK_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ShouldCheckForPackUpdatesInput {
  enabled: boolean;
  online: boolean;
  lastCheckedAt?: number;
  now: number;
  hasInstalledPacks: boolean;
}

/** Pure gate — false when auto-update is off, the browser reports
 *  offline (navigator.onLine — advisory only; the real "offline"
 *  signal is a fetch failure inside checkUpdates() itself, which
 *  already handles that per-source, see runPackAutoUpdate below; this
 *  is just a cheap pre-filter), or nothing is installed to refresh
 *  (checkUpdates() itself already no-ops on zero sources, but gating
 *  here ALSO means a user who has never installed a remote pack never
 *  gets packAutoUpdateCheckedAt stamped at all). Otherwise true once
 *  >= PACK_UPDATE_INTERVAL_MS has elapsed since lastCheckedAt — a
 *  missing lastCheckedAt (never auto-checked before) counts as due
 *  immediately. */
export function shouldCheckForPackUpdates(input: ShouldCheckForPackUpdatesInput): boolean {
  if (!input.enabled || !input.online || !input.hasInstalledPacks) return false;
  if (input.lastCheckedAt === undefined) return true;
  // Clock skew: a lastCheckedAt AHEAD of `now` (the system clock moved
  // backward since the last check, or `now` itself is a slightly-stale
  // snapshot racing a fresh write) must never wedge this permanently
  // "not due" — the plain `now - lastCheckedAt >= INTERVAL` subtraction
  // goes negative in that case, which is always < INTERVAL, i.e. never
  // due again until the real clock catches up to the bogus future
  // value. Treat any future lastCheckedAt as due right away instead.
  if (input.lastCheckedAt > input.now) return true;
  return input.now - input.lastCheckedAt >= PACK_UPDATE_INTERVAL_MS;
}

export interface RunPackAutoUpdateDeps {
  enabled: boolean;
  online: boolean;
  lastCheckedAt?: number;
  hasInstalledPacks: boolean;
  /** Defaults to Date.now() — overridable so a test (or a single
   *  caller wanting one consistent `now` shared between the gate check
   *  and the recorded timestamp) doesn't race two separate clock
   *  reads. */
  now?: number;
  isMeetingActive: () => boolean;
  checkUpdates: () => Promise<string[]>;
  recordCheckedAt: (checkedAt: number) => void;
}

export interface PackAutoUpdateResult {
  checked: boolean;
  updated: string[];
  failed: number;
}

/** The actual once-a-day background refresh. Reuses checkUpdates()
 *  (remotePacks.ts) wholesale — never a second fetch/validate/persist
 *  path. Skips entirely (before even consulting
 *  shouldCheckForPackUpdates) while a meeting is live: refetching and
 *  swapping installed pack manifests mid-meeting would rebuild
 *  scanDictionary's regex caches right as live detection depends on
 *  them staying put.
 *
 *  Never throws, by construction: `checkUpdates()` and `recordCheckedAt`
 *  each get their OWN try/catch (so one failing can't stop the other,
 *  and a `recordCheckedAt` that itself throws while handling a
 *  `checkUpdates()` failure can't escape uncaught), and the whole body
 *  is additionally wrapped as a last-resort net against anything else
 *  unexpected (e.g. an injected `isMeetingActive` throwing).
 *  `recordCheckedAt` fires whenever an attempt is actually made
 *  (checked:true) — success OR failure alike, so a single
 *  persistently-dead source can't force a full re-check on every app
 *  launch forever — but never fires on a skip (checked:false), so a
 *  skip (disabled/offline/nothing installed/not due yet/a live
 *  meeting) never falsely starts the next interval's clock. */
export async function runPackAutoUpdate(deps: RunPackAutoUpdateDeps): Promise<PackAutoUpdateResult> {
  try {
    if (deps.isMeetingActive()) {
      return { checked: false, updated: [], failed: 0 };
    }
    const now = deps.now ?? Date.now();
    const due = shouldCheckForPackUpdates({
      enabled: deps.enabled,
      online: deps.online,
      lastCheckedAt: deps.lastCheckedAt,
      now,
      hasInstalledPacks: deps.hasInstalledPacks,
    });
    if (!due) {
      return { checked: false, updated: [], failed: 0 };
    }

    let updated: string[] = [];
    let failed = 0;
    try {
      updated = await deps.checkUpdates();
    } catch (err) {
      console.warn("[packAutoUpdate] checkUpdates failed", err);
      failed = 1;
    }
    // MEDIUM-2 fix (v0.6 round-2 review): re-checked AGAIN here, right
    // before stamping — deps.checkUpdates() itself can run for several
    // seconds (one fetch per installed source; see remotePacks.ts's own
    // checkUpdates, which independently re-checks a `shouldContinue`
    // right before its own write, protecting the registry-generation
    // bump specifically). This second check is what protects the STAMP:
    // an attempt that started mid-meeting-start must not stamp
    // packAutoUpdateCheckedAt, or the NEXT due-check (once the meeting
    // ends) would be robbed of its due-ness for a full
    // PACK_UPDATE_INTERVAL_MS. Bails the same shape as the entry-time
    // guard above — checked:false, nothing recorded.
    if (deps.isMeetingActive()) {
      return { checked: false, updated: [], failed: 0 };
    }
    try {
      deps.recordCheckedAt(now);
    } catch (err) {
      console.warn("[packAutoUpdate] recordCheckedAt failed", err);
    }
    return { checked: true, updated, failed };
  } catch (err) {
    console.warn("[packAutoUpdate] unexpected failure", err);
    return { checked: false, updated: [], failed: 0 };
  }
}
