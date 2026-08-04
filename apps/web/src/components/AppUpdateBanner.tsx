"use client";

// Field-fix #8 v2 — non-nagging update banner (desktop only). Mounted
// once in page.tsx, right beside RecoveryBanner (see that component's
// own header comment, updated alongside this one — it used to note
// there was no global-notice banner to mirror; now there is, and this
// one deliberately copies its flat border-b/bg-panel2 shell + text
// button styling rather than inventing a new visual language).
//
// All the actual "is there an update, has this version been dismissed"
// logic lives in lib/desktop/updateCheck.ts's shouldShowUpdateBanner —
// this component is just that gate plus the two actions: 打开下载页
// (openExternal, the SAME desktop-external-link helper every other
// call site already uses) and 忽略 (writes Settings.appUpdateDismissedVersion
// so THIS exact version never shows again, but a newer one still will).

import { IS_DESKTOP } from "@/lib/platform/desktop";
import { openExternal } from "@/lib/platform/openExternal";
import { useApp } from "@/lib/store";
import { shouldShowUpdateBanner, useUpdateCheck } from "@/lib/desktop/updateCheck";

export default function AppUpdateBanner() {
  const status = useUpdateCheck((s) => s.status);
  const latestVersion = useUpdateCheck((s) => s.latestVersion);
  const url = useUpdateCheck((s) => s.url);
  const dismissedVersion = useApp((s) => s.settings.appUpdateDismissedVersion);

  if (!IS_DESKTOP || !shouldShowUpdateBanner({ status, latestVersion, dismissedVersion })) {
    return null;
  }

  const handleDismiss = () => {
    useApp.getState().updateSettings({ appUpdateDismissedVersion: latestVersion });
  };

  return (
    <div
      data-testid="app-update-banner"
      className="flex flex-wrap items-center gap-3 border-b border-edge bg-panel2 px-4 py-2 text-sm text-fg"
    >
      <span>发现新版本 {latestVersion}</span>
      <div className="ml-auto flex items-center gap-2">
        {url && (
          <button
            type="button"
            data-testid="app-update-banner-open"
            onClick={() => void openExternal(url)}
            className="btn-tactile border border-edge px-2 py-0.5 font-mono text-xs text-act hover:bg-panel3"
          >
            打开下载页
          </button>
        )}
        <button
          type="button"
          data-testid="app-update-banner-dismiss"
          onClick={handleDismiss}
          className="btn-tactile px-2 py-0.5 font-mono text-xs text-mut hover:text-warn-soft"
        >
          忽略
        </button>
      </div>
    </div>
  );
}
