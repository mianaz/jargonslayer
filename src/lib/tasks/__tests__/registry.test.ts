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
  selectCanDismiss,
  selectHasTasks,
  selectRunningCount,
  selectRunningTasks,
  selectTotalCount,
  selectTrayTasks,
  startTask,
  updateTaskProgress,
  useTasks,
  type TaskState,
} from "../registry";
import { clearDiag, getDiagEntries } from "../../diag/log";

describe("task registry lifecycle (#58)", () => {
  beforeEach(() => {
    useTasks.setState({ tasks: {} });
    webhookUrl = "";
    mockPostTaskWebhook.mockClear();
    clearDiag();
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

  // Diagnostics choke point (item 2): failTask writes task kind + error
  // message to the diag ring buffer — never the imported file/session
  // content that led to the failure.
  it("failTask also writes an 'error' diag entry carrying the task kind and error message", () => {
    startTask("t1", "import-audio", "meeting.wav");
    failTask("t1", "解析失败");
    const entries = getDiagEntries().filter((e) => e.tag === "task-registry");
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("error");
    expect(entries[0].message).toContain("import-audio");
    expect(entries[0].detail).toBe("解析失败");
    expect(entries[0].ref).toMatch(/^JS-/);
  });

  it("progress/complete/fail on an unknown id are no-ops (no throw, no phantom entry)", () => {
    updateTaskProgress("ghost", 0.5, "x");
    completeTask("ghost", "s1");
    failTask("ghost", "e");
    expect(useTasks.getState().tasks).toEqual({});
  });

  it("failTask on an unknown id does not write a diag entry either", () => {
    failTask("ghost", "e");
    expect(getDiagEntries().filter((e) => e.tag === "task-registry")).toHaveLength(0);
  });

  // Tag-blocker MEDIUM 4: a sidecar/job error string can carry a URL
  // with a query string (filenames, signed params, tokens) — the diag
  // entry (copyable report) must have it redacted; the tray/task UI
  // (TaskState.error) must keep the full, un-redacted string.
  it("failTask redacts URLs/query strings in the DIAG entry only — the tray/task error stays full", () => {
    startTask("t1", "import-url", "https://example.com/audio.mp3");
    const rawError =
      "下载失败：https://cdn.example.com/private/audio.mp3?token=SENTINEL-SECRET&sig=abc123 (404)";
    failTask("t1", rawError);

    const task = useTasks.getState().tasks.t1;
    expect(task.error).toBe(rawError); // tray/task UI: unredacted, unchanged

    const entries = getDiagEntries().filter((e) => e.tag === "task-registry");
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).not.toContain("SENTINEL-SECRET");
    expect(entries[0].detail).not.toContain("cdn.example.com");
    expect(entries[0].detail).toContain("<url>");
    expect(entries[0].detail).toContain("(404)"); // non-URL context survives
  });

  it("dismissTask removes the entry entirely; dismissing twice is a no-op", () => {
    startTask("t1", "import-audio", "a.wav");
    dismissTask("t1");
    expect(useTasks.getState().tasks.t1).toBeUndefined();
    expect(() => dismissTask("t1")).not.toThrow();
  });
});

describe("task lifecycle diag entries (item 4)", () => {
  beforeEach(() => {
    useTasks.setState({ tasks: {} });
    webhookUrl = "";
    mockPostTaskWebhook.mockClear();
    clearDiag();
    vi.useRealTimers();
  });

  it("startTask writes an 'info' task-started entry carrying only the task kind, NEVER the label/filename", () => {
    startTask("t1", "import-audio", "board-meeting-q3-SENTINEL.wav");
    const entries = getDiagEntries().filter((e) => e.tag === "task-started");
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("info");
    expect(entries[0].message).toContain("import-audio");
    expect(entries[0].message).not.toContain("SENTINEL");
    expect(entries[0].detail ?? "").not.toContain("SENTINEL");
    expect(entries[0].ref).toBeUndefined(); // info entries carry no error ref (log.ts)
  });

  it("updateTaskProgress writes a task-phase entry on the very first call (transition off the initial empty stage)", () => {
    startTask("t1", "import-audio", "a.wav");
    updateTaskProgress("t1", 0, "读取音频");
    const entries = getDiagEntries().filter((e) => e.tag === "task-phase");
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("info");
    expect(entries[0].detail).toBe("stage=读取音频 progress=0");
  });

  it("does NOT write another task-phase entry when the stage's leading label is unchanged, even though the exact string keeps changing every tick (e.g. a growing MB suffix)", () => {
    startTask("t1", "import-audio", "a.wav");
    updateTaskProgress("t1", undefined, "下载模型 1.0MB（首次较慢）");
    updateTaskProgress("t1", undefined, "下载模型 4.7MB（首次较慢）");
    updateTaskProgress("t1", 0.3, "下载模型 12.3MB（首次较慢）");

    const entries = getDiagEntries().filter((e) => e.tag === "task-phase");
    expect(entries).toHaveLength(1); // only the first tick's transition
    expect(entries[0].detail).toBe("stage=下载模型 1.0MB（首次较慢） progress=-");
  });

  it("the same throttle applies to a batch-counter suffix (e.g. importText.ts's '检测 1/2' -> '检测 2/2')", () => {
    startTask("t1", "import-text", "粘贴的文稿");
    updateTaskProgress("t1", 0.5, "检测 1/2");
    updateTaskProgress("t1", 1, "检测 2/2");

    const entries = getDiagEntries().filter((e) => e.tag === "task-phase");
    expect(entries).toHaveLength(1);
  });

  it("DOES write a new task-phase entry once the stage's leading label actually changes", () => {
    startTask("t1", "import-audio", "a.wav");
    updateTaskProgress("t1", undefined, "下载模型 1.0MB（首次较慢）");
    updateTaskProgress("t1", undefined, "下载模型 90.0MB（首次较慢）");
    updateTaskProgress("t1", 1, "转录中");

    const entries = getDiagEntries().filter((e) => e.tag === "task-phase");
    expect(entries).toHaveLength(2);
    expect(entries[0].detail).toBe("stage=下载模型 1.0MB（首次较慢） progress=-");
    expect(entries[1].detail).toBe("stage=转录中 progress=100");
  });

  it("task-phase progress is rounded to a whole percent, and '-' when undefined", () => {
    startTask("t1", "import-audio", "a.wav");
    updateTaskProgress("t1", 0.126, "读取音频");
    updateTaskProgress("t1", undefined, "下载模型（首次较慢）");

    const entries = getDiagEntries().filter((e) => e.tag === "task-phase");
    expect(entries[0].detail).toBe("stage=读取音频 progress=13");
    expect(entries[1].detail).toBe("stage=下载模型（首次较慢） progress=-");
  });

  it("completeTask writes a task-done entry with elapsed ms", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    startTask("t1", "import-audio", "a.wav");
    vi.setSystemTime(1_750);
    completeTask("t1", "session-1");

    const entries = getDiagEntries().filter((e) => e.tag === "task-done");
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("info");
    expect(entries[0].message).toContain("import-audio");
    expect(entries[0].detail).toBe("elapsedMs=750");
    vi.useRealTimers();
  });

  it("task-started/task-phase/task-done entries track per-task-id independently — a second concurrent task doesn't suppress the first's transitions", () => {
    startTask("t1", "import-audio", "a.wav");
    startTask("t2", "import-video", "b.mp4");
    updateTaskProgress("t1", 0, "读取音频");
    updateTaskProgress("t2", 0, "提取音频");
    updateTaskProgress("t1", 0.5, "下载模型 5.0MB（首次较慢）");
    updateTaskProgress("t2", 0.5, "提取音频"); // same leading label as t2's own last stage

    const started = getDiagEntries().filter((e) => e.tag === "task-started");
    expect(started).toHaveLength(2);
    const phase = getDiagEntries().filter((e) => e.tag === "task-phase");
    // t1: "" -> 读取音频 -> 下载模型... (2 transitions). t2: "" -> 提取音频,
    // then a repeat of 提取音频 (no transition) (1 transition).
    expect(phase).toHaveLength(3);
  });

  it("progress/complete on an unknown id writes no task-phase/task-done entry (mirrors the existing no-op contract)", () => {
    updateTaskProgress("ghost", 0.5, "x");
    completeTask("ghost", "s1");
    expect(getDiagEntries().filter((e) => e.tag === "task-phase")).toHaveLength(0);
    expect(getDiagEntries().filter((e) => e.tag === "task-done")).toHaveLength(0);
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

  it("selectTotalCount counts every task regardless of status", () => {
    const tasks: Record<string, TaskState> = {
      a: task({ id: "a", status: "running" }),
      b: task({ id: "b", status: "done" }),
      c: task({ id: "c", status: "error" }),
    };
    expect(selectTotalCount(tasks)).toBe(3);
    expect(selectTotalCount({})).toBe(0);
  });

  it("selectCanDismiss is false only for status:running (#58 review fix 3)", () => {
    expect(selectCanDismiss("running")).toBe(false);
    expect(selectCanDismiss("done")).toBe(true);
    expect(selectCanDismiss("error")).toBe(true);
  });
});

describe("terminal-task pruning on insert (#58 review fix 6)", () => {
  beforeEach(() => {
    useTasks.setState({ tasks: {} });
    webhookUrl = "";
    mockPostTaskWebhook.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not prune when a new insert brings the terminal count to exactly the cap", () => {
    for (let i = 0; i < 20; i++) {
      vi.setSystemTime(i * 10);
      startTask(`t${i}`, "import-audio", `f${i}`);
      completeTask(`t${i}`, `s${i}`);
    }
    expect(Object.keys(useTasks.getState().tasks)).toHaveLength(20);

    vi.setSystemTime(1000);
    startTask("t-running", "import-video", "still-going.mp4");

    const tasks = useTasks.getState().tasks;
    // 20 terminal (untouched, still exactly at the cap) + 1 running.
    expect(Object.keys(tasks)).toHaveLength(21);
    expect(tasks.t0).toBeDefined();
  });

  it("prunes exactly the single oldest-updated terminal task once an insert pushes the terminal count one over the cap", () => {
    for (let i = 0; i < 21; i++) {
      vi.setSystemTime(i * 10);
      startTask(`t${i}`, "import-audio", `f${i}`);
      completeTask(`t${i}`, `s${i}`);
    }
    // completeTask itself never prunes — only a NEW insert does.
    expect(Object.keys(useTasks.getState().tasks)).toHaveLength(21);

    vi.setSystemTime(1000);
    startTask("t-running", "import-video", "still-going.mp4");

    const tasks = useTasks.getState().tasks;
    expect(tasks.t0).toBeUndefined(); // oldest-updated terminal task, pruned
    expect(tasks.t1).toBeDefined(); // every other terminal task survives
    expect(tasks["t-running"]).toBeDefined();
    expect(tasks["t-running"].status).toBe("running");
    // 21 terminal - 1 pruned = 20 terminal, + the 1 new running task.
    expect(Object.keys(tasks)).toHaveLength(21);
  });

  it("never prunes a running task, even one older than every terminal task and even once the terminal count is well over the cap", () => {
    startTask("keep-running", "import-audio", "long.wav");
    for (let i = 0; i < 25; i++) {
      vi.setSystemTime((i + 1) * 10);
      startTask(`t${i}`, "import-audio", `f${i}`);
      completeTask(`t${i}`, `s${i}`);
    }
    const kept = useTasks.getState().tasks["keep-running"];
    expect(kept).toBeDefined();
    expect(kept.status).toBe("running");
  });
});

describe("task.* webhook destination captured at task-start (#58 review fix 7)", () => {
  beforeEach(() => {
    useTasks.setState({ tasks: {} });
    webhookUrl = "";
    mockPostTaskWebhook.mockClear();
  });

  it("task.started AND task.done both use the URL captured at startTask time, even if webhookUrl changes before the task completes", () => {
    webhookUrl = "https://a.example.com/hook";
    const id = runTracked("import-audio", "meeting.wav", () => {});
    // Settings change mid-task — a naive live-read at emit time would
    // send task.done here instead.
    webhookUrl = "https://b.example.com/hook";
    completeTask(id, "session-1");

    expect(mockPostTaskWebhook).toHaveBeenCalledTimes(2);
    expect(mockPostTaskWebhook.mock.calls[0][1]).toBe("task.started");
    expect(mockPostTaskWebhook.mock.calls[0][2]).toBe("https://a.example.com/hook");
    expect(mockPostTaskWebhook.mock.calls[1][1]).toBe("task.done");
    expect(mockPostTaskWebhook.mock.calls[1][2]).toBe("https://a.example.com/hook");
  });

  it("a failed task's captured URL is used for task.error too", () => {
    webhookUrl = "https://a.example.com/hook";
    const id = runTracked("import-url", "https://x", () => {});
    webhookUrl = "https://b.example.com/hook";
    failTask(id, "下载失败");

    expect(mockPostTaskWebhook).toHaveBeenCalledTimes(2);
    expect(mockPostTaskWebhook.mock.calls[1][1]).toBe("task.error");
    expect(mockPostTaskWebhook.mock.calls[1][2]).toBe("https://a.example.com/hook");
  });

  it("no webhookUrl configured at start: task.done never fires even if one is configured before completion", () => {
    webhookUrl = "";
    const id = runTracked("import-audio", "meeting.wav", () => {});
    webhookUrl = "https://late.example.com/hook";
    completeTask(id, "session-1");

    expect(mockPostTaskWebhook).not.toHaveBeenCalled();
  });

  it("the captured URL is never exposed on the TaskState payload itself", () => {
    webhookUrl = "https://a.example.com/hook";
    const id = runTracked("import-audio", "meeting.wav", () => {});
    const task = useTasks.getState().tasks[id];
    expect(task).not.toHaveProperty("webhookUrl");
  });
});
