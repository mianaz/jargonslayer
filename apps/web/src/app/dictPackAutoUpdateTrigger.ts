// Round-2 dict-pack auto-update — page.tsx's actual startup/online-event
// wiring for lib/detect/packAutoUpdate.ts's runPackAutoUpdate, pulled
// into its own file for the SAME reason wizardHelpTransition.ts (this
// directory's own sibling) is: page.tsx has no component test harness
// in this repo (see that file's own header comment), so the "gather the
// real settings/online/meeting-active state, call runPackAutoUpdate,
// log the outcome, and guarantee a rejection from ANY of that can never
// escape as an unhandled promise rejection" glue needs to be directly
// testable on its own, with every dependency injected exactly like
// runPackAutoUpdate's own deps are. page.tsx's real call site supplies
// the real remotePacks.ts/store.ts bindings (both on its mount effect,
// once hydrated, and again on every browser "online" event); tests
// supply fakes. diagLog itself is imported directly here (not
// injected) — same posture lib/desktop/bootstrap.ts already uses for
// every one of its own diagLog calls, since diagLog never throws and
// tests can inspect its ring buffer directly (getDiagEntries()) instead
// of needing a mock.

import { diagLog } from "@/lib/diag/log";
import { runPackAutoUpdate, type PackAutoUpdateResult } from "@/lib/detect/packAutoUpdate";

export interface DictPackAutoUpdateTriggerDeps {
  getSettings: () => { packAutoUpdate: boolean; packAutoUpdateCheckedAt?: number };
  isOnline: () => boolean;
  isMeetingActive: () => boolean;
  /** Only `.length` is read — loosely typed so this file needs no
   *  import from remotePacks.ts of its own (stays a leaf, same posture
   *  as lib/detect/packAutoUpdate.ts's own header comment). */
  listPackSources: () => Promise<unknown[]>;
  checkUpdates: () => Promise<string[]>;
  recordCheckedAt: (checkedAt: number) => void;
}

function logResult(result: PackAutoUpdateResult): void {
  diagLog(
    "info",
    "dict-update",
    result.checked
      ? `词典自动更新检查完成，更新 ${result.updated.length} 个，失败 ${result.failed} 个`
      : "词典自动更新检查已跳过",
  );
}

/** Fire-and-forget entry point — page.tsx calls this as `void
 *  triggerDictPackAutoUpdate(realDeps)`, both once hydration settles
 *  and again on every "online" event. NEVER rejects, regardless of
 *  which injected dependency throws/rejects (listPackSources,
 *  getSettings, isOnline, isMeetingActive — runPackAutoUpdate's own
 *  checkUpdates/recordCheckedAt are already never-throw by
 *  construction, see that function's own doc), so a `void`-fired call
 *  here can never surface as an unhandled promise rejection. */
export async function triggerDictPackAutoUpdate(deps: DictPackAutoUpdateTriggerDeps): Promise<void> {
  try {
    const settings = deps.getSettings();
    let hasInstalledPacks = false;
    try {
      hasInstalledPacks = (await deps.listPackSources()).length > 0;
    } catch (err) {
      console.warn("[dictPackAutoUpdateTrigger] listPackSources failed", err);
    }
    const result = await runPackAutoUpdate({
      enabled: settings.packAutoUpdate,
      online: deps.isOnline(),
      lastCheckedAt: settings.packAutoUpdateCheckedAt,
      hasInstalledPacks,
      isMeetingActive: deps.isMeetingActive,
      checkUpdates: deps.checkUpdates,
      recordCheckedAt: deps.recordCheckedAt,
    });
    logResult(result);
  } catch (err) {
    console.warn("[dictPackAutoUpdateTrigger] failed", err);
  }
}
