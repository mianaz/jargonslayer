// S10 field-fix (docs/design-explorations/s10-fieldfix-blueprint.md,
// Chunk A) — the ONE helper every desktop external link migrates to
// (this sprint's own wave-2 HANDOFF list covers every existing call
// site). WKWebView/wry cannot usefully navigate itself to an arbitrary
// `https://` URL (SettingsDialog.tsx's pre-S10 `window.location.href`
// dead-end — blueprint triage table item 2), so a desktop build routes
// through the system browser via tauri-plugin-opener instead of the
// ordinary web new-tab open.
//
// `openExternalWith` is the pure, fully-testable core (explicit
// `isDesktop` + an injected opener factory) — mirrors store.ts's own
// applyPlatformEngineDefaults(settings, isDesktop) split, used for the
// identical reason: this repo's `IS_DESKTOP` is a real import-time
// const no test can flip (see store.test.ts's migrateSettings
// describe-block header comment for the same documented limitation).
// `openExternal` is the thin real-`IS_DESKTOP`/real-`getOpener` wrapper
// every actual call site uses.
import { getOpener, type OpenExternalFn } from "../desktop/tauriApi";
import { IS_DESKTOP } from "./desktop";

export async function openExternalWith(
  url: string,
  isDesktop: boolean,
  opener: () => Promise<OpenExternalFn>,
): Promise<void> {
  if (isDesktop) {
    const open = await opener();
    await open(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

/** PINNED CONTRACT (S10 blueprint): every desktop external link call
 *  site swaps to this in wave 2. */
export function openExternal(url: string): Promise<void> {
  return openExternalWith(url, IS_DESKTOP, getOpener);
}
