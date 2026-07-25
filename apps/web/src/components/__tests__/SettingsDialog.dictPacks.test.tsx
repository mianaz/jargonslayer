// @vitest-environment jsdom
//
// v0.6 T7 — installable dictionary pack UI coverage (T1 provenance
// badges, T2 file/paste import, T3(b)/(c) inline install errors, T4
// enabledPacks materialization wiring, T6 catalog browse). Mirrors
// GlossaryPanel.test.tsx's own module-mock idiom: @/lib/detect/
// remotePacks is mocked via importOriginal so classifyPackOrigin (pure,
// no I/O) stays REAL — these tests exercise its genuine official/
// imported classification, not a stand-in — while every network/
// idb-keyval-backed export is a plain vi.fn() the tests control
// directly. blob->raw URL rewriting (toRawGithubUrl) is unit-tested on
// its own in lib/detect/__tests__/githubUrl.test.ts, not re-covered
// here. Do NOT snapshot-test the whole dialog (owner instruction).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/detect/remotePacks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/detect/remotePacks")>();
  return {
    ...actual,
    addPackSource: vi.fn(),
    addPackFromManifest: vi.fn(),
    // N7(d)/N7(b) fix round: removePackSource now returns boolean
    // (was void) — default to the success case so any test that
    // doesn't override this still exercises the "已移除" toast path.
    removePackSource: vi.fn(async () => true),
    listPackSources: vi.fn(async () => []),
    checkUpdates: vi.fn(async () => []),
    loadRemotePacksIntoRegistry: vi.fn(async () => {}),
  };
});

// Default resolves an empty catalog so every describe block BESIDES
// the dedicated T6 one below (which overrides per-test via
// mockResolvedValue/mockRejectedValue) doesn't have to care that
// SettingsDialog's own lazy-fetch effect (T6) fires the moment AI 检测
// is opened — a bare vi.fn() with no implementation would return
// undefined, not a Promise, and crash that effect's own .then().
vi.mock("@/lib/detect/dictCatalog", () => ({
  fetchDictCatalog: vi.fn(async () => ({ packs: [] })),
}));

import { useApp } from "../../lib/store";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import { setLoadedRemotePacks } from "@jargonslayer/core/detect/remotePacksRegistry";
import type { LoadedRemotePack } from "@jargonslayer/core/detect/remotePacksRegistry";
// H2 fix round: real (unmocked) dictionary.ts — used to observe the
// module-level detector registry (registeredEnabledPacks) indirectly
// via scanDictionary, since there is no direct getter for it.
import { scanDictionary, setEnabledPacks } from "@jargonslayer/core/detect/dictionary";
import * as remotePacks from "@/lib/detect/remotePacks";
import * as dictCatalog from "@/lib/detect/dictCatalog";
import SettingsDialog from "../SettingsDialog";

function fakePack(id: string, name: string, version: string | number = "1.0"): LoadedRemotePack {
  return { id, name, version, expressions: [], terms: [] };
}

function resetStore() {
  useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: true, toast: null });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function findNavButton(container: HTMLDivElement, label: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('nav[aria-label="设置分类"] button')).find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`nav button "${label}" not found`);
  return btn as HTMLButtonElement;
}

async function openAiDetectCategory(container: HTMLDivElement): Promise<void> {
  await act(async () => {
    findNavButton(container, "AI 检测").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function findButtonByText(container: HTMLDivElement, text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text);
  if (!btn) throw new Error(`button "${text}" not found`);
  return btn as HTMLButtonElement;
}

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)!.set!;
function typeInto(input: HTMLInputElement, value: string) {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype,
  "value",
)!.set!;
function typeIntoTextarea(el: HTMLTextAreaElement, value: string) {
  nativeTextareaValueSetter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---------------------------------------------------------------
// T1 — provenance badges
// ---------------------------------------------------------------

describe("SettingsDialog — v0.6 T1: provenance badges (官方/已导入)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetStore();
    setLoadedRemotePacks([
      fakePack("official-pack", "Official Pack"),
      fakePack("imported-pack", "Imported Pack"),
      fakePack("file-pack", "File Pack"),
    ]);
    vi.mocked(remotePacks.listPackSources).mockResolvedValue([
      {
        url: "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/official.json",
        pack: fakePack("official-pack", "Official Pack"),
        origin: "official",
      },
      {
        url: "https://example.com/imported.json",
        pack: fakePack("imported-pack", "Imported Pack"),
        origin: "imported",
      },
      {
        url: "",
        pack: fakePack("file-pack", "File Pack"),
        importedAt: Date.now(),
        origin: "imported",
      },
    ]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root!.unmount());
    container!.remove();
    container = null;
    root = null;
    setLoadedRemotePacks([]);
    resetStore();
    vi.clearAllMocks();
  });

  function badgeFor(name: string): HTMLSpanElement | null {
    const spans = Array.from(container!.querySelectorAll("span[title]")) as HTMLSpanElement[];
    return spans.find((s) => s.parentElement?.textContent?.startsWith(name)) ?? null;
  }

  it("shows 官方 for a jargonslayer-dicts URL, 已导入 for any other URL, and 已导入 for a file-imported (no-url) pack — recomputed via classifyPackOrigin, not a stored flag", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);
    await flush();

    const official = badgeFor("Official Pack");
    expect(official?.textContent).toBe("官方");
    expect(official?.title).toBe("来自 JargonSlayer 官方词典库");

    const imported = badgeFor("Imported Pack");
    expect(imported?.textContent).toBe("已导入");
    expect(imported?.title).toBe("由你从外部链接或文件导入，内容未经官方审核");

    const filePack = badgeFor("File Pack");
    expect(filePack?.textContent).toBe("已导入");
  });

  it("renders no badge at all for a built-in pack", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);
    await flush();

    expect(badgeFor("会议流程与推进")).toBeNull();
  });
});

// ---------------------------------------------------------------
// T2 — import from file / pasted JSON
// ---------------------------------------------------------------

describe("SettingsDialog — v0.6 T2: import a pack from file / pasted JSON", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetStore();
    vi.mocked(remotePacks.listPackSources).mockResolvedValue([]);
    vi.mocked(dictCatalog.fetchDictCatalog).mockResolvedValue({ packs: [] });
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
    vi.clearAllMocks();
  });

  async function openImportPanel(): Promise<void> {
    await openAiDetectCategory(container!);
    await act(async () => {
      findButtonByText(container!, "展开").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("importing a valid file calls addPackFromManifest(parsed) and toasts success", async () => {
    vi.mocked(remotePacks.addPackFromManifest).mockResolvedValue({
      ok: true,
      pack: fakePack("new-pack", "文件词典"),
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openImportPanel();

    const fileInput = container!.querySelector('input[type="file"]') as HTMLInputElement;
    if (!fileInput) throw new Error("pack file input not found");
    const manifest = { id: "new-pack", name: "文件词典", version: "1.0" };
    const file = new File([JSON.stringify(manifest)], "pack.json", { type: "application/json" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    await flush();

    expect(remotePacks.addPackFromManifest).toHaveBeenCalledWith(manifest);
    expect(useApp.getState().toast).toBe("已导入词典「文件词典」");
  });

  it("pasting malformed JSON shows an inline error instead of calling addPackFromManifest", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openImportPanel();

    const textarea = container!.querySelector(
      'textarea[placeholder="或粘贴词典包 JSON…"]',
    ) as HTMLTextAreaElement;
    if (!textarea) throw new Error("pack JSON textarea not found");
    await act(async () => {
      typeIntoTextarea(textarea, "{not valid json");
    });
    await act(async () => {
      findButtonByText(container!, "解析并导入").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(remotePacks.addPackFromManifest).not.toHaveBeenCalled();
    expect(container!.textContent).toContain("词典包不是有效的 JSON");
  });

  it("addPackFromManifest returning {ok:false} shows the returned zh error inline (not lost to a toast)", async () => {
    vi.mocked(remotePacks.addPackFromManifest).mockResolvedValue({
      ok: false,
      error: "此词典需要 JargonSlayer v9.9.9 或更高版本",
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openImportPanel();

    const textarea = container!.querySelector(
      'textarea[placeholder="或粘贴词典包 JSON…"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      typeIntoTextarea(textarea, JSON.stringify({ id: "x", name: "X", version: 1 }));
    });
    await act(async () => {
      findButtonByText(container!, "解析并导入").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container!.textContent).toContain("此词典需要 JargonSlayer v9.9.9 或更高版本");
    expect(useApp.getState().toast).toBeNull();
  });
});

// ---------------------------------------------------------------
// T3(b)/(c) — URL install: inline error surfacing + https-only gate
// ---------------------------------------------------------------

describe("SettingsDialog — v0.6 T3(b)/(c): URL install surfaces errors inline and rejects non-https", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetStore();
    vi.mocked(remotePacks.listPackSources).mockResolvedValue([]);
    vi.mocked(dictCatalog.fetchDictCatalog).mockResolvedValue({ packs: [] });
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
    vi.clearAllMocks();
  });

  function urlInput(): HTMLInputElement {
    const input = container!.querySelector(
      'input[placeholder^="https://raw.githubusercontent.com"]',
    ) as HTMLInputElement | null;
    if (!input) throw new Error("pack source URL input not found");
    return input;
  }

  it("surfaces addPackSource's thrown zh error inline in 词典源 (size cap / minAppVersion / quota / fetch failure class)", async () => {
    vi.mocked(remotePacks.addPackSource).mockRejectedValue(new Error("词典包过大：单个词典包不能超过 2 MB"));
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);

    await act(async () => {
      typeInto(urlInput(), "https://example.com/huge.json");
    });
    await act(async () => {
      findButtonByText(container!, "添加").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container!.textContent).toContain("词典包过大：单个词典包不能超过 2 MB");
  });

  it("rejects a non-https URL before ever calling addPackSource", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);

    await act(async () => {
      typeInto(urlInput(), "http://example.com/pack.json");
    });
    await act(async () => {
      findButtonByText(container!, "添加").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(remotePacks.addPackSource).not.toHaveBeenCalled();
    expect(container!.textContent).toContain("请输入有效的 https 链接");
  });

  it("silently rewrites a pasted GitHub blob URL to raw.githubusercontent.com before calling addPackSource", async () => {
    vi.mocked(remotePacks.addPackSource).mockResolvedValue({
      url: "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/pharma.json",
      pack: fakePack("pharma", "医药与生物科技"),
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);

    await act(async () => {
      typeInto(urlInput(), "https://github.com/mianaz/jargonslayer-dicts/blob/main/pharma.json");
    });
    await act(async () => {
      findButtonByText(container!, "添加").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(remotePacks.addPackSource).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/pharma.json",
    );
  });
});

// ---------------------------------------------------------------
// H1/H2 fix round — materializeEnabledPacks REVERT. The premise was
// wrong (see packages/core/src/detect/packs.ts's own git history):
// dictionary.ts's commonWord guard SUPPRESSES under null and FIRES
// under an explicit list, so materializing null->explicit on install
// did the opposite of the intent. This whole T4 wiring (AddPackSourceOptions/
// packInstallOptions/onEnabledPacksChange) is deleted; these tests pin
// the revert.
// ---------------------------------------------------------------

describe("SettingsDialog — H1/H2 fix round: pack install no longer write-throughs enabledPacks", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetStore();
    vi.mocked(remotePacks.listPackSources).mockResolvedValue([]);
    vi.mocked(dictCatalog.fetchDictCatalog).mockResolvedValue({ packs: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root!.unmount());
    container!.remove();
    container = null;
    root = null;
    setLoadedRemotePacks([]);
    resetStore();
    vi.clearAllMocks();
  });

  it("installing a pack via URL calls addPackSource with ONLY the url (no options object) and never touches settings.enabledPacks", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, enabledPacks: null }, hydrated: true });
    vi.mocked(remotePacks.addPackSource).mockResolvedValue({
      url: "https://example.com/pack.json",
      pack: fakePack("new-pack", "New Pack"),
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);

    const input = container!.querySelector(
      'input[placeholder^="https://raw.githubusercontent.com"]',
    ) as HTMLInputElement;
    await act(async () => {
      typeInto(input, "https://example.com/pack.json");
    });
    await act(async () => {
      findButtonByText(container!, "添加").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(remotePacks.addPackSource).toHaveBeenCalledWith("https://example.com/pack.json");
    // The old (reverted) mechanism used to write
    // ["core", "meeting-flow", "new-pack", …] straight into the live
    // store the moment install resolved — that side effect is gone;
    // enabledPacks stays exactly what it was until 保存 is clicked.
    expect(useApp.getState().settings.enabledPacks).toBeNull();
  });
});

// ---------------------------------------------------------------
// T6 — 词典库 catalog browse
// ---------------------------------------------------------------

describe("SettingsDialog — v0.6 T6: 词典库 catalog browse", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetStore();
    vi.mocked(remotePacks.listPackSources).mockResolvedValue([
      { url: "https://x/same.json", pack: fakePack("same-version", "Same Version", "2.0") },
      // L3/N6 fix round: url now matches the catalog row's own url
      // below exactly — this is the genuine "same source, catalog has
      // a newer version" case; see the dedicated L3/N6 describe block
      // further down for the fork/downgrade cases this used to conflate.
      { url: "https://example.com/c.json", pack: fakePack("older-version", "Older Version", "1.0") },
    ]);
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
    vi.clearAllMocks();
  });

  function rowButton(name: string): HTMLButtonElement {
    // .closest() from the name element itself (not a querySelectorAll
    // over every <div> + .find) — 词典源's installed-source rows share
    // the EXACT same row className as 词典库's catalog rows, and a
    // naive outer-to-inner div search would match the whole dialog's
    // own outermost wrapper first (document order) and return its
    // first unrelated button (e.g. the 简单/高级 header toggle) instead.
    const nameEl = Array.from(container!.querySelectorAll(".truncate")).find(
      (el) => el.textContent === name,
    );
    const row = nameEl?.closest("div.flex.items-center.justify-between");
    const btn = row?.querySelector("button");
    if (!btn) throw new Error(`catalog row button for "${name}" not found`);
    return btn as HTMLButtonElement;
  }

  it("renders 安装/已安装/更新 action state per row based on packSources", async () => {
    vi.mocked(dictCatalog.fetchDictCatalog).mockResolvedValue({
      packs: [
        { id: "not-installed", name: "Not Installed", version: "1.0", url: "https://example.com/a.json" },
        { id: "same-version", name: "Same Version", version: "2.0", url: "https://example.com/b.json" },
        { id: "older-version", name: "Older Version", version: "2.0", url: "https://example.com/c.json" },
      ],
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);
    await flush();

    expect(rowButton("Not Installed").textContent).toBe("安装");
    expect(rowButton("Not Installed").disabled).toBe(false);
    expect(rowButton("Same Version").textContent).toBe("已安装");
    expect(rowButton("Same Version").disabled).toBe(true);
    expect(rowButton("Older Version").textContent).toBe("更新");
    expect(rowButton("Older Version").disabled).toBe(false);
  });

  it("installing a catalog row calls addPackSource(row.url) and toasts success", async () => {
    vi.mocked(dictCatalog.fetchDictCatalog).mockResolvedValue({
      packs: [{ id: "not-installed", name: "Not Installed", version: "1.0", url: "https://example.com/a.json" }],
    });
    vi.mocked(remotePacks.addPackSource).mockResolvedValue({
      url: "https://example.com/a.json",
      pack: fakePack("not-installed", "Not Installed"),
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);
    await flush();

    await act(async () => {
      rowButton("Not Installed").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(remotePacks.addPackSource).toHaveBeenCalledWith("https://example.com/a.json");
    expect(useApp.getState().toast).toBe("已安装词典「Not Installed」");
  });

  it("renders the honest failure state when the catalog fetch fails (primary + fallback both down)", async () => {
    vi.mocked(dictCatalog.fetchDictCatalog).mockRejectedValue(new Error("network down"));
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);
    await flush();

    expect(container!.textContent).toContain("暂时无法加载词典目录，可稍后重试或用下方链接手动添加");
  });

  it("does not fetch the catalog on dialog mount — only once the AI 检测 category is actually opened", async () => {
    vi.mocked(dictCatalog.fetchDictCatalog).mockResolvedValue({ packs: [] });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    expect(dictCatalog.fetchDictCatalog).not.toHaveBeenCalled();

    await openAiDetectCategory(container!);
    await flush();
    expect(dictCatalog.fetchDictCatalog).toHaveBeenCalledTimes(1);

    // Switching away and back does not refetch (fetch-once contract).
    await act(async () => {
      findNavButton(container!, "转录引擎").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await openAiDetectCategory(container!);
    await flush();
    expect(dictCatalog.fetchDictCatalog).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------
// H2 SEPARATE fix (adversarial review) — the mount effect used to run
// with `[]` deps (exactly once, at whatever settings.enabledPacks was
// in the closure at first render), so a dialog mounted before
// store.hydrate() resolves (#62/tag-blocker 1) would permanently
// register the PRE-hydration value with the detector, disagreeing with
// buildMeetingLexicon's own live-store read for the whole session.
// ---------------------------------------------------------------

describe("SettingsDialog — H2 fix: mount effect re-syncs enabledPacks with the detector AFTER hydration", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetStore();
    vi.mocked(remotePacks.listPackSources).mockResolvedValue([]);
    vi.mocked(dictCatalog.fetchDictCatalog).mockResolvedValue({ packs: [] });
    setLoadedRemotePacks([
      {
        id: "probe-pack",
        name: "Probe",
        version: 1,
        expressions: [],
        terms: [{ term: "ZZZPROBETERM", type: "other", gloss_en: "", gloss_zh: "探针", pack: "probe-pack" }],
      },
    ]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root!.unmount());
    container!.remove();
    container = null;
    root = null;
    setLoadedRemotePacks([]);
    // Real module-level registry state, untouched by vi.clearAllMocks()
    // — must be restored explicitly, same discipline dictionary.test.ts
    // itself documents.
    setEnabledPacks(null);
    resetStore();
    vi.clearAllMocks();
  });

  it("re-registers enabledPacks with the detector once hydration resolves, not just at pre-hydration mount", async () => {
    // Mounted BEFORE hydration resolves, with an explicit "nothing
    // enabled" selection still in the closure.
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, enabledPacks: [] }, hydrated: false });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(
      scanDictionary("we discussed ZZZPROBETERM today").terms.some((t) => t.term === "ZZZPROBETERM"),
    ).toBe(false);

    // hydrate() resolves with the REAL persisted selection — null
    // ("everything on") this time.
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, enabledPacks: null }, hydrated: true });
    await flush();

    expect(
      scanDictionary("we discussed ZZZPROBETERM today").terms.some((t) => t.term === "ZZZPROBETERM"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------
// H3(b) fix (adversarial review) — defense-in-depth read hardening.
// H3(a) (validateManifest rejecting id: "__proto__") already closes
// this off at the normal install path; this simulates the registry
// somehow ending up with one anyway (a direct setLoadedRemotePacks
// call, bypassing remotePacks.ts's own install pipeline entirely).
// ---------------------------------------------------------------

describe("SettingsDialog — H3(b): packEntryCounts read survives a __proto__ pack id", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetStore();
    setLoadedRemotePacks([fakePack("__proto__", "Prototype Pollution Attempt")]);
    vi.mocked(remotePacks.listPackSources).mockResolvedValue([
      {
        url: "https://example.com/x.json",
        pack: fakePack("__proto__", "Prototype Pollution Attempt"),
        origin: "imported",
      },
    ]);
    vi.mocked(dictCatalog.fetchDictCatalog).mockResolvedValue({ packs: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root!.unmount());
    container!.remove();
    container = null;
    root = null;
    setLoadedRemotePacks([]);
    resetStore();
    vi.clearAllMocks();
  });

  it("renders the pack row (not a crash) when a loaded remote pack's id is __proto__", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);
    await flush();

    expect(container!.textContent).toContain("Prototype Pollution Attempt");
  });
});

// ---------------------------------------------------------------
// L1/L2 fixes (adversarial review, cheap)
// ---------------------------------------------------------------

describe("SettingsDialog — L1: pack import panel state resets on a fresh dialog open", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetStore();
    vi.mocked(remotePacks.listPackSources).mockResolvedValue([]);
    vi.mocked(dictCatalog.fetchDictCatalog).mockResolvedValue({ packs: [] });
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
    vi.clearAllMocks();
  });

  it("packInstallError/packImportOpen/packImportText do not survive a close-then-reopen cycle", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);

    // Open the import panel and leave some text in it.
    await act(async () => {
      findButtonByText(container!, "展开").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const textarea = container!.querySelector(
      'textarea[placeholder="或粘贴词典包 JSON…"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      typeIntoTextarea(textarea, "{not valid json");
    });
    await act(async () => {
      findButtonByText(container!, "解析并导入").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(container!.textContent).toContain("词典包不是有效的 JSON");
    expect(container!.textContent).toContain("收起"); // panel is open

    // Close, then reopen — same mounted component instance (page.tsx's
    // own always-mounted contract).
    await act(async () => {
      root!.render(<SettingsDialog open={false} onClose={() => {}} />);
    });
    await flush();
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);
    await flush();

    expect(container!.textContent).not.toContain("词典包不是有效的 JSON");
    expect(container!.textContent).not.toContain("收起"); // panel collapsed again
    expect(container!.textContent).toContain("展开");
  });
});

describe("SettingsDialog — L2: 词典库 catalog error state offers a 重试 button", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetStore();
    vi.mocked(remotePacks.listPackSources).mockResolvedValue([]);
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
    vi.clearAllMocks();
  });

  it("clicking 重试 re-fetches the catalog and can recover from the error state", async () => {
    vi.mocked(dictCatalog.fetchDictCatalog)
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({
        packs: [{ id: "recovered", name: "Recovered Pack", version: 1, url: "https://example.com/r.json" }],
      });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);
    await flush();

    expect(container!.textContent).toContain("暂时无法加载词典目录");
    expect(dictCatalog.fetchDictCatalog).toHaveBeenCalledTimes(1);

    await act(async () => {
      findButtonByText(container!, "重试").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(dictCatalog.fetchDictCatalog).toHaveBeenCalledTimes(2);
    expect(container!.textContent).toContain("Recovered Pack");
  });
});

// ---------------------------------------------------------------
// L3/N6 fix (adversarial review) — 已安装/更新 comparison is now
// source-url-aware (not id-only) and semver-ordered (not
// String(a)===String(b)).
// ---------------------------------------------------------------

describe("SettingsDialog — L3/N6: 词典库 更新 requires the SAME installed source + real semver ordering", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetStore();
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
    vi.clearAllMocks();
  });

  function rowButton(name: string): HTMLButtonElement {
    const nameEl = Array.from(container!.querySelectorAll(".truncate")).find((el) => el.textContent === name);
    const row = nameEl?.closest("div.flex.items-center.justify-between");
    const btn = row?.querySelector("button");
    if (!btn) throw new Error(`catalog row button for "${name}" not found`);
    return btn as HTMLButtonElement;
  }

  it("shows 安装 (not 更新) when the installed pack's source url differs from the catalog's — a same-id fork, even though its version is older", async () => {
    vi.mocked(remotePacks.listPackSources).mockResolvedValue([
      { url: "https://my-fork.example/pack.json", pack: fakePack("forked-pack", "Forked", "1.0") },
    ]);
    vi.mocked(dictCatalog.fetchDictCatalog).mockResolvedValue({
      packs: [{ id: "forked-pack", name: "Forked", version: "2.0", url: "https://official.example/pack.json" }],
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);
    await flush();

    expect(rowButton("Forked").textContent).toBe("安装");
    expect(rowButton("Forked").disabled).toBe(false);
  });

  it("shows 已安装 (not 更新) when the catalog's version is semver-OLDER than what's installed — never presents a downgrade as an update", async () => {
    vi.mocked(remotePacks.listPackSources).mockResolvedValue([
      { url: "https://official.example/pack.json", pack: fakePack("stale-catalog-pack", "Stale", "3.0.0") },
    ]);
    vi.mocked(dictCatalog.fetchDictCatalog).mockResolvedValue({
      packs: [
        { id: "stale-catalog-pack", name: "Stale", version: "2.5", url: "https://official.example/pack.json" },
      ],
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);
    await flush();

    expect(rowButton("Stale").textContent).toBe("已安装");
    expect(rowButton("Stale").disabled).toBe(true);
  });
});

// ---------------------------------------------------------------
// N5 fix (adversarial review) — pack name isolated in <bdi> next to
// the provenance badge.
// ---------------------------------------------------------------

describe("SettingsDialog — N5: pack name renders inside <bdi>, isolated from the provenance badge", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetStore();
    setLoadedRemotePacks([fakePack("bdi-pack", "BDI Pack")]);
    vi.mocked(remotePacks.listPackSources).mockResolvedValue([
      { url: "https://example.com/x.json", pack: fakePack("bdi-pack", "BDI Pack"), origin: "imported" },
    ]);
    vi.mocked(dictCatalog.fetchDictCatalog).mockResolvedValue({ packs: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root!.unmount());
    container!.remove();
    container = null;
    root = null;
    setLoadedRemotePacks([]);
    resetStore();
    vi.clearAllMocks();
  });

  it("wraps the pack name in a <bdi> element", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);
    await flush();

    const bdi = Array.from(container!.querySelectorAll("bdi")).find((el) => el.textContent === "BDI Pack");
    expect(bdi).toBeDefined();
  });
});

// ---------------------------------------------------------------
// N7(b) fix (adversarial review) — removal toasts honestly instead of
// always claiming 已移除词典包 regardless of whether the write landed.
// ---------------------------------------------------------------

describe("SettingsDialog — N7(b): pack removal toasts success/failure honestly", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetStore();
    vi.mocked(remotePacks.listPackSources).mockResolvedValue([
      { url: "https://example.com/removable.json", pack: fakePack("removable-pack", "Removable"), origin: "imported" },
    ]);
    vi.mocked(dictCatalog.fetchDictCatalog).mockResolvedValue({ packs: [] });
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
    vi.clearAllMocks();
  });

  async function clickRemoveTwice(): Promise<void> {
    const btn = findButtonByText(container!, "移除");
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const confirmBtn = findButtonByText(container!, "确认移除?");
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
  }

  it("passes the discriminated (url, packId) pair to removePackSource and toasts 已移除词典包 on success", async () => {
    vi.mocked(remotePacks.removePackSource).mockResolvedValue(true);
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);
    await flush();

    await clickRemoveTwice();

    expect(remotePacks.removePackSource).toHaveBeenCalledWith(
      "https://example.com/removable.json",
      "removable-pack",
    );
    expect(useApp.getState().toast).toBe("已移除词典包");
  });

  it("toasts a failure message (never 已移除词典包) when removePackSource resolves false", async () => {
    vi.mocked(remotePacks.removePackSource).mockResolvedValue(false);
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);
    await flush();

    await clickRemoveTwice();

    expect(useApp.getState().toast).not.toBe("已移除词典包");
    expect(useApp.getState().toast).toBe("移除词典包失败，请重试");
  });
});

// ---------------------------------------------------------------
// Round-2: dict-pack auto-update checkbox + last-checked line (词典源
// section, lib/detect/packAutoUpdate.ts). findSwitchByLabel mirrors
// SettingsDialog.test.tsx's own helper of the same name byte-for-byte
// (that file's own doc: a real <label> click forwards to the nested
// <button role="switch">) — duplicated rather than cross-imported,
// since these are independent test files; same "mirror, don't
// hand-duplicate a DIFFERENT rule" posture the app code itself already
// uses for the meetingActive predicate across bootstrap.ts/
// SettingsDialog.tsx/page.tsx.
// ---------------------------------------------------------------

function findSwitchByLabel(container: HTMLDivElement, labelText: string): HTMLButtonElement {
  const label = Array.from(container.querySelectorAll("label")).find((l) =>
    l.textContent?.includes(labelText),
  );
  if (!label) throw new Error(`label containing "${labelText}" not found`);
  const btn = label.querySelector('button[role="switch"]');
  if (!btn) throw new Error(`no switch inside label "${labelText}"`);
  return btn as HTMLButtonElement;
}

describe("SettingsDialog — round 2: 自动更新词典 checkbox + last-checked line", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetStore();
    vi.mocked(remotePacks.listPackSources).mockResolvedValue([]);
    vi.mocked(dictCatalog.fetchDictCatalog).mockResolvedValue({ packs: [] });
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
    vi.clearAllMocks();
  });

  it("checkbox reflects settings.packAutoUpdate (true) and toggles the draft on click", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, packAutoUpdate: true }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);
    await flush();

    const label = "自动更新词典（联网时每天检查一次）";
    expect(findSwitchByLabel(container!, label).getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      findSwitchByLabel(container!, label).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(findSwitchByLabel(container!, label).getAttribute("aria-checked")).toBe("false");
  });

  it("checkbox reflects settings.packAutoUpdate (false) on open", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, packAutoUpdate: false }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);
    await flush();

    expect(
      findSwitchByLabel(container!, "自动更新词典（联网时每天检查一次）").getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("last-checked line renders 尚未检查 when packAutoUpdateCheckedAt is absent", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, packAutoUpdateCheckedAt: undefined },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);
    await flush();

    expect(container!.textContent).toContain("尚未检查");
  });

  it("last-checked line renders a relative time (上次检查：2 小时前) when packAutoUpdateCheckedAt is set", async () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, packAutoUpdateCheckedAt: twoHoursAgo },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory(container!);
    await flush();

    expect(container!.textContent).toContain("上次检查：2 小时前");
  });
});
