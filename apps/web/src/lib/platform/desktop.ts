// v0.4 S3 (docs/design-explorations/s3-tauri-uv-blueprint.md, architecture
// decision 5) — desktop-context flag: true only in a Tauri desktop build
// (BUILD_TARGET=desktop, see next.config.mjs's `env` block), false in
// every ordinary web build. Read via a build-time NEXT_PUBLIC_DESKTOP var
// rather than a runtime check like `window.__TAURI__` for two reasons:
// the Tauri v2 runtime global is actually `__TAURI_INTERNALS__` (an
// undocumented implementation detail, fragile to depend on), and a
// build-time flag lets webpack/Terser tree-shake `@tauri-apps/*` imports
// out of the web bundle entirely wherever this is statically false,
// instead of shipping that code dead-but-present. See src/lib/agent/
// localHost.ts's SUBSCRIPTION_DIRECT_BUILT comment for the cross-module-
// inlining caveat on how reliable that elimination is at any GIVEN call
// site (this const's own RUNTIME value is unconditionally correct either
// way — bundle-text elimination at a given usage is a separate, weaker
// guarantee callers should verify themselves the same way that comment
// documents).
export const IS_DESKTOP = process.env.NEXT_PUBLIC_DESKTOP === "1";
