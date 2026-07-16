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

// S11 osspeech blueprint (§3 Worker D, §A4) — Worker C's caps module,
// not on disk when this worker started (mocked, never stubbed — see
// this suite's own new describe block below). `null` is this mock's
// default (mirrors the real hook's own "not yet probed" snapshot) — S11
// fix-round J3 gave that its OWN dedicated screen (OsSpeechProbeScreen),
// so every PRE-EXISTING (pre-osspeech) test below now pins
// `{ supported: false }` explicitly to keep reaching the plain
// ConsentScreen it was actually written to exercise, rather than
// implicitly relying on this default the way it could before J3.
let mockOsSpeechCaps: { supported: boolean } | null = null;
vi.mock("@/lib/desktop/osspeechCaps", () => ({
  useOsSpeechCaps: () => mockOsSpeechCaps,
}));

const mockChooseOsSpeechEngine = vi.fn(async () => undefined);
vi.mock("@/lib/desktop/bootstrap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop/bootstrap")>();
  return {
    ...actual,
    chooseOsSpeechEngine: () => mockChooseOsSpeechEngine(),
  };
});

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
  mlxVenvDir: "/fake/AppData/mlx-venv",
  mlxVenvPython: "/fake/AppData/mlx-venv/bin/python",
  mlxRequirementsLockPath: "/fake/Resources/sidecar/requirements-mlx.lock",
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
    // S11 osspeech blueprint (§3 Worker D) — reset between tests so an
    // osspeech-specific test never bleeds its caps value into a LATER,
    // unrelated test (every pre-S11 test relies on the null default).
    mockOsSpeechCaps = null;
    mockChooseOsSpeechEngine.mockClear();
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
          onDismissStepError={noop}
          onRetry={noop}
          onRecheckHealth={asyncNoop}
          onReprovision={asyncNoop}
          {...overrides}
        />,
      );
    });
  }

  it("WIZARD_CONSENT_REQUIRED: renders the consent screen; 开始安装 calls onBeginProvision(model), 稍后再说 calls onDismissConsent", async () => {
    mockOsSpeechCaps = { supported: false }; // pre-osspeech baseline — see this suite's own header comment
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
    mockOsSpeechCaps = { supported: false }; // pre-osspeech baseline — see this suite's own header comment
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

  // S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C Q8,
  // worker A3) — the wizard's own model-picker step "accommodates" the
  // parakeet stub simply by never rendering it: this is an INTEGRATION
  // check (real MODEL_CATALOG, real embedded <ModelPicker>, not
  // ModelPicker's own mocked-catalog unit tests) that the wizard step
  // never leaks the still-`available:false` row through, and can never
  // land it as the eventual onBeginProvision(model) argument either.
  it("WIZARD_CONSENT_REQUIRED: the embedded <ModelPicker> never renders the still-unavailable parakeet-tdt-0.6b-v3 stub (§C L1 — worker B2 flips it later)", async () => {
    mockOsSpeechCaps = { supported: false };
    const onBeginProvision = vi.fn();
    await renderWizard({ phase: "WIZARD_CONSENT_REQUIRED" }, [], { onBeginProvision });

    const parakeet = MODEL_CATALOG.find((m) => m.id === "parakeet-tdt-0.6b-v3");
    expect(parakeet?.available).toBe(false); // sanity: the stub really is still gated
    expect(container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]')).toBeNull();

    const visibleCount = MODEL_CATALOG.filter((m) => m.available !== false).length;
    expect(container!.querySelectorAll('[role="radio"]').length).toBe(visibleCount);
    expect(container!.querySelectorAll('[role="radio"]').length).toBeLessThan(MODEL_CATALOG.length);
  });

  // S11 osspeech blueprint (§3 Worker D, §A4) — EngineChoiceScreen
  // gating: it becomes the WIZARD_CONSENT_REQUIRED screen (replacing
  // ConsentScreen) IFF osspeech caps report supported; osspeech choice
  // skips whisper provisioning entirely and dismisses; whisper choice
  // enters the existing ConsentScreen unchanged; caps DEFINITIVELY
  // unsupported skips the new screen entirely. caps not-yet-resolved
  // (null) is its OWN third case as of S11 fix-round J3 — see the
  // dedicated test below, not folded into "unsupported" anymore.

  it("WIZARD_CONSENT_REQUIRED + osspeech supported: renders EngineChoiceScreen (not ConsentScreen), pre-selected to 系统识别", async () => {
    mockOsSpeechCaps = { supported: true };
    await renderWizard({ phase: "WIZARD_CONSENT_REQUIRED" });

    expect(container!.querySelector('[data-testid="engine-choice-screen"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="desktop-wizard-consent"]')).toBeNull();
  });

  it("WIZARD_CONSENT_REQUIRED + osspeech supported: choosing 系统识别 -> 继续 fires chooseOsSpeechEngine() and dismisses via onDismissConsent — provisioning is skipped entirely", async () => {
    mockOsSpeechCaps = { supported: true };
    const onBeginProvision = vi.fn();
    const onDismissConsent = vi.fn();
    await renderWizard({ phase: "WIZARD_CONSENT_REQUIRED" }, [], { onBeginProvision, onDismissConsent });

    await act(async () => {
      container!.querySelector('[data-testid="btn-engine-choice-continue"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(mockChooseOsSpeechEngine).toHaveBeenCalledTimes(1);
    expect(onDismissConsent).toHaveBeenCalledTimes(1);
    expect(onBeginProvision).not.toHaveBeenCalled();
    // never advances into the provisioning ConsentScreen/StepRowsScreen.
    expect(container!.querySelector('[data-testid="desktop-wizard-consent"]')).toBeNull();
    expect(container!.querySelector('[data-testid="desktop-wizard-steps"]')).toBeNull();
  });

  it("WIZARD_CONSENT_REQUIRED + osspeech supported: choosing Whisper -> 继续 enters the existing ConsentScreen unchanged (开始安装/稍后再说 behave exactly as pre-S11)", async () => {
    mockOsSpeechCaps = { supported: true };
    const onBeginProvision = vi.fn();
    const onDismissConsent = vi.fn();
    await renderWizard({ phase: "WIZARD_CONSENT_REQUIRED" }, [], { onBeginProvision, onDismissConsent });

    await act(async () => {
      container!.querySelector('[data-testid="engine-choice-card-whisper"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await act(async () => {
      container!.querySelector('[data-testid="btn-engine-choice-continue"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(mockChooseOsSpeechEngine).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="engine-choice-screen"]')).toBeNull();
    expect(container!.querySelector('[data-testid="desktop-wizard-consent"]')).not.toBeNull();

    await act(async () => {
      container!.querySelector('[data-testid="btn-begin-provision"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onBeginProvision).toHaveBeenCalledTimes(1);
    expect(onBeginProvision).toHaveBeenCalledWith(WIZARD_PRESELECTED_MODEL);
  });

  it("WIZARD_CONSENT_REQUIRED + osspeech DEFINITIVELY not supported: EngineChoiceScreen is skipped entirely — wizard is byte-identical to pre-S11 (renders ConsentScreen directly)", async () => {
    mockOsSpeechCaps = { supported: false };
    await renderWizard({ phase: "WIZARD_CONSENT_REQUIRED" });

    expect(container!.querySelector('[data-testid="engine-choice-screen"]')).toBeNull();
    expect(container!.querySelector('[data-testid="desktop-wizard-osspeech-probe"]')).toBeNull();
    expect(container!.querySelector('[data-testid="desktop-wizard-consent"]')).not.toBeNull();
  });

  // S11 fix-round J3 (Opus MEDIUM): caps null (not yet resolved — the
  // probe is a helper process spawn, several hundred ms) used to fall
  // through to the SAME branch as "definitively unsupported" above,
  // rendering the INTERACTIVE ConsentScreen — a quick 开始安装 click
  // during that window could kick off a 1.5GB whisper provision on a
  // machine that should have been offered 系统识别 first. It now renders
  // a brief, non-interactive placeholder instead, until caps resolves
  // either way.
  it("WIZARD_CONSENT_REQUIRED + osspeech caps not yet resolved (null): renders a NON-interactive probing placeholder — neither ConsentScreen nor EngineChoiceScreen", async () => {
    mockOsSpeechCaps = null;
    await renderWizard({ phase: "WIZARD_CONSENT_REQUIRED" });

    expect(container!.querySelector('[data-testid="desktop-wizard-osspeech-probe"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="engine-choice-screen"]')).toBeNull();
    expect(container!.querySelector('[data-testid="desktop-wizard-consent"]')).toBeNull();
    // Non-interactive: nothing to mis-click while caps is still resolving.
    expect(container!.querySelectorAll("button").length).toBe(0);
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
    // the two v0.4.0 error-recovery affordances are ERROR-only chrome —
    // an actively-advancing install must not offer them.
    expect(container!.querySelector('[data-testid="btn-back-to-consent"]')).toBeNull();
    expect(container!.querySelector('[data-testid="btn-dismiss-step-error"]')).toBeNull();
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

  it("STEP/ERROR: 返回重新选择 awaits onReprovision (busy label while pending), 关闭，稍后处理 calls onDismissStepError — the v0.4.0 field fix's two ways OUT of a deterministic install failure", async () => {
    let resolveReprovision!: () => void;
    const reprovisionGate = new Promise<void>((resolve) => {
      resolveReprovision = resolve;
    });
    const onReprovision = vi.fn(() => reprovisionGate);
    const onDismissStepError = vi.fn();
    await renderWizard(
      { phase: "STEP", step: "INSTALL_PYTHON", status: "ERROR", error: "failed to spawn uv", retriable: true },
      [],
      { onReprovision, onDismissStepError },
    );

    const backBtn = container!.querySelector('[data-testid="btn-back-to-consent"]')! as HTMLButtonElement;
    expect(backBtn.textContent).toBe("返回重新选择");
    await act(async () => {
      backBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onReprovision).toHaveBeenCalledTimes(1);
    // busy while the awaited reprovision is still in flight — mirrors
    // TerminalErrorScreen's own 处理中… contract.
    expect(backBtn.textContent).toBe("处理中…");
    expect(backBtn.disabled).toBe(true);
    await act(async () => {
      resolveReprovision();
      await reprovisionGate;
    });
    expect(backBtn.textContent).toBe("返回重新选择");
    expect(backBtn.disabled).toBe(false);

    await act(async () => {
      container!.querySelector('[data-testid="btn-dismiss-step-error"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDismissStepError).toHaveBeenCalledTimes(1);
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
