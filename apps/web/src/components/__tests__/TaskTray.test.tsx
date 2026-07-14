// @vitest-environment jsdom
//
// S10 field-fix #6 (Q2 verdict): TaskTray lost its own popover —
// TaskCenterDrawer.tsx is now the one place task rows render (see that
// file's own React #185-regression coverage, the direct descendant of
// this file's PRE-S10 popover test). This file now only covers the
// compact chip itself: running/idle counts and the onOpen callback.
// Mirrors Toast.test.tsx's createRoot/act pattern (no
// @testing-library/react in this repo's test stack).

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import TaskTray from "../TaskTray";
import { startTask, updateTaskProgress, useTasks } from "../../lib/tasks/registry";

describe("TaskTray — compact activity chip", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.remove();
    container = null;
    useTasks.setState({ tasks: {} });
  });

  function mountTray() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  it("renders nothing when the registry is empty", async () => {
    mountTray();
    await act(async () => {
      root!.render(<TaskTray onOpen={() => {}} />);
    });
    expect(container!.querySelector('button[aria-label="后台任务"]')).toBeNull();
  });

  it("shows a spinner + the running count while any task is running", async () => {
    startTask("task-1", "import-audio", "meeting.mp3");
    startTask("task-2", "import-video", "clip.mp4");
    mountTray();
    await act(async () => {
      root!.render(<TaskTray onOpen={() => {}} />);
    });

    const chip = container!.querySelector('button[aria-label="后台任务"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("2");
  });

  it("switches to the static total count once nothing is running", async () => {
    startTask("task-1", "import-audio", "meeting.mp3");
    useTasks.setState((s) => ({
      tasks: { ...s.tasks, "task-1": { ...s.tasks["task-1"], status: "done" } },
    }));
    mountTray();
    await act(async () => {
      root!.render(<TaskTray onOpen={() => {}} />);
    });

    const chip = container!.querySelector('button[aria-label="后台任务"]');
    expect(chip!.textContent).toContain("1");
  });

  it("a progress tick on a running task never crashes the chip (no per-row rendering left to break)", async () => {
    startTask("task-1", "import-audio", "meeting.mp3");
    mountTray();
    await act(async () => {
      root!.render(<TaskTray onOpen={() => {}} />);
    });
    await act(async () => {
      updateTaskProgress("task-1", 0.4, "转录中");
    });

    expect(container!.querySelector('button[aria-label="后台任务"]')).not.toBeNull();
    // No task label/stage text ever appears — the chip carries no row
    // content anymore (S10: that's TaskCenterDrawer's job now).
    expect(container!.textContent).not.toContain("meeting.mp3");
    expect(container!.textContent).not.toContain("转录中");
  });

  it("clicking the chip calls onOpen — it no longer manages any open/close state of its own", async () => {
    startTask("task-1", "import-audio", "meeting.mp3");
    const onOpen = vi.fn();
    mountTray();
    await act(async () => {
      root!.render(<TaskTray onOpen={onOpen} />);
    });

    const chip = container!.querySelector('button[aria-label="后台任务"]');
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
    // Still just the chip — no popover ever mounts.
    expect(container!.querySelector(".fixed")).toBeNull();
  });
});
