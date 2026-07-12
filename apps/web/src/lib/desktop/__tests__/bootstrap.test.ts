// v0.4 S3 chunk 5 — bootstrapDesktop (the testable core) exercised
// directly with fakes for every behavioral case (no env stubbing
// needed — it has zero IS_DESKTOP/tauriApi coupling of its own);
// initDesktop's own idempotency/IS_DESKTOP-guard wrapper tested
// separately, in the test env's default (NEXT_PUBLIC_DESKTOP unset)
// state, so it never needs to touch a real `@tauri-apps/*` package.
import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapDesktop,
  initDesktop,
  resetDesktopBootstrap,
  type BootstrapDeps,
  type DesktopBootstrapHandle,
  type DesktopBootstrapState,
} from "../bootstrap";
import type { InvokeFn, ListenFn, TauriEvent, TauriFetchFn } from "../tauriApi";
import type { DesktopPaths } from "../uvCommands";

const paths: DesktopPaths = {
  appData: "/fake/AppData",
  pythonInstallDir: "/fake/AppData/python",
  uvCacheDir: "/fake/AppData/uv-cache",
  venvDir: "/fake/AppData/venv",
  venvPython: "/fake/AppData/venv/bin/python",
  modelsDir: "/fake/AppData/models",
  scriptPath: "/fake/Resources/sidecar/whisper_server.py",
  requirementsPath: "/fake/Resources/sidecar/requirements-sidecar.txt",
  logPath: "/fake/Logs/whisper_server.log",
  markerPath: "/fake/AppData/.provisioned.json",
};

function makeFakeInvoke(
  handlers: Record<string, (args?: Record<string, unknown>) => unknown>,
  onCall?: (cmd: string) => void,
) {
  const invoke: InvokeFn = (async <T>(cmd: string, args?: Record<string, unknown>) => {
    onCall?.(cmd);
    if (!(cmd in handlers)) throw new Error(`unexpected invoke("${cmd}")`);
    return handlers[cmd](args) as T;
  }) as InvokeFn;
  return invoke;
}

function makeFakeListen(): ListenFn {
  return (async <T>(_event: string, _handler: (event: TauriEvent<T>) => void) => {
    return () => {};
  }) as ListenFn;
}

const fakeTauriFetch = (async () => new Response("{}")) as unknown as TauriFetchFn;

/** Subscribes and resolves once the machine reaches a stopping point —
 *  HEALTHY, TERMINAL_ERROR, or STEP&&ERROR ("NEEDS_PROVISION-wizard-
 *  required", see bootstrap.ts's header comment) — the exact pattern a
 *  real subscriber (chunk 6's wizard) would use, since bootstrapDesktop
 *  itself resolves before the drive loop finishes (see that file's own
 *  header comment on why). */
function waitForStable(handle: DesktopBootstrapHandle): Promise<DesktopBootstrapState> {
  const isStable = (s: DesktopBootstrapState) =>
    s.phase === "HEALTHY" || s.phase === "TERMINAL_ERROR" || (s.phase === "STEP" && s.status === "ERROR");
  const initialState = handle.currentState();
  if (isStable(initialState)) return Promise.resolve(initialState);
  return new Promise((resolve) => {
    const unsubscribe = handle.state$((state) => {
      if (isStable(state)) {
        unsubscribe();
        resolve(state);
      }
    });
  });
}

const successfulPipelineHandlers = {
  app_paths: () => paths,
  read_provision_marker: () => null,
  run_uv: () => ({ code: 0 }),
  prewarm_model: () => ({ code: 0 }),
  write_provision_marker: () => undefined,
  start_server: () => ({ alreadyRunning: false }),
};

describe("bootstrapDesktop — setTransport ordering", () => {
  it("calls setTransport() before the first invoke()/probe call (order-sensitive)", async () => {
    const order: string[] = [];
    const invoke = makeFakeInvoke(
      { app_paths: () => paths, read_provision_marker: () => null },
      (cmd) => order.push(`invoke:${cmd}`),
    );
    const deps: BootstrapDeps = {
      invoke,
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => order.push("setTransport"),
      probeSidecarFn: async () => {
        order.push("probe");
        return { up: true };
      },
    };

    const handle = await bootstrapDesktop(deps);
    await waitForStable(handle);

    expect(order[0]).toBe("setTransport");
    expect(order.indexOf("setTransport")).toBeLessThan(order.indexOf("invoke:app_paths"));
  });

  it("passes deps.tauriFetch to setTransport, unchanged", async () => {
    let received: unknown;
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({ app_paths: () => paths, read_provision_marker: () => null }),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: (t) => {
        received = t;
      },
      probeSidecarFn: async () => ({ up: true }),
    };
    await bootstrapDesktop(deps);
    expect(received).toBe(fakeTauriFetch);
  });
});

describe("bootstrapDesktop — machine-to-HEALTHY happy path", () => {
  it("adopt path: probe healthy from the start -> HEALTHY with no provisioning calls", async () => {
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({ app_paths: () => paths, read_provision_marker: () => null }),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => ({ up: true }),
    };
    const handle = await bootstrapDesktop(deps);
    const finalState = await waitForStable(handle);
    expect(finalState).toEqual({ phase: "HEALTHY" });
    expect(handle.currentState()).toEqual({ phase: "HEALTHY" });
  });

  it("full NEEDS_PROVISION pipeline (no marker, probe dead) drives every step through to HEALTHY", async () => {
    let probeCalls = 0;
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke(successfulPipelineHandlers),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => {
        probeCalls += 1;
        // 1st call = CHECKING's own probe (must be dead to enter
        // NEEDS_PROVISION at all); every call after (POLLING_HEALTH) is
        // healthy immediately.
        return { up: probeCalls > 1 };
      },
    };
    const handle = await bootstrapDesktop(deps);
    const finalState = await waitForStable(handle);
    expect(finalState).toEqual({ phase: "HEALTHY" });
  });
});

describe("bootstrapDesktop — NEEDS_PROVISION surfaces a wizard-required (STEP/ERROR) state", () => {
  it("a failing first step (INSTALL_PYTHON) stops the auto-drive at STEP/ERROR, not HEALTHY or an unhandled rejection", async () => {
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        app_paths: () => paths,
        read_provision_marker: () => null,
        run_uv: () => ({ code: 1 }),
      }),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => ({ up: false }),
    };
    const handle = await bootstrapDesktop(deps);
    const finalState = await waitForStable(handle);
    expect(finalState).toEqual({
      phase: "STEP",
      step: "INSTALL_PYTHON",
      status: "ERROR",
      error: "exited with code 1",
      retriable: true,
    });
  });

  it("retryStep() re-enters the failed step and (once it succeeds) resumes driving all the way to HEALTHY", async () => {
    let runUvCalls = 0;
    let probeCalls = 0;
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        ...successfulPipelineHandlers,
        run_uv: () => {
          runUvCalls += 1;
          return runUvCalls === 1 ? { code: 1 } : { code: 0 }; // INSTALL_PYTHON fails once, then succeeds (incl. on retry)
        },
      }),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => {
        probeCalls += 1;
        // Only ever called once BEFORE POLLING_HEALTH (CHECKING's own
        // probe) regardless of the INSTALL_PYTHON retry in between —
        // same "1st call dead, every call after healthy" shape the
        // full-pipeline test above uses.
        return { up: probeCalls > 1 };
      },
    };
    const handle = await bootstrapDesktop(deps);
    const errored = await waitForStable(handle);
    expect(errored).toMatchObject({ phase: "STEP", step: "INSTALL_PYTHON", status: "ERROR" });

    handle.retryStep();
    const finalState = await waitForStable(handle);
    expect(finalState).toEqual({ phase: "HEALTHY" });
  });

  it("retryStep() is a no-op when the machine isn't currently in a STEP/ERROR state", async () => {
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({ app_paths: () => paths, read_provision_marker: () => null }),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => ({ up: true }),
    };
    const handle = await bootstrapDesktop(deps);
    await waitForStable(handle); // -> HEALTHY
    const before = handle.currentState();
    handle.retryStep();
    expect(handle.currentState()).toEqual(before);
  });
});

describe("bootstrapDesktop — state$ subscription", () => {
  it("subscribe/unsubscribe: an unsubscribed listener stops receiving notifications", async () => {
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({ app_paths: () => paths, read_provision_marker: () => null }),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => ({ up: true }),
    };
    const handle = await bootstrapDesktop(deps);
    const seen: DesktopBootstrapState[] = [];
    const unsubscribe = handle.state$((s) => seen.push(s));
    await waitForStable(handle);
    unsubscribe();
    const countAfterUnsubscribe = seen.length;
    handle.retryStep(); // no-op (already HEALTHY) — but even if it weren't, seen must not grow
    expect(seen.length).toBe(countAfterUnsubscribe);
  });
});

describe("initDesktop — idempotency + IS_DESKTOP guard", () => {
  afterEach(() => {
    resetDesktopBootstrap();
  });

  it("outside a desktop build (NEXT_PUBLIC_DESKTOP unset in the test env), resolves a stable NOT_DESKTOP handle without touching invoke/listen/fetch", async () => {
    const handle = await initDesktop();
    expect(handle.currentState()).toEqual({ phase: "NOT_DESKTOP" });
    handle.retryStep(); // must not throw
    expect(handle.currentState()).toEqual({ phase: "NOT_DESKTOP" });
  });

  it("is idempotent: two calls return the exact same cached promise, resolving to the exact same handle", async () => {
    const p1 = initDesktop();
    const p2 = initDesktop();
    expect(p1).toBe(p2);
    const [h1, h2] = await Promise.all([p1, p2]);
    expect(h1).toBe(h2);
  });

  it("resetDesktopBootstrap() clears the cache — the next call is a genuinely NEW promise", async () => {
    const p1 = initDesktop();
    await p1;
    resetDesktopBootstrap();
    const p2 = initDesktop();
    expect(p2).not.toBe(p1); // proves the cache was actually rebuilt, not just re-read
    const [h1, h2] = await Promise.all([p1, p2]);
    expect(h1).toEqual(h2); // same NOT_DESKTOP shape either way
  });
});
