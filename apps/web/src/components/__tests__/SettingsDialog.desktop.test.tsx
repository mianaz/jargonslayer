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
import SettingsDialog from "../SettingsDialog";

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
};

/** A scriptable stand-in for the real bootstrapDesktop() handle — only
 *  installDiarization() is exercised by this suite (handleInstallDiarization
 *  -> jobsBridge.trackInstallDiar); every other field is present (full
 *  DesktopBootstrapHandle compliance) but inert, mirroring bootstrap.ts's
 *  own NOT_DESKTOP_HANDLE constant's exact shape/posture. */
function makeFakeHandle(): { handle: DesktopBootstrapHandle; resolveInstall: () => void } {
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
    expect(btn.textContent).toBe("预下载模型");

    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockPreinstallOsSpeech).toHaveBeenCalledWith("zh-CN");
    expect(btn.textContent).toBe("下载中…");
    expect(btn.disabled).toBe(true);

    await act(async () => {
      resolvePreinstall();
      await Promise.resolve();
    });
    expect(btn.textContent).toBe("已下载");
    expect(btn.disabled).toBe(true);
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
