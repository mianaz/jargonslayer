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
    removePackSource: vi.fn(async () => {}),
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

  it("importing a valid file calls addPackFromManifest(parsed, opts) and toasts success", async () => {
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

    expect(remotePacks.addPackFromManifest).toHaveBeenCalledWith(
      manifest,
      expect.objectContaining({ onEnabledPacksChange: expect.any(Function) }),
    );
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
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------
// T4 — enabledPacks materialization wiring
// ---------------------------------------------------------------

describe("SettingsDialog — v0.6 T4: enabledPacks materialization callback wiring", () => {
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

  it("installing a pack via URL passes the CURRENT enabledPacks and its onEnabledPacksChange write-through lands in settings.enabledPacks immediately (no 保存 needed)", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, enabledPacks: null }, hydrated: true });
    vi.mocked(remotePacks.addPackSource).mockImplementation(async (url, opts) => {
      // Mirrors what the REAL addPackSource (remotePacks.ts) does on
      // success: materialize + invoke the caller's own callback.
      opts?.onEnabledPacksChange?.(["core", "meeting-flow", "new-pack"]);
      return { url, pack: fakePack("new-pack", "New Pack") };
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

    expect(remotePacks.addPackSource).toHaveBeenCalledWith(
      "https://example.com/pack.json",
      expect.objectContaining({ currentEnabledPacks: null, onEnabledPacksChange: expect.any(Function) }),
    );
    // Write-through, not draft-staged: lands in the live store the
    // moment install resolves, same D1 contract theme-import CRUD
    // already established (SettingsDialog.test.tsx's own D1 describe
    // block) — no 保存 click anywhere in this test.
    expect(useApp.getState().settings.enabledPacks).toEqual(["core", "meeting-flow", "new-pack"]);
  });

  it("currentEnabledPacks reflects an UNSAVED in-dialog checkbox edit, not last-saved settings.enabledPacks (avoids silently discarding it)", async () => {
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

    // Uncheck a built-in pack's toggle (unsaved — 保存 is never clicked
    // in this test) before installing anything.
    const label = Array.from(container!.querySelectorAll("label")).find((l) =>
      l.textContent?.includes("会议流程与推进"),
    );
    const switchBtn = label?.querySelector('button[role="switch"]') as HTMLButtonElement | null;
    if (!switchBtn) throw new Error("会议流程与推进 toggle not found");
    await act(async () => {
      switchBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

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

    const passedOptions = vi.mocked(remotePacks.addPackSource).mock.calls[0][1];
    expect(passedOptions?.currentEnabledPacks).not.toBeNull();
    expect(passedOptions?.currentEnabledPacks).not.toContain("meeting-flow");
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
      { url: "https://x/older.json", pack: fakePack("older-version", "Older Version", "1.0") },
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

  it("installing a catalog row calls addPackSource(row.url, opts) and toasts success", async () => {
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

    expect(remotePacks.addPackSource).toHaveBeenCalledWith(
      "https://example.com/a.json",
      expect.objectContaining({ onEnabledPacksChange: expect.any(Function) }),
    );
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
