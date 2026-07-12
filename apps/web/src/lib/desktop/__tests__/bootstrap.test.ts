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
  redactHomePath,
  resetDesktopBootstrap,
  type BootstrapDeps,
  type DesktopBootstrapHandle,
  type DesktopBootstrapState,
  type DesktopLogLine,
} from "../bootstrap";
import { MAX_RESTARTS_PER_WINDOW } from "../provisionMachine";
import type { PrewarmProgressEvent } from "../provisionRunner";
import type { InvokeFn, ListenFn, TauriEvent, TauriFetchFn } from "../tauriApi";
import type { DesktopPaths } from "../uvCommands";
import { clearDiag, getDiagEntries } from "../../diag/log";

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

/** Like makeFakeListen, but actually retains handlers so a test can
 *  fire an event (server://exit, uv://log) at will — mirrors
 *  provisionRunner.test.ts's own richer fake-listen helper (same
 *  ListenFn contract), kept as a SEPARATE helper here rather than
 *  replacing makeFakeListen() everywhere so the many existing call
 *  sites that don't need to emit anything stay untouched. */
function makeEmittableListen() {
  const active = new Map<string, Array<(event: TauriEvent<unknown>) => void>>();
  const listen: ListenFn = (async <T>(event: string, handler: (event: TauriEvent<T>) => void) => {
    const list = active.get(event) ?? [];
    list.push(handler as (event: TauriEvent<unknown>) => void);
    active.set(event, list);
    return () => {
      active.set(
        event,
        (active.get(event) ?? []).filter((h) => h !== handler),
      );
    };
  }) as ListenFn;
  function emit(event: string, payload: unknown): void {
    for (const handler of active.get(event) ?? []) handler({ event, payload });
  }
  return { listen, emit };
}

const fakeTauriFetch = (async () => new Response("{}")) as unknown as TauriFetchFn;

/** Subscribes and resolves once the machine reaches a stopping point —
 *  HEALTHY, TERMINAL_ERROR, STEP&&ERROR ("NEEDS_PROVISION-wizard-
 *  required", see bootstrap.ts's header comment), or the LEAD
 *  AMENDMENT's own WIZARD_CONSENT_REQUIRED pause — the exact pattern a
 *  real subscriber (chunk 6's wizard) would use, since bootstrapDesktop
 *  itself resolves before the drive loop finishes (see that file's own
 *  header comment on why). */
function waitForStable(handle: DesktopBootstrapHandle): Promise<DesktopBootstrapState> {
  const isStable = (s: DesktopBootstrapState) =>
    s.phase === "HEALTHY" ||
    s.phase === "TERMINAL_ERROR" ||
    s.phase === "WIZARD_CONSENT_REQUIRED" ||
    s.phase === "EXTERNAL_UNMANAGED" ||
    (s.phase === "STEP" && s.status === "ERROR");
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

/** Resolves on the FIRST future state$ notification matching
 *  `predicate` — unlike waitForStable, this NEVER short-circuits on the
 *  CURRENT snapshot, so it's the right tool for "wait for a state that
 *  might recur later" (chunk 7's crash-restart tests: HEALTHY is both
 *  the starting point AND the thing to wait for again after a
 *  restart). */
function waitForNextState(
  handle: DesktopBootstrapHandle,
  predicate: (s: DesktopBootstrapState) => boolean,
): Promise<DesktopBootstrapState> {
  return new Promise((resolve) => {
    const unsubscribe = handle.state$((state) => {
      if (predicate(state)) {
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

  it("full NEEDS_PROVISION pipeline (no marker, probe dead): pauses for consent, then — once given — drives every step through to HEALTHY", async () => {
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
    // LEAD AMENDMENT: a fresh NEEDS_PROVISION pauses for consent BEFORE
    // driving any step — see the dedicated describe block below for
    // this pause's own direct coverage; beginProvision() here is what
    // lets this test's existing "drives every step through to HEALTHY"
    // assertion still hold.
    const gated = await waitForStable(handle);
    expect(gated).toEqual({ phase: "WIZARD_CONSENT_REQUIRED" });

    handle.beginProvision();
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
    const gated = await waitForStable(handle);
    expect(gated).toEqual({ phase: "WIZARD_CONSENT_REQUIRED" });

    handle.beginProvision();
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
    const gated = await waitForStable(handle);
    expect(gated).toEqual({ phase: "WIZARD_CONSENT_REQUIRED" });
    handle.beginProvision();

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

describe("bootstrapDesktop — fresh-provision consent gate (LEAD AMENDMENT)", () => {
  it("a fresh NEEDS_PROVISION (no marker, probe dead) pauses at WIZARD_CONSENT_REQUIRED and never calls run_uv until beginProvision()", async () => {
    let runUvCalls = 0;
    let probeCalls = 0;
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        ...successfulPipelineHandlers,
        run_uv: () => {
          runUvCalls += 1;
          return { code: 0 };
        },
      }),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => {
        probeCalls += 1;
        // 1st call = CHECKING's own probe (must be dead to enter
        // NEEDS_PROVISION at all); every call after (POLLING_HEALTH)
        // is healthy immediately.
        return { up: probeCalls > 1 };
      },
    };
    const handle = await bootstrapDesktop(deps);
    const gated = await waitForStable(handle);
    expect(gated).toEqual({ phase: "WIZARD_CONSENT_REQUIRED" });
    expect(runUvCalls).toBe(0); // no uv command run before consent

    handle.beginProvision();
    const finalState = await waitForStable(handle);
    expect(finalState).toEqual({ phase: "HEALTHY" });
    expect(runUvCalls).toBeGreaterThan(0);
  });

  it("PROVISIONED_DEAD (valid marker, probe dead) never pauses for consent — keeps auto-driving straight through to HEALTHY", async () => {
    const validMarkerJson = JSON.stringify({
      schema: 1,
      model: "small",
      py: "3.12",
      deps: "faster-whisper==1.2.1,websockets==13.1,numpy==2.5.1",
      ts: "2026-07-01T00:00:00.000Z",
    });
    let probeCalls = 0;
    const seenPhases: string[] = [];
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({ ...successfulPipelineHandlers, read_provision_marker: () => validMarkerJson }),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => {
        probeCalls += 1;
        return { up: probeCalls > 1 };
      },
    };
    const handle = await bootstrapDesktop(deps);
    handle.state$((s) => seenPhases.push(s.phase));
    const finalState = await waitForStable(handle);
    expect(finalState).toEqual({ phase: "HEALTHY" });
    expect(seenPhases).not.toContain("WIZARD_CONSENT_REQUIRED");
  });

  it("beginProvision() is a no-op when the machine isn't currently paused for consent (e.g. already HEALTHY)", async () => {
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
    handle.beginProvision();
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
    handle.beginProvision(); // must not throw
    expect(handle.currentState()).toEqual({ phase: "NOT_DESKTOP" });
    await expect(handle.recheckHealth()).resolves.toBeUndefined();
    await expect(handle.reprovision()).resolves.toBeUndefined();
    await expect(handle.readSidecarLog(200)).resolves.toBe("");
    // S4 chunk 2: downloadProgress$/currentDownloadProgress are inert
    // outside a desktop build too — same posture as every other handle
    // method above.
    expect(handle.currentDownloadProgress()).toBeNull();
    const unsubscribeDownloadProgress = handle.downloadProgress$(() => {
      throw new Error("should never be called on NOT_DESKTOP");
    });
    unsubscribeDownloadProgress(); // must not throw
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

describe("bootstrapDesktop — log$ subscription (chunk 6 wizard 详细日志 pane)", () => {
  it("forwards uv://log lines emitted during a provisioning step to log$ subscribers", async () => {
    const { listen, emit } = makeEmittableListen();
    let probeCalls = 0;
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        ...successfulPipelineHandlers,
        run_uv: () => {
          emit("uv://log", { stream: "stdout", line: "Installed Python 3.12" });
          return { code: 0 };
        },
      }),
      listen,
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => {
        probeCalls += 1;
        return { up: probeCalls > 1 };
      },
    };
    const handle = await bootstrapDesktop(deps);
    const lines: DesktopLogLine[] = [];
    handle.log$((line) => lines.push(line));

    const gated = await waitForStable(handle);
    expect(gated).toEqual({ phase: "WIZARD_CONSENT_REQUIRED" });
    handle.beginProvision();
    await waitForStable(handle); // -> HEALTHY

    expect(lines).toContainEqual({ stream: "stdout", line: "Installed Python 3.12" });
  });

  it("an unsubscribed log$ listener stops receiving lines", async () => {
    const { listen, emit } = makeEmittableListen();
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({ app_paths: () => paths, read_provision_marker: () => null }),
      listen,
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => ({ up: true }),
    };
    const handle = await bootstrapDesktop(deps);
    await waitForStable(handle); // -> HEALTHY (adopted, nothing to log yet)
    const lines: DesktopLogLine[] = [];
    const unsubscribe = handle.log$((line) => lines.push(line));
    unsubscribe();
    emit("uv://log", { stream: "stdout", line: "should not arrive" });
    expect(lines).toEqual([]);
  });
});

describe("bootstrapDesktop — downloadProgress$ / currentDownloadProgress() (S4 chunk 2 prewarm://progress)", () => {
  it("forwards prewarm://progress updates emitted during DOWNLOAD_MODEL to downloadProgress$ subscribers and the snapshot getter", async () => {
    const { listen, emit } = makeEmittableListen();
    let probeCalls = 0;
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        ...successfulPipelineHandlers,
        prewarm_model: () => {
          emit("prewarm://progress", { downloaded: 1000, total: 4000 });
          emit("prewarm://progress", { downloaded: 4000, total: 4000 });
          return { code: 0 };
        },
      }),
      listen,
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => {
        probeCalls += 1;
        return { up: probeCalls > 1 };
      },
    };
    const handle = await bootstrapDesktop(deps);
    const updates: Array<PrewarmProgressEvent | null> = [];
    handle.downloadProgress$((p) => updates.push(p));

    const gated = await waitForStable(handle);
    expect(gated).toEqual({ phase: "WIZARD_CONSENT_REQUIRED" });
    expect(handle.currentDownloadProgress()).toBeNull(); // nothing has downloaded yet

    handle.beginProvision();
    await waitForStable(handle); // -> HEALTHY

    expect(updates).toContainEqual({ downloaded: 1000, total: 4000 });
    expect(updates).toContainEqual({ downloaded: 4000, total: 4000 });
  });

  it("resets the snapshot to null once the DOWNLOAD_MODEL step completes (moves on to STARTING)", async () => {
    const { listen, emit } = makeEmittableListen();
    let probeCalls = 0;
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        ...successfulPipelineHandlers,
        prewarm_model: () => {
          emit("prewarm://progress", { downloaded: 2000, total: 4000 });
          return { code: 0 };
        },
      }),
      listen,
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => {
        probeCalls += 1;
        return { up: probeCalls > 1 };
      },
    };
    const handle = await bootstrapDesktop(deps);
    const gated = await waitForStable(handle);
    expect(gated).toEqual({ phase: "WIZARD_CONSENT_REQUIRED" });

    handle.beginProvision();
    // Waits for the STARTING row specifically (rather than jumping
    // straight to waitForStable's HEALTHY) so this test actually
    // observes the reset AT the DOWNLOAD_MODEL -> STARTING boundary,
    // not just "eventually null once everything is done".
    const starting = await waitForNextState(
      handle,
      (s) => s.phase === "STEP" && s.step === "STARTING" && s.status === "RUNNING",
    );
    expect(starting).toMatchObject({ step: "STARTING" });
    expect(handle.currentDownloadProgress()).toBeNull();

    await waitForStable(handle); // -> HEALTHY
    expect(handle.currentDownloadProgress()).toBeNull();
  });

  it("resets the snapshot to null once the DOWNLOAD_MODEL step errors out too", async () => {
    const { listen, emit } = makeEmittableListen();
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        app_paths: () => paths,
        read_provision_marker: () => null,
        run_uv: () => ({ code: 0 }), // INSTALL_PYTHON/CREATE_VENV/INSTALL_DEPS all succeed
        prewarm_model: () => {
          emit("prewarm://progress", { downloaded: 500, total: 4000 });
          return { code: 1 };
        },
      }),
      listen,
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => ({ up: false }),
    };
    const handle = await bootstrapDesktop(deps);
    const gated = await waitForStable(handle);
    expect(gated).toEqual({ phase: "WIZARD_CONSENT_REQUIRED" });

    handle.beginProvision();
    const errored = await waitForStable(handle);
    expect(errored).toMatchObject({ phase: "STEP", step: "DOWNLOAD_MODEL", status: "ERROR" });
    expect(handle.currentDownloadProgress()).toBeNull();
  });

  it("an unsubscribed downloadProgress$ listener stops receiving updates", async () => {
    const { listen, emit } = makeEmittableListen();
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({ app_paths: () => paths, read_provision_marker: () => null }),
      listen,
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => ({ up: true }),
    };
    const handle = await bootstrapDesktop(deps);
    await waitForStable(handle); // -> HEALTHY (adopted, nothing to report yet)
    const updates: Array<PrewarmProgressEvent | null> = [];
    const unsubscribe = handle.downloadProgress$((p) => updates.push(p));
    unsubscribe();
    emit("prewarm://progress", { downloaded: 1, total: 2 });
    expect(updates).toEqual([]);
  });

  it("does not replay past updates to a late subscriber — a listener added after DOWNLOAD_MODEL finished sees nothing, and the snapshot is already back to null", async () => {
    const { listen, emit } = makeEmittableListen();
    let probeCalls = 0;
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        ...successfulPipelineHandlers,
        prewarm_model: () => {
          emit("prewarm://progress", { downloaded: 1000, total: 4000 });
          return { code: 0 };
        },
      }),
      listen,
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => {
        probeCalls += 1;
        return { up: probeCalls > 1 };
      },
    };
    const handle = await bootstrapDesktop(deps);
    const gated = await waitForStable(handle);
    expect(gated).toEqual({ phase: "WIZARD_CONSENT_REQUIRED" });
    handle.beginProvision();
    await waitForStable(handle); // -> HEALTHY, DOWNLOAD_MODEL long since finished

    const updates: Array<PrewarmProgressEvent | null> = [];
    handle.downloadProgress$((p) => updates.push(p));
    expect(updates).toEqual([]); // no replay
    expect(handle.currentDownloadProgress()).toBeNull();
  });
});

describe("bootstrapDesktop — server://exit crash-restart policy wiring (chunk 7)", () => {
  it("a server://exit while HEALTHY auto-restarts (re-invokes start_server) and returns to HEALTHY", async () => {
    let startServerCalls = 0;
    const { listen, emit } = makeEmittableListen();
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        app_paths: () => paths,
        read_provision_marker: () => null,
        start_server: () => {
          startServerCalls += 1;
          return { alreadyRunning: false };
        },
      }),
      listen,
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => ({ up: true }), // adopt path -> HEALTHY immediately, never spawns
    };
    const handle = await bootstrapDesktop(deps);
    await waitForStable(handle); // -> HEALTHY (adopted)
    expect(startServerCalls).toBe(0);

    const healthyAgain = waitForNextState(handle, (s) => s.phase === "HEALTHY");
    emit("server://exit", { code: 1 });
    await healthyAgain;

    expect(startServerCalls).toBe(1); // the restart's own STARTING step actually spawned
  });

  it("a server://exit received while NOT HEALTHY (still provisioning) is a silent no-op — no restart wiring fires", async () => {
    const { listen, emit } = makeEmittableListen();
    let resolveRunUv: (() => void) | null = null;
    const runUvGate = new Promise<void>((resolve) => {
      resolveRunUv = resolve;
    });
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        app_paths: () => paths,
        read_provision_marker: () => null,
        run_uv: async () => {
          await runUvGate;
          return { code: 0 };
        },
      }),
      listen,
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => ({ up: false }),
    };
    const handle = await bootstrapDesktop(deps);
    const gated = await waitForStable(handle);
    expect(gated).toEqual({ phase: "WIZARD_CONSENT_REQUIRED" });

    handle.beginProvision();
    // mid-INSTALL_PYTHON — run_uv's promise is deliberately held open.
    expect(handle.currentState()).toEqual({ phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" });

    emit("server://exit", { code: 1 }); // stray exit — must be a no-op
    expect(handle.currentState()).toEqual({ phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" });

    resolveRunUv!(); // let the held step finish (test cleanup, avoids a dangling promise)
  });

  it("the 4th server://exit within the 60s restart window exhausts the policy -> TERMINAL_ERROR", async () => {
    const { listen, emit } = makeEmittableListen();
    let nowMs = 1_000_000;
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        app_paths: () => paths,
        read_provision_marker: () => null,
        start_server: () => ({ alreadyRunning: false }),
      }),
      listen,
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => ({ up: true }),
      restartClock: () => nowMs,
    };
    const handle = await bootstrapDesktop(deps);
    await waitForStable(handle); // -> HEALTHY (adopted)

    for (let i = 0; i < MAX_RESTARTS_PER_WINDOW; i++) {
      const healthyAgain = waitForNextState(handle, (s) => s.phase === "HEALTHY");
      nowMs += 1000; // stays well within the 60s window throughout
      emit("server://exit", { code: 1 });
      await healthyAgain;
    }

    const terminal = waitForNextState(handle, (s) => s.phase === "TERMINAL_ERROR");
    nowMs += 1000;
    emit("server://exit", { code: 1 });
    const finalState = await terminal;
    expect(finalState).toMatchObject({ phase: "TERMINAL_ERROR" });
  });
});

describe("bootstrapDesktop — readSidecarLog() (chunk 7 SettingsDialog「查看本地服务日志」)", () => {
  it('invokes "read_sidecar_log" with the given tailLines and returns the result verbatim — reuses deps.invoke, no second getInvoke() call site', async () => {
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        app_paths: () => paths,
        read_provision_marker: () => null,
        read_sidecar_log: (args) => `log tail for ${args?.tailLines} lines`,
      }),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => ({ up: true }),
    };
    const handle = await bootstrapDesktop(deps);
    await waitForStable(handle); // -> HEALTHY

    const text = await handle.readSidecarLog(200);
    expect(text).toBe("log tail for 200 lines");
  });
});

describe("bootstrapDesktop — reprovision() (chunk 7 SettingsDialog「重新运行安装向导」)", () => {
  it("from HEALTHY: stops the server, clears the marker, and re-drives back to WIZARD_CONSENT_REQUIRED", async () => {
    let stopServerCalls = 0;
    let writtenMarkerJson: unknown;
    let probeCalls = 0;
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        app_paths: () => paths,
        read_provision_marker: () => null,
        stop_server: () => {
          stopServerCalls += 1;
          return undefined;
        },
        write_provision_marker: (args) => {
          writtenMarkerJson = args?.json;
          return undefined;
        },
      }),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => {
        probeCalls += 1;
        // Only the very first CHECKING probe (initial adopt) is
        // healthy — every later probe (the post-reprovision CHECKING)
        // reflects the server this call just stopped.
        return { up: probeCalls === 1 };
      },
    };
    const handle = await bootstrapDesktop(deps);
    await waitForStable(handle); // -> HEALTHY (adopted)

    await handle.reprovision();
    expect(stopServerCalls).toBe(1);
    expect(writtenMarkerJson).toBe("null");

    const gated = await waitForStable(handle);
    expect(gated).toEqual({ phase: "WIZARD_CONSENT_REQUIRED" });
  });

  it("rejects (does not swallow) a stop_server failure, leaving the caller to handle it", async () => {
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        app_paths: () => paths,
        read_provision_marker: () => null,
        stop_server: () => {
          throw new Error("boom");
        },
      }),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => ({ up: true }),
    };
    const handle = await bootstrapDesktop(deps);
    await waitForStable(handle); // -> HEALTHY
    await expect(handle.reprovision()).rejects.toThrow("boom");
  });
});

describe("bootstrapDesktop — recheckHealth() (chunk 6 wizard escape hatch)", () => {
  it("on error, a positive re-probe jumps straight to HEALTHY, bypassing the stuck step entirely", async () => {
    // A mutable flag (not a reassigned deps.probeSidecarFn) — bootstrapDesktop
    // captures ITS OWN `probe` closure once, at setup time, so a later
    // `deps.probeSidecarFn = ...` reassignment would never be observed;
    // toggling behavior BEHIND the same captured function reference is
    // the correct way to simulate "the situation changed since setup".
    let manualInstallDone = false;
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        app_paths: () => paths,
        read_provision_marker: () => null,
        run_uv: () => ({ code: 1 }),
      }),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => ({ up: manualInstallDone }),
    };
    const handle = await bootstrapDesktop(deps);
    const gated = await waitForStable(handle);
    expect(gated).toEqual({ phase: "WIZARD_CONSENT_REQUIRED" });
    handle.beginProvision();
    const errored = await waitForStable(handle);
    expect(errored).toMatchObject({ phase: "STEP", step: "INSTALL_PYTHON", status: "ERROR" });

    manualInstallDone = true; // simulate the user's own manual install now answering
    await handle.recheckHealth();
    expect(handle.currentState()).toEqual({ phase: "HEALTHY" });
  });

  it("is a no-op outside a STEP/ERROR state (e.g. already HEALTHY)", async () => {
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
    await handle.recheckHealth();
    expect(handle.currentState()).toEqual(before);
  });
});

describe("bootstrapDesktop — external sidecar mode (Finding 2)", () => {
  it('getSidecarMode absent: unchanged managed behavior (defaults to "managed", drives the full pipeline as before)', async () => {
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
  });

  it('sidecarMode:"external", probe down: parks at EXTERNAL_UNMANAGED — never runs the drive loop (no read_provision_marker/run_uv/prewarm_model/start_server, no consent phase)', async () => {
    const invokeCalls: string[] = [];
    const deps: BootstrapDeps = {
      // read_provision_marker/run_uv/prewarm_model/start_server are
      // deliberately absent from the handlers map — makeFakeInvoke
      // throws on any unexpected invoke(), so this doubles as an
      // assertion that external mode never calls them.
      invoke: makeFakeInvoke({ app_paths: () => paths }, (cmd) => invokeCalls.push(cmd)),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      getSidecarMode: async () => "external",
      probeSidecarFn: async () => ({ up: false }),
    };
    const handle = await bootstrapDesktop(deps);
    const finalState = await waitForStable(handle);
    expect(finalState).toEqual({ phase: "EXTERNAL_UNMANAGED" });
    expect(invokeCalls).toEqual(["app_paths"]);
  });

  it('sidecarMode:"external", probe up: HEALTHY, same no-drive guarantee', async () => {
    const invokeCalls: string[] = [];
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({ app_paths: () => paths }, (cmd) => invokeCalls.push(cmd)),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      getSidecarMode: async () => "external",
      probeSidecarFn: async () => ({ up: true }),
    };
    const handle = await bootstrapDesktop(deps);
    const finalState = await waitForStable(handle);
    expect(finalState).toEqual({ phase: "HEALTHY" });
    expect(invokeCalls).toEqual(["app_paths"]);
  });

  it("external mode never registers the server://exit crash-restart listener", async () => {
    const listenCalls: string[] = [];
    const listen: ListenFn = (async (event: string) => {
      listenCalls.push(event);
      return () => {};
    }) as ListenFn;
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({ app_paths: () => paths }),
      listen,
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      getSidecarMode: async () => "external",
      probeSidecarFn: async () => ({ up: true }),
    };
    const handle = await bootstrapDesktop(deps);
    await waitForStable(handle);
    expect(listenCalls).toEqual([]);
  });
});

describe("bootstrapDesktop — drive-loop re-entrancy guards (Finding 3)", () => {
  it("reprovision() is single-flighted: two interleaved calls run stop_server/write_provision_marker exactly once each, and both callers observe the same outcome", async () => {
    let stopServerCalls = 0;
    let writeMarkerCalls = 0;
    let probeCalls = 0;
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        app_paths: () => paths,
        read_provision_marker: () => null,
        stop_server: () => {
          stopServerCalls += 1;
          return undefined;
        },
        write_provision_marker: () => {
          writeMarkerCalls += 1;
          return undefined;
        },
      }),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => {
        probeCalls += 1;
        return { up: probeCalls === 1 }; // healthy on adopt, dead on the post-reprovision re-check
      },
    };
    const handle = await bootstrapDesktop(deps);
    await waitForStable(handle); // -> HEALTHY (adopted)

    const p1 = handle.reprovision();
    const p2 = handle.reprovision(); // interleaved — must join p1, not double-run
    await Promise.all([p1, p2]);

    expect(stopServerCalls).toBe(1);
    expect(writeMarkerCalls).toBe(1);

    const gated = await waitForStable(handle);
    expect(gated).toEqual({ phase: "WIZARD_CONSENT_REQUIRED" });
  });

  it("a superseded drive applies no further transitions once a newer reprovision() takes over its generation", async () => {
    let runUvCalls = 0;
    let resolveFirstRunUv: (() => void) | null = null;
    const firstRunUvGate = new Promise<void>((resolve) => {
      resolveFirstRunUv = resolve;
    });
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        app_paths: () => paths,
        read_provision_marker: () => null,
        stop_server: () => undefined,
        write_provision_marker: () => undefined,
        run_uv: async () => {
          runUvCalls += 1;
          if (runUvCalls === 1) {
            await firstRunUvGate; // held open — simulates a slow/stuck INSTALL_PYTHON
          }
          return { code: 0 };
        },
      }),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => ({ up: false }),
    };
    const handle = await bootstrapDesktop(deps);
    const gated = await waitForStable(handle);
    expect(gated).toEqual({ phase: "WIZARD_CONSENT_REQUIRED" });
    handle.beginProvision();
    expect(handle.currentState()).toEqual({ phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" });

    const seen: DesktopBootstrapState[] = [];
    handle.state$((s) => seen.push(s));

    // Races the still-in-flight first drive (run_uv held open) — bumps
    // the generation, resets state, and starts its OWN drive.
    await handle.reprovision();
    const gatedAgain = await waitForStable(handle);
    expect(gatedAgain).toEqual({ phase: "WIZARD_CONSENT_REQUIRED" });

    // Now let the FIRST (superseded) run_uv() resolve — if drive()#1
    // were still applying transitions, this STEP_OK would advance
    // straight past the fresh WIZARD_CONSENT_REQUIRED pause. It must be
    // a complete no-op instead: no further notify(), no state change.
    const seenCountBeforeStaleResolve = seen.length;
    resolveFirstRunUv!();
    await new Promise((resolve) => setTimeout(resolve, 0)); // flush the (wrongly-)pending chain, if any
    expect(seen.length).toBe(seenCountBeforeStaleResolve);
    expect(handle.currentState()).toEqual(gatedAgain);
  });
});

describe("bootstrapDesktop — diag redaction at the STEP_ERROR choke point (Finding 4)", () => {
  it("redactHomePath: replaces macOS/Linux/Windows home-dir segments with ~, everywhere they occur, leaving everything else untouched", () => {
    expect(redactHomePath("failed to create /Users/miana/Library/Application Support/x: permission denied")).toBe(
      "failed to create ~/Library/Application Support/x: permission denied",
    );
    expect(redactHomePath("/home/miana/.cache/uv/foo")).toBe("~/.cache/uv/foo");
    expect(redactHomePath("C:\\Users\\miana\\AppData\\Local\\foo")).toBe("~\\AppData\\Local\\foo");
    expect(redactHomePath("/Users/miana/a and again /Users/miana/b")).toBe("~/a and again ~/b");
    expect(redactHomePath("exited with code 1")).toBe("exited with code 1");
  });

  it("a STEP_ERROR carrying a /Users path lands REDACTED in the diag entry, while the machine's own state.error (the wizard's on-screen escape hatch) stays raw", async () => {
    clearDiag();
    const deps: BootstrapDeps = {
      invoke: makeFakeInvoke({
        app_paths: () => paths,
        read_provision_marker: () => null,
        run_uv: () => {
          throw new Error("failed to create /Users/miana/Library/Application Support/x: permission denied");
        },
      }),
      listen: makeFakeListen(),
      tauriFetch: fakeTauriFetch,
      setTransport: () => {},
      probeSidecarFn: async () => ({ up: false }),
    };
    const handle = await bootstrapDesktop(deps);
    const gated = await waitForStable(handle);
    expect(gated).toEqual({ phase: "WIZARD_CONSENT_REQUIRED" });
    handle.beginProvision();
    const errored = await waitForStable(handle);
    expect(errored).toMatchObject({
      phase: "STEP",
      error: "failed to create /Users/miana/Library/Application Support/x: permission denied",
    });

    const stepErrorEntry = getDiagEntries().find((e) => e.tag === "desktop-provision" && e.level === "error");
    expect(stepErrorEntry?.detail).toBe("failed to create ~/Library/Application Support/x: permission denied");
  });
});
