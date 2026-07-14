// @vitest-environment jsdom
//
// Desktop-only coverage for TaskCenterDrawer's 系统状态 zone + per-kind
// retry/re-check actions. IS_DESKTOP is a module-scope import-time
// const (lib/platform/desktop.ts) — vi.mock affects this whole file, so
// this lives in its own file rather than a describe block inside
// TaskCenterDrawer.test.tsx, which needs the REAL (false) value for its
// own "系统状态 absent outside desktop" coverage. initDesktop/
// probeSidecar/jobsBridge are mocked (no real sidecar/Tauri IPC in a
// unit test); updateCheck.ts and openExternal.ts run FOR REAL — both
// already have their own dedicated test files, this one only checks
// THIS component's wiring to them (tauriApi + fetch are the only things
// stubbed underneath them).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/platform/desktop", () => ({ IS_DESKTOP: true }));

const mockGetAppVersion = vi.fn(async () => "0.4.1");
const mockOpenUrl = vi.fn(async (_url: string) => {});
vi.mock("@/lib/desktop/tauriApi", () => ({
  getAppVersion: () => mockGetAppVersion(),
  getOpener: async () => (url: string) => mockOpenUrl(url),
}));

const mockInitDesktop = vi.fn();
vi.mock("@/lib/desktop/bootstrap", () => ({
  initDesktop: () => mockInitDesktop(),
}));

const mockProbeSidecar = vi.fn();
vi.mock("@/lib/stt/sidecarHealth", () => ({
  probeSidecar: (settings: unknown) => mockProbeSidecar(settings),
}));

const mockTrackSwitchModel = vi.fn();
const mockTrackInstallDiar = vi.fn();
const mockModelForTask = vi.fn();
vi.mock("@/lib/desktop/jobsBridge", () => ({
  trackSwitchModel: (...args: unknown[]) => mockTrackSwitchModel(...args),
  trackInstallDiar: (...args: unknown[]) => mockTrackInstallDiar(...args),
  modelForTask: (id: string) => mockModelForTask(id),
}));

import TaskCenterDrawer from "../TaskCenterDrawer";
import { failTask, startTask, useTasks } from "../../lib/tasks/registry";
import { useApp } from "../../lib/store";
import { useUpdateCheck } from "../../lib/desktop/updateCheck";

describe("TaskCenterDrawer — desktop-only surfaces", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let fetchMock: ReturnType<typeof vi.fn>;

  function defaultFetchResponse() {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ tag_name: "v0.4.1", html_url: "https://example.com/v0.4.1" }),
    };
  }

  beforeEach(() => {
    mockGetAppVersion.mockClear().mockImplementation(async () => "0.4.1");
    mockOpenUrl.mockClear();
    mockInitDesktop.mockReset().mockResolvedValue(null);
    mockProbeSidecar.mockReset().mockResolvedValue({ up: true, installed: true });
    mockTrackSwitchModel.mockClear();
    mockTrackInstallDiar.mockClear();
    mockModelForTask.mockReset();
    fetchMock = vi.fn(async () => defaultFetchResponse());
    vi.stubGlobal("fetch", fetchMock);
    useUpdateCheck.setState({
      status: "idle",
      currentVersion: "",
      latestVersion: undefined,
      url: undefined,
      checkedAt: undefined,
    });
    useApp.setState((s) => ({
      settings: { ...s.settings, sidecarMode: "managed" },
      sidecarUp: null,
    }));
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.remove();
    container = null;
    useTasks.setState({ tasks: {} });
    vi.unstubAllGlobals();
  });

  function mountDrawer() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  function findButton(text: string): HTMLButtonElement | undefined {
    return Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === text,
    ) as HTMLButtonElement | undefined;
  }

  it("系统状态 zone renders the sidecar row (托管/外部 + up/down) and the update row", async () => {
    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open onClose={() => {}} />);
    });
    await flush();

    expect(container!.textContent).toContain("系统状态");
    expect(container!.textContent).toContain("本地服务");
    expect(container!.textContent).toContain("托管");
    expect(container!.textContent).toContain("应用更新");
    expect(mockProbeSidecar).toHaveBeenCalledWith(useApp.getState().settings);
  });

  it("重新检测 (sidecar row) re-probes and mirrors the result into the store", async () => {
    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open onClose={() => {}} />);
    });
    await flush();
    mockProbeSidecar.mockClear();
    mockProbeSidecar.mockResolvedValue({ up: false, installed: false });

    const recheck = findButton("重新检测");
    expect(recheck).toBeTruthy();

    await act(async () => {
      recheck!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockProbeSidecar).toHaveBeenCalledTimes(1);
    expect(useApp.getState().sidecarUp).toBe(false);
  });

  it("重新检查 runs checkAppUpdate for real, and 打开下载页 opens the found release URL once available", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ tag_name: "v9.9.9", html_url: "https://example.com/v9.9.9" }),
    }));

    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open onClose={() => {}} />);
    });
    await flush();

    expect(container!.textContent).toContain("发现新版本");

    const openPage = findButton("打开下载页");
    expect(openPage).toBeTruthy();

    await act(async () => {
      openPage!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockOpenUrl).toHaveBeenCalledWith("https://example.com/v9.9.9");
  });

  it("重试 on an errored model-download task re-calls trackSwitchModel(handle, model) — model comes from jobsBridge's own modelForTask", async () => {
    const fakeHandle = { fake: "handle" };
    mockInitDesktop.mockResolvedValue(fakeHandle);
    mockModelForTask.mockReturnValue("medium");
    startTask("t1", "model-download", "均衡·推荐 (zh-en)");
    failTask("t1", "下载失败");

    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open onClose={() => {}} />);
    });
    await flush();

    const retry = findButton("重试");
    expect(retry).toBeTruthy();

    await act(async () => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockTrackSwitchModel).toHaveBeenCalledWith(fakeHandle, "medium");
  });

  it("no retry button for an errored model-download task when modelForTask has nothing recorded (defensive guard)", async () => {
    const fakeHandle = { fake: "handle" };
    mockInitDesktop.mockResolvedValue(fakeHandle);
    mockModelForTask.mockReturnValue(undefined);
    startTask("t1", "model-download", "均衡·推荐 (zh-en)");
    failTask("t1", "下载失败");

    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open onClose={() => {}} />);
    });
    await flush();

    expect(findButton("重试")).toBeUndefined();
  });

  it("重试 on an errored diar-install task re-calls trackInstallDiar(handle)", async () => {
    const fakeHandle = { fake: "handle" };
    mockInitDesktop.mockResolvedValue(fakeHandle);
    startTask("t1", "diar-install", "说话人分离扩展");
    failTask("t1", "退出码 1");

    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open onClose={() => {}} />);
    });
    await flush();

    const retry = findButton("重试");
    expect(retry).toBeTruthy();

    await act(async () => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockTrackInstallDiar).toHaveBeenCalledWith(fakeHandle);
  });

  it("重新检测 on an errored diar-install task row probes + toasts a concise result (no handle needed)", async () => {
    mockProbeSidecar.mockResolvedValue({ up: true, installed: true });
    const showToastSpy = vi.fn();
    useApp.setState({ showToast: showToastSpy });
    startTask("t1", "diar-install", "说话人分离扩展");
    failTask("t1", "退出码 1");

    mountDrawer();
    await act(async () => {
      root!.render(<TaskCenterDrawer open onClose={() => {}} />);
    });
    await flush();
    mockProbeSidecar.mockClear();

    // Two 重新检测 buttons exist now (系统状态's sidecar row + this task
    // row) — scope to the task row's own DOM subtree (`.group`, the one
    // class only task rows carry) rather than positional indexing.
    const taskRow = Array.from(container!.querySelectorAll(".group")).find((r) =>
      r.textContent?.includes("说话人分离扩展"),
    );
    expect(taskRow).toBeTruthy();
    const taskRowRecheck = Array.from(taskRow!.querySelectorAll("button")).find(
      (b) => b.textContent === "重新检测",
    );
    expect(taskRowRecheck).toBeTruthy();

    await act(async () => {
      taskRowRecheck!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockProbeSidecar).toHaveBeenCalledTimes(1);
    expect(showToastSpy).toHaveBeenCalledWith("说话人分离已安装");
  });
});
