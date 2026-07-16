// @vitest-environment jsdom
//
// S12b worker B2 (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md,
// §C L1/§E, task item 3) — the end-to-end proof that the flip holds
// together: a user, on Apple-Silicon-supported caps, opens Settings'
// 转录引擎 更换模型 picker, selects the REAL parakeet-tdt-0.6b-v3 row
// (modelCatalog.ts's own B2 flip, unmocked here), clicks 下载并切换, and
// the FULL two-phase provision (§C R1/Provision) fires in the exact
// pinned order — all the way down to Rust's invoke() boundary and the
// sidecar's own HTTP job API, nothing short-circuited.
//
// Mocking strategy (deliberately DIFFERENT from SettingsDialog.desktop.
// test.tsx's own F5/F7/S12a describe blocks, which fully replace
// initDesktop() with a hand-scripted DesktopBootstrapHandle stub — this
// suite's whole point is exercising bootstrap.ts's REAL switchModel/
// ensureMlxExtras logic, so it can't share that file's mock, hence a
// separate file): bootstrap.ts itself is left REAL (imported via
// importOriginal, only its exported `initDesktop` thin wrapper is
// swapped for one that calls the SAME real, exported `bootstrapDesktop`
// core with directly-injected fake deps — the exact "testable core"
// seam bootstrap.test.ts's own healthyDeps()/makeFakeInvoke() already
// exercise, just wired to a live component tree here instead of calling
// the handle API directly). tauriApi.ts is mocked wholesale (its own
// `@tauri-apps/*` dynamic imports would otherwise need a real Tauri
// runtime) so mlxCaps.ts's OWN (also unmocked) probeMlxCaps()/
// refreshMlxCaps() round-trip through the IDENTICAL fake invoke — the
// picker's displayed gating state and switchModel's own capability gate
// are proven to agree, not independently stubbed. Global `fetch` is
// mocked for the sidecar's HTTP job API (/download-model, /jobs/:id,
// /health) — real `httpBaseFromWs`/`pollJob` (lib/stt/upload.ts) and
// `probeSidecar` (lib/stt/sidecarHealth.ts) run for real against it,
// same "mock at the actual network/invoke boundary, not a higher-level
// function" posture as the invoke() side.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { InvokeFn, ListenFn, TauriEvent, TauriFetchFn } from "@/lib/desktop/tauriApi";

vi.mock("@/lib/platform/desktop", () => ({ IS_DESKTOP: true }));

vi.mock("@/lib/desktop/audiocapCaps", () => ({
  probeAudiocapCaps: async () => ({ appAudioSupported: true, reason: null }),
  isAppAudioFloorLocked: () => false,
  appAudioLockReason: () => "",
}));

vi.mock("@/lib/desktop/osspeechCaps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop/osspeechCaps")>();
  return { ...actual, useOsSpeechCaps: () => null, preinstallOsSpeech: async () => undefined };
});

vi.mock("@/lib/oauth/openrouterDesktop", () => ({ connectOpenRouterDesktop: vi.fn() }));

// Shared mutable state every hoisted mock factory below closes over —
// vi.hoisted (not a plain top-level `let`) per this repo's own
// established convention for exactly this shape (ModelPicker.render.
// test.tsx's mlxState, mlxCaps.desktop.test.ts's invokeQueue).
const harness = vi.hoisted(() => {
  const state: {
    invoke: InvokeFn;
    listen: ListenFn;
    tauriFetch: TauriFetchFn;
    hfToken: string;
    cachedHandlePromise: Promise<unknown> | null;
  } = {
    invoke: (async () => {
      throw new Error("harness.invoke: not configured for this test");
    }) as InvokeFn,
    listen: (async () => () => {}) as ListenFn,
    tauriFetch: (async () => new Response("{}")) as unknown as TauriFetchFn,
    hfToken: "",
    cachedHandlePromise: null,
  };
  return state;
});

vi.mock("@/lib/desktop/tauriApi", () => ({
  getInvoke: () => Promise.resolve(harness.invoke),
  getListen: () => Promise.resolve(harness.listen),
  getTauriFetch: () => Promise.resolve(harness.tauriFetch),
}));

// initDesktop() is the ONLY bootstrap.ts export overridden — every other
// export (bootstrapDesktop itself, chooseOsSpeechEngine, etc.) is the
// REAL module via importOriginal. Memoized on harness.cachedHandlePromise
// so the multiple call sites SettingsDialog.tsx makes (当前模型 effect +
// 更换模型's own handleSwitchModel) share ONE bootstrapDesktop() instance
// — mirrors the real initDesktop()'s own idempotency contract exactly,
// just backed by directly-injected deps instead of tauriApi.ts's dynamic
// imports.
vi.mock("@/lib/desktop/bootstrap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop/bootstrap")>();
  return {
    ...actual,
    initDesktop: () => {
      if (!harness.cachedHandlePromise) {
        harness.cachedHandlePromise = actual.bootstrapDesktop({
          invoke: harness.invoke,
          listen: harness.listen,
          tauriFetch: harness.tauriFetch,
          setTransport: () => {},
          probeSidecarFn: async () => ({ up: true }), // adopt path -> HEALTHY immediately; also the final post-restart health poll
          sleep: async () => {}, // instant — no real download/health-poll wall-clock wait
          now: () => "2026-07-16T00:00:00.000Z",
          isMeetingActive: () => false,
          readHfToken: () => harness.hfToken,
        });
      }
      return harness.cachedHandlePromise;
    },
  };
});

import { useApp } from "../../lib/store";
import { useTasks } from "../../lib/tasks/registry";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import SettingsDialog from "../SettingsDialog";

const FAKE_PATHS = {
  appData: "/fake/AppData",
  pythonInstallDir: "/fake/AppData/python",
  uvCacheDir: "/fake/AppData/uv-cache",
  venvDir: "/fake/AppData/venv",
  venvPython: "/fake/AppData/venv/bin/python",
  modelsDir: "/fake/AppData/models",
  scriptPath: "/fake/Resources/sidecar/whisper_server.py",
  requirementsPath: "/fake/Resources/sidecar/requirements-sidecar.txt",
  diarRequirementsPath: "/fake/Resources/sidecar/requirements-diar.txt",
  logPath: "/fake/Logs/whisper_server.log",
  markerPath: "/fake/AppData/.provisioned.json",
  mlxVenvDir: "/fake/AppData/mlx-venv",
  mlxVenvPython: "/fake/AppData/mlx-venv/bin/python",
  mlxRequirementsLockPath: "/fake/Resources/sidecar/requirements-mlx.lock",
};

const existingMarkerJson = JSON.stringify({
  schema: 1,
  model: "small",
  py: "3.12",
  deps: "faster-whisper==1.2.1,websockets==13.1,numpy==2.5.1",
  ts: "2026-06-01T00:00:00.000Z",
});

function seedSettings(): Settings {
  return { ...DEFAULT_SETTINGS, uiMode: "advanced", sidecarMode: "managed", hfToken: "hf_test_token_123" };
}

function resetStore() {
  useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: false });
}

/** Mirrors bootstrap.test.ts's own makeFakeInvoke — kept as an
 *  independent, test-file-local copy (same posture as mlxCaps.desktop.
 *  test.ts's makeGatedInvoke doc comment explains for this repo's other
 *  per-file test helpers). Records every call (in order) into `order`. */
function makeOrderedInvoke(
  handlers: Record<string, (args?: Record<string, unknown>) => unknown>,
  order: string[],
): InvokeFn {
  return (async <T,>(cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "run_uv") {
      const a = (args?.args as string[]) ?? [];
      // "venv"'s own a[1] is the (fake, machine-specific) venv dir path,
      // not a subcommand — only "pip"'s a[1] (install/check) is worth
      // recording alongside a[0].
      order.push(`run_uv:${a[0]}${a[0] === "pip" && a[1] ? " " + a[1] : ""}`);
    } else {
      order.push(cmd);
    }
    if (!(cmd in handlers)) throw new Error(`unexpected invoke("${cmd}")`);
    return handlers[cmd](args) as T;
  }) as InvokeFn;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The sidecar's own HTTP job API (:8766) — POST /download-model,
 *  GET /jobs/:id, GET /health — same three endpoints real, unmocked
 *  httpBaseFromWs/pollJob (lib/stt/upload.ts) and probeSidecar
 *  (lib/stt/sidecarHealth.ts) actually hit. Records matched calls into
 *  `order` (prefixed `fetch:`) so the download step's own position in
 *  the pinned sequence is directly assertable, not just implied by
 *  "downloading" progress events. */
function stubSidecarHttp(order: string[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/download-model")) {
      order.push("fetch:/download-model");
      return jsonResponse({ job_id: "job-parakeet" }, 202);
    }
    if (url.includes("/jobs/job-parakeet")) {
      order.push("fetch:/jobs/job-parakeet");
      return jsonResponse({ status: "done", progress: 1, error: null });
    }
    if (url.includes("/health")) {
      return jsonResponse({
        ok: true,
        model: "small",
        diarization_installed: true,
        diarization_ready: true,
        diarization_error: null,
      });
    }
    throw new Error(`unexpected fetch(${url})`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Every invoke("mlx_capabilities")/invoke("mlx_import_preflight")/
 *  invoke("app_data_disk_free")/invoke("run_uv") handler needed to drive
 *  a full, no-pre-existing-venv parakeet switch to completion (mirrors
 *  bootstrap.test.ts's own "happy path" mlx-family switchModel() test's
 *  handler shape) — shared by both tests below, `overrides` lets the
 *  disk-shortfall test swap in a failing app_data_disk_free. */
function mlxHandlers(overrides: Record<string, (args?: Record<string, unknown>) => unknown> = {}) {
  let preflightCalls = 0;
  return {
    app_paths: () => FAKE_PATHS,
    read_provision_marker: () => existingMarkerJson,
    mlx_capabilities: () => ({ mlxSupported: true, reason: null }),
    mlx_import_preflight: () => {
      preflightCalls += 1;
      // 1st call = ensureMlxExtras' own leading skip-check ("not yet
      // installed" -> falls through); 2nd = the real post-install
      // verification, once pip install has actually succeeded.
      return preflightCalls === 1 ? { ok: false, stderr: "" } : { ok: true, stderr: "" };
    },
    app_data_disk_free: () => ({ freeBytes: 20 * 1024 ** 3 }), // 20GB — comfortably above the ~5GB reserve
    run_uv: () => ({ code: 0 }),
    write_provision_marker: () => undefined,
    stop_server: () => undefined,
    start_server: (args?: Record<string, unknown>) => {
      expect(args?.model).toBe("parakeet-tdt-0.6b-v3");
      // Q6/§3.5's hfToken threading — hfTokenArg(deps) spreads `hfToken`
      // onto THIS call specifically (postDownloadModel's own POST body
      // carries none — see the accepted-asymmetry assertion below).
      expect(args?.hfToken).toBe(harness.hfToken);
      return { alreadyRunning: false };
    },
    ...overrides,
  };
}

describe("SettingsDialog (desktop) — parakeet switch, end to end through the REAL model picker (§C L1/§E, worker B2)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let order: string[] = [];

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({ settings: seedSettings(), hydrated: true });
    useTasks.setState({ tasks: {} });
    order = [];
    harness.cachedHandlePromise = null;
    harness.hfToken = "hf_test_token_123";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root!.unmount());
    container!.remove();
    container = null;
    root = null;
    resetStore();
    useTasks.setState({ tasks: {} });
    vi.unstubAllGlobals();
  });

  async function flushUntil(check: () => boolean, maxTicks = 100): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      if (check()) return;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    if (!check()) throw new Error("flushUntil: condition never became true");
  }

  function findButtonContaining(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
    if (!btn) throw new Error(`button containing "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  function modelDownloadTask() {
    return Object.values(useTasks.getState().tasks).find((t) => t.kind === "model-download");
  }

  it("user on supported caps selects parakeet in the Settings model picker -> the full two-phase-provision invoke sequence fires in the pinned order, hfToken rides start_server, task settles done", async () => {
    harness.invoke = makeOrderedInvoke(mlxHandlers(), order);
    const fetchMock = stubSidecarHttp(order);

    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    // Let the 当前模型 mount effect (initDesktop().then(handle.installedModel)) settle.
    await flushUntil(() => container!.textContent?.includes("当前模型") ?? false);
    await flushUntil(() => container!.textContent?.includes("small") ?? false);

    await act(async () => {
      findButtonContaining("更换模型").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // ModelPicker's own mount effect (useMlxCaps' probeMlxCaps()) must
    // settle before the parakeet row reads enabled.
    await flushUntil(() => {
      const row = container!.querySelector(
        '[data-testid="model-option-parakeet-tdt-0.6b-v3"]',
      ) as HTMLButtonElement | null;
      return row !== null && row.disabled === false;
    });

    order.length = 0; // everything above is bootstrap adoption + the picker's own caps probe, not the switch itself

    await act(async () => {
      container!
        .querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      findButtonContaining("下载并切换").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await flushUntil(() => modelDownloadTask()?.status === "done" || modelDownloadTask()?.status === "error");
    expect(modelDownloadTask()?.status).toBe("done"); // fails loudly (task.error) if the flow actually errored

    expect(order).toEqual([
      "mlx_capabilities",
      "mlx_import_preflight",
      "app_data_disk_free",
      "run_uv:venv",
      "run_uv:pip install",
      "mlx_import_preflight",
      "run_uv:pip check",
      "fetch:/download-model",
      "fetch:/jobs/job-parakeet",
      "read_provision_marker", // performSwitchModel's own pre-write read (py/deps reuse) — see that function's own doc comment
      "write_provision_marker",
      "stop_server",
      "start_server",
    ]);

    // hfToken threads through the switch's own start_server call —
    // Q6/§3.5's pinned contract (postDownloadModel's own accepted
    // asymmetry means the /download-model POST body carries none, only
    // start_server does — see bootstrap.ts's own doc comment on that
    // accepted limitation).
    const downloadCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/download-model"));
    expect(downloadCall).toBeDefined();
    const downloadBody = JSON.parse(String((downloadCall![1] as RequestInit).body));
    expect(downloadBody).toEqual({ model: "parakeet-tdt-0.6b-v3" }); // no hfToken here — accepted asymmetry
  });

  it("disk check returns too-little space -> the flow aborts with the shortfall message, ZERO venv mutations (no run_uv at all), old server untouched", async () => {
    harness.invoke = makeOrderedInvoke(
      mlxHandlers({ app_data_disk_free: () => ({ freeBytes: 1 * 1024 ** 3 }) }), // 1GB — well short of the ~5GB reserve
      order,
    );
    stubSidecarHttp(order);

    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flushUntil(() => container!.textContent?.includes("small") ?? false);

    await act(async () => {
      findButtonContaining("更换模型").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushUntil(() => {
      const row = container!.querySelector(
        '[data-testid="model-option-parakeet-tdt-0.6b-v3"]',
      ) as HTMLButtonElement | null;
      return row !== null && row.disabled === false;
    });

    order.length = 0;

    await act(async () => {
      container!
        .querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      findButtonContaining("下载并切换").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await flushUntil(() => modelDownloadTask()?.status === "error");
    expect(modelDownloadTask()?.error).toBe("磁盘空间不足：可用 1.0GB，需要至少 5.0GB");

    // ensureMlxExtras self-heals ANY attempt(false) failure with exactly
    // one attempt(true) (--clear) retry (§C Provision, transactional
    // venv build) — attempt(true) skips the leading "already installed"
    // mlx_import_preflight short-circuit (clear:true never short-
    // circuits) but re-runs checkMlxInstallDiskSpace fresh, so the
    // shortfall fires (and is recorded) TWICE before the retry's own
    // error propagates as-is.
    expect(order).toEqual([
      "mlx_capabilities",
      "mlx_import_preflight",
      "app_data_disk_free",
      "app_data_disk_free",
    ]);
    expect(order).not.toContain("run_uv:venv");
    expect(order.some((c) => c.startsWith("run_uv"))).toBe(false);
    expect(order).not.toContain("fetch:/download-model");
    expect(order).not.toContain("stop_server");
    expect(order).not.toContain("start_server");
  });
});
