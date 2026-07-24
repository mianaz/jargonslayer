import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";

// Mirrors registry.test.ts's own mocking posture (registry.ts, which
// these wrappers sit on top of, reads useApp.getState().settings.
// webhookUrl at every startTask — a real Settings-shaped object here
// keeps that read, and jobsBridge's own settings.* reads, both honest
// without hand-rolling a partial shape). postTaskWebhook/autoExport is
// mocked for the identical reason registry.test.ts mocks it: its own
// module graph pulls in IndexedDB-backed history storage that has no
// business running under these tests (webhookUrl stays "" below, so it
// would never actually fire regardless).
let mockSettings: typeof DEFAULT_SETTINGS = { ...DEFAULT_SETTINGS };
const mockSetSidecarUp = vi.fn();
vi.mock("../../store", () => ({
  useApp: {
    getState: () => ({ settings: mockSettings, setSidecarUp: mockSetSidecarUp }),
  },
}));

const mockPostTaskWebhook = vi.fn(async (_task: unknown, _event: string, _url: string) => {});
vi.mock("../../history/autoExport", () => ({
  postTaskWebhook: (task: unknown, event: string, url: string) =>
    mockPostTaskWebhook(task, event, url),
}));

const mockProbeSidecar = vi.fn();
vi.mock("../../stt/sidecarHealth", () => ({
  probeSidecar: (settings: unknown) => mockProbeSidecar(settings),
}));

import { modelForTask, trackInstallDiar, trackOsSpeechAsset, trackPrewarm, trackSwitchModel } from "../jobsBridge";
import { completeTask, dismissTask, startTask, useTasks, type TaskState } from "../../tasks/registry";
import type { DesktopBootstrapHandle, DesktopBootstrapState, SwitchModelProgress } from "../bootstrap";
import type { PrewarmProgressEvent } from "../provisionRunner";
import type { DesktopPaths } from "../uvCommands";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const fakePaths: DesktopPaths = {
  appData: "",
  pythonInstallDir: "",
  uvCacheDir: "",
  venvDir: "",
  venvPython: "",
  modelsDir: "",
  scriptPath: "",
  requirementsPath: "",
  diarRequirementsPath: "",
  logPath: "",
  markerPath: "",
  mlxVenvDir: "",
  mlxVenvPython: "",
  mlxRequirementsLockPath: "",
};

/** Mirrors bootstrap.ts's own (module-private) NOT_DESKTOP_HANDLE shape
 *  — every method a safe no-op by default, overridable per test for the
 *  one or two methods that test actually exercises. */
function fakeHandle(overrides: Partial<DesktopBootstrapHandle> = {}): DesktopBootstrapHandle {
  return {
    state$: () => () => {},
    currentState: () => ({ phase: "NOT_DESKTOP" }),
    retryStep: () => {},
    beginProvision: () => {},
    log$: () => () => {},
    downloadProgress$: () => () => {},
    currentDownloadProgress: () => null,
    paths: fakePaths,
    recheckHealth: async () => {},
    reprovision: async () => {},
    requestProvisionCheck: async () => {},
    installedModel: async () => null,
    switchModel: async () => {},
    switchModelProgress$: () => () => {},
    currentSwitchModelProgress: () => null,
    installDiarization: async () => {},
    readSidecarLog: async () => "",
    cancelPrewarm: async () => {},
    cancelSwitchModel: async () => {},
    ...overrides,
  };
}

function task(id: string): TaskState {
  const t = useTasks.getState().tasks[id];
  if (!t) throw new Error(`no task ${id}`);
  return t;
}

describe("trackSwitchModel", () => {
  beforeEach(() => {
    useTasks.setState({ tasks: {} });
    mockSettings = { ...DEFAULT_SETTINGS };
    mockSetSidecarUp.mockClear();
    mockPostTaskWebhook.mockClear();
    mockProbeSidecar.mockReset();
  });

  it("registers a running model-download task immediately, labeled from MODEL_CATALOG", () => {
    const id = trackSwitchModel(fakeHandle(), "medium");
    expect(task(id)).toMatchObject({
      kind: "model-download",
      label: "均衡·推荐 (zh-en)",
      status: "running",
    });
  });

  it("falls back to the raw model id as the label when it's not in MODEL_CATALOG (manual/legacy model)", () => {
    const id = trackSwitchModel(fakeHandle(), "custom-ct2-dir");
    expect(task(id).label).toBe("custom-ct2-dir");
  });

  it("modelForTask remembers the model this task was started for", () => {
    const id = trackSwitchModel(fakeHandle(), "large-v3");
    expect(modelForTask(id)).toBe("large-v3");
  });

  it("modelForTask returns undefined for an id it never tracked", () => {
    expect(modelForTask("never-seen")).toBeUndefined();
  });

  // F11 (LOW, adversarial review): modelByTaskId is a private side-table
  // in jobsBridge.ts, NOT registry.ts's own `tasks` map — its doc
  // comment used to (falsely) claim MAX_TERMINAL_TASKS already bounded
  // it. It must now prune in lockstep with the task's ACTUAL removal
  // from the registry (dismiss OR the registry's own FIFO eviction) —
  // never merely on settle (done/error), since TaskCenterDrawer's 重试
  // retry action reads modelForTask back for an already-settled
  // (error) task.
  describe("modelByTaskId pruning (F11)", () => {
    it("still resolves for a task that has already settled (done) but not yet dismissed/pruned — the retry flow depends on this surviving completion", async () => {
      const id = trackSwitchModel(fakeHandle(), "medium");
      await flush();
      expect(task(id).status).toBe("done");
      expect(modelForTask(id)).toBe("medium");
    });

    it("is pruned once the task is explicitly dismissed from the registry", async () => {
      const id = trackSwitchModel(fakeHandle(), "medium");
      await flush();
      expect(modelForTask(id)).toBe("medium");

      dismissTask(id);

      expect(modelForTask(id)).toBeUndefined();
    });

    it("is pruned once the registry's own MAX_TERMINAL_TASKS (20) FIFO eviction removes the task, even without an explicit dismiss", async () => {
      const id = trackSwitchModel(fakeHandle(), "medium");
      await flush();
      expect(task(id).status).toBe("done");
      expect(modelForTask(id)).toBe("medium");

      // pruneTerminalTasks only runs inside startTask itself — 20 more
      // terminal (done) tasks, then one more startTask to trigger the
      // prune check that finally evicts the (now oldest) original task.
      for (let i = 0; i < 20; i++) {
        const fillerId = `filler-${i}`;
        startTask(fillerId, "model-download", "filler");
        completeTask(fillerId);
      }
      startTask("trigger-prune", "model-download", "trigger");

      expect(useTasks.getState().tasks[id]).toBeUndefined(); // sanity: the registry itself evicted it
      expect(modelForTask(id)).toBeUndefined();
    });

    it("a still-running task's model mapping is never pruned merely by OTHER tasks settling/dismissing", async () => {
      const id = trackSwitchModel(
        fakeHandle({ switchModel: async () => new Promise(() => {}) }), // never settles
        "medium",
      );
      expect(task(id).status).toBe("running");

      const otherId = trackSwitchModel(fakeHandle(), "large-v3");
      await flush();
      dismissTask(otherId);

      expect(modelForTask(id)).toBe("medium");
    });
  });

  it("subscribes to switchModelProgress$ before calling switchModel — a progress tick fired synchronously from inside the fake switchModel still lands", () => {
    let listener: ((p: SwitchModelProgress | null) => void) | null = null;
    const handle = fakeHandle({
      switchModelProgress$: (l) => {
        listener = l;
        return () => {};
      },
      switchModel: async () => {
        // Fires synchronously, before switchModel's own first await —
        // only reaches the task if the listener was ALREADY registered
        // by the time this runs.
        listener?.({ phase: "downloading", progress: 0.4 });
        await new Promise(() => {}); // never resolves — this test doesn't need settle
      },
    });

    const id = trackSwitchModel(handle, "medium");

    expect(task(id).stage).toBe("下载中");
    expect(task(id).progress).toBe(0.4);
  });

  it("phase:restarting clears progress (no trustworthy fraction left) and sets stage 启动中", () => {
    let listener: ((p: SwitchModelProgress | null) => void) | null = null;
    const handle = fakeHandle({
      switchModelProgress$: (l) => {
        listener = l;
        return () => {};
      },
    });
    const id = trackSwitchModel(handle, "medium");

    listener!({ phase: "downloading", progress: 0.7 });
    expect(task(id).progress).toBe(0.7);

    listener!({ phase: "restarting" });
    expect(task(id).stage).toBe("启动中");
    expect(task(id).progress).toBeUndefined();
  });

  it("a null progress update (bootstrap.ts's own reset-at-both-ends) is a no-op, not a crash", () => {
    let listener: ((p: SwitchModelProgress | null) => void) | null = null;
    const handle = fakeHandle({
      switchModelProgress$: (l) => {
        listener = l;
        return () => {};
      },
    });
    const id = trackSwitchModel(handle, "medium");
    expect(() => listener!(null)).not.toThrow();
    expect(task(id).stage).toBe(""); // untouched — startTask's own initial stage
  });

  // S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
  // Provision/Task 7) — an mlx-family switch's leading extras phase
  // gets its OWN "mlx-install" task row, separate from the
  // "model-download" row trackSwitchModel already starts immediately.
  describe("mlx-install task row (§C Provision/Task 7)", () => {
    it("a plain whisper-family switch (no mlx-* phase ever fires) never creates a second task row", () => {
      let listener: ((p: SwitchModelProgress | null) => void) | null = null;
      const handle = fakeHandle({
        switchModelProgress$: (l) => {
          listener = l;
          return () => {};
        },
      });
      trackSwitchModel(handle, "medium");

      listener!({ phase: "downloading", progress: 0.3 });
      listener!({ phase: "restarting" });

      const tasks = Object.values(useTasks.getState().tasks);
      expect(tasks).toHaveLength(1); // only the "model-download" row
      expect(tasks[0].kind).toBe("model-download");
    });

    it("the FIRST mlx-* phase update lazily starts a running 'mlx-install' row, labeled MLX 运行环境, stage from MLX_INSTALL_STAGE_LABELS", () => {
      let listener: ((p: SwitchModelProgress | null) => void) | null = null;
      const handle = fakeHandle({
        switchModelProgress$: (l) => {
          listener = l;
          return () => {};
        },
      });
      trackSwitchModel(handle, "parakeet-tdt-0.6b-v3");

      listener!({ phase: "mlx-venv" });

      const mlxTask = Object.values(useTasks.getState().tasks).find((t) => t.kind === "mlx-install");
      expect(mlxTask).toMatchObject({ kind: "mlx-install", label: "MLX 运行环境", stage: "创建虚拟环境", status: "running" });
    });

    it("subsequent mlx-* phases update the SAME row's stage, never starting a second one", () => {
      let listener: ((p: SwitchModelProgress | null) => void) | null = null;
      const handle = fakeHandle({
        switchModelProgress$: (l) => {
          listener = l;
          return () => {};
        },
      });
      trackSwitchModel(handle, "parakeet-tdt-0.6b-v3");

      listener!({ phase: "mlx-venv" });
      const mlxTaskId = Object.values(useTasks.getState().tasks).find((t) => t.kind === "mlx-install")!.id;
      listener!({ phase: "mlx-pip" });
      listener!({ phase: "mlx-preflight" });

      const mlxTasks = Object.values(useTasks.getState().tasks).filter((t) => t.kind === "mlx-install");
      expect(mlxTasks).toHaveLength(1);
      expect(mlxTasks[0].id).toBe(mlxTaskId);
      expect(mlxTasks[0].stage).toBe("检查依赖");
    });

    it("transitioning to 'downloading' completes the mlx-install row (its own success signal) and proceeds with the ordinary model-download row handling", () => {
      let listener: ((p: SwitchModelProgress | null) => void) | null = null;
      const handle = fakeHandle({
        switchModelProgress$: (l) => {
          listener = l;
          return () => {};
        },
      });
      const modelDownloadId = trackSwitchModel(handle, "parakeet-tdt-0.6b-v3");

      listener!({ phase: "mlx-venv" });
      const mlxTaskId = Object.values(useTasks.getState().tasks).find((t) => t.kind === "mlx-install")!.id;
      listener!({ phase: "mlx-preflight" });
      listener!({ phase: "downloading", progress: 0.1 });

      expect(task(mlxTaskId).status).toBe("done");
      expect(task(modelDownloadId).stage).toBe("下载中");
      expect(task(modelDownloadId).progress).toBe(0.1);
    });

    it("if switchModel() rejects while the mlx row is STILL open (extras never reached downloading), that row is ALSO failed, with the same rejection message", async () => {
      let listener: ((p: SwitchModelProgress | null) => void) | null = null;
      const handle = fakeHandle({
        switchModelProgress$: (l) => {
          listener = l;
          return () => {};
        },
        switchModel: async () => {
          listener!({ phase: "mlx-venv" });
          throw new Error("当前设备不支持 Apple 芯片 MLX 加速");
        },
      });
      const modelDownloadId = trackSwitchModel(handle, "parakeet-tdt-0.6b-v3");
      await flush();

      const mlxTask = Object.values(useTasks.getState().tasks).find((t) => t.kind === "mlx-install")!;
      expect(mlxTask.status).toBe("error");
      expect(mlxTask.error).toBe("当前设备不支持 Apple 芯片 MLX 加速");
      expect(task(modelDownloadId).status).toBe("error");
      expect(task(modelDownloadId).error).toBe("当前设备不支持 Apple 芯片 MLX 加速");
    });

    it("if switchModel() SUCCEEDS after the mlx row already completed (transitioned to downloading), the mlx row is NOT touched again on settle", async () => {
      let listener: ((p: SwitchModelProgress | null) => void) | null = null;
      const handle = fakeHandle({
        switchModelProgress$: (l) => {
          listener = l;
          return () => {};
        },
        switchModel: async () => {
          listener!({ phase: "mlx-venv" });
          listener!({ phase: "downloading", progress: 1 });
          listener!({ phase: "restarting" });
        },
      });
      trackSwitchModel(handle, "parakeet-tdt-0.6b-v3");
      await flush();

      const mlxTask = Object.values(useTasks.getState().tasks).find((t) => t.kind === "mlx-install")!;
      expect(mlxTask.status).toBe("done"); // completed at the "downloading" transition, untouched since
    });
  });

  it("on success: marks the task done and unsubscribes from progress", async () => {
    const unsubscribe = vi.fn();
    const handle = fakeHandle({
      switchModelProgress$: () => unsubscribe,
      switchModel: async () => {},
    });

    const id = trackSwitchModel(handle, "medium");
    await flush();

    expect(task(id).status).toBe("done");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("on failure: marks the task error with the rejection message and still unsubscribes", async () => {
    const unsubscribe = vi.fn();
    const handle = fakeHandle({
      switchModelProgress$: () => unsubscribe,
      switchModel: async () => {
        throw new Error("本地服务当前不可用，暂时无法切换模型");
      },
    });

    const id = trackSwitchModel(handle, "medium");
    await flush();

    expect(task(id).status).toBe("error");
    expect(task(id).error).toBe("本地服务当前不可用，暂时无法切换模型");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("a non-Error rejection is stringified rather than crashing the tracker", async () => {
    const handle = fakeHandle({
      switchModel: async () => {
        throw "plain string failure";
      },
    });

    const id = trackSwitchModel(handle, "medium");
    await flush();

    expect(task(id).status).toBe("error");
    expect(task(id).error).toBe("plain string failure");
  });
});

describe("trackPrewarm (field-test issue 6 — first-run download background-and-track)", () => {
  beforeEach(() => {
    useTasks.setState({ tasks: {} });
    mockSettings = { ...DEFAULT_SETTINGS };
    mockSetSidecarUp.mockClear();
    mockPostTaskWebhook.mockClear();
    mockProbeSidecar.mockReset();
  });

  /** Mirrors trackSwitchModel's own "subscribes to switchModelProgress$
   *  before calling switchModel" test's pattern (capturing a listener via
   *  a custom override) — trackPrewarm is PUSH-driven (no Promise of its
   *  own to await), so its tests drive it by calling the captured
   *  state$/downloadProgress$ listeners directly, exactly like the real
   *  DesktopBootstrapHandle would. */
  function fakeTrackableHandle(overrides: Partial<DesktopBootstrapHandle> = {}) {
    const listeners: {
      state: ((s: DesktopBootstrapState) => void) | null;
      progress: ((p: PrewarmProgressEvent | null) => void) | null;
    } = { state: null, progress: null };
    const unsubCounts = { state: 0, progress: 0 };
    const handle = fakeHandle({
      // F5 (Sol LOW #21, review round): defaults to a genuinely
      // in-flight snapshot — the realistic state at the one real call
      // site (DesktopBootstrap.tsx's onBackgroundDownload, always mid
      // STEP/DOWNLOAD_MODEL/RUNNING) — so trackPrewarm's own new
      // currentState() seed-check (see jobsBridge.ts) doesn't
      // immediately settle every OTHER test in this block, which drives
      // the flow via emitState() instead. The dedicated describe block
      // below overrides this to exercise the seed-check itself.
      currentState: () => ({ phase: "STEP", step: "DOWNLOAD_MODEL", status: "RUNNING" }),
      // Unsubscribing actually clears the reference (not just a
      // counter bump) — mirrors bootstrap.ts's own real Set.delete()
      // behavior, so a stray emitState/emitProgress call AFTER
      // trackPrewarm settles is a genuine no-op in these tests too,
      // exactly like it would be against the real handle.
      state$: (l) => {
        listeners.state = l;
        return () => {
          unsubCounts.state += 1;
          listeners.state = null;
        };
      },
      downloadProgress$: (l) => {
        listeners.progress = l;
        return () => {
          unsubCounts.progress += 1;
          listeners.progress = null;
        };
      },
      ...overrides,
    });
    return {
      handle,
      emitState: (s: DesktopBootstrapState) => listeners.state?.(s),
      emitProgress: (p: PrewarmProgressEvent | null) => listeners.progress?.(p),
      unsubCounts,
    };
  }

  it("registers a running model-download task immediately, labeled from MODEL_CATALOG", () => {
    const { handle } = fakeTrackableHandle();
    const id = trackPrewarm(handle, "medium");
    expect(task(id)).toMatchObject({
      kind: "model-download",
      label: "均衡·推荐 (zh-en)",
      status: "running",
    });
  });

  it("falls back to the raw model id as the label when it's not in MODEL_CATALOG", () => {
    const { handle } = fakeTrackableHandle();
    const id = trackPrewarm(handle, "custom-ct2-dir");
    expect(task(id).label).toBe("custom-ct2-dir");
  });

  it("is NEVER registered in modelByTaskId — unlike trackSwitchModel, so TaskCenterDrawer's 重试 button (gated on modelForTask) never renders for a first-run download row", () => {
    const { handle } = fakeTrackableHandle();
    const id = trackPrewarm(handle, "medium");
    expect(modelForTask(id)).toBeUndefined();
  });

  it("forwards downloadProgress$ ticks as a downloaded/total fraction with a 下载中 stage", () => {
    const { handle, emitProgress } = fakeTrackableHandle();
    const id = trackPrewarm(handle, "medium");

    emitProgress({ downloaded: 25, total: 100 });

    expect(task(id)).toMatchObject({ progress: 0.25, stage: "下载中" });
  });

  it("a zero/unknown total omits progress (undefined) rather than dividing by zero", () => {
    const { handle, emitProgress } = fakeTrackableHandle();
    const id = trackPrewarm(handle, "medium");

    emitProgress({ downloaded: 0, total: 0 });

    expect(task(id).progress).toBeUndefined();
  });

  it("a null progress tick (no active phase) is ignored, never overwriting the last real tick", () => {
    const { handle, emitProgress } = fakeTrackableHandle();
    const id = trackPrewarm(handle, "medium");

    emitProgress({ downloaded: 25, total: 100 });
    emitProgress(null);

    expect(task(id).progress).toBe(0.25);
  });

  it("HEALTHY completes the task and unsubscribes both listeners", () => {
    const { handle, emitState, unsubCounts } = fakeTrackableHandle();
    const id = trackPrewarm(handle, "medium");

    emitState({ phase: "HEALTHY" });

    expect(task(id).status).toBe("done");
    expect(unsubCounts).toEqual({ state: 1, progress: 1 });
  });

  it("STEP/ERROR fails the task with the machine's own error message — a genuine crash, e.g. disk full", () => {
    const { handle, emitState, unsubCounts } = fakeTrackableHandle();
    const id = trackPrewarm(handle, "medium");

    emitState({ phase: "STEP", step: "DOWNLOAD_MODEL", status: "ERROR", error: "磁盘空间不足", retriable: true });

    expect(task(id)).toMatchObject({ status: "error", error: "磁盘空间不足" });
    expect(unsubCounts).toEqual({ state: 1, progress: 1 });
  });

  it("leaving STEP any other way (in practice: cancel_prewarm's own WIZARD_CONSENT_REQUIRED landing spot, bootstrap.ts's downloadWasCancelled interception) fails the task with 已取消", () => {
    const { handle, emitState, unsubCounts } = fakeTrackableHandle();
    const id = trackPrewarm(handle, "medium");

    emitState({ phase: "WIZARD_CONSENT_REQUIRED" });

    expect(task(id)).toMatchObject({ status: "error", error: "已取消" });
    expect(unsubCounts).toEqual({ state: 1, progress: 1 });
  });

  it("an in-flight STEP transition (still RUNNING/POLLING, non-ERROR) never settles the task early", () => {
    const { handle, emitState } = fakeTrackableHandle();
    const id = trackPrewarm(handle, "medium");

    emitState({ phase: "STEP", step: "DOWNLOAD_MODEL", status: "RUNNING" });
    emitState({ phase: "STEP", step: "STARTING", status: "RUNNING" });
    emitState({ phase: "STEP", step: "POLLING_HEALTH", status: "POLLING", attempts: 1 });

    expect(task(id).status).toBe("running");
  });

  it("settles exactly once — a stray notification after HEALTHY never re-fires (both listeners already unsubscribed)", () => {
    const { handle, emitState, unsubCounts } = fakeTrackableHandle();
    const id = trackPrewarm(handle, "medium");

    emitState({ phase: "HEALTHY" });
    expect(unsubCounts).toEqual({ state: 1, progress: 1 }); // unsubscribed after the first settle — a later emitState call below is a no-op precisely because nothing is listening anymore
    emitState({ phase: "STEP", step: "DOWNLOAD_MODEL", status: "ERROR", error: "should never apply", retriable: true });

    expect(task(id).status).toBe("done"); // unchanged
  });

  // F5 (Sol LOW #21, review round): trackPrewarm used to subscribe to
  // the non-replaying state$ WITHOUT ever seeding from currentState() —
  // a caller invoked in a stale render, after the drive already
  // delivered HEALTHY/ERROR/etc. before trackPrewarm ever subscribed,
  // would see no further notification and the tray row got stuck
  // "running" until reload. Fixed by checking currentState() at track
  // time and settling immediately when it's already terminal.
  describe("currentState() seed check (F5) — a stale render started AFTER the drive already went terminal", () => {
    it("HEALTHY at track time settles the task immediately instead of subscribing", () => {
      const { handle, unsubCounts } = fakeTrackableHandle({ currentState: () => ({ phase: "HEALTHY" }) });
      const id = trackPrewarm(handle, "medium");

      expect(task(id).status).toBe("done");
      expect(unsubCounts).toEqual({ state: 0, progress: 0 }); // never even subscribed
    });

    it("a STEP/ERROR snapshot at track time fails the task immediately with the machine's own error message", () => {
      const { handle, unsubCounts } = fakeTrackableHandle({
        currentState: () => ({
          phase: "STEP",
          step: "DOWNLOAD_MODEL",
          status: "ERROR",
          error: "磁盘空间不足",
          retriable: true,
        }),
      });
      const id = trackPrewarm(handle, "medium");

      expect(task(id)).toMatchObject({ status: "error", error: "磁盘空间不足" });
      expect(unsubCounts).toEqual({ state: 0, progress: 0 });
    });

    it("a non-STEP snapshot (e.g. WIZARD_CONSENT_REQUIRED — cancel_prewarm's own landing spot) fails the task immediately with 已取消", () => {
      const { handle, unsubCounts } = fakeTrackableHandle({
        currentState: () => ({ phase: "WIZARD_CONSENT_REQUIRED" }),
      });
      const id = trackPrewarm(handle, "medium");

      expect(task(id)).toMatchObject({ status: "error", error: "已取消" });
      expect(unsubCounts).toEqual({ state: 0, progress: 0 });
    });

    it("an in-flight STEP snapshot at track time subscribes normally, exactly like before this fix", () => {
      const { handle, emitState, unsubCounts } = fakeTrackableHandle({
        currentState: () => ({ phase: "STEP", step: "DOWNLOAD_MODEL", status: "RUNNING" }),
      });
      const id = trackPrewarm(handle, "medium");

      expect(task(id).status).toBe("running");
      expect(unsubCounts).toEqual({ state: 0, progress: 0 }); // subscribed, nothing settled yet

      emitState({ phase: "HEALTHY" });
      expect(task(id).status).toBe("done");
    });
  });
});

describe("trackInstallDiar", () => {
  beforeEach(() => {
    useTasks.setState({ tasks: {} });
    mockSettings = { ...DEFAULT_SETTINGS };
    mockSetSidecarUp.mockClear();
    mockPostTaskWebhook.mockClear();
    mockProbeSidecar.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers an indeterminate running diar-install task immediately (stage 安装中, no progress)", () => {
    const id = trackInstallDiar(fakeHandle());
    expect(task(id)).toMatchObject({
      kind: "diar-install",
      label: "说话人分离扩展",
      stage: "安装中",
      status: "running",
    });
    expect(task(id).progress).toBeUndefined();
  });

  it("on success: re-probes the sidecar, mirrors the result into the store, then completes the task", async () => {
    mockProbeSidecar.mockResolvedValue({ up: true, installed: true });
    const handle = fakeHandle({ installDiarization: async () => {} });

    const id = trackInstallDiar(handle);
    await flush();

    expect(mockProbeSidecar).toHaveBeenCalledWith(mockSettings);
    expect(mockSetSidecarUp).toHaveBeenCalledWith(true);
    expect(task(id).status).toBe("done");
  });

  it("on failure: fails the task and never re-probes (the install itself didn't happen)", async () => {
    const handle = fakeHandle({
      installDiarization: async () => {
        throw new Error("退出码 1");
      },
    });

    const id = trackInstallDiar(handle);
    await flush();

    expect(task(id).status).toBe("error");
    expect(task(id).error).toBe("退出码 1");
    expect(mockProbeSidecar).not.toHaveBeenCalled();
  });

  it("a non-Error rejection is stringified rather than crashing the tracker", async () => {
    const handle = fakeHandle({
      installDiarization: async () => {
        throw "plain string failure";
      },
    });

    const id = trackInstallDiar(handle);
    await flush();

    expect(task(id).status).toBe("error");
    expect(task(id).error).toBe("plain string failure");
  });
});

// S11 (v0.4.3, docs/design-explorations/s11-osspeech-blueprint.md) — a
// PUSH-style driver rather than a subscribe-a-Promise-returning-action
// one (unlike trackSwitchModel/trackInstallDiar above): both
// OsSpeechEngine's own osspeech://status listener and osspeechCaps.ts's
// preinstallOsSpeech feed events into the tracker returned here from
// THEIR OWN listen() call — this module owns no listener of its own, so
// these tests just call `.handle(...)` directly.
describe("trackOsSpeechAsset", () => {
  beforeEach(() => {
    useTasks.setState({ tasks: {} });
    mockSettings = { ...DEFAULT_SETTINGS };
    mockPostTaskWebhook.mockClear();
  });

  it("asset-checking alone never starts a task row (§2.6: only asset-downloading does)", () => {
    const tracker = trackOsSpeechAsset();
    tracker.handle("asset-checking");
    expect(useTasks.getState().tasks).toEqual({});
  });

  it("asset-downloading lazily starts a running task row, labeled 系统识别模型 by default", () => {
    const tracker = trackOsSpeechAsset();
    tracker.handle("asset-downloading", 0.3);

    const tasks = Object.values(useTasks.getState().tasks);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      kind: "os-speech-asset",
      label: "系统识别模型",
      stage: "下载中",
      progress: 0.3,
      status: "running",
    });
  });

  it("accepts a custom label (e.g. preinstallOsSpeech's own attempt)", () => {
    const tracker = trackOsSpeechAsset("系统识别模型（预下载）");
    tracker.handle("asset-downloading", 0.1);

    const tasks = Object.values(useTasks.getState().tasks);
    expect(tasks[0].label).toBe("系统识别模型（预下载）");
  });

  it("repeated asset-downloading events update the SAME row's progress rather than starting a new one", () => {
    const tracker = trackOsSpeechAsset();
    tracker.handle("asset-downloading", 0.2);
    const idAfterFirst = Object.keys(useTasks.getState().tasks)[0];

    tracker.handle("asset-downloading", 0.9);

    const tasks = useTasks.getState().tasks;
    expect(Object.keys(tasks)).toEqual([idAfterFirst]);
    expect(tasks[idAfterFirst].progress).toBe(0.9);
  });

  it("asset-installed completes the row that asset-downloading started", () => {
    const tracker = trackOsSpeechAsset();
    tracker.handle("asset-downloading", 0.5);
    tracker.handle("asset-installed");

    const tasks = Object.values(useTasks.getState().tasks);
    expect(tasks[0].status).toBe("done");
  });

  it("asset-installed with NO prior downloading is a no-op (model was already installed — no row to complete)", () => {
    const tracker = trackOsSpeechAsset();
    tracker.handle("asset-installed");

    expect(useTasks.getState().tasks).toEqual({});
  });

  it("asset-failed after a downloading row fails that SAME row with the given message", () => {
    const tracker = trackOsSpeechAsset();
    tracker.handle("asset-downloading", 0.4);
    tracker.handle("asset-failed", undefined, "network unreachable");

    const tasks = Object.values(useTasks.getState().tasks);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "error", error: "network unreachable" });
  });

  it("asset-failed with NO prior downloading (e.g. a checking-phase failure) still surfaces a NEW failed row, defensively", () => {
    const tracker = trackOsSpeechAsset();
    tracker.handle("asset-failed", undefined, "disk read error");

    const tasks = Object.values(useTasks.getState().tasks);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "error", error: "disk read error" });
  });

  it("asset-failed with no message falls back to a generic zh failure string", () => {
    const tracker = trackOsSpeechAsset();
    tracker.handle("asset-failed");

    const tasks = Object.values(useTasks.getState().tasks);
    expect(tasks[0].error).toBe("系统识别模型下载失败");
  });

  it("a FRESH tracker per call never reuses a PRIOR tracker's already-settled task id", () => {
    const first = trackOsSpeechAsset();
    first.handle("asset-downloading", 1);
    first.handle("asset-installed");
    const firstId = Object.keys(useTasks.getState().tasks)[0];

    const second = trackOsSpeechAsset();
    second.handle("asset-downloading", 0.1);

    const tasks = useTasks.getState().tasks;
    expect(Object.keys(tasks)).toHaveLength(2);
    expect(tasks[firstId].status).toBe("done"); // untouched by the second tracker
  });

  // S11 fix-round J2(b) — single-flight across DIFFERENT tracker
  // instances: the preempt handoff (a session start superseding an
  // in-flight preinstall, per osSpeech.ts's own osspeech://status
  // `source` contract) must show exactly ONE "os-speech-asset" row
  // throughout — the session's OWN, freshly-minted tracker (a "FRESH
  // tracker every start()", per this file's own trackOsSpeechAsset doc)
  // must ADOPT whichever row is already running rather than starting a
  // second one the moment ITS OWN asset events start arriving.
  describe("single-flight across trackers (J2b preempt handoff)", () => {
    it("a SECOND tracker's asset-downloading ADOPTS the first tracker's still-running row rather than starting a new one", () => {
      const first = trackOsSpeechAsset("系统识别模型（预下载）");
      first.handle("asset-downloading", 0.3);
      const firstId = Object.keys(useTasks.getState().tasks)[0];

      const second = trackOsSpeechAsset(); // e.g. the session's own fresh per-start() tracker
      second.handle("asset-downloading", 0.6);

      const tasks = useTasks.getState().tasks;
      expect(Object.keys(tasks)).toEqual([firstId]); // still exactly ONE row
      expect(tasks[firstId].progress).toBe(0.6); // driven by the second tracker now
      expect(tasks[firstId].label).toBe("系统识别模型（预下载）"); // adopted row keeps its ORIGINAL label
    });

    it("a SECOND tracker's asset-installed completes the FIRST tracker's row, even though the second tracker never itself saw asset-downloading", () => {
      const first = trackOsSpeechAsset();
      first.handle("asset-downloading", 0.9);
      const firstId = Object.keys(useTasks.getState().tasks)[0];

      const second = trackOsSpeechAsset();
      second.handle("asset-installed");

      expect(useTasks.getState().tasks[firstId].status).toBe("done");
    });

    it("a SECOND tracker's asset-failed fails the FIRST tracker's row (adopted, not a second one)", () => {
      const first = trackOsSpeechAsset();
      first.handle("asset-downloading", 0.5);
      const firstId = Object.keys(useTasks.getState().tasks)[0];

      const second = trackOsSpeechAsset();
      second.handle("asset-failed", undefined, "network unreachable");

      const tasks = useTasks.getState().tasks;
      expect(Object.keys(tasks)).toEqual([firstId]);
      expect(tasks[firstId]).toMatchObject({ status: "error", error: "network unreachable" });
    });

    it("does NOT adopt an already-SETTLED (done) row — a genuinely new attempt after a prior one finished still starts its own fresh row", () => {
      const first = trackOsSpeechAsset();
      first.handle("asset-downloading", 1);
      first.handle("asset-installed");
      const firstId = Object.keys(useTasks.getState().tasks)[0];

      const second = trackOsSpeechAsset();
      second.handle("asset-downloading", 0.1);

      const tasks = useTasks.getState().tasks;
      expect(Object.keys(tasks)).toHaveLength(2);
      expect(tasks[firstId].status).toBe("done"); // untouched
    });
  });

  // S11 fix-round J2(c) — settle(): neutral-fails a still-RUNNING row
  // when the flow ends some OTHER way (any osspeech://status terminal
  // kind besides asset-installed/asset-failed, both already handled via
  // `handle` — see osSpeech.ts's own handleStatus terminal-latch branch,
  // the real caller). Looks up the CURRENTLY active row via the
  // registry, not just this tracker's own local id, so it settles the
  // right row even in the preempt-handoff case (a DIFFERENT tracker
  // started it).
  describe("settle() (J2c)", () => {
    it("fails a row this SAME tracker started, if still running", () => {
      const tracker = trackOsSpeechAsset();
      tracker.handle("asset-downloading", 0.4);

      tracker.settle();

      const tasks = Object.values(useTasks.getState().tasks);
      expect(tasks[0]).toMatchObject({ status: "error", error: "系统识别已停止，模型下载未完成" });
    });

    it("fails a row a DIFFERENT tracker started (preempt-handoff case) — looks up the registry, not just its own local id", () => {
      const preinstallTracker = trackOsSpeechAsset("系统识别模型（预下载）");
      preinstallTracker.handle("asset-downloading", 0.2);
      const rowId = Object.keys(useTasks.getState().tasks)[0];

      const sessionTracker = trackOsSpeechAsset(); // never itself saw asset-downloading
      sessionTracker.settle();

      expect(useTasks.getState().tasks[rowId].status).toBe("error");
    });

    it("is a no-op when no row was ever started", () => {
      const tracker = trackOsSpeechAsset();

      expect(() => tracker.settle()).not.toThrow();
      expect(useTasks.getState().tasks).toEqual({});
    });

    it("is a no-op once the row already reached 'done' — never re-fails an already-succeeded install", () => {
      const tracker = trackOsSpeechAsset();
      tracker.handle("asset-downloading", 1);
      tracker.handle("asset-installed");
      const id = Object.keys(useTasks.getState().tasks)[0];

      tracker.settle();

      expect(useTasks.getState().tasks[id].status).toBe("done");
    });

    it("is a no-op once the row already reached 'error' — never overwrites asset-failed's own real message with the generic 已停止 one", () => {
      const tracker = trackOsSpeechAsset();
      tracker.handle("asset-downloading", 1);
      tracker.handle("asset-failed", undefined, "network unreachable");
      const id = Object.keys(useTasks.getState().tasks)[0];

      tracker.settle();

      expect(useTasks.getState().tasks[id].error).toBe("network unreachable");
    });
  });
});
