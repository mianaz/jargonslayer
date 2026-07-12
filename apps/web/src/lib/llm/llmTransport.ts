// v0.4 S2 (PLAN-v0.4 §1A/§4) — client-side LLM transport: the fetch
// implementation the client-side callProvider path issues provider
// requests through, plus the feature flag that decides whether
// detect/define/translate/summarize even USE that path at all.
//
// Two independent concerns, deliberately kept in one small file since
// S3 (Tauri) needs to touch both at once:
//
// 1. Transport injection point. Default = the platform's global fetch.
//    S3's Tauri shell registers tauri-plugin-http's fetch here ONCE at
//    app init (`setTransport(tauriFetch)`) so every client-side
//    provider call (Anthropic direct + openai-compat direct, see
//    clientProvider.ts/providerCore.ts) transparently goes through it
//    instead — native fetch, bypasses CORS uniformly (PLAN-v0.4 §1A).
//    S2 itself adds NO tauri dependency; this is only the documented
//    registration point S3 will use.
// 2. The ON/OFF flag deciding whether lib/llm/client.ts's *Api
//    functions use the client-side path at all. Default OFF (mirrors
//    deployTier.ts's PREVIEW_TIER pattern: a plain NEXT_PUBLIC_* build
//    var, explicitly defaulted in next.config.mjs's `env` block so an
//    unset var is still reliably build-time-inlinable — see that
//    file's own comment on why DefinePlugin needs the var PRESENT, not
//    just falsy-by-absence). With the flag off, client.ts's *Api
//    functions behave exactly as they did before S2 — the existing
//    /api/* Next.js routes serve every call, unchanged.

/** Fetch-shaped — matches the global `fetch` signature exactly so
 *  tauri-plugin-http's `fetch` (a drop-in Fetch API implementation)
 *  satisfies this type with no adapter needed. */
export type Transport = typeof fetch;

// Wrapped in a closure (not `let activeTransport: Transport = fetch;`)
// so the default always resolves the CURRENT global `fetch` binding at
// call time rather than capturing whatever it pointed to at module-load
// time — required for existing tests' `vi.stubGlobal("fetch", mock)`
// convention to keep working transparently through this indirection.
let activeTransport: Transport = (...args) => fetch(...args);

/** S3's registration point: call once during Tauri app init with
 *  tauri-plugin-http's fetch. Every subsequent client-side provider
 *  call (any provider, any task) routes through it. */
export function setTransport(transport: Transport): void {
  activeTransport = transport;
}

/** The Transport every client-side provider call currently issues
 *  requests through — resolved fresh at each call site (never cached
 *  by a caller) so a setTransport call always takes effect immediately. */
export function getTransport(): Transport {
  return activeTransport;
}

/** Test helper — restores the platform-fetch default. Mirrors
 *  client.ts's resetSubscriptionToastLatch pattern for module-level
 *  state that must not leak between independent `it()` blocks. */
export function resetTransport(): void {
  activeTransport = (...args) => fetch(...args);
}

// ---------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------

const CLIENT_TRANSPORT_BUILD_FLAG = process.env.NEXT_PUBLIC_LLM_TRANSPORT === "client";

// Test-only override — bypasses the build-time env var so a test can
// flip client-transport on/off without a rebuild. `null` (the default)
// defers to the build-time flag. Documented programmatic override per
// the S2 design doc; mirrors resetSubscriptionToastLatch's role for
// SUBSCRIPTION_DIRECT_BUILT-adjacent module state.
let transportFlagOverride: boolean | null = null;

/** Set/clear the test-only override. Pass `null` to restore the
 *  build-time NEXT_PUBLIC_LLM_TRANSPORT default. */
export function setClientTransportOverride(value: boolean | null): void {
  transportFlagOverride = value;
}

/** True when lib/llm/client.ts's *Api functions should call the
 *  provider directly (this file's Transport) instead of the existing
 *  /api/* Next.js routes. Default OFF (process.env unset ->
 *  CLIENT_TRANSPORT_BUILD_FLAG false) — web's behavior is byte-
 *  identical to pre-S2 whenever this returns false. */
export function useClientTransport(): boolean {
  return transportFlagOverride ?? CLIENT_TRANSPORT_BUILD_FLAG;
}
