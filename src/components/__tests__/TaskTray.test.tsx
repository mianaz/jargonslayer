// @vitest-environment jsdom
//
// Regression test for the 2026-07-10 prod crash (minified React #185,
// "Maximum update depth exceeded"): opening the task tray while any
// task exists looped render→getSnapshot forever, because the
// open-gated selector handed zustand a FRESH selectTrayTasks() array
// on every call — zustand v5 dropped v4's selector-output caching
// (plain useSyncExternalStore), so selector output must be
// referentially stable unless wrapped in useShallow. Mirrors
// Toast.test.tsx's createRoot/act pattern (no @testing-library/react
// in this repo's test stack).

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import TaskTray from "../TaskTray";
import { startTask, updateTaskProgress, useTasks } from "../../lib/tasks/registry";

describe("TaskTray — open tray with live tasks (React #185 regression)", () => {
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

  function mountTray() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    // onUncaughtError: React 19 routes render-phase errors (no error
    // boundary here) to this root option instead of rethrowing — the
    // #185 loop would otherwise only show up as console noise.
    root = createRoot(container, {
      onUncaughtError: (err) => {
        uncaught.push(err);
      },
    });
  }

  it("renders rows and survives progress ticks without 'Maximum update depth exceeded'", async () => {
    startTask("task-1", "import-audio", "导入 meeting.mp3");
    mountTray();

    let thrown: unknown = null;
    try {
      await act(async () => {
        root!.render(<TaskTray />);
      });
      const chip = container!.querySelector('button[aria-label="后台任务"]');
      expect(chip).not.toBeNull();
      await act(async () => {
        chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      // A model-download progress tick against the OPEN tray — the
      // exact prod scenario (import running, user watching progress).
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

    // The open tray must actually show the live row, stage included.
    expect(container!.textContent).toContain("导入 meeting.mp3");
    expect(container!.textContent).toContain("下载模型");
    expect(container!.textContent).toContain("40%");
  });

  // Coordinator follow-up on the honest-progress fix: the transcribe
  // phase's start post now carries an undefined ratio (no per-chunk
  // hook exists to back a real number) instead of the old literal 0,
  // which used to sit here as a fake "转录中 0%" for the entire
  // transcription of a long file — the exact stuck-progress complaint
  // this fix chases. The tray's existing typeof-number guard already
  // renders stage-only in that case; this pins the actual rendered
  // behavior down.
  it("a running task with progress:undefined shows the stage text alone, no fabricated percentage", async () => {
    startTask("task-2", "import-audio", "导入 long-meeting.wav");
    mountTray();

    await act(async () => {
      root!.render(<TaskTray />);
    });
    const chip = container!.querySelector('button[aria-label="后台任务"]');
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      updateTaskProgress("task-2", undefined, "转录中");
    });

    expect(container!.textContent).toContain("导入 long-meeting.wav");
    expect(container!.textContent).toContain("转录中");
    expect(container!.textContent).not.toContain("%");
  });

  // F4 LOW (codex review round 1) — defense in depth: registry.test.ts
  // already pins that updateTaskProgress's own choke point coerces a
  // non-finite progress to undefined before it ever reaches TaskState;
  // this pins the render guard itself against a NaN that reaches
  // TaskState through some OTHER path. The old guard, `typeof
  // task.progress === "number"`, is true for NaN too (it really is a JS
  // `number`) and used to render a literal "NaN%".
  it("a task with a NaN progress value shows the stage text alone, never 'NaN%'", async () => {
    startTask("task-3", "import-audio", "导入 broken-duration.mov");
    mountTray();

    await act(async () => {
      root!.render(<TaskTray />);
    });
    const chip = container!.querySelector('button[aria-label="后台任务"]');
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      useTasks.setState((s) => ({
        tasks: {
          ...s.tasks,
          "task-3": { ...s.tasks["task-3"], progress: Number.NaN, stage: "转码中" },
        },
      }));
    });

    expect(container!.textContent).toContain("导入 broken-duration.mov");
    expect(container!.textContent).toContain("转码中");
    expect(container!.textContent).not.toContain("NaN");
  });
});
