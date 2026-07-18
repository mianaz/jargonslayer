// @vitest-environment jsdom
//
// SettingsDialog — desktop-only coverage (F5 + F7, MEDIUM, adversarial
// review). IS_DESKTOP is a module-scope import-time const
// (lib/platform/desktop.ts) — vi.mock affects this whole file, so this
// lives in its own file rather than a describe block inside
// SettingsDialog.test.tsx, which needs the REAL (false) value for its
// own ambient (web) coverage — same split TaskCenterDrawer.desktop.
// test.tsx already established for the identical constraint (see that
// file's own header comment).
//
// F5's own describe block seeds sidecarMode "external" so the 当前模型/
// 说话人分离 安装扩展 managed-only mount effects (initDesktop()/
// fetchSidecarHealth()) never fire — that suite only needs to control
// connectOpenRouterDesktop. F7's own describe block below seeds
// "managed" instead, to reach diarizationInstalled's own probe/install
// flow, and mocks initDesktop/fetchSidecarHealth/probeSidecar
// accordingly. audiocapCaps's own probe effect (unconditional on
// IS_DESKTOP, unrelated to sidecarMode either way) is stubbed for both:
// its REAL implementation would otherwise reach tauriApi.ts's
// getInvoke(), which throws SYNCHRONOUSLY outside an actual
// NEXT_PUBLIC_DESKTOP=1 build (a second, independent desktop flag this
// file's IS_DESKTOP mock does not touch — see tauriApi.ts's own header
// comment on why the two are kept deliberately separate).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/platform/desktop", () => ({ IS_DESKTOP: true }));

const mockProbeAudiocapCaps = vi.fn(async () => ({ appAudioSupported: true, reason: null }));
vi.mock("@/lib/desktop/audiocapCaps", () => ({
  probeAudiocapCaps: () => mockProbeAudiocapCaps(),
  isAppAudioFloorLocked: () => false,
  appAudioLockReason: () => "",
}));

// S11 osspeech blueprint (§3 Worker D) — only useOsSpeechCaps/
// preinstallOsSpeech are mocked (both would otherwise reach
// tauriApi.ts's getInvoke(), which throws synchronously outside a real
// desktop build, same reason audiocapCaps is mocked above);
// isOsSpeechFloorLocked/osSpeechLockReason are pure functions of their
// own arguments with no Tauri dependency, so they're left REAL via
// importOriginal — this suite's own osspeech gating tests exercise the
// genuine gating logic, not a stand-in.
const mockUseOsSpeechCaps = vi.fn(
  () => null as { supported: boolean; reason: string | null; locales: string[]; installedLocales: string[] } | null,
);
const mockPreinstallOsSpeech = vi.fn(async (_locale: string) => undefined);
vi.mock("@/lib/desktop/osspeechCaps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop/osspeechCaps")>();
  return {
    ...actual,
    useOsSpeechCaps: () => mockUseOsSpeechCaps(),
    preinstallOsSpeech: (locale: string) => mockPreinstallOsSpeech(locale),
  };
});

const mockConnectOpenRouterDesktop = vi.fn();
vi.mock("@/lib/oauth/openrouterDesktop", () => ({
  connectOpenRouterDesktop: () => mockConnectOpenRouterDesktop(),
}));

// S12b fix round FB8-refresh (§F) — the ONE describe block below that
// actually opens the embedded <ModelPicker> (every pre-existing block in
// this file only checks 更换模型's own `disabled` attribute, never
// clicks it) needs mlxCaps.ts's real probe short-circuited: with
// IS_DESKTOP mocked true above but tauriApi.ts left REAL, mlxCaps.ts's
// own probeMlxCaps() would reach tauriApi.ts's getInvoke(), which
// throws SYNCHRONOUSLY outside an actual NEXT_PUBLIC_DESKTOP=1 build —
// same landmine class audiocapCaps/osspeechCaps are mocked above to
// avoid. Always resolves "supported" — harmless/inert for every
// PRE-EXISTING test in this file (none of them ever reach ModelPicker
// at all).
vi.mock("@/lib/desktop/mlxCaps", () => ({
  getMlxCapsSnapshot: () => ({ mlxSupported: true, reason: null }),
  subscribeMlxCaps: () => () => {},
  probeMlxCaps: async () => ({ status: "ok" as const, caps: { mlxSupported: true, reason: null } }),
  refreshMlxCaps: async () => ({ status: "ok" as const, caps: { mlxSupported: true, reason: null } }),
}));

// F7 only — F5's own describe block never reaches any of these three
// (sidecarMode:"external" skips the managed-gated effects/handlers
// that would call them).
const mockInitDesktop = vi.fn();
vi.mock("@/lib/desktop/bootstrap", () => ({
  initDesktop: () => mockInitDesktop(),
}));
const mockFetchSidecarHealth = vi.fn();
vi.mock("@/lib/stt/upload", () => ({
  fetchSidecarHealth: (settings: unknown) => mockFetchSidecarHealth(settings),
}));
const mockProbeSidecar = vi.fn();
vi.mock("@/lib/stt/sidecarHealth", () => ({
  probeSidecar: (settings: unknown) => mockProbeSidecar(settings),
}));

import { useApp } from "../../lib/store";
import { useTasks } from "../../lib/tasks/registry";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import type { DesktopBootstrapHandle } from "@/lib/desktop/bootstrap";
import { remapOpenRouterModelDefaults } from "@/lib/oauth/openrouterModelDefaults";
import SettingsDialog, {
  OSSPEECH_PREINSTALL_BUSY_LABEL,
  OSSPEECH_PREINSTALL_DONE_LABEL,
  OSSPEECH_PREINSTALL_IDLE_LABEL,
} from "../SettingsDialog";

// Already on the "openrouter" preset (provider/baseUrl match
// PROVIDER_PRESETS' own "openrouter" entry) — this is what makes
// CredentialFields render the "一键连接 OpenRouter 账号" button at all
// (activePreset === "openrouter" && onConnectOpenRouter, see that
// component's own gating).
function openRouterSeedSettings(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    uiMode: "advanced",
    sidecarMode: "external",
    provider: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-or-original",
  };
}

function resetStore() {
  useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: false });
}

// React tracks an <input>'s value via a wrapped native setter — same
// bypass OnboardingByokStep.test.tsx's own typeInto already documents.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)!.set!;
function typeInto(input: HTMLInputElement, value: string) {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SettingsDialog (desktop) — F5: OAuth-success draft resync must not clobber unrelated unsaved edits", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({ settings: openRouterSeedSettings(), hydrated: true });
    mockConnectOpenRouterDesktop.mockReset();
    mockProbeAudiocapCaps.mockClear();
    // useProviderModels' own debounced (~400ms) model-list fetch fires
    // once the AI 检测 credentials block mounts enabled — never awaited
    // by this suite (irrelevant to the draft-merge assertions below),
    // but stubbed so a slow CI run can never turn it into a real
    // network call.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in tests")));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root!.unmount());
    container!.remove();
    container = null;
    root = null;
    resetStore();
    vi.unstubAllGlobals();
  });

  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function findNavButton(label: string): HTMLButtonElement {
    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const btn = navButtons.find((b) => b.textContent === label);
    if (!btn) throw new Error(`nav button "${label}" not found`);
    return btn;
  }

  function findButtonContaining(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(text),
    );
    if (!btn) throw new Error(`button containing "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  it("connecting via OAuth merges ONLY provider/baseUrl/apiKey into the draft — an unrelated draft-only 检测模型 edit survives, and the new key lands", async () => {
    mockConnectOpenRouterDesktop.mockImplementation(async () => {
      // Mirrors connectOpenRouterDesktop's own PINNED contract (writes
      // straight to the LIVE store on success — see that module's own
      // doc comment); this mock replicates the one side effect
      // handleConnectOpenRouter's own resync depends on.
      useApp.getState().updateSettings({
        provider: "openai-compat",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-newly-issued",
      });
      return { ok: true };
    });

    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    await act(async () => {
      findNavButton("AI 检测").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const detectInput = container!.querySelector(
      'input[list="primary-detect-options"]',
    ) as HTMLInputElement | null;
    if (!detectInput) throw new Error("检测模型 input not found");
    await act(async () => {
      typeInto(detectInput, "my-custom-detect-model-xyz");
    });
    expect(detectInput.value).toBe("my-custom-detect-model-xyz");

    await act(async () => {
      findButtonContaining("一键连接 OpenRouter 账号").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();

    expect(mockConnectOpenRouterDesktop).toHaveBeenCalledTimes(1);

    // The draft-only 检测模型 edit must survive the post-connect resync…
    const detectInputAfter = container!.querySelector(
      'input[list="primary-detect-options"]',
    ) as HTMLInputElement;
    expect(detectInputAfter.value).toBe("my-custom-detect-model-xyz");

    // …and the newly-issued key IS reflected in the draft.
    const keyInput = container!.querySelector('input[placeholder="sk-…"]') as HTMLInputElement;
    expect(keyInput.value).toBe("sk-or-newly-issued");

    // F (persistence investigation): the typed-but-unsaved 检测模型 edit
    // must survive all the way through a real 保存, not just the
    // post-connect resync above — this is scenario (2) from the task's
    // own investigation list ("does the typed draft value survive
    // 保存?"). detectModel was UNCHANGED by this mock's own updateSettings
    // (only provider/baseUrl/apiKey), so the diff-based model resync
    // (see handleConnectOpenRouter's own beforeSettings comment) never
    // touches draft.detectModel — 保存 writes the user's typed value
    // straight through.
    await act(async () => {
      findButtonContaining("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.detectModel).toBe("my-custom-detect-model-xyz");
  });

  // Field-test fix (real user report) — the bug this whole diff-based
  // resync closes: connectOpenRouterDesktop's own conditional
  // detectModel/summaryModel remap (openrouterModelDefaults.ts) lands
  // on the LIVE store same as provider/baseUrl/apiKey, but the ORIGINAL
  // F5 merge above never resynced those two fields into `draft` — so a
  // user who never touched the 检测模型/会议报告模型 fields at all would
  // click 保存 (writing their STALE open-time draft, still the bare
  // pre-fix model) and silently revert the very fix OAuth just applied.
  // RED against the pre-fix merge (provider/baseUrl/apiKey only): this
  // test's final two assertions would have failed (settings reverted to
  // "claude-haiku-4-5"/"claude-sonnet-5") before the diff-based
  // detectModel/summaryModel merge existed.
  it("field-test fix: OAuth's own conditional detectModel/summaryModel remap is resynced into the draft too — 保存 (without ever touching those fields) must not revert it back to the stale pre-connect value", async () => {
    useApp.setState({
      settings: {
        ...openRouterSeedSettings(),
        detectModel: "claude-haiku-4-5",
        summaryModel: "claude-sonnet-5",
      },
      hydrated: true,
    });

    mockConnectOpenRouterDesktop.mockImplementation(async () => {
      // Mirrors the REAL connectOpenRouterDesktop's conditional remap
      // (openrouterModelDefaults.ts): live detectModel/summaryModel
      // were bare, so the real OAuth completion would ALSO have
      // patched them alongside provider/baseUrl/apiKey.
      useApp.getState().updateSettings({
        provider: "openai-compat",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-newly-issued",
        detectModel: "deepseek/deepseek-v4-flash",
        summaryModel: "deepseek/deepseek-v4-pro",
      });
      return { ok: true };
    });

    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    await act(async () => {
      findNavButton("AI 检测").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // User never touches 检测模型/会议报告模型 at all — connects straight away.
    await act(async () => {
      findButtonContaining("一键连接 OpenRouter 账号").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();

    await act(async () => {
      findButtonContaining("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.detectModel).toBe("deepseek/deepseek-v4-flash");
    expect(useApp.getState().settings.summaryModel).toBe("deepseek/deepseek-v4-pro");
  });

  // R3 (adversarial review, HIGH): the ORIGINAL diff-based merge above
  // keyed its detectModel/summaryModel resync off whether LIVE changed
  // (`live[field] !== beforeSettings[field]`) — so a user who typed
  // their OWN unsaved custom 检测模型 edit into the draft got it
  // silently clobbered the instant OAuth's REAL conditional remap
  // (openrouterModelDefaults.ts's remapOpenRouterModelDefaults) ALSO
  // happened to touch the live model (because the pre-connect live
  // value was still a bare id). Exercises the REAL remap function
  // (not a credential-only mock) so this is provably the actual
  // production interaction, not a stand-in. RED against the pre-fix
  // `live[field] !== beforeSettings[field]` gate: the final assertion
  // below would have failed (detectModel reverted to
  // "deepseek/deepseek-v4-flash", the live remap's own output,
  // clobbering the user's still-unsaved "my-custom-detect-model-xyz").
  it("R3: an unsaved custom 检测模型 draft edit survives OAuth connect even when the REAL remapOpenRouterModelDefaults ALSO fires on the live store", async () => {
    useApp.setState({
      settings: {
        ...openRouterSeedSettings(),
        detectModel: "claude-haiku-4-5", // bare — remapOpenRouterModelDefaults will touch this on connect
        summaryModel: "claude-sonnet-5",
      },
      hydrated: true,
    });

    mockConnectOpenRouterDesktop.mockImplementation(async () => {
      // Mirrors connectOpenRouterDesktopWith's own real sequencing:
      // deps.getSettings() reads live settings at the moment the code
      // exchange succeeds, and the real remapOpenRouterModelDefaults
      // (imported here, not reimplemented) decides the patch.
      const liveNow = useApp.getState().settings;
      useApp.getState().updateSettings({
        provider: "openai-compat",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-newly-issued",
        ...remapOpenRouterModelDefaults(liveNow),
      });
      return { ok: true };
    });

    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    await act(async () => {
      findNavButton("AI 检测").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const detectInput = container!.querySelector(
      'input[list="primary-detect-options"]',
    ) as HTMLInputElement | null;
    if (!detectInput) throw new Error("检测模型 input not found");
    await act(async () => {
      typeInto(detectInput, "my-custom-detect-model-xyz");
    });
    expect(detectInput.value).toBe("my-custom-detect-model-xyz");

    await act(async () => {
      findButtonContaining("一键连接 OpenRouter 账号").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();

    // The real remap DID fire on the live store (proving this isn't a
    // vacuous test)...
    expect(useApp.getState().settings.detectModel).toBe("deepseek/deepseek-v4-flash");
    // ...but the user's own unsaved draft edit must survive the resync
    // untouched.
    const detectInputAfter = container!.querySelector(
      'input[list="primary-detect-options"]',
    ) as HTMLInputElement;
    expect(detectInputAfter.value).toBe("my-custom-detect-model-xyz");

    await act(async () => {
      findButtonContaining("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.detectModel).toBe("my-custom-detect-model-xyz");
  });
});

// ---------------------------------------------------------------
// F7 (MEDIUM, adversarial review): jobsBridge.trackInstallDiar's own
// success handler mirrors sidecarUp into the STORE, but this dialog's
// OWN diarizationInstalled comes from a SEPARATE fetchSidecarHealth
// call (the 说话人分离 install-state row's own probe) — an open dialog
// kept showing 需先安装 until reopened even after the install actually
// finished. Fixed by re-running that same probe once the diar-install
// task reaches "done" while the dialog stays open.
// ---------------------------------------------------------------

function diarSeedSettings(): Settings {
  return { ...DEFAULT_SETTINGS, uiMode: "advanced", sidecarMode: "managed" };
}

const FAKE_PATHS = {
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

/** A scriptable stand-in for the real bootstrapDesktop() handle — only
 *  installDiarization() is exercised by this suite (handleInstallDiarization
 *  -> jobsBridge.trackInstallDiar); every other field is present (full
 *  DesktopBootstrapHandle compliance) but inert, mirroring bootstrap.ts's
 *  own NOT_DESKTOP_HANDLE constant's exact shape/posture.
 *
 *  `overrides` (S12b fix round FB7/FB8, §F): an optional partial spread
 *  onto the base shape above — added so the FB7-settings/FB8-refresh
 *  describe block below can drive `installedModel` to a specific value
 *  (e.g. "parakeet-tdt-0.6b-v3") without depending on bootstrap.ts's
 *  REAL switchModel/marker internals (that coupling belongs to
 *  SettingsDialog.parakeetSwitch.integration.test.tsx alone, which
 *  exercises the real module) — every PRE-EXISTING call site omits it
 *  and is byte-unaffected (`undefined` spreads to nothing). */
function makeFakeHandle(
  overrides: Partial<DesktopBootstrapHandle> = {},
): { handle: DesktopBootstrapHandle; resolveInstall: () => void } {
  let resolveInstall!: () => void;
  const installPromise = new Promise<void>((resolve) => {
    resolveInstall = resolve;
  });
  const handle: DesktopBootstrapHandle = {
    state$: () => () => {},
    currentState: () => ({ phase: "HEALTHY" }),
    retryStep: () => {},
    beginProvision: () => {},
    log$: () => () => {},
    downloadProgress$: () => () => {},
    currentDownloadProgress: () => null,
    paths: FAKE_PATHS,
    recheckHealth: async () => {},
    reprovision: async () => {},
    installedModel: async () => null,
    switchModel: async () => {},
    switchModelProgress$: () => () => {},
    currentSwitchModelProgress: () => null,
    installDiarization: () => installPromise,
    readSidecarLog: async () => "",
    ...overrides,
  };
  return { handle, resolveInstall };
}

describe("SettingsDialog (desktop) — F7: a completed diar-install task refreshes the OPEN dialog's own probe", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({ settings: diarSeedSettings(), hydrated: true });
    mockInitDesktop.mockReset();
    mockFetchSidecarHealth.mockReset();
    mockProbeSidecar.mockReset().mockResolvedValue({ up: true });
    mockProbeAudiocapCaps.mockClear();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in tests")));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root!.unmount());
    container!.remove();
    container = null;
    root = null;
    resetStore();
    useTasks.setState({ tasks: {} });
    vi.unstubAllGlobals();
  });

  async function flushUntil(check: () => boolean, maxTicks = 50): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      if (check()) return;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    if (!check()) throw new Error("flushUntil: condition never became true");
  }

  function findNavButton(label: string): HTMLButtonElement {
    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const btn = navButtons.find((b) => b.textContent === label);
    if (!btn) throw new Error(`nav button "${label}" not found`);
    return btn;
  }

  function findButtonContaining(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(text),
    );
    if (!btn) throw new Error(`button containing "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  it("completing a diar-install task while the dialog stays open re-probes and flips 未安装 -> 已安装 without reopening", async () => {
    mockFetchSidecarHealth
      .mockResolvedValueOnce({
        ok: true,
        diarization_installed: false,
        diarization_ready: false,
        diarization_error: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        diarization_installed: true,
        diarization_ready: true,
        diarization_error: null,
      });
    const { handle, resolveInstall } = makeFakeHandle();
    mockInitDesktop.mockResolvedValue(handle);

    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await act(async () => {
      findNavButton("说话人分离").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushUntil(() => container!.textContent?.includes("未安装") ?? false);

    expect(container!.textContent).toContain("需先安装说话人分离扩展");

    await act(async () => {
      findButtonContaining("安装扩展").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushUntil(() => mockInitDesktop.mock.calls.length >= 1);

    // Still mid-install — the OLD probe result (未安装) is untouched.
    expect(container!.textContent).toContain("未安装");
    expect(mockFetchSidecarHealth).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInstall();
    });

    // The task reaching "done" (jobsBridge's own probeSidecar + completeTask
    // chain) must re-trigger THIS dialog's own diarization probe — the
    // fix under test — flipping the row to 已安装 without reopening.
    await flushUntil(() => container!.textContent?.includes("已安装") ?? false);
    expect(mockFetchSidecarHealth).toHaveBeenCalledTimes(2);
    expect(container!.textContent).not.toContain("需先安装说话人分离扩展");
  });
});

describe("SettingsDialog (desktop) — S11 osspeech ENGINE_CARD gating + 预下载模型 + diarize hint (§3 Worker D)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  // sidecarMode "external" (mirrors F5's own openRouterSeedSettings) —
  // none of this describe block's own assertions touch the managed-mode
  // sidecar probe/install machinery F7 above exercises; uiMode
  // "advanced" (mirrors F5's own seed too) keeps every #62
  // progressive-disclosure section visible regardless of level.
  function engineSeedSettings(): Settings {
    return { ...DEFAULT_SETTINGS, uiMode: "advanced", sidecarMode: "external" };
  }

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({ settings: engineSeedSettings(), hydrated: true });
    mockUseOsSpeechCaps.mockReset().mockReturnValue(null);
    mockPreinstallOsSpeech.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in tests")));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root!.unmount());
    container!.remove();
    container = null;
    root = null;
    resetStore();
    vi.unstubAllGlobals();
  });

  function findNavButton(label: string): HTMLButtonElement {
    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const btn = navButtons.find((b) => b.textContent === label);
    if (!btn) throw new Error(`nav button "${label}" not found`);
    return btn;
  }

  function findOsSpeechCard(): HTMLButtonElement {
    const card = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("系统识别 · 开箱即用"),
    );
    if (!card) throw new Error('"系统识别 · 开箱即用" card not found');
    return card as HTMLButtonElement;
  }

  // S11 fix-round J5: the 识别语言 <select> has no data-testid of its
  // own — found the same way findOsSpeechCard/findNavButton above locate
  // their own targets (by rendered text), via its preceding <label>'s
  // sibling <select>.
  function findLanguageSelect(): HTMLSelectElement {
    const label = Array.from(container!.querySelectorAll("label")).find((l) => l.textContent === "识别语言");
    const select = label?.parentElement?.querySelector("select");
    if (!select) throw new Error("识别语言 select not found");
    return select as HTMLSelectElement;
  }

  it("系统识别 card: floor-locked with the caps' own reason when osspeech caps report unsupported", async () => {
    mockUseOsSpeechCaps.mockReturnValue({
      supported: false,
      reason: "需要 macOS 26 或更高版本",
      locales: [],
      installedLocales: [],
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    const card = findOsSpeechCard();
    expect(card.disabled).toBe(true);
    expect(card.title).toBe("需要 macOS 26 或更高版本");
  });

  it("系统识别 card: selectable (not locked) once osspeech caps report supported", async () => {
    mockUseOsSpeechCaps.mockReturnValue({ supported: true, reason: null, locales: ["zh_CN"], installedLocales: [] });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    const card = findOsSpeechCard();
    expect(card.disabled).toBe(false);
    expect(card.title).toBeFalsy();
  });

  it("预下载模型 button: busy while preinstallOsSpeech(draft.language) is in flight, done once it resolves", async () => {
    mockUseOsSpeechCaps.mockReturnValue({ supported: true, reason: null, locales: [], installedLocales: [] });
    useApp.setState({ settings: { ...engineSeedSettings(), engine: "osspeech", language: "zh-CN" }, hydrated: true });
    let resolvePreinstall!: () => void;
    mockPreinstallOsSpeech.mockReturnValue(
      new Promise<undefined>((resolve) => {
        resolvePreinstall = () => resolve(undefined);
      }),
    );

    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });

    const btn = container!.querySelector('[data-testid="btn-preinstall-osspeech"]') as HTMLButtonElement;
    expect(btn.textContent).toBe(OSSPEECH_PREINSTALL_IDLE_LABEL);

    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockPreinstallOsSpeech).toHaveBeenCalledWith("zh-CN");
    expect(btn.textContent).toBe(OSSPEECH_PREINSTALL_BUSY_LABEL);
    expect(btn.disabled).toBe(true);

    await act(async () => {
      resolvePreinstall();
      await Promise.resolve();
    });
    expect(btn.textContent).toBe(OSSPEECH_PREINSTALL_DONE_LABEL);
    expect(btn.disabled).toBe(true);
  });

  // S11 fix-round J5 (Opus LOW): 已下载 used to be a bare boolean,
  // surviving ANY later draft.language switch — so preinstalling for
  // zh-CN, then switching to a DIFFERENT language, kept showing 已下载
  // for a language that was never actually preinstalled.
  it("预下载模型 button: 已下载 is keyed by the language it was preinstalled for — switching draft.language afterward shows 预下载模型 again, not a stale 已下载", async () => {
    mockUseOsSpeechCaps.mockReturnValue({ supported: true, reason: null, locales: [], installedLocales: [] });
    useApp.setState({ settings: { ...engineSeedSettings(), engine: "osspeech", language: "zh-CN" }, hydrated: true });
    mockPreinstallOsSpeech.mockResolvedValue(undefined);

    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });

    const btn = container!.querySelector('[data-testid="btn-preinstall-osspeech"]') as HTMLButtonElement;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockPreinstallOsSpeech).toHaveBeenCalledWith("zh-CN");
    expect(btn.textContent).toBe(OSSPEECH_PREINSTALL_DONE_LABEL);

    const languageSelect = findLanguageSelect();
    await act(async () => {
      languageSelect.value = "en-GB";
      languageSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(btn.textContent).toBe(OSSPEECH_PREINSTALL_IDLE_LABEL);
    expect(btn.disabled).toBe(false);
  });

  it("实时说话人分离 row: shows 该引擎不支持说话人分离 (not 需先配置 HF Token) when draft.engine is osspeech", async () => {
    useApp.setState({ settings: { ...engineSeedSettings(), engine: "osspeech" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await act(async () => {
      findNavButton("说话人分离").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.textContent).toContain("该引擎不支持说话人分离");
    expect(container!.textContent).not.toContain("需先配置 HF Token");
  });
});

// ---------------------------------------------------------------
// S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
// Provision state machine, worker A3) — mlx-install task progress is
// DISPLAY-ONLY wiring here (see installingMlx's own doc comment in
// SettingsDialog.tsx): worker A2's provisionMachine.ts/bootstrap.ts own
// the actual "mlx-install" task emission (as part of a parakeet-family
// model's two-phase provision), so this suite drives the registry
// DIRECTLY via useTasks.setState — mirroring the F7 describe block
// above's own "managed" seed + initDesktop/fetchSidecarHealth mocking,
// reusing its makeFakeHandle()/FAKE_PATHS/diarSeedSettings.
// ---------------------------------------------------------------

describe("SettingsDialog (desktop) — S12a mlx-install task progress + gating (§C Provision state machine, worker A3)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({ settings: diarSeedSettings(), hydrated: true });
    mockInitDesktop.mockReset();
    mockFetchSidecarHealth.mockReset().mockResolvedValue({
      ok: true,
      diarization_installed: true,
      diarization_ready: true,
      diarization_error: null,
    });
    mockProbeSidecar.mockReset().mockResolvedValue({ up: true });
    mockProbeAudiocapCaps.mockClear();
    const { handle } = makeFakeHandle();
    mockInitDesktop.mockResolvedValue(handle);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in tests")));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root!.unmount());
    container!.remove();
    container = null;
    root = null;
    resetStore();
    useTasks.setState({ tasks: {} });
    vi.unstubAllGlobals();
  });

  async function flushUntil(check: () => boolean, maxTicks = 50): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      if (check()) return;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    if (!check()) throw new Error("flushUntil: condition never became true");
  }

  function findNavButton(label: string): HTMLButtonElement {
    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const btn = navButtons.find((b) => b.textContent === label);
    if (!btn) throw new Error(`nav button "${label}" not found`);
    return btn;
  }

  function findButtonContaining(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(text),
    );
    if (!btn) throw new Error(`button containing "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  function seedRunningMlxInstall() {
    useTasks.setState({
      tasks: {
        t1: {
          id: "t1",
          kind: "mlx-install",
          label: "安装 MLX 运行环境",
          stage: "",
          status: "running",
          createdAt: 0,
          updatedAt: 0,
        },
      },
    });
  }

  it("no running mlx-install task: no MLX hint renders, and 更换模型/重新运行安装向导 are unaffected by it", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    expect(container!.textContent).not.toContain("正在安装 MLX 运行环境");
    expect(findButtonContaining("更换模型").disabled).toBe(false);
    expect(findButtonContaining("重新运行安装向导").disabled).toBe(false);
  });

  it("a running mlx-install task shows the 后台任务 hint and disables 更换模型/重新运行安装向导 (same mutual-exclusion set as switchingModel/installingDiarization, S4 review Finding 1c)", async () => {
    seedRunningMlxInstall();
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });

    expect(container!.textContent).toContain("正在安装 MLX 运行环境，进度见右下角「后台任务」");
    expect(findButtonContaining("更换模型").disabled).toBe(true);
    expect(findButtonContaining("重新运行安装向导").disabled).toBe(true);
  });

  it("a running mlx-install task also disables 说话人分离's own 安装扩展 button (joins the SAME mutual-exclusion set)", async () => {
    mockFetchSidecarHealth.mockResolvedValue({
      ok: true,
      diarization_installed: false,
      diarization_ready: false,
      diarization_error: null,
    });
    seedRunningMlxInstall();
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await act(async () => {
      findNavButton("说话人分离").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushUntil(() => container!.textContent?.includes("未安装") ?? false);

    expect(findButtonContaining("安装扩展").disabled).toBe(true);
  });

  it("the mlx-install hint clears and 更换模型/重新运行安装向导 re-enable once the task leaves the running state", async () => {
    seedRunningMlxInstall();
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    expect(container!.textContent).toContain("正在安装 MLX 运行环境");

    await act(async () => {
      useTasks.setState((s) => ({ tasks: { ...s.tasks, t1: { ...s.tasks.t1, status: "done" } } }));
    });

    expect(container!.textContent).not.toContain("正在安装 MLX 运行环境");
    expect(findButtonContaining("更换模型").disabled).toBe(false);
    expect(findButtonContaining("重新运行安装向导").disabled).toBe(false);
  });
});

// ---------------------------------------------------------------
// S12b fix round FB7-settings + FB8-refresh (§F) — both driven off
// makeFakeHandle()'s own scriptable installedModel/switchModel (never
// bootstrap.ts's REAL switchModel internals, which are actively being
// developed by a concurrent lane in this same worktree as this suite
// was written — that coupling belongs to SettingsDialog.
// parakeetSwitch.integration.test.tsx alone, which exercises the real
// module on purpose). FB7 needs only `installedModel`/draft state (no
// picker interaction); FB8 additionally drives the REAL 更换模型 ->
// pick -> 下载并切换 click path so a REAL "model-download" task lands in
// the REAL task registry (jobsBridge.trackSwitchModel, unmocked) and
// genuinely settles "done" — the same registry-subscription shape the
// S12a mlx-install describe block above already established for
// mlx-install task progress, reused here for switchModelDone.
// ---------------------------------------------------------------

describe("SettingsDialog (desktop) — S12b fix round FB7-settings + FB8-refresh (§F)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  function fb7SeedSettings(overrides: Partial<Settings> = {}): Settings {
    return {
      ...DEFAULT_SETTINGS,
      uiMode: "advanced",
      sidecarMode: "managed",
      engine: "whisper",
      whisperModel: "medium",
      hfToken: "hf_test_token_123",
      ...overrides,
    };
  }

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({ settings: fb7SeedSettings(), hydrated: true });
    mockInitDesktop.mockReset();
    mockFetchSidecarHealth.mockReset().mockResolvedValue({
      ok: true,
      diarization_installed: true,
      diarization_ready: true,
      diarization_error: null,
    });
    mockProbeSidecar.mockReset().mockResolvedValue({ up: true });
    mockProbeAudiocapCaps.mockClear();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in tests")));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root!.unmount());
    container!.remove();
    container = null;
    root = null;
    resetStore();
    useTasks.setState({ tasks: {} });
    vi.unstubAllGlobals();
  });

  async function flushUntil(check: () => boolean, maxTicks = 50): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      if (check()) return;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    if (!check()) throw new Error("flushUntil: condition never became true");
  }

  function findButtonContaining(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
    if (!btn) throw new Error(`button containing "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  function findNavButton(label: string): HTMLButtonElement {
    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const btn = navButtons.find((b) => b.textContent === label);
    if (!btn) throw new Error(`nav button "${label}" not found`);
    return btn;
  }

  /** 说话人分离's own section only mounts once that nav category is
   *  active (activeCategory === "diarization", SettingsDialog.tsx) —
   *  every test below that needs the toggle/安装扩展 box navigates there
   *  first, same as this file's own pre-existing S12a "说话人分离's own
   *  安装扩展" test does. */
  async function openDiarizationSection(): Promise<void> {
    await act(async () => {
      findNavButton("说话人分离").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  /** 实时说话人分离's own <ToggleSwitch> — a real <button role="switch">
   *  nested inside the <label> carrying the row's own visible text
   *  (ToggleSwitch.tsx's own doc comment), not a standalone testid. */
  function findRealtimeDiarizeToggle(): HTMLButtonElement {
    const label = Array.from(container!.querySelectorAll("label")).find((l) =>
      l.textContent?.includes("实时说话人分离"),
    );
    if (!label) throw new Error("实时说话人分离 label not found");
    const toggle = label.querySelector('[role="switch"]');
    if (!toggle) throw new Error("实时说话人分离 toggle not found");
    return toggle as HTMLButtonElement;
  }

  it("FB7-settings: realtime toggle disabled + parakeet-specific reason when installedModel is parakeet (draft.whisperModel stays a whisper model)", async () => {
    const { handle } = makeFakeHandle({ installedModel: async () => "parakeet-tdt-0.6b-v3" });
    mockInitDesktop.mockResolvedValue(handle);
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    // 当前模型 line lives under the engine (default) category — waited
    // for THERE (installedModel's own async resolution) before
    // navigating away to 说话人分离, whose own section unmounts it.
    await flushUntil(() => container!.textContent?.includes("当前模型：parakeet-tdt-0.6b-v3") ?? false);
    await openDiarizationSection();

    expect(findRealtimeDiarizeToggle().disabled).toBe(true);
    expect(container!.textContent).toContain("parakeet 本地转录暂不支持实时说话人分离");
  });

  it("FB7-settings: realtime toggle disabled + parakeet-specific reason when draft.whisperModel (the SELECTED preference) is parakeet, even while installedModel is still a whisper model", async () => {
    useApp.setState({ settings: fb7SeedSettings({ whisperModel: "parakeet-tdt-0.6b-v3" }), hydrated: true });
    const { handle } = makeFakeHandle({ installedModel: async () => "medium" });
    mockInitDesktop.mockResolvedValue(handle);
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flushUntil(() => container!.textContent?.includes("当前模型：medium") ?? false);
    await openDiarizationSection();

    expect(findRealtimeDiarizeToggle().disabled).toBe(true);
    expect(container!.textContent).toContain("parakeet 本地转录暂不支持实时说话人分离");
  });

  it("FB7-settings: 安装扩展 gets an informational parakeet hint but stays ENABLED (communicates, doesn't block — installing ahead of a later whisper switch is still useful)", async () => {
    mockFetchSidecarHealth.mockResolvedValue({
      ok: true,
      diarization_installed: false,
      diarization_ready: false,
      diarization_error: null,
    });
    const { handle } = makeFakeHandle({ installedModel: async () => "parakeet-tdt-0.6b-v3" });
    mockInitDesktop.mockResolvedValue(handle);
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flushUntil(() => container!.textContent?.includes("当前模型：parakeet-tdt-0.6b-v3") ?? false);
    await openDiarizationSection();
    await flushUntil(() => container!.textContent?.includes("未安装") ?? false);

    expect(container!.textContent).toContain("parakeet 本地转录暂不支持实时说话人分离，安装扩展不会让当前会话生效");
    expect(findButtonContaining("安装扩展").disabled).toBe(false);
  });

  it("FB7-settings: unaffected for an ordinary whisper model — toggle available (token configured), no parakeet copy anywhere", async () => {
    const { handle } = makeFakeHandle({ installedModel: async () => "medium" });
    mockInitDesktop.mockResolvedValue(handle);
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flushUntil(() => container!.textContent?.includes("当前模型：medium") ?? false);
    await openDiarizationSection();

    expect(findRealtimeDiarizeToggle().disabled).toBe(false);
    expect(container!.textContent).not.toContain("parakeet 本地转录暂不支持实时说话人分离");
  });

  it("FB8-refresh: switch completes -> 当前模型 (and, downstream, FB7's own parakeet gate) reflects the NEW installed model WITHOUT closing/reopening the dialog", async () => {
    let installed = "small";
    const { handle } = makeFakeHandle({
      installedModel: async () => installed,
      switchModel: async (model: string) => {
        installed = model; // mirrors a real switchModel() actually landing the new marker
      },
    });
    mockInitDesktop.mockResolvedValue(handle);
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flushUntil(() => container!.textContent?.includes("当前模型：small") ?? false);
    await openDiarizationSection();
    expect(findRealtimeDiarizeToggle().disabled).toBe(false); // small is an ordinary whisper model — armed pre-switch

    // Back to 转录引擎 (更换模型 lives there) — activeCategory persists
    // across nav clicks within the same open dialog.
    await act(async () => {
      findNavButton("转录引擎").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      findButtonContaining("更换模型").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushUntil(() => container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]') !== null);

    await act(async () => {
      container!
        .querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      findButtonContaining("下载并切换").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await flushUntil(() =>
      Object.values(useTasks.getState().tasks).some((t) => t.kind === "model-download" && t.status === "done"),
    );

    // The product contract FB8 exists for: 当前模型 updates in place, and
    // FB7's own parakeet gate (downstream of the SAME installedModel
    // state) reacts too — neither needed the dialog closed/reopened.
    await flushUntil(() => container!.textContent?.includes("当前模型：parakeet-tdt-0.6b-v3") ?? false);
    await openDiarizationSection();
    expect(findRealtimeDiarizeToggle().disabled).toBe(true);
    expect(container!.textContent).toContain("parakeet 本地转录暂不支持实时说话人分离");
  });
});
