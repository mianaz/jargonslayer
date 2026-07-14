// @vitest-environment jsdom
//
// Default (non-desktop) test-env coverage — IS_DESKTOP is unset here,
// same posture as every other IS_DESKTOP-gated file's own test
// convention in this repo (see audiocapCaps.test.ts's own doc comment:
// "the thin ... wrapper is tested in the test env's default state").
// This covers the 任务 zone (imports everywhere + the two new kinds,
// platform-independent) plus confirms 系统状态 is absent outside
// desktop. Desktop-only behavior (系统状态 zone content, retry/re-probe
// actions that need a real handle) lives in
// TaskCenterDrawer.desktop.test.tsx, which mocks IS_DESKTOP true.
//
// React #185 regression coverage (the 2026-07-10 prod crash — see
// registry.ts's own EMPTY_TASKS doc) is the direct descendant of
// TaskTray.test.tsx's PRE-S10 version, now here since this is where the
// open-gated selectTrayTasks() array lives post-S10.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import TaskCenterDrawer from "../TaskCenterDrawer";
import { failTask, startTask, updateTaskProgress, useTasks } from "../../lib/tasks/registry";

describe("TaskCenterDrawer", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  const uncaught: unknown[] = [];

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.remove();
    container = null;
    uncaught.length = 0;
    useTasks.setState({ tasks: {} });
  });

  function mountDrawer() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container, {
      onUncaughtError: (err) => {
        uncaught.push(err);
      },
    });
  }

  it("renders nothing while closed", async () => {
    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open={false} onClose={() => {}} />);
    });
    expect(container!.textContent).toBe("");
  });

  it("empty registry shows the empty state, and 系统状态 is absent outside a desktop build", async () => {
    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open onClose={() => {}} />);
    });
    expect(container!.textContent).toContain("暂无后台任务");
    expect(container!.textContent).not.toContain("系统状态");
    expect(container!.textContent).not.toContain("本地服务");
    expect(container!.textContent).not.toContain("应用更新");
  });

  it("survives progress ticks against an open drawer without 'Maximum update depth exceeded' (React #185 regression)", async () => {
    startTask("task-1", "import-audio", "meeting.mp3");
    mountDrawer();

    let thrown: unknown = null;
    try {
      await act(async () => {
        root!.render(<TaskCenterDrawer open onClose={() => {}} />);
      });
      await act(async () => {
        updateTaskProgress("task-1", 0.4, "下载模型");
      });
    } catch (err) {
      thrown = err;
    }

    const messages = [...uncaught, thrown]
      .filter(Boolean)
      .map((e) => (e instanceof Error ? e.message : String(e)));
    expect(messages.filter((m) => /Maximum update depth/i.test(m))).toEqual([]);
    expect(container!.textContent).toContain("meeting.mp3");
    expect(container!.textContent).toContain("40%");
  });

  it("a running task with progress:undefined shows the stage alone, no fabricated percentage", async () => {
    startTask("task-1", "import-audio", "long-meeting.wav");
    updateTaskProgress("task-1", undefined, "转录中");
    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open onClose={() => {}} />);
    });

    expect(container!.textContent).toContain("long-meeting.wav");
    expect(container!.textContent).toContain("转录中");
    expect(container!.textContent).not.toContain("%");
  });

  it("shows the kind label alongside imports and the two new desktop kinds", async () => {
    startTask("t-audio", "import-audio", "a.wav");
    startTask("t-video", "import-video", "b.mp4");
    startTask("t-url", "import-url", "https://x");
    startTask("t-text", "import-text", "粘贴的文稿");
    startTask("t-model", "model-download", "均衡·推荐 (zh-en)");
    startTask("t-diar", "diar-install", "说话人分离扩展");
    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open onClose={() => {}} />);
    });

    expect(container!.textContent).toContain("音频导入");
    expect(container!.textContent).toContain("视频导入");
    expect(container!.textContent).toContain("链接导入");
    expect(container!.textContent).toContain("文稿导入");
    expect(container!.textContent).toContain("下载模型");
    expect(container!.textContent).toContain("安装说话人分离");
  });

  it("an errored task shows its message and a dismiss control that removes it", async () => {
    startTask("t1", "import-audio", "meeting.wav");
    failTask("t1", "解析失败");
    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open onClose={() => {}} />);
    });

    expect(container!.textContent).toContain("解析失败");
    const dismiss = container!.querySelector('button[aria-label="移除"]');
    expect(dismiss).not.toBeNull();

    await act(async () => {
      dismiss!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useTasks.getState().tasks.t1).toBeUndefined();
    expect(container!.textContent).toContain("暂无后台任务");
  });

  it("a running task has no dismiss control (selectCanDismiss gate)", async () => {
    startTask("t1", "import-audio", "meeting.wav");
    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open onClose={() => {}} />);
    });

    expect(container!.querySelector('button[aria-label="移除"]')).toBeNull();
  });

  it("a done task without a sessionId is not clickable (no jump affordance)", async () => {
    startTask("t1", "import-audio", "meeting.wav");
    useTasks.setState((s) => ({
      tasks: { ...s.tasks, t1: { ...s.tasks.t1, status: "done" } },
    }));
    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open onClose={() => {}} />);
    });

    expect(container!.querySelector('[role="button"]')).toBeNull();
  });

  it("a done task WITH a sessionId is clickable and jumping closes the drawer", async () => {
    startTask("t1", "import-audio", "meeting.wav");
    useTasks.setState((s) => ({
      tasks: { ...s.tasks, t1: { ...s.tasks.t1, status: "done", sessionId: "session-1" } },
    }));
    const onClose = vi.fn();
    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open onClose={onClose} />);
    });

    const row = container!.querySelector('[role="button"]');
    expect(row).not.toBeNull();

    await act(async () => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("an errored model-download task shows no retry control outside a desktop build (no handle to retry through)", async () => {
    startTask("t1", "model-download", "均衡·推荐 (zh-en)");
    failTask("t1", "下载失败");
    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open onClose={() => {}} />);
    });

    expect(container!.textContent).toContain("下载失败");
    expect(container!.textContent).not.toContain("重试");
  });

  it("an errored diar-install task shows no retry control outside a desktop build (needs a handle) but keeps 重新检测 (a plain probeSidecar call, no handle needed)", async () => {
    startTask("t1", "diar-install", "说话人分离扩展");
    failTask("t1", "退出码 1");
    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open onClose={() => {}} />);
    });

    expect(container!.textContent).toContain("退出码 1");
    expect(container!.textContent).not.toContain("重试");
    expect(container!.textContent).toContain("重新检测");
  });

  it("rows sort most-recently-updated first (selectTrayTasks contract)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    startTask("older", "import-audio", "older.wav");
    vi.setSystemTime(2000);
    startTask("newer", "import-audio", "newer.wav");
    vi.useRealTimers();
    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open onClose={() => {}} />);
    });

    const labels = Array.from(container!.querySelectorAll(".truncate")).map((el) => el.textContent);
    expect(labels.indexOf("newer.wav")).toBeLessThan(labels.indexOf("older.wav"));
  });
});
