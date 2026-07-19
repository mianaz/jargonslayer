// S13 (docs/design-explorations/s13-ios-blueprint.md, §6 D4, normative)
// — iOS build-context flag, mirrors this directory's own desktop.ts
// (IS_DESKTOP) shape exactly: a build-time NEXT_PUBLIC_IOS var (set only
// for a BUILD_TARGET=ios build, see next.config.mjs's `env` block), not a
// runtime `window.__TAURI_INTERNALS__` check — same tree-shake rationale
// as IS_DESKTOP's own header comment (a build-time-inlinable literal lets
// webpack/Terser tree-shake `@tauri-apps/*` imports out of an ordinary
// web build entirely wherever this is statically false, instead of
// shipping that code dead-but-present).
//
// CRITICAL SEMANTICS (blueprint D4 — do not "fix" this by widening
// IS_DESKTOP instead): `IS_DESKTOP` means EXACTLY "macOS desktop shell"
// and MUST stay false on iOS — every sidecar/uv/wizard/diarization/
// model-management call site gated on it today (SettingsDialog's ~30
// sites, TaskCenterDrawer's 系统状态 zone, StatusLine's sidecarDownHint,
// DesktopUpdateBanner, ImportHub's transcription label, page.tsx's
// DesktopBootstrap mount + checkAppUpdate) correctly has no iOS
// equivalent in v1 and must go dark there, not light up. iOS must NOT
// flip IS_DESKTOP.
//
// `IS_TAURI` means "any Tauri shell, macOS desktop OR iOS" — the handful
// of call sites that only care whether native invoke/listen/fetch/opener
// are reachable at all (tauriApi.ts's runtime-API gate, the LLM
// setTransport bootstrap, openExternal.ts's native-opener gate) use this
// instead of IS_DESKTOP.
import { IS_DESKTOP } from "./desktop";

export const IS_IOS = process.env.NEXT_PUBLIC_IOS === "1";

/** Any Tauri shell — macOS desktop OR iOS. See this file's header
 *  comment for exactly which call sites belong on this vs. IS_DESKTOP
 *  alone. */
export const IS_TAURI = IS_DESKTOP || IS_IOS;
