// S10 field-fix (docs/design-explorations/s10-fieldfix-blueprint.md,
// Chunk A) — the ONE helper every desktop external link migrates to
// (this sprint's own wave-2 HANDOFF list covers every existing call
// site). WKWebView/wry cannot usefully navigate itself to an arbitrary
// `https://` URL (SettingsDialog.tsx's pre-S10 `window.location.href`
// dead-end — blueprint triage table item 2), so a Tauri build routes
// through the system browser via tauri-plugin-opener instead of the
// ordinary web new-tab open.
//
// S13 (docs/design-explorations/s13-ios-blueprint.md, §6 F6) — gate
// widened from `IS_DESKTOP` to `IS_TAURI`: the opener plugin is
// iOS-supported too (D3), registered on both platforms (Lane A), so an
// iOS build must route through it the same as desktop — `window.open`
// is a dead end inside WKWebView, the exact reason this helper exists
// in the first place.
//
// `openExternalWith` is the pure, fully-testable core (explicit
// `isTauri` + an injected opener factory) — mirrors store.ts's own
// applyPlatformEngineDefaults(settings, isDesktop) split, used for the
// identical reason: this repo's `IS_TAURI`/`IS_DESKTOP` are real
// import-time consts no test can flip (see store.test.ts's
// migrateSettings describe-block header comment for the same documented
// limitation). `openExternal` is the thin real-`IS_TAURI`/real-
// `getOpener` wrapper every actual call site uses.
import { getOpener, type OpenExternalFn } from "../desktop/tauriApi";
import { IS_TAURI } from "./ios";

export async function openExternalWith(
  url: string,
  isTauri: boolean,
  opener: () => Promise<OpenExternalFn>,
): Promise<void> {
  if (isTauri) {
    const open = await opener();
    await open(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

/** PINNED CONTRACT (S10 blueprint, widened by S13 §6 F6): every Tauri
 *  (desktop OR iOS) external link call site swaps to this. */
export function openExternal(url: string): Promise<void> {
  return openExternalWith(url, IS_TAURI, getOpener);
}
