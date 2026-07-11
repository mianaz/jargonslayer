// @vitest-environment jsdom
//
// Coordinator follow-up on the honest-progress fix: HistoryDrawer's
// inline import job rows independently reproduced the exact "stuck at a
// fabricated 0%" bug via `task.progress ?? 0` — a phase with no
// trustworthy ratio (download with an unknown Content-Length, or
// transcribe, see whisper.worker.ts) coerced straight to a progress bar
// frozen at 0% for the entire phase, in a SECOND surface beyond
// TaskTray.tsx. Mirrors TaskTray.test.tsx's createRoot/act pattern (no
// @testing-library/react in this repo's test stack).

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import HistoryDrawer from "../HistoryDrawer";
import { failTask, startTask, updateTaskProgress, useTasks } from "../../lib/tasks/registry";

describe("HistoryDrawer — import job rows render progress honestly", () => {
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

  function mountDrawer() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  it("a running task with progress:undefined shows the stage text but NO fabricated percentage/bar", async () => {
    startTask("t1", "import-audio", "meeting.wav");
    updateTaskProgress("t1", undefined, "转录中");

    mountDrawer();
    await act(async () => {
      root!.render(<HistoryDrawer open onClose={() => {}} onOpenImport={() => {}} />);
    });

    expect(container!.textContent).toContain("meeting.wav");
    expect(container!.textContent).toContain("转录中");
    // No percentage anywhere in the drawer — the only place a "%" could
    // legitimately come from is this row's progress bar.
    expect(container!.textContent).not.toContain("%");
  });

  it("a running task with a real numeric progress renders the percentage", async () => {
    startTask("t2", "import-audio", "meeting2.wav");
    updateTaskProgress("t2", 0.42, "下载模型 5.0MB（首次较慢）");

    mountDrawer();
    await act(async () => {
      root!.render(<HistoryDrawer open onClose={() => {}} onOpenImport={() => {}} />);
    });

    expect(container!.textContent).toContain("42%");
  });

  it("an errored task still shows its error message, unaffected by the progress-rendering fix", async () => {
    startTask("t3", "import-audio", "meeting3.wav");
    failTask("t3", "解析失败");

    mountDrawer();
    await act(async () => {
      root!.render(<HistoryDrawer open onClose={() => {}} onOpenImport={() => {}} />);
    });

    expect(container!.textContent).toContain("解析失败");
    expect(container!.textContent).not.toContain("%");
  });
});
