// Preview tier (#61) — hosted showroom build (apps.bioinfospace.com/
// jargonslayer): full UI stays visible, AI calls run on OUR own
// rate-limited server key (not the user's), and BYOK/sidecar-dependent
// affordances render greyed with a 「本地版功能」 badge instead of being
// removed — deliberate "show everything, no dead ends" posture, not a
// feature-probe-to-unlock experience. The default (unset) build is
// "full": everything enabled, BYOK inputs live, exactly today's
// behavior.
//
// Unlike NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT (which needs dead-code
// ELIMINATION at the JSX call site, and therefore reads
// process.env.NEXT_PUBLIC_X directly in SettingsDialog.tsx rather than
// a re-exported const — see src/lib/agent/localHost.ts's
// SUBSCRIPTION_DIRECT_BUILT comment for the full webpack/Terser
// cross-module-inlining caveat this works around), preview-tier
// greying only changes PRESENTATION (disabled attrs, badges, dropdown
// contents) — there's no security/compliance requirement that the
// BYOK markup's own TEXT be absent from the bundle, only that it
// render disabled at runtime. A plain re-exported const is fine here.
export const PREVIEW_TIER = process.env.NEXT_PUBLIC_DEPLOY_TIER === "preview";

// Preview-tier model allowlists (single source of truth for the
// Settings dropdowns — see SettingsDialog.tsx's detectModel/
// summaryModel selects). IDs must match the server's
// JARGONSLAYER_MODEL_ALLOWLIST env at deploy time, or a request for an
// unlisted model will be rejected server-side.
//
// Live paths (detect) deliberately EXCLUDE deepseek/deepseek-v4-pro:
// its measured detect median is 69.4s, unusable before the 25s client
// timeout (see llm/client.ts's PREVIEW_TIER branch). Summary is async
// (no live-UI budget), so pro is allowed there.
export const PREVIEW_LIVE_MODELS = [
  "minimax/minimax-m3",
  "deepseek/deepseek-v4-flash",
] as const;

export const PREVIEW_SUMMARY_MODELS = [
  "minimax/minimax-m3",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
] as const;

// Soniox preview lane (hosted trial, server-funded via /api/soniox/
// token — see that route's own header): a SECOND gate on top of
// PREVIEW_TIER, not a replacement for it, so the trial can be flipped
// on/off per-deploy independent of the tier switch itself. Presentation
// +routing gate ONLY — card selectability, coercion survival, mint-path
// wiring (SettingsDialog.tsx/store.ts/engineOptions.ts/stt/soniox.ts).
// If the flag is set but the deploy has no JARGONSLAYER_SONIOX_KEY, the
// runtime mint simply 404s (no_key) and the client surfaces an honest
// error — there is no security reliance on this flag being build-time
// (unlike a real credential, which never reaches the client either
// way). Also unlike SUBSCRIPTION_DIRECT_BUILT (lib/agent/localHost.ts),
// this build-time const has no Terser/webpack cross-module-inlining
// caveat to work around — see PREVIEW_TIER's own comment above for why
// that caveat doesn't apply here either (presentation-only gating, no
// dead-code-elimination requirement on any BYOK markup's own text).
export const SONIOX_PREVIEW_LANE =
  PREVIEW_TIER && process.env.NEXT_PUBLIC_SONIOX_PREVIEW === "1";
