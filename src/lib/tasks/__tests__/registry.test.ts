import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPostTaskWebhook = vi.fn(async (_task: unknown, _event: string, _url: string) => {});
vi.mock("../../history/autoExport", () => ({
  postTaskWebhook: (task: unknown, event: string, url: string) =>
    mockPostTaskWebhook(task, event, url),
}));

let webhookUrl = "";
vi.mock("../../store", () => ({
  useApp: {
    getState: () => ({ settings: { webhookUrl } }),
  },
}));

import {
  completeTask,
  dismissTask,
  failTask,
  runTracked,
  runTrackedAsync,
  selectHasTasks,
  selectRunningCount,
  selectRunningTasks,
  selectTrayTasks,
  startTask,
  updateTaskProgress,
  useTasks,
  type TaskState,
} from "../registry";

describe("task registry lifecycle (#58)", () => {
  beforeEach(() => {
    useTasks.setState({ tasks: {} });
    webhookUrl = "";
    mockPostTaskWebhook.mockClear();
    vi.useRealTimers();
  });

  it("startTask registers a running task with empty stage and no progress/sessionId/error", () => {
    const task = startTask("t1", "import-audio", "meeting.wav");
    expect(task).toMatchObject({
      id: "t1",
      kind: "import-audio",
      label: "meeting.wav",
      stage: "",
      status: "running",
    });
    expect(task.progress).toBeUndefined();
    expect(task.sessionId).toBeUndefined();
    expect(task.error).toBeUndefined();
    expect(useTasks.getState().tasks.t1).toEqual(task);
  });

  it("updateTaskProgress patches stage/progress and bumps updatedAt without touching status", async () => {
    startTask("t1", "import-audio", "meeting.wav");
    const before = useTasks.getState().tasks.t1.updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    updateTaskProgress("t1", 0.4, "转录中");
    const task = useTasks.getState().tasks.t1;
    expect(task.progress).toBe(0.4);
    expect(task.stage).toBe("转录中");
    expect(task.status).toBe("running");
    expect(task.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("completeTask marks status done and records the sessionId", () => {
    startTask("t1", "import-url", "https://example.com/x");
    completeTask("t1", "session-42");
    const task = useTasks.getState().tasks.t1;
    expect(task.status).toBe("done");
    expect(task.sessionId).toBe("session-42");
  });

  it("failTask marks status error and records the message", () => {
    startTask("t1", "import-text", "粘贴的文稿");
    failTask("t1", "解析失败");
    const task = useTasks.getState().tasks.t1;
    expect(task.status).toBe("error");
    expect(task.error).toBe("解析失败");
  });

  it("progress/complete/fail on an unknown id are no-ops (no throw, no phantom entry)", () => {
    updateTaskProgress("ghost", 0.5, "x");
    completeTask("ghost", "s1");
    failTask("ghost", "e");
    expect(useTasks.getState().tasks).toEqual({});
  });

  it("dismissTask removes the entry entirely; dismissing twice is a no-op", () => {
    startTask("t1", "import-audio", "a.wav");
    dismissTask("t1");
    expect(useTasks.getState().tasks.t1).toBeUndefined();
    expect(() => dismissTask("t1")).not.toThrow();
  });
});

describe("runTracked — ImportCallbacks-shaped wrapper (importAndTrack/importUrlAndTrack call sites)", () => {
  beforeEach(() => {
    useTasks.setState({ tasks: {} });
    webhookUrl = "";
    mockPostTaskWebhook.mockClear();
  });

  it("registers a running task immediately and returns its id", () => {
    let captured: { onProgress: (p: number, s: string) => void } | null = null;
    const id = runTracked("import-audio", "meeting.wav", (cb) => {
      captured = cb;
    });
    expect(useTasks.getState().tasks[id]).toMatchObject({
      status: "running",
      kind: "import-audio",
      label: "meeting.wav",
    });
    expect(captured).not.toBeNull();
  });

  it("the callbacks handed to fn write progress/done into the registry, alongside whatever the caller's own callbacks do", () => {
    const callerSeen: { progress: number[]; done?: string; error?: string } = { progress: [] };
    const id = runTracked("import-video", "clip.mp4", (cb) => {
      cb.onProgress(0.2, "转录中");
      callerSeen.progress.push(0.2);
      cb.onProgress(0.9, "构建会话");
      callerSeen.progress.push(0.9);
      cb.onDone("session-9");
      callerSeen.done = "session-9";
    });
    const task = useTasks.getState().tasks[id];
    expect(task.status).toBe("done");
    expect(task.progress).toBe(0.9);
    expect(task.stage).toBe("构建会话");
    expect(task.sessionId).toBe("session-9");
    expect(callerSeen).toEqual({ progress: [0.2, 0.9], done: "session-9" });
  });

  it("onError writes a failed task, mirroring importAndTrack's never-throws contract", () => {
    const id = runTracked("import-audio", "meeting.wav", (cb) => {
      cb.onError("上传失败（500）");
    });
    const task = useTasks.getState().tasks[id];
    expect(task.status).toBe("error");
    expect(task.error).toBe("上传失败（500）");
  });
});

describe("runTrackedAsync — Promise-shaped wrapper (importAudio.ts/importText.ts call sites)", () => {
  beforeEach(() => {
    useTasks.setState({ tasks: {} });
    webhookUrl = "";
    mockPostTaskWebhook.mockClear();
  });

  it("resolves normally, marking the task done with the resolved sessionId, reporting progress along the way", async () => {
    const { id, result } = runTrackedAsync("import-text", "粘贴的文稿", async (onProgress) => {
      onProgress(0.5, "检测 1/2");
      onProgress(1, "检测 2/2");
      return { sessionId: "session-7", warnings: [] };
    });

    expect(useTasks.getState().tasks[id].status).toBe("running");
    const value = await result;
    expect(value).toEqual({ sessionId: "session-7", warnings: [] });

    const task = useTasks.getState().tasks[id];
    expect(task.status).toBe("done");
    expect(task.sessionId).toBe("session-7");
    expect(task.progress).toBe(1);
    expect(task.stage).toBe("检测 2/2");
  });

  it("a rejection marks the task error AND rethrows to the caller (registry recording never swallows the original failure)", async () => {
    const { id, result } = runTrackedAsync("import-video", "clip.mp4", async () => {
      throw new Error("视频过大（超过 400 MB）");
    });

    await expect(result).rejects.toThrow("视频过大（超过 400 MB）");
    const task = useTasks.getState().tasks[id];
    expect(task.status).toBe("error");
    expect(task.error).toBe("视频过大（超过 400 MB）");
  });

  it("a non-Error rejection is stringified rather than crashing the registry write", async () => {
    const { id, result } = runTrackedAsync("import-text", "x", async () => {
      throw "plain string failure";
    });
    await expect(result).rejects.toBe("plain string failure");
    expect(useTasks.getState().tasks[id].error).toBe("plain string failure");
  });
});

describe("task.* webhook envelope (#58 design decision 5 — connector hook)", () => {
  beforeEach(() => {
    useTasks.setState({ tasks: {} });
    webhookUrl = "";
    mockPostTaskWebhook.mockClear();
  });

  it("fires task.started/task.done with the task snapshot + url when webhookUrl is set", () => {
    webhookUrl = "https://hooks.example.com/x";
    const id = runTracked("import-audio", "meeting.wav", (cb) => {
      cb.onDone("session-1");
    });

    expect(mockPostTaskWebhook).toHaveBeenCalledTimes(2);
    const [startedTask, startedEvent, startedUrl] = mockPostTaskWebhook.mock.calls[0];
    expect(startedEvent).toBe("task.started");
    expect(startedUrl).toBe("https://hooks.example.com/x");
    expect((startedTask as TaskState).id).toBe(id);

    const [doneTask, doneEvent] = mockPostTaskWebhook.mock.calls[1];
    expect(doneEvent).toBe("task.done");
    expect((doneTask as TaskState).status).toBe("done");
    expect((doneTask as TaskState).sessionId).toBe("session-1");
  });

  it("fires task.error on failure", () => {
    webhookUrl = "https://hooks.example.com/x";
    runTracked("import-url", "https://x", (cb) => {
      cb.onError("下载失败");
    });
    expect(mockPostTaskWebhook).toHaveBeenCalledTimes(2);
    expect(mockPostTaskWebhook.mock.calls[1][1]).toBe("task.error");
  });

  it("never calls the webhook when webhookUrl is unset (default)", () => {
    startTask("t1", "import-audio", "a.wav");
    completeTask("t1", "s1");
    expect(mockPostTaskWebhook).not.toHaveBeenCalled();
  });
});

describe("pure selectors — chip/tray derivation", () => {
  function task(overrides: Partial<TaskState>): TaskState {
    return {
      id: "t",
      kind: "import-audio",
      label: "x",
      stage: "",
      status: "running",
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    };
  }

  it("selectRunningTasks/selectRunningCount count only status:running", () => {
    const tasks: Record<string, TaskState> = {
      a: task({ id: "a", status: "running" }),
      b: task({ id: "b", status: "done" }),
      c: task({ id: "c", status: "error" }),
      d: task({ id: "d", status: "running" }),
    };
    expect(selectRunningTasks(tasks).map((t) => t.id).sort()).toEqual(["a", "d"]);
    expect(selectRunningCount(tasks)).toBe(2);
  });

  it("selectTrayTasks sorts most-recently-updated first", () => {
    const tasks: Record<string, TaskState> = {
      a: task({ id: "a", updatedAt: 100 }),
      b: task({ id: "b", updatedAt: 300 }),
      c: task({ id: "c", updatedAt: 200 }),
    };
    expect(selectTrayTasks(tasks).map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("selectHasTasks is false only for an empty map", () => {
    expect(selectHasTasks({})).toBe(false);
    expect(selectHasTasks({ a: task({ id: "a" }) })).toBe(true);
  });

  it("empty registry: running count 0, no tasks", () => {
    expect(selectRunningCount({})).toBe(0);
    expect(selectTrayTasks({})).toEqual([]);
  });
});
