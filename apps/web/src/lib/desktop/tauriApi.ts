// v0.4 S3 chunk 5 (docs/design-explorations/s3-tauri-uv-blueprint.md,
// §Chunk 5) — the ONLY module in this app that ever imports
// `@tauri-apps/*`. Every import below is a DYNAMIC import() gated by a
// LITERAL `process.env.NEXT_PUBLIC_DESKTOP === "1"` check living in
// THIS SAME MODULE, directly beside each import() call — deliberately
// NOT the imported `IS_DESKTOP` re-export (src/lib/platform/
// desktop.ts). Per src/lib/agent/localHost.ts's own
// SUBSCRIPTION_DIRECT_BUILT comment: webpack/Terser's DefinePlugin +
// ConstPlugin dead-branch elimination reliably prunes a DIRECT
// `process.env.NEXT_PUBLIC_X === "1"` literal at the call site, but
// does NOT always achieve the same for a re-exported const imported
// across a module boundary. Keeping every `@tauri-apps/*` import out of
// the ordinary web bundle is this file's entire reason to exist
// (verified by chunk 5's tree-shake grep — see task report), so this is
// the one spot where that stronger guarantee is worth the small
// duplication against IS_DESKTOP's own definition — mirrors
// SettingsDialog.tsx's own choice to read process.env.NEXT_PUBLIC_X
// directly for the same reason. `IS_DESKTOP` itself stays the right
// import everywhere else (provisionRunner.ts, bootstrap.ts) since those
// files never write an `import()` of their own.
//
// Callers never import `@tauri-apps/*` themselves — they take
// invoke/listen/fetch as plain injected function values (see
// provisionRunner.ts's RunnerDeps / bootstrap.ts's BootstrapDeps), so
// unit tests exercise them with fakes and import zero Tauri, the same
// contract chunk 4's provisionMachine.ts/uvCommands.ts already
// established for the pure layer.
const DESKTOP_BUILD = process.env.NEXT_PUBLIC_DESKTOP === "1";

/** Matches `@tauri-apps/api/core`'s `invoke` signature closely enough
 *  for every command this app calls: Tauri auto-camelCases each Rust
 *  command's snake_case parameter names for the JS-side arg object (see
 *  uvCommands.ts's own DesktopPaths comment for the same conversion on
 *  return-value struct fields) — every caller here already accounts for
 *  that (e.g. `tailLines` for Rust's `tail_lines`). */
export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Matches `@tauri-apps/api/event`'s own Event<T> shape closely enough
 *  for this app's one consumer (uv://log) — trimmed to the fields
 *  callers actually read. */
export interface TauriEvent<T> {
  event: string;
  payload: T;
}

export type UnlistenFn = () => void;

/** Matches `@tauri-apps/api/event`'s `listen` signature. */
export type ListenFn = <T>(event: string, handler: (event: TauriEvent<T>) => void) => Promise<UnlistenFn>;

/** Matches the global `fetch` signature — `@tauri-apps/plugin-http`'s
 *  `fetch` is a drop-in Fetch API implementation, the same contract
 *  llmTransport.ts's own `Transport` type documents. */
export type TauriFetchFn = typeof fetch;

let invokePromise: Promise<InvokeFn> | null = null;
let listenPromise: Promise<ListenFn> | null = null;
let tauriFetchPromise: Promise<TauriFetchFn> | null = null;

/** Lazily imports `@tauri-apps/api/core` and resolves its `invoke`.
 *  Throws SYNCHRONOUSLY (before the import() is ever reached) outside a
 *  desktop build — see this file's header comment for why the guard
 *  must sit right here, not behind a shared helper call. */
export function getInvoke(): Promise<InvokeFn> {
  if (!DESKTOP_BUILD) {
    throw new Error("tauriApi.getInvoke: unavailable outside a desktop build (NEXT_PUBLIC_DESKTOP !== \"1\")");
  }
  if (!invokePromise) {
    invokePromise = import("@tauri-apps/api/core").then((mod) => mod.invoke as InvokeFn);
  }
  return invokePromise;
}

/** Lazily imports `@tauri-apps/api/event` and resolves its `listen` —
 *  provisionRunner.ts's uv://log subscription (run_uv/prewarm_model
 *  both emit it, see apps/desktop/src-tauri/src/uv.rs's emit_uv_log)
 *  goes through this. */
export function getListen(): Promise<ListenFn> {
  if (!DESKTOP_BUILD) {
    throw new Error("tauriApi.getListen: unavailable outside a desktop build (NEXT_PUBLIC_DESKTOP !== \"1\")");
  }
  if (!listenPromise) {
    listenPromise = import("@tauri-apps/api/event").then((mod) => mod.listen as unknown as ListenFn);
  }
  return listenPromise;
}

/** Lazily imports `@tauri-apps/plugin-http` and resolves its `fetch` —
 *  the S3 registration target for llmTransport.ts's `setTransport()`
 *  (see bootstrap.ts's initDesktop). */
export function getTauriFetch(): Promise<TauriFetchFn> {
  if (!DESKTOP_BUILD) {
    throw new Error("tauriApi.getTauriFetch: unavailable outside a desktop build (NEXT_PUBLIC_DESKTOP !== \"1\")");
  }
  if (!tauriFetchPromise) {
    tauriFetchPromise = import("@tauri-apps/plugin-http").then((mod) => mod.fetch as TauriFetchFn);
  }
  return tauriFetchPromise;
}

/** Test-only reset — clears the memoized import promises. Mirrors
 *  llmTransport.ts's resetTransport / client.ts's
 *  resetSubscriptionToastLatch convention for module-level state that
 *  must never leak between independent `it()` blocks (relevant if a
 *  future test stubs NEXT_PUBLIC_DESKTOP + `vi.resetModules()`s this
 *  file mid-suite). */
export function resetTauriApiCache(): void {
  invokePromise = null;
  listenPromise = null;
  tauriFetchPromise = null;
}
