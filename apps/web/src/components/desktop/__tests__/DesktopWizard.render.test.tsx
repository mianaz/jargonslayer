// @vitest-environment jsdom
//
// v0.4 S3 chunk 6 — DesktopWizard.tsx render coverage (one of this
// chunk's required red-verifies). Mirrors Header.render.test.tsx's own
// createRoot/act pattern (no @testing-library/react in this repo's
// test stack) — every assertion drives the REAL component with plain
// vi.fn() callback props, no lib/desktop/bootstrap.ts involved at all
// (that file's own bootstrap.test.ts already covers the state machine
// wiring; this file only covers "does the right screen/row/button show
// up for a given DesktopBootstrapState").
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import DesktopWizard from "../DesktopWizard";
import type { DesktopBootstrapState, DesktopLogLine } from "@/lib/desktop/bootstrap";
import { MODEL_CATALOG, WIZARD_PRESELECTED_MODEL } from "@/lib/desktop/modelCatalog";
import type { DesktopPaths } from "@/lib/desktop/uvCommands";

const paths: DesktopPaths = {
  appData: "/fake/AppData",
  pythonInstallDir: "/fake/AppData/python",
  uvCacheDir: "/fake/AppData/uv-cache",
  venvDir: "/fake/AppData/venv",
  venvPython: "/fake/AppData/venv/bin/python",
  modelsDir: "/fake/AppData/models",
  scriptPath: "/fake/Resources/sidecar/whisper_server.py",
  requirementsPath: "/fake/Resources/sidecar/requirements-sidecar.txt",
  diarRequirementsPath: "/fake/Resources/sidecar/requirements-diar.txt",
  logPath: "/fake/Logs/whisper_server.log",
  markerPath: "/fake/AppData/.provisioned.json",
};

function noop() {}
async function asyncNoop() {}

describe("DesktopWizard — state-driven rendering", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  async function renderWizard(state: DesktopBootstrapState, logLines: DesktopLogLine[] = [], overrides: Partial<Parameters<typeof DesktopWizard>[0]> = {}) {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <DesktopWizard
          state={state}
          paths={paths}
          logLines={logLines}
          downloadProgress={null}
          onBeginProvision={noop}
          onDismissConsent={noop}
          onDismissTerminal={noop}
          onRetry={noop}
          onRecheckHealth={asyncNoop}
          onReprovision={asyncNoop}
          {...overrides}
        />,
      );
    });
  }

  it("WIZARD_CONSENT_REQUIRED: renders the consent screen; 开始安装 calls onBeginProvision(model), 稍后再说 calls onDismissConsent", async () => {
    const onBeginProvision = vi.fn();
    const onDismissConsent = vi.fn();
    await renderWizard({ phase: "WIZARD_CONSENT_REQUIRED" }, [], { onBeginProvision, onDismissConsent });

    expect(container!.querySelector('[data-testid="desktop-wizard-consent"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="desktop-wizard-steps"]')).toBeNull();
    expect(container!.querySelector('[data-testid="desktop-wizard-terminal"]')).toBeNull();

    await act(async () => {
      container!.querySelector('[data-testid="btn-begin-provision"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onBeginProvision).toHaveBeenCalledTimes(1);
    expect(onBeginProvision).toHaveBeenCalledWith(WIZARD_PRESELECTED_MODEL);

    await act(async () => {
      container!.querySelector('[data-testid="btn-dismiss-wizard"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDismissConsent).toHaveBeenCalledTimes(1);
  });

  it("WIZARD_CONSENT_REQUIRED: embeds <ModelPicker>, pre-selected to WIZARD_PRESELECTED_MODEL, and the 开始安装 button text tracks the selection", async () => {
    const onBeginProvision = vi.fn();
    await renderWizard({ phase: "WIZARD_CONSENT_REQUIRED" }, [], { onBeginProvision });

    expect(container!.querySelector('[data-testid="model-picker"]')).not.toBeNull();
    const preselected = MODEL_CATALOG.find((m) => m.id === WIZARD_PRESELECTED_MODEL)!;
    const beginBtn = container!.querySelector('[data-testid="btn-begin-provision"]')!;
    expect(beginBtn.textContent).toBe(`开始安装（${preselected.id} · ${preselected.size}）`);
    expect(
      container!.querySelector(`[data-testid="model-option-${WIZARD_PRESELECTED_MODEL}"]`)!.getAttribute("aria-checked"),
    ).toBe("true");

    // Pick a different row — the button text updates to match, and the
    // eventual onBeginProvision call carries THAT model, not the
    // pre-selected default.
    const largeV3 = MODEL_CATALOG.find((m) => m.id === "large-v3")!;
    await act(async () => {
      container!.querySelector('[data-testid="model-option-large-v3"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(beginBtn.textContent).toBe(`开始安装（${largeV3.id} · ${largeV3.size}）`);

    await act(async () => {
      beginBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onBeginProvision).toHaveBeenCalledWith("large-v3");
  });

  it("STEP/RUNNING (CREATE_VENV): earlier rows read done, the current row reads running, later rows read pending — no error/escape-hatch chrome", async () => {
    await renderWizard({ phase: "STEP", step: "CREATE_VENV", status: "RUNNING" });

    expect(container!.querySelector('[data-testid="desktop-wizard-steps"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="wizard-step-INSTALL_PYTHON"]')!.getAttribute("data-status")).toBe("done");
    expect(container!.querySelector('[data-testid="wizard-step-CREATE_VENV"]')!.getAttribute("data-status")).toBe("running");
    expect(container!.querySelector('[data-testid="wizard-step-INSTALL_DEPS"]')!.getAttribute("data-status")).toBe("pending");
    expect(container!.querySelector('[data-testid="wizard-step-DOWNLOAD_MODEL"]')!.getAttribute("data-status")).toBe("pending");
    expect(container!.querySelector('[data-testid="wizard-step-STARTING"]')!.getAttribute("data-status")).toBe("pending");
    expect(container!.querySelector('[data-testid="btn-retry-step"]')).toBeNull();
    expect(container!.querySelector('[data-testid="btn-manual-recheck"]')).toBeNull();
  });

  it("STEP/POLLING (POLLING_HEALTH): folds into the STARTING row, shown as running", async () => {
    await renderWizard({ phase: "STEP", step: "POLLING_HEALTH", status: "POLLING", attempts: 3 });

    expect(container!.querySelector('[data-testid="wizard-step-STARTING"]')!.getAttribute("data-status")).toBe("running");
    expect(container!.querySelector('[data-testid="wizard-step-DOWNLOAD_MODEL"]')!.getAttribute("data-status")).toBe("done");
  });

  it("STEP/RUNNING (DOWNLOAD_MODEL) with downloadProgress: shows pct + human-readable downloaded/total on that row only", async () => {
    await renderWizard({ phase: "STEP", step: "DOWNLOAD_MODEL", status: "RUNNING" }, [], {
      downloadProgress: { downloaded: 500 * 1024 * 1024, total: 1500 * 1024 * 1024 },
    });

    const row = container!.querySelector('[data-testid="wizard-step-DOWNLOAD_MODEL"]')!;
    expect(row.querySelector('[data-testid="wizard-download-progress"]')).not.toBeNull();
    expect(row.textContent).toContain("33%");
    expect(row.textContent).toContain("500.0MB");
    expect(row.textContent).toContain("1.5GB");

    // no other row grows the same progress chrome
    expect(container!.querySelector('[data-testid="wizard-step-STARTING"] [data-testid="wizard-download-progress"]')).toBeNull();
  });

  it("STEP/RUNNING (DOWNLOAD_MODEL) with no downloadProgress yet (null): no progress chrome on the row", async () => {
    await renderWizard({ phase: "STEP", step: "DOWNLOAD_MODEL", status: "RUNNING" });
    expect(container!.querySelector('[data-testid="wizard-download-progress"]')).toBeNull();
  });

  it("DOWNLOAD_MODEL progress is only shown while that row is RUNNING — a stale non-null downloadProgress during a LATER row (STARTING) renders no chrome", async () => {
    await renderWizard({ phase: "STEP", step: "STARTING", status: "RUNNING" }, [], {
      downloadProgress: { downloaded: 1, total: 2 },
    });
    expect(container!.querySelector('[data-testid="wizard-download-progress"]')).toBeNull();
  });

  it("STEP/ERROR: shows the error row, message, 重试 (onRetry), and the escape hatch (paths + 我已手动安装 -> onRecheckHealth)", async () => {
    const onRetry = vi.fn();
    const onRecheckHealth = vi.fn(asyncNoop);
    await renderWizard(
      { phase: "STEP", step: "INSTALL_PYTHON", status: "ERROR", error: "exited with code 1", retriable: true },
      [],
      { onRetry, onRecheckHealth },
    );

    expect(container!.querySelector('[data-testid="wizard-step-INSTALL_PYTHON"]')!.getAttribute("data-status")).toBe("error");
    expect(container!.textContent).toContain("exited with code 1");
    expect(container!.textContent).toContain(paths.appData);
    expect(container!.textContent).toContain(paths.venvPython);

    await act(async () => {
      container!.querySelector('[data-testid="btn-retry-step"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);

    await act(async () => {
      container!.querySelector('[data-testid="btn-manual-recheck"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRecheckHealth).toHaveBeenCalledTimes(1);
  });

  it("详细日志 pane: collapsed by default, expands on click, and renders every given log line", async () => {
    const logLines: DesktopLogLine[] = [
      { stream: "stdout", line: "Installed Python 3.12" },
      { stream: "stderr", line: "warning: slow mirror" },
    ];
    await renderWizard({ phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" }, logLines);

    expect(container!.querySelector('[data-testid="wizard-log-pane"]')).toBeNull();
    await act(async () => {
      container!.querySelector('[data-testid="btn-toggle-wizard-log"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const pane = container!.querySelector('[data-testid="wizard-log-pane"]');
    expect(pane).not.toBeNull();
    expect(pane!.textContent).toContain("Installed Python 3.12");
    expect(pane!.textContent).toContain("warning: slow mirror");
  });

  it("TERMINAL_ERROR: renders the crash reason, 重新运行安装向导 calls onReprovision, dismiss calls onDismissTerminal", async () => {
    const onReprovision = vi.fn(asyncNoop);
    const onDismissTerminal = vi.fn();
    await renderWizard(
      { phase: "TERMINAL_ERROR", reason: "本地服务在 60 秒内退出了 3 次，已停止自动重启" },
      [],
      { onReprovision, onDismissTerminal },
    );

    expect(container!.querySelector('[data-testid="desktop-wizard-terminal"]')).not.toBeNull();
    expect(container!.textContent).toContain("本地服务在 60 秒内退出了 3 次");

    await act(async () => {
      container!.querySelector('[data-testid="btn-reprovision"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onReprovision).toHaveBeenCalledTimes(1);

    await act(async () => {
      container!.querySelector('[data-testid="btn-dismiss-wizard"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDismissTerminal).toHaveBeenCalledTimes(1);
  });

  it("HEALTHY / CHECKING / NOT_DESKTOP: renders nothing (the caller, DesktopBootstrap.tsx, is what decides visibility)", async () => {
    for (const state of [{ phase: "HEALTHY" }, { phase: "CHECKING" }, { phase: "NOT_DESKTOP" }] as DesktopBootstrapState[]) {
      await renderWizard(state);
      expect(container!.querySelector('[data-testid="desktop-wizard"]')).toBeNull();
    }
  });
});
