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

// S12b worker B2 (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md,
// §C L1) — the embedded <ModelPicker>'s own mlxOnly gating (worker A3,
// ModelPicker.tsx) reads mlxCaps.ts's probeMlxCaps()/refreshMlxCaps()
// directly, not through this file's own `paths`/callback props — this
// suite doesn't otherwise touch mlxCaps.ts at all, so left UNMOCKED
// every pre-existing (pre-B2) test below would still pass today: with
// IS_DESKTOP genuinely false in this jsdom test env (no
// `@/lib/platform/desktop` mock in this file), mlxCaps.ts's own
// probeMlxCaps() short-circuits to `{status:"error", caps: FAIL_CLOSED}`
// WITHOUT ever reaching tauriApi.ts's getInvoke() (see that module's own
// IS_DESKTOP guard) — i.e. every pre-existing test's parakeet row (now
// rendered, since modelCatalog.ts's own stub flips `available: true`
// this sprint) reads disabled-fail-closed by default, harmlessly, same
// as an unmocked ModelPicker.render.test.tsx row would. Mocked here only
// so the TWO new gating tests below (§C Gating F13's "supported" vs
// "unsupported" states) can drive an explicit result without fighting
// tauriApi's own dynamic `@tauri-apps/*` import — mirrors ModelPicker.
// render.test.tsx's own hoisted `mlxState` pattern (probeImpl/refreshImpl
// reassigned per-test), default here is the SAME fail-closed shape the
// real, unmocked module already produces in this jsdom env, so every
// OTHER (non-mlx) test in this file is byte-unaffected by this mock's
// mere presence.
const mlxState = vi.hoisted(() => {
  const FAIL_CLOSED = { mlxSupported: false, reason: "无法确认 Apple 芯片支持，请重试" };
  const state: {
    probeImpl: () => Promise<{ status: "ok" | "error"; caps: { mlxSupported: boolean; reason: string | null } }>;
  } = {
    probeImpl: async () => ({ status: "error", caps: FAIL_CLOSED }),
  };
  return state;
});
vi.mock("@/lib/desktop/mlxCaps", () => ({
  getMlxCapsSnapshot: () => null,
  subscribeMlxCaps: () => () => {},
  probeMlxCaps: () => mlxState.probeImpl(),
  refreshMlxCaps: () => mlxState.probeImpl(),
}));

import DesktopWizard, { RETURN_TO_CONSENT_LABEL, WIZARD_BUSY_LABEL } from "../DesktopWizard";
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
    // S12b worker B2 — same reset discipline, for the mlxCaps mock added
    // above: a gating test that overrides mlxState.probeImpl must never
    // bleed its result into a LATER, unrelated test.
    mlxState.probeImpl = async () => ({
      status: "error",
      caps: { mlxSupported: false, reason: "无法确认 Apple 芯片支持，请重试" },
    });
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

  // S12b fix round FB1-copy (§F) — the consent screen's own summary
  // paragraph must be honest PER SELECTION, not a static whisper-family
  // description regardless of what's actually picked.
  it("WIZARD_CONSENT_REQUIRED: the summary copy is the pre-existing whisper-family text (byte-identical) while a whisper model is selected — no faster-whisper/size claim leaks under a parakeet pick that hasn't happened yet", async () => {
    mockOsSpeechCaps = { supported: false };
    await renderWizard({ phase: "WIZARD_CONSENT_REQUIRED" }, [], {});

    const consent = container!.querySelector('[data-testid="desktop-wizard-consent"]')!;
    expect(consent.textContent).toContain("语音识别引擎（faster-whisper）");
    expect(consent.textContent).toContain("预计下载体积约 0.5–1.5 GB");
    expect(consent.textContent).toContain("Whisper 每约 30 秒判定一种语言"); // whisper-only guidance still shows
    // Narrower than a bare "MLX" substring check — parakeet's own
    // (always-rendered) catalog ROW text legitimately contains "MLX 本机
    //加速" regardless of what's currently selected; what must NOT leak
    // is the SUMMARY paragraph's own parakeet-branch sentence.
    expect(consent.textContent).not.toContain("MLX 运行环境（Apple 芯片加速）");
    expect(consent.textContent).not.toContain("仅支持 Apple 芯片（M 系列）。");
  });

  it("WIZARD_CONSENT_REQUIRED: selecting parakeet swaps the summary copy to the honest MLX/2.5GB framing, and hides the whisper-only guidance block (§F FB1-copy)", async () => {
    mockOsSpeechCaps = { supported: false };
    mlxState.probeImpl = async () => ({ status: "ok", caps: { mlxSupported: true, reason: null } });
    await renderWizard({ phase: "WIZARD_CONSENT_REQUIRED" }, [], {});
    await act(async () => {
      await Promise.resolve(); // let useMlxCaps' own mount-effect probe settle
    });

    await act(async () => {
      container!
        .querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const consent = container!.querySelector('[data-testid="desktop-wizard-consent"]')!;
    expect(consent.textContent).toContain("MLX");
    expect(consent.textContent).toContain("仅支持 Apple 芯片（M 系列）");
    expect(consent.textContent).toContain("预计下载体积约 2.5GB（含约 1GB MLX 运行环境，首次安装）");
    // The old whisper-family claims must NOT leak under a parakeet pick.
    expect(consent.textContent).not.toContain("faster-whisper");
    expect(consent.textContent).not.toContain("预计下载体积约 0.5–1.5 GB");
    // Whisper-only guidance (language-detection cadence + model-choice
    // matrix) is meaningless for parakeet — hidden, not reworded.
    expect(consent.textContent).not.toContain("Whisper 每约 30 秒判定一种语言");
    expect(consent.textContent).not.toContain("Apple Silicon 实时→medium");

    // Copy constants (tech-debt ledger #4): derives the expected label
    // from MODEL_CATALOG's own id/size, mirroring the 更换模型-tracking
    // test below instead of re-pinning a second copy of the "开始安装（…）"
    // wrapper text here.
    const parakeet = MODEL_CATALOG.find((m) => m.id === "parakeet-tdt-0.6b-v3")!;
    const beginBtn = container!.querySelector('[data-testid="btn-begin-provision"]')!;
    expect(beginBtn.textContent).toBe(`开始安装（${parakeet.id} · ${parakeet.size}）`);
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

  // S12b worker B2 (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md,
  // §C L1) — modelCatalog.ts's own parakeet stub is now `available:
  // true` (B2's flip), so the wizard step's own <ModelPicker> DOES
  // render its row unconditionally — the previous "never renders the
  // still-unavailable stub" contract this suite pinned pre-flip is
  // superseded by two real gating states instead: an INTEGRATION check
  // (real MODEL_CATALOG, real embedded <ModelPicker>, not ModelPicker's
  // own mocked-catalog unit tests) that the row shows up, is selectable,
  // and reaches onBeginProvision(model) on a supported-caps mock; and
  // that it still renders (available:true means it's never HIDDEN
  // anymore) but stays disabled/unselectable with a visible reason on an
  // unsupported-caps result — mlxOnly gating disables, it doesn't hide;
  // only `available:false` (ModelPicker.tsx's own OTHER, independent
  // gating layer, unaffected by this file's mlxCaps mock) hides a row
  // entirely, and no catalog entry is `available:false` today. "Web" is
  // a THIRD, structurally separate gate (page.tsx:297 mounts
  // <DesktopBootstrap>/this wizard only under IS_DESKTOP at all — S12a
  // §D F15, confirmed, not owned by this worker) — out of scope for a
  // DesktopWizard-level render test, which by construction only ever
  // renders on the "desktop" side of that gate.
  it("WIZARD_CONSENT_REQUIRED: the embedded <ModelPicker> renders the parakeet-tdt-0.6b-v3 row, selectable, when mlxCaps reports supported (§C Gating F13, §C L1 B2 flip)", async () => {
    mockOsSpeechCaps = { supported: false };
    mlxState.probeImpl = async () => ({ status: "ok", caps: { mlxSupported: true, reason: null } });
    const onBeginProvision = vi.fn();
    await renderWizard({ phase: "WIZARD_CONSENT_REQUIRED" }, [], { onBeginProvision });
    await act(async () => {
      await Promise.resolve(); // let useMlxCaps' own mount-effect probe settle
    });

    const parakeet = MODEL_CATALOG.find((m) => m.id === "parakeet-tdt-0.6b-v3");
    expect(parakeet?.available).toBe(true); // sanity: B2's flip landed

    const row = container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]') as HTMLButtonElement;
    expect(row).not.toBeNull();
    expect(row.disabled).toBe(false);
    expect(container!.querySelectorAll('[role="radio"]').length).toBe(MODEL_CATALOG.length); // every entry visible today

    await act(async () => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const beginBtn = container!.querySelector('[data-testid="btn-begin-provision"]')!;
    await act(async () => {
      beginBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onBeginProvision).toHaveBeenCalledWith("parakeet-tdt-0.6b-v3");
  });

  // S12b fix round FB10 (§F; product default, ON THE VETO LIST §7.7) —
  // supersedes this suite's own PRE-FB10 "still renders disabled" test:
  // the wizard now passes ModelPicker's own hideDefinitivelyUnsupported
  // prop, so a DEFINITIVELY-unsupported mlxOnly row is hidden entirely
  // here (Settings' own picker keeps the pre-FB10 disabled-with-reason
  // behavior instead — see ModelPicker.realCatalog.render.test.tsx's own
  // "hideDefinitivelyUnsupported" describe block for that side).
  it("WIZARD_CONSENT_REQUIRED: the embedded <ModelPicker>'s parakeet-tdt-0.6b-v3 row is HIDDEN entirely (not just disabled) when mlxCaps DEFINITIVELY reports unsupported (§F FB10)", async () => {
    mockOsSpeechCaps = { supported: false };
    const reason = "需要 Apple 芯片（M 系列），macOS 14 或更高";
    mlxState.probeImpl = async () => ({ status: "ok", caps: { mlxSupported: false, reason } });
    const onBeginProvision = vi.fn();
    await renderWizard({ phase: "WIZARD_CONSENT_REQUIRED" }, [], { onBeginProvision });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]')).toBeNull();
    expect(container!.textContent).not.toContain(reason);
    expect(container!.querySelectorAll('[role="radio"]').length).toBe(MODEL_CATALOG.length - 1);

    // WIZARD_PRESELECTED_MODEL (medium) is still what 开始安装 carries —
    // a hidden row was never reachable as a selection in the first place.
    const beginBtn = container!.querySelector('[data-testid="btn-begin-provision"]')!;
    await act(async () => {
      beginBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onBeginProvision).toHaveBeenCalledWith(WIZARD_PRESELECTED_MODEL);
    expect(onBeginProvision).not.toHaveBeenCalledWith("parakeet-tdt-0.6b-v3");
  });

  // §F FB10's own explicit carve-out: a transient probe ERROR is NEVER
  // hidden, on EITHER surface — the wizard still shows disabled+重试
  // here, same as pre-FB10 (retrying CAN change this answer, unlike a
  // definitive result).
  it("WIZARD_CONSENT_REQUIRED: the embedded <ModelPicker>'s parakeet-tdt-0.6b-v3 row still RENDERS disabled with a 重试 affordance (never hidden) on a transient mlxCaps probe ERROR (§F FB10's carve-out)", async () => {
    mockOsSpeechCaps = { supported: false };
    const FAIL_CLOSED = { mlxSupported: false, reason: "无法确认 Apple 芯片支持，请重试" };
    mlxState.probeImpl = async () => ({ status: "error", caps: FAIL_CLOSED });
    await renderWizard({ phase: "WIZARD_CONSENT_REQUIRED" }, [], {});
    await act(async () => {
      await Promise.resolve();
    });

    const row = container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]') as HTMLButtonElement;
    expect(row).not.toBeNull();
    expect(row.disabled).toBe(true);
    expect(container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3-retry"]')).not.toBeNull();
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
    expect(backBtn.textContent).toBe(RETURN_TO_CONSENT_LABEL);
    await act(async () => {
      backBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onReprovision).toHaveBeenCalledTimes(1);
    // busy while the awaited reprovision is still in flight — mirrors
    // TerminalErrorScreen's own 处理中… contract.
    expect(backBtn.textContent).toBe(WIZARD_BUSY_LABEL);
    expect(backBtn.disabled).toBe(true);
    await act(async () => {
      resolveReprovision();
      await reprovisionGate;
    });
    expect(backBtn.textContent).toBe(RETURN_TO_CONSENT_LABEL);
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
