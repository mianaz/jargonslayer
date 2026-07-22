// @vitest-environment jsdom
//
// SettingsDialog — Soniox preview lane, M2 fix (Sol review 2026-07-20,
// v0.5 closeout). PREVIEW_TIER/SONIOX_PREVIEW_LANE are both import-time
// consts (deployTier.ts) — same "needs its own vi.mock'd file" limit
// SettingsDialog.test.tsx's own header comment documents (that file's
// ambient PREVIEW_TIER is false) — mirrors engineOptions.
// sonioxPreviewLane.test.ts's established one-file-per-const-combo
// convention.
//
// Covers: the tabaudio-cloud card previously promised the shared trial
// UNCONDITIONALLY (both its grid hint and its own detail-panel hint),
// and had no restored-backup notice at all — unlike the Soniox card,
// which already had the notice but the SAME unconditional-trial hint
// bug. Both cards' hints + the (now-shared) notice component are
// covered here.
//
// BYOK preview sprint (2026-07-21, docs/design-explorations/
// byok-preview-blueprint.md, Lane B): this file's mocked PREVIEW_TIER
// harness is also the only place in this component's test suite that
// can mount SettingsDialog under PREVIEW_TIER:true — reused below (a
// second top-level describe) for the broader settings-UI unlock this
// sprint ships: primary CredentialFields, 分任务模型（高级）, Soniox/
// Deepgram key rows, ENGINE_CARDS' byokOnly arm, and the AI-section
// badge removal.
//
// Adversarial review fix round (Sol BLOCK + Opus, 2026-07-21): a third
// top-level describe below covers the allowlist-bypass/copy findings
// the settings-UI unlock introduced — Sol #3 (taskLlm per-task model
// fields + the 保存-boundary coercion), Sol #4 (tab-cloud card copy
// naming Soniox regardless of the selected provider), Sol #7 (routing
// disclosures not per-domain).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/deployTier", () => ({
  PREVIEW_TIER: true,
  SONIOX_PREVIEW_LANE: true,
  PREVIEW_LIVE_MODELS: ["minimax/minimax-m3", "deepseek/deepseek-v4-flash"],
  PREVIEW_SUMMARY_MODELS: ["minimax/minimax-m3", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
}));

import { useApp } from "../../lib/store";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import { PREVIEW_LIVE_MODELS, PREVIEW_SUMMARY_MODELS } from "@/lib/deployTier";
import SettingsDialog from "../SettingsDialog";

function resetStore() {
  useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: false });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// React tracks an <input>'s value via a wrapped native setter — same
// bypass SettingsDialog.test.tsx's own typeInto already documents (a
// plain `input.value = x` + dispatchEvent("input") doesn't reliably
// trip React's onChange). Module-scope here too since the fix-round
// describe block below is the first in this file to type into a field
// rather than only clicking/reading one.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)!.set!;
function typeInto(input: HTMLInputElement, value: string) {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SettingsDialog — Soniox preview lane: restored-key honesty (M2)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  function findButtonContaining(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(text),
    );
    if (!btn) throw new Error(`button containing "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  function findButtonByText(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  });

  it("without a restored key, both cards keep the keyless trial hint (no regression)", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech", sonioxKey: "" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const sonioxCard = findButtonContaining("Soniox 云端识别");
    const tabCloudCard = findButtonContaining("标签页音频·云端");
    expect(sonioxCard.textContent).toContain("预览体验：无需密钥");
    expect(tabCloudCard.textContent).toContain("预览体验：无需密钥");
    expect(sonioxCard.textContent).not.toContain("将按你的账户计费");
    expect(tabCloudCard.textContent).not.toContain("将按你的账户计费");
  });

  it("a restored sonioxKey switches BOTH cards' grid hint to the BYOK-billing copy", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "webspeech", sonioxKey: "sk-restored-from-backup" },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const sonioxCard = findButtonContaining("Soniox 云端识别");
    const tabCloudCard = findButtonContaining("标签页音频·云端");
    expect(sonioxCard.textContent).toContain("已检测到你的 Soniox Key，将按你的账户计费");
    expect(tabCloudCard.textContent).toContain("已检测到你的 Soniox Key，将按你的账户计费");
    expect(sonioxCard.textContent).not.toContain("预览体验：无需密钥");
    expect(tabCloudCard.textContent).not.toContain("预览体验：无需密钥");
  });

  it("the Soniox card's own restored-backup notice still renders (post-extraction regression check)", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "soniox", sonioxKey: "sk-restored-from-backup" },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container!.textContent).toContain(
      "检测到已保存的 Soniox Key：会话将直接使用你自己的 Key 并按你的账户计费，而非上方的预览体验。",
    );
    expect(container!.textContent).toContain("清除已保存的 Key（改用预览体验）");
  });

  it("the tab-cloud card gets the SAME restored-backup notice the Soniox card has (the M2 gap)", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud", sonioxKey: "sk-restored-from-backup" },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container!.textContent).toContain(
      "检测到已保存的 Soniox Key：会话将直接使用你自己的 Key 并按你的账户计费，而非上方的预览体验。",
    );
    expect(container!.textContent).toContain("清除已保存的 Key（改用预览体验）");
    // BYOK preview sprint (2026-07-21) folded the M2 fix's own two-way
    // branch ("已检测到你的 Soniox Key，将按你的账户计费" vs "无需自备 Key")
    // into ONE line that reads correctly whether or not a key is present
    // — the detail panel's own separate hint line (distinct from the
    // grid card's hint, which still branches on sonioxKeyBillsUser
    // exactly as before) now always shows this, so it can never drift
    // out of sync with the restored-backup notice right below it again.
    expect(container!.textContent).toContain(
      "未填 Key 时（体验版试用）走 Soniox 限时试用；填入自己的 Key 后使用你的账户、浏览器直连",
    );
    expect(container!.textContent).not.toContain("预览体验固定使用 Soniox 云端转写，无需自备 Key");
  });

  it("the tab-cloud card has NO notice and the ordinary trial detail-hint when no key is present", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud", sonioxKey: "" },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container!.textContent).not.toContain("清除已保存的 Key（改用预览体验）");
    expect(container!.textContent).toContain(
      "未填 Key 时（体验版试用）走 Soniox 限时试用；填入自己的 Key 后使用你的账户、浏览器直连",
    );
  });

  it("清除已保存的 Key on the tab-cloud card's notice clears draft.sonioxKey (notice reverts; detail hint was already the same line either way)", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud", sonioxKey: "sk-restored-from-backup" },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    expect(container!.textContent).toContain("清除已保存的 Key（改用预览体验）");

    await act(async () => {
      findButtonByText("清除已保存的 Key（改用预览体验）").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(container!.textContent).not.toContain("清除已保存的 Key（改用预览体验）");
    expect(container!.textContent).toContain(
      "未填 Key 时（体验版试用）走 Soniox 限时试用；填入自己的 Key 后使用你的账户、浏览器直连",
    );

    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.sonioxKey).toBe("");
  });
});

// ---------------------------------------------------------------
// BYOK preview sprint (2026-07-21) — the broader settings-UI unlock,
// see this file's own header comment. One shared container/root (same
// shape as the M2 describe block above) since every `it` below mounts
// the same PREVIEW_TIER:true SettingsDialog, just with different seeded
// settings/nav category per test.
// ---------------------------------------------------------------

describe("SettingsDialog — BYOK preview sprint: settings-UI unlock", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  function findButtonContaining(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(text),
    );
    if (!btn) throw new Error(`button containing "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  function findNavButton(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll('nav[aria-label="设置分类"] button')).find(
      (b) => b.textContent === text,
    );
    if (!btn) throw new Error(`nav category "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  // ENGINE_CARDS' own label span (`<span className="min-w-0 font-medium">`,
  // SettingsDialog.tsx) exact-matched — unlike findButtonContaining's
  // substring search, this can't accidentally return the WRONG card: the
  // 浏览器识别 card's own hint text ("…建议标签页音频或本地 Whisper") happens
  // to contain the "本地 Whisper" card's exact label as a substring, and
  // it sorts first in ENGINE_CARDS.
  function findEngineCard(label: string): HTMLButtonElement {
    const span = Array.from(container!.querySelectorAll("button span.font-medium")).find(
      (s) => s.textContent === label,
    );
    const btn = span?.closest("button");
    if (!btn) throw new Error(`engine card "${label}" not found`);
    return btn as HTMLButtonElement;
  }

  // Detect/报告模型 render as either a locked <select> (keyless preview)
  // or a free-text <input> (full tier, or preview once keyed) — same
  // label->parentElement->querySelector idiom as this file's own
  // findProviderSelect (see the M2 describe block above).
  function findModelControl(label: string): HTMLSelectElement | HTMLInputElement {
    const l = Array.from(container!.querySelectorAll("label")).find((el) => el.textContent === label);
    const control = l?.parentElement?.querySelector("select, input");
    if (!control) throw new Error(`model control "${label}" not found`);
    return control as HTMLSelectElement | HTMLInputElement;
  }

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  });

  async function openOnAiDetect(settings: Partial<typeof DEFAULT_SETTINGS> = {}) {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, uiMode: "advanced", ...settings },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await act(async () => {
      findNavButton("AI 检测").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("keyless: primary Key input is enabled, model fields stay the locked <select>, demo-key banner shows, and a chip renders", async () => {
    await openOnAiDetect({ apiKey: "" });

    const apiKeyInput = container!.querySelector('input[placeholder="sk-…"]') as HTMLInputElement | null;
    expect(apiKeyInput).not.toBeNull();
    expect(apiKeyInput!.disabled).toBe(false);

    expect(findModelControl("检测模型").tagName).toBe("SELECT");
    expect(findModelControl("报告模型").tagName).toBe("SELECT");

    expect(container!.textContent).toContain("体验版由内置演示 Key 提供 AI，本地版可接入自己的 Key");
    expect(container!.textContent).not.toContain("自带 Key 由浏览器直连你的模型服务商");

    const chips = Array.from(container!.querySelectorAll('[data-testid="key-status-chip"]'));
    expect(chips.some((c) => c.textContent === "未配置")).toBe(true);
  });

  it("with a draft key: model fields become free-text (a custom value survives — coercePreviewModels skipped), banner switches to the BYOK copy, chip reads 已配置", async () => {
    await openOnAiDetect({ apiKey: "sk-byok-user", detectModel: "not-on-the-preview-allowlist" });

    const detectControl = findModelControl("检测模型");
    expect(detectControl.tagName).toBe("INPUT");
    expect((detectControl as HTMLInputElement).value).toBe("not-on-the-preview-allowlist");
    expect(findModelControl("报告模型").tagName).toBe("INPUT");

    expect(container!.textContent).toContain(
      "自带 Key 由浏览器直连你的模型服务商，Key 与会议内容不经过本站服务器",
    );
    expect(container!.textContent).not.toContain("体验版由内置演示 Key 提供 AI");

    const chips = Array.from(container!.querySelectorAll('[data-testid="key-status-chip"]'));
    expect(chips.some((c) => c.textContent === "已配置")).toBe(true);
  });

  it("the CORS hint appears near Base URL once a custom openai-compat endpoint + key are drafted", async () => {
    await openOnAiDetect({
      apiKey: "sk-byok-user",
      provider: "openai-compat",
      baseUrl: "https://my-endpoint.example.com",
    });
    expect(container!.textContent).toContain("自定义端点需支持浏览器跨域（CORS）；不支持时请使用本地版");
  });

  it("分任务模型（高级）: no longer badge-locked, its 展开 toggle works, and expanding mounts the 3 domain blocks", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, uiMode: "advanced" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await act(async () => {
      findNavButton("分任务模型（高级）").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container!.textContent).not.toContain("本地版功能");
    const expandBtn = findButtonContaining("展开");
    expect(expandBtn.disabled).toBe(false);

    await act(async () => {
      expandBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.textContent).toContain("选区翻译 / 双语转录");
    expect(container!.textContent).toContain("会议报告");
  });

  it("Soniox key row: input + eye toggle + chip + console link are enabled", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "soniox", sonioxKey: "" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const input = container!.querySelector(
      'input[placeholder="粘贴你的 Soniox API Key"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input!.disabled).toBe(false);
    expect(container!.querySelector('[data-testid="key-status-chip"]')).not.toBeNull();
    expect(container!.textContent).toContain("console.soniox.com");
  });

  it("Deepgram key row: input + eye toggle + chip + console link are enabled", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "deepgram", deepgramKey: "" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const input = container!.querySelector(
      'input[placeholder="粘贴你的 Deepgram API Key"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input!.disabled).toBe(false);
    expect(container!.querySelector('[data-testid="key-status-chip"]')).not.toBeNull();
    expect(container!.textContent).toContain("console.deepgram.com");
  });

  // ITEM 6: the OLD select forced its displayed `value` to "soniox"
  // and disabled the Deepgram <option> on this exact lane (SONIOX_
  // PREVIEW_LANE:true, this file's own mock) — the two things the BYOK
  // preview sprint un-gates.
  it("tabAudioCloud provider select shows the REAL draft value (not forced to soniox) with Deepgram genuinely selectable", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud", tabAudioCloudProvider: "deepgram" },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const label = Array.from(container!.querySelectorAll("label")).find((l) => l.textContent === "转录服务商");
    const select = label?.parentElement?.querySelector("select") as HTMLSelectElement | null;
    if (!select) throw new Error("转录服务商 select not found");

    expect(select.disabled).toBe(false);
    expect(select.value).toBe("deepgram");
    const deepgramOption = Array.from(select.options).find((o) => o.value === "deepgram");
    expect(deepgramOption!.disabled).toBe(false);
    expect(deepgramOption!.title).toBe("");
  });

  it("engine cards: soniox/deepgram/tabaudio-cloud are selectable (byokOnly no longer previewLocked); whisper (sidecarOnly) stays locked", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const whisperCard = findEngineCard("本地 Whisper");
    expect(whisperCard.disabled).toBe(true);
    expect(whisperCard.title).toBe("本地版功能：体验版暂未开放");

    for (const label of ["Soniox 云端识别", "Deepgram 云端识别", "标签页音频·云端"]) {
      const card = findEngineCard(label);
      expect(card.disabled).toBe(false);
    }
  });

  it("PreviewLockedBadge (本地版功能) is gone from the AI 检测 banner, still present on Whisper 地址 and the 说话人分离 heading", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, uiMode: "advanced" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    await act(async () => {
      findNavButton("AI 检测").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const banner = container!.querySelector('[data-ui-level="aiDetectPreviewBanner"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).not.toContain("本地版功能");

    await act(async () => {
      findNavButton("转录引擎").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.textContent).toContain("本地版功能"); // Whisper 地址

    await act(async () => {
      findNavButton("说话人分离").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.textContent).toContain("本地版功能");
  });
});

// ---------------------------------------------------------------
// Adversarial review fix round (Sol BLOCK + Opus, 2026-07-21) — see
// this file's own header comment for the finding list. One shared
// container/root per `it`, same shape as the two describe blocks
// above, each with its own locally-scoped helpers (this file's
// established per-describe convention — see the second block's own
// findButtonContaining/findNavButton/findEngineCard/findModelControl,
// none shared globally).
// ---------------------------------------------------------------

describe("SettingsDialog — BYOK preview sprint fix round: allowlist + routing-disclosure findings", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  function findButtonContaining(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(text),
    );
    if (!btn) throw new Error(`button containing "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  function findButtonByText(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  function findNavButton(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll('nav[aria-label="设置分类"] button')).find(
      (b) => b.textContent === text,
    );
    if (!btn) throw new Error(`nav category "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  function findEngineCard(label: string): HTMLButtonElement {
    const span = Array.from(container!.querySelectorAll("button span.font-medium")).find(
      (s) => s.textContent === label,
    );
    const btn = span?.closest("button");
    if (!btn) throw new Error(`engine card "${label}" not found`);
    return btn as HTMLButtonElement;
  }

  // Sol #3 fix: a 分任务模型（高级） domain block's own "模型" label text is
  // generic (all three domains reuse it) — scoped by first locating the
  // domain's OWN unique heading text (TASK_DOMAIN_META's `label`), then
  // walking up to its bordered box (TaskDomainBlock's own wrapper
  // className) before looking for "模型" inside just that box.
  function findDomainModelControl(domainLabel: string): HTMLSelectElement | HTMLInputElement {
    const heading = Array.from(container!.querySelectorAll("div")).find(
      (d) => d.textContent === domainLabel,
    );
    const box = heading?.closest("div.space-y-2.border.border-edge.bg-panel2.p-3");
    const label = box
      ? Array.from(box.querySelectorAll("label")).find((l) => l.textContent === "模型")
      : undefined;
    const control = label?.parentElement?.querySelector("select, input");
    if (!control) throw new Error(`model control for domain "${domainLabel}" not found`);
    return control as HTMLSelectElement | HTMLInputElement;
  }

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  });

  async function openOnAiDetect(settings: Partial<typeof DEFAULT_SETTINGS> = {}) {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, uiMode: "advanced", ...settings },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await act(async () => {
      findNavButton("AI 检测").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  async function openOnTaskLlmExpanded(settings: Partial<typeof DEFAULT_SETTINGS> = {}) {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, uiMode: "advanced", ...settings },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await act(async () => {
      findNavButton("分任务模型（高级）").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      findButtonContaining("展开").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  // ---- Sol #3a: taskLlm per-task model field allowlist lock ----

  it("Sol #3a: a keyless taskLlm domain shows the locked <select>, scoped to its own allowlist (detect-class -> PREVIEW_LIVE_MODELS, summary -> PREVIEW_SUMMARY_MODELS)", async () => {
    await openOnTaskLlmExpanded({
      apiKey: "",
      taskLlm: {
        detect: { enabled: true },
        summary: { enabled: true },
      },
    });

    const detectControl = findDomainModelControl("检测与解释");
    expect(detectControl.tagName).toBe("SELECT");
    expect(Array.from((detectControl as HTMLSelectElement).options).map((o) => o.value)).toEqual([
      ...PREVIEW_LIVE_MODELS,
    ]);

    const summaryControl = findDomainModelControl("会议报告");
    expect(summaryControl.tagName).toBe("SELECT");
    expect(Array.from((summaryControl as HTMLSelectElement).options).map((o) => o.value)).toEqual([
      ...PREVIEW_SUMMARY_MODELS,
    ]);
  });

  it("Sol #3a: a domain with its OWN key keeps the free-text field (a custom off-allowlist value survives)", async () => {
    await openOnTaskLlmExpanded({
      apiKey: "",
      taskLlm: {
        detect: { enabled: true, apiKey: "sk-domain-own", model: "not-on-the-preview-allowlist" },
      },
    });

    const detectControl = findDomainModelControl("检测与解释");
    expect(detectControl.tagName).toBe("INPUT");
    expect((detectControl as HTMLInputElement).value).toBe("not-on-the-preview-allowlist");
  });

  it("Sol #3a: a domain INHERITING a keyed primary (blank domain key) also stays free-text", async () => {
    await openOnTaskLlmExpanded({
      apiKey: "sk-primary",
      taskLlm: {
        translate: { enabled: true, model: "not-on-the-preview-allowlist" },
      },
    });

    const translateControl = findDomainModelControl("选区翻译 / 双语转录");
    expect(translateControl.tagName).toBe("INPUT");
    expect((translateControl as HTMLInputElement).value).toBe("not-on-the-preview-allowlist");
  });

  // ---- Sol #3b/#3c: 保存-boundary coercion ----

  it("Sol #3b: clearing the primary Key mid-dialog, then 保存, coerces the now-keyless draft's models onto the allowlist", async () => {
    await openOnAiDetect({
      apiKey: "sk-was-byok",
      detectModel: "claude-sonnet-5",
      summaryModel: "claude-opus-4-8",
    });
    const apiKeyInput = container!.querySelector('input[placeholder="sk-…"]') as HTMLInputElement;

    await act(async () => {
      typeInto(apiKeyInput, "");
    });
    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.detectModel).toBe(PREVIEW_LIVE_MODELS[0]);
    expect(useApp.getState().settings.summaryModel).toBe(PREVIEW_SUMMARY_MODELS[0]);
  });

  // Sol #3c: a pre-existing hole (a keyless preset write bypasses the
  // locked <select> entirely — handleSelectPreset patches detectModel/
  // summaryModel straight into state) is closed by the SAME (b) fix —
  // pinned here so a regression in the shared coercePreviewModels call
  // at 保存 fails this too, not just (b)'s own test above.
  it("Sol #3c: a keyless preset pick (OpenAI) writes off-allowlist models straight into the draft; 保存 still coerces them", async () => {
    await openOnAiDetect({ apiKey: "" });

    const providerLabel = Array.from(container!.querySelectorAll("label")).find(
      (l) => l.textContent === "提供方",
    );
    const providerSelect = providerLabel?.parentElement?.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      providerSelect.value = "openai";
      providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.detectModel).toBe(PREVIEW_LIVE_MODELS[0]);
    expect(useApp.getState().settings.summaryModel).toBe(PREVIEW_SUMMARY_MODELS[0]);
  });

  // ---- Sol #4: tab-cloud copy must never claim Soniox for a Deepgram session ----

  it("Sol #4: Deepgram selected + a residual sonioxKey -> the tab-cloud card shows NEITHER Soniox billing NOR the restored-key notice", async () => {
    useApp.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        engine: "tabaudio-cloud",
        tabAudioCloudProvider: "deepgram",
        sonioxKey: "sk-residual-from-backup",
      },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const card = findEngineCard("标签页音频·云端");
    expect(card.textContent).not.toContain("已检测到你的 Soniox Key，将按你的账户计费");
    expect(card.textContent).not.toContain("Soniox 云端转写");
    expect(card.textContent).toContain(
      "需要 Soniox 或 Deepgram Key、浏览器分享标签页并勾选共享音频；选择 Deepgram 时仅支持英文",
    );
    expect(container!.textContent).not.toContain(
      "检测到已保存的 Soniox Key：会话将直接使用你自己的 Key 并按你的账户计费，而非上方的预览体验。",
    );
  });

  it("Sol #4: Soniox selected (explicit) + a real key -> the existing billing/restored notices are intact", async () => {
    useApp.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        engine: "tabaudio-cloud",
        tabAudioCloudProvider: "soniox",
        sonioxKey: "sk-restored-from-backup",
      },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const card = findEngineCard("标签页音频·云端");
    expect(card.textContent).toContain("已检测到你的 Soniox Key，将按你的账户计费");
    expect(container!.textContent).toContain(
      "检测到已保存的 Soniox Key：会话将直接使用你自己的 Key 并按你的账户计费，而非上方的预览体验。",
    );
  });

  // ---- Sol #7a: AI banner mixed-config routing disclosure ----

  it("Sol #7a: an ENABLED taskLlm override with its OWN key on a keyless primary appends the per-domain routing line", async () => {
    await openOnAiDetect({
      apiKey: "",
      taskLlm: { detect: { enabled: true, apiKey: "sk-domain-own" } },
    });

    expect(container!.textContent).toContain(
      "分任务配置按各自 Key 路由：有 Key 的任务浏览器直连，无 Key 的任务走体验版代理",
    );
  });

  it("Sol #7a: no mixed-routing line when an enabled override's blank key just inherits the (keyed) primary — not a real split", async () => {
    await openOnAiDetect({
      apiKey: "sk-primary",
      taskLlm: { summary: { enabled: true } },
    });

    expect(container!.textContent).not.toContain("分任务配置按各自 Key 路由");
  });

  it("Sol #7a: no mixed-routing line with no taskLlm overrides at all (no regression on the plain banner)", async () => {
    await openOnAiDetect({ apiKey: "" });
    expect(container!.textContent).not.toContain("分任务配置按各自 Key 路由");
  });
});
