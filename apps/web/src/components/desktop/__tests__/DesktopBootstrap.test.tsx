// @vitest-environment jsdom
//
// DesktopBootstrap — F6 (MEDIUM, adversarial review): the onboarding-
// trigger effect used to fire on ANY STEP -> HEALTHY transition,
// including a RETURNING user's model-switch failure recovering
// (HEALTHY -> STEP/ERROR -> HEALTHY, bootstrap.ts's own
// performSwitchModel/landOnSwitchFailure reuse the SAME "STEP" phase a
// first-run provision drive uses) — nagging them with first-run
// onboarding they've already seen. Fixed by requiring a session ref
// armed ONLY by a REAL first-run provisioning begin (DesktopWizard's
// own onBeginProvision seam, wired here to handle.beginProvision).
//
// IS_DESKTOP is a module-scope import-time const — vi.mock affects this
// whole file, mirrors TaskCenterDrawer.desktop.test.tsx/SettingsDialog.
// desktop.test.tsx's own established split for the identical
// constraint. initDesktop() is faked with a small scriptable handle
// (state$/currentState/beginProvision — the only three DesktopBootstrap
// itself drives) rather than driving the real bootstrapDesktop() state
// machine, so this suite tests DesktopBootstrap's OWN ref-gating logic
// in isolation. DesktopWizard/DesktopOnboardingSteps (this component's
// two children) are mocked to bare-bones stand-ins exposing only the
// props THIS component's own logic cares about — each already has its
// own dedicated render coverage (DesktopWizard.render.test.tsx,
// DesktopOnboardingSteps.test.tsx), so re-exercising their internals
// here would just be duplicated, more fragile coverage of already-owned
// behavior.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { DesktopBootstrapHandle, DesktopBootstrapState } from "@/lib/desktop/bootstrap";
import type { DesktopPaths } from "@/lib/desktop/uvCommands";
import { useApp } from "@/lib/store";

vi.mock("@/lib/platform/desktop", () => ({ IS_DESKTOP: true }));

const mockInitDesktop = vi.fn();
vi.mock("@/lib/desktop/bootstrap", () => ({
  initDesktop: () => mockInitDesktop(),
  redactHomePath: (s: string) => s,
}));

vi.mock("../DesktopWizard", () => ({
  __esModule: true,
  default: (props: { onBeginProvision: (model?: string) => void }) => (
    <button
      type="button"
      data-testid="fake-begin-provision"
      onClick={() => props.onBeginProvision("fake-model")}
    >
      begin
    </button>
  ),
  DesktopOnboardingSteps: (_props: { onDone: () => void }) => (
    <div data-testid="fake-onboarding-steps" />
  ),
}));

import DesktopBootstrap from "../DesktopBootstrap";

const FAKE_PATHS: DesktopPaths = {
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

/** A small scriptable stand-in for the real bootstrapDesktop() handle —
 *  only state$/currentState/beginProvision are exercised by
 *  DesktopBootstrap.tsx itself; every other field is present (full
 *  DesktopBootstrapHandle compliance) but inert, mirroring bootstrap.ts's
 *  own NOT_DESKTOP_HANDLE constant's exact shape/posture. */
function makeFakeHandle(initial: DesktopBootstrapState): {
  handle: DesktopBootstrapHandle;
  setState: (s: DesktopBootstrapState) => void;
  beginProvisionCalls: (string | undefined)[];
} {
  let current = initial;
  const listeners = new Set<(s: DesktopBootstrapState) => void>();
  const beginProvisionCalls: (string | undefined)[] = [];

  function setState(s: DesktopBootstrapState): void {
    current = s;
    for (const listener of listeners) listener(s);
  }

  const handle: DesktopBootstrapHandle = {
    state$: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentState: () => current,
    retryStep: () => {},
    beginProvision: (model) => {
      beginProvisionCalls.push(model);
    },
    log$: () => () => {},
    downloadProgress$: () => () => {},
    currentDownloadProgress: () => null,
    paths: FAKE_PATHS,
    recheckHealth: async () => {},
    reprovision: async () => {},
    requestProvisionCheck: async () => {},
    installedModel: async () => null,
    switchModel: async () => {},
    switchModelProgress$: () => () => {},
    currentSwitchModelProgress: () => null,
    installDiarization: async () => {},
    readSidecarLog: async () => "",
  };

  return { handle, setState, beginProvisionCalls };
}

describe("DesktopBootstrap — F6: onboarding only after a REAL first-run provisioning begin", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.remove();
    container = null;
    mockInitDesktop.mockReset();
  });

  async function mount(): Promise<void> {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<DesktopBootstrap />);
    });
  }

  function onboardingShown(): boolean {
    return container!.querySelector('[data-testid="fake-onboarding-steps"]') !== null;
  }

  it("a returning user's model-switch failure recovering (HEALTHY -> STEP/ERROR -> HEALTHY) never shows onboarding", async () => {
    const { handle, setState } = makeFakeHandle({ phase: "CHECKING" });
    mockInitDesktop.mockResolvedValue(handle);

    await mount();
    await act(async () => {
      setState({ phase: "HEALTHY" }); // ordinary launch adopting an already-healthy sidecar
    });
    expect(onboardingShown()).toBe(false);

    await act(async () => {
      setState({
        phase: "STEP",
        step: "STARTING",
        status: "ERROR",
        error: "switch failed",
        retriable: true,
      }); // bootstrap.ts's own landOnSwitchFailure — reuses the SAME "STEP" phase a first-run provision uses
    });
    expect(onboardingShown()).toBe(false);

    await act(async () => {
      setState({ phase: "HEALTHY" }); // recovered — NOT a first-run provisioning finishing
    });
    expect(onboardingShown()).toBe(false);
  });

  it("consent -> beginProvision -> STEP -> HEALTHY (a REAL first-run provisioning) shows onboarding exactly once", async () => {
    const { handle, setState, beginProvisionCalls } = makeFakeHandle({ phase: "WIZARD_CONSENT_REQUIRED" });
    mockInitDesktop.mockResolvedValue(handle);

    await mount();
    expect(onboardingShown()).toBe(false);

    await act(async () => {
      container!.querySelector('[data-testid="fake-begin-provision"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(beginProvisionCalls).toEqual(["fake-model"]);

    await act(async () => {
      setState({ phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" });
    });
    expect(onboardingShown()).toBe(false);

    await act(async () => {
      setState({ phase: "HEALTHY" });
    });
    expect(onboardingShown()).toBe(true);
  });
});

// Field-test fix (desktop first-run onboarding never seen — verified
// root cause): DesktopBootstrap's own sync of store.ts's wizardVisible —
// see that field's own doc comment for the full contract this is
// standing in for (page.tsx itself has no existing test harness to
// extend — see this worker's own PR report).
describe("DesktopBootstrap — field-test fix (wizardVisible sync into store.ts)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.remove();
    container = null;
    mockInitDesktop.mockReset();
  });

  async function mount(): Promise<void> {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<DesktopBootstrap />);
    });
  }

  function onboardingShown(): boolean {
    return container!.querySelector('[data-testid="fake-onboarding-steps"]') !== null;
  }

  it("mirrors the wizard's own visibility: true while WIZARD_CONSENT_REQUIRED/STEP, false once HEALTHY", async () => {
    const { handle, setState } = makeFakeHandle({ phase: "WIZARD_CONSENT_REQUIRED" });
    mockInitDesktop.mockResolvedValue(handle);

    await mount();
    expect(useApp.getState().wizardVisible).toBe(true);

    await act(async () => {
      setState({ phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" });
    });
    expect(useApp.getState().wizardVisible).toBe(true);

    await act(async () => {
      setState({ phase: "HEALTHY" });
    });
    expect(useApp.getState().wizardVisible).toBe(false);
  });

  it("stays true through the post-install onboarding steps too (showOnboarding) — the SAME full-screen WizardFrame chrome as WIZARD_CONSENT_REQUIRED/STEP, not just those two phases", async () => {
    const { handle, setState } = makeFakeHandle({ phase: "WIZARD_CONSENT_REQUIRED" });
    mockInitDesktop.mockResolvedValue(handle);

    await mount();
    await act(async () => {
      container!.querySelector('[data-testid="fake-begin-provision"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await act(async () => {
      setState({ phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" });
    });

    await act(async () => {
      setState({ phase: "HEALTHY" }); // real beginProvision + STEP -> HEALTHY triggers onboarding
    });
    expect(onboardingShown()).toBe(true);
    expect(useApp.getState().wizardVisible).toBe(true); // onboarding is STILL a full-screen overlay
  });

  it("resets to false on unmount", async () => {
    const { handle } = makeFakeHandle({ phase: "WIZARD_CONSENT_REQUIRED" });
    mockInitDesktop.mockResolvedValue(handle);

    await mount();
    expect(useApp.getState().wizardVisible).toBe(true);

    await act(async () => {
      root!.unmount();
    });
    root = null;
    expect(useApp.getState().wizardVisible).toBe(false);
  });

  it("never leaves the screen uncovered mid-transition: HEALTHY (nothing to show) never marks wizardVisible true", async () => {
    const { handle } = makeFakeHandle({ phase: "HEALTHY" });
    mockInitDesktop.mockResolvedValue(handle);

    await mount();
    expect(useApp.getState().wizardVisible).toBe(false);
  });
});
