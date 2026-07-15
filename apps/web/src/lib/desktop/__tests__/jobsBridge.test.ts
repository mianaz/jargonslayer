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

import { modelForTask, trackInstallDiar, trackOsSpeechAsset, trackSwitchModel } from "../jobsBridge";
import { completeTask, dismissTask, startTask, useTasks, type TaskState } from "../../tasks/registry";
import type { DesktopBootstrapHandle, SwitchModelProgress } from "../bootstrap";
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
    installedModel: async () => null,
    switchModel: async () => {},
    switchModelProgress$: () => () => {},
    currentSwitchModelProgress: () => null,
    installDiarization: async () => {},
    readSidecarLog: async () => "",
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
});
