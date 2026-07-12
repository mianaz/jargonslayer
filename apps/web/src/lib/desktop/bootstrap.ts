// v0.4 S3 chunk 5 (docs/design-explorations/s3-tauri-uv-blueprint.md,
// §Chunk 5 + §Data flow) — desktop app init: "① setTransport(plugin-
// http fetch) -> ② runs the provision flow: fetch app_paths -> build
// machine initial() -> drive transitions with provisionRunner until
// HEALTHY / NEEDS_PROVISION-wizard-required / TERMINAL_ERROR". The
// THIRD stopping condition ("NEEDS_PROVISION-wizard-required") is a
// STEP/ERROR machine state: the ONLY point besides the two true
// terminals (HEALTHY, TERMINAL_ERROR) where an automatic drive loop can
// meaningfully pause — every other STEP status (RUNNING/POLLING) keeps
// auto-advancing with no user action needed (the blueprint's own Data
// flow section describes the whole uv pipeline as one unattended
// sequence, "uv python install -> uv venv -> uv pip install ->
// prewarm(small) -> marker -> start_server -> /health", not a
// click-through wizard).
//
// `initDesktop()` is idempotent (a module-level cached promise —
// mirrors llmTransport.ts's activeTransport / client.ts's toast-latch
// module-state pattern) and returns almost immediately (as soon as
// app_paths() resolves and the machine is constructed) — it does NOT
// wait for the drive loop to reach a stopping point before resolving.
// Driving happens in the background from the moment the returned
// handle exists, notifying every `state$` subscriber of each
// transition live — this is what lets chunk 6's wizard render "coarse
// per-step rows" as they actually happen, not just a final result.
//
// `bootstrapDesktop` (the testable core, ZERO @tauri-apps imports —
// invoke/listen/tauriFetch/setTransport all arrive as injected
// BootstrapDeps) does the real work; `initDesktop()` is a thin
// IS_DESKTOP-gated wrapper that supplies tauriApi.ts's real
// implementations. Tests exercise bootstrapDesktop directly with fakes
// (no env stubbing needed) for every behavioral case, and initDesktop's
// own caching wrapper separately for idempotency/guard behavior.
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";

import { IS_DESKTOP } from "../platform/desktop";
import { setTransport, type Transport } from "../llm/llmTransport";
import type { SidecarProbeResult } from "../stt/sidecarHealth";
import { getInvoke, getListen, getTauriFetch, type InvokeFn, type ListenFn, type TauriFetchFn } from "./tauriApi";
import { getAppPaths, runEffects, type OnLog } from "./provisionRunner";
import { initial, transition, type MachineState, type ProvisionContext } from "./provisionMachine";

/** small — first-run reliability (blueprint architecture decision 4);
 *  S4's model picker is what makes this caller-chosen. */
const DEFAULT_DESKTOP_MODEL = "small";

/** The machine's own MachineState, widened with one extra phase this
 *  file alone can produce: IS_DESKTOP=false (an ordinary web build) has
 *  no provisioning to report at all. */
export type DesktopBootstrapState = MachineState | { phase: "NOT_DESKTOP" };

/** Minimal subscription surface (blueprint chunk 5: "a tiny listener
 *  set, not a new dependency; NOT zustand — this predates store
 *  hydration") — a single subscribe function (returns its own
 *  unsubscribe), a state snapshot getter, and a retry trigger. Nothing
 *  more; chunk 6 extends this shape only if it turns out to need to. */
export interface DesktopBootstrapHandle {
  /** Subscribe to every subsequent state transition; returns an
   *  unsubscribe function. Does NOT replay past transitions — call
   *  `currentState()` first for the snapshot as of subscribe time. */
  state$: (listener: (state: DesktopBootstrapState) => void) => () => void;
  currentState: () => DesktopBootstrapState;
  /** Re-enters the current step's SAME effect — a no-op outside a
   *  STEP/ERROR state, mirroring provisionMachine.ts's own RETRY
   *  no-op contract exactly (never throws on a stray/late call). */
  retryStep: () => void;
}

const NOT_DESKTOP_HANDLE: DesktopBootstrapHandle = {
  state$: () => () => {},
  currentState: () => ({ phase: "NOT_DESKTOP" }),
  retryStep: () => {},
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAutoAdvancing(state: MachineState): boolean {
  return state.phase === "CHECKING" || (state.phase === "STEP" && state.status !== "ERROR");
}

export interface BootstrapDeps {
  invoke: InvokeFn;
  listen: ListenFn;
  tauriFetch: TauriFetchFn;
  /** Injected rather than imported so bootstrapDesktop stays free of
   *  any module with side-effecting global state beyond what the
   *  caller explicitly hands it — llmTransport.ts's own module-level
   *  `activeTransport` is exactly that kind of state, hence injection
   *  here instead of a bare top-level import + call. */
  setTransport: (transport: Transport) => void;
  /** small by default (see DEFAULT_DESKTOP_MODEL) — overridable for
   *  tests exercising the provisioned-dead-marker path without
   *  fighting the default. */
  model?: string;
  onLog?: OnLog;
  probeSidecarFn?: (settings: Settings) => Promise<SidecarProbeResult>;
  now?: () => string;
}

/** The testable core — see this file's header comment. Resolves once
 *  app_paths() has been fetched and the machine's initial CHECKING
 *  state exists; the provisioning drive loop itself then runs in the
 *  background, notifying `state$` subscribers of every transition. */
export async function bootstrapDesktop(deps: BootstrapDeps): Promise<DesktopBootstrapHandle> {
  // ① MUST precede any invoke/probe call below (order-sensitive — see
  // this file's header comment and the task's own acceptance test).
  deps.setTransport(deps.tauriFetch);

  // ② the provision flow.
  const paths = await getAppPaths(deps.invoke);
  const ctx: ProvisionContext = { paths, model: deps.model ?? DEFAULT_DESKTOP_MODEL };
  const runnerDeps = {
    invoke: deps.invoke,
    listen: deps.listen,
    // Managed mode's whisperUrl is fixed (blueprint architecture
    // decision 6), and DEFAULT_SETTINGS.whisperUrl ("ws://
    // localhost:8765") already matches start_server's own fixed --host
    // 127.0.0.1 --port 8765 (server.rs) — no override needed today. A
    // future sidecarMode-aware caller can thread a real Settings
    // through once chunk 6 adds that toggle.
    settings: DEFAULT_SETTINGS,
    onLog: deps.onLog,
    probeSidecarFn: deps.probeSidecarFn,
    now: deps.now,
  };

  let current = initial();
  const listeners = new Set<(state: DesktopBootstrapState) => void>();

  function notify(): void {
    for (const listener of listeners) listener(current.state);
  }

  async function drive(): Promise<void> {
    while (isAutoAdvancing(current.state)) {
      const event = await runEffects(current.state, current.effects, runnerDeps);
      current = transition(ctx, current.state, event);
      notify();
    }
  }

  function driveGuarded(): void {
    drive().catch((error: unknown) => {
      // Every expected failure mode is already turned into a
      // STEP_ERROR event inside runEffects' own try/catch — reaching
      // here means something outside that contract broke (a genuine
      // bug). Surface it as TERMINAL_ERROR rather than an unhandled
      // rejection + a silently-stuck handle.
      current = { state: { phase: "TERMINAL_ERROR", reason: describeError(error) }, effects: [] };
      notify();
    });
  }

  driveGuarded();

  return {
    state$(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentState() {
      return current.state;
    },
    retryStep() {
      if (current.state.phase !== "STEP" || current.state.status !== "ERROR") return;
      current = transition(ctx, current.state, { type: "RETRY" });
      notify();
      driveGuarded();
    },
  };
}

// ---------------------------------------------------------------
// initDesktop() — the real, IS_DESKTOP-gated, idempotent entry point.
// ---------------------------------------------------------------

let cachedHandlePromise: Promise<DesktopBootstrapHandle> | null = null;

async function bootstrapWithRealDeps(): Promise<DesktopBootstrapHandle> {
  const [tauriFetch, invoke, listen] = await Promise.all([getTauriFetch(), getInvoke(), getListen()]);
  return bootstrapDesktop({ invoke, listen, tauriFetch, setTransport });
}

/** Call once during desktop app init (chunk 6's DesktopBootstrap.tsx).
 *  Idempotent: every call after the first returns the SAME cached
 *  promise/handle, never re-runs setTransport/app_paths/the drive loop
 *  again. Guards on IS_DESKTOP: an ordinary web build gets a stable
 *  no-op handle and never touches tauriApi.ts (so never imports
 *  `@tauri-apps/*`) at all. */
export function initDesktop(): Promise<DesktopBootstrapHandle> {
  if (!cachedHandlePromise) {
    cachedHandlePromise = IS_DESKTOP ? bootstrapWithRealDeps() : Promise.resolve(NOT_DESKTOP_HANDLE);
  }
  return cachedHandlePromise;
}

/** Test-only reset — clears the cached handle promise. Mirrors
 *  llmTransport.ts's resetTransport / tauriApi.ts's resetTauriApiCache
 *  convention for module-level state that must never leak between
 *  independent `it()` blocks. */
export function resetDesktopBootstrap(): void {
  cachedHandlePromise = null;
}
