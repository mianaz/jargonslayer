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
});
