// @vitest-environment jsdom
//
// Field bug fix (iOS TestFlight "画词 dead end", FIX 2): a zero-hit
// detect result used to be a silent dead end (a bare "未检测到需要特别
//解释的表达" label, no way forward), and saving a hand-filled glossary
// draft was blocked until the user typed a non-empty 中文解释 — with no
// API key configured that's the ONLY path available, so it was a second
// dead end. This suite pins: the zero-hit message + primary-action
// button label vary by state (aiDetect on/off, dictFallback), and 保存
// no longer requires a non-empty 中文解释. Mirrors LookupPopover.
// defineModel.test.tsx's "exercise the real store" precedent — only
// llm/client (the network seam) and history/glossary's findEntryBySurface
// (so existingEntry stays null, matching a fresh selection) are mocked.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

const mockDetectApi = vi.fn();
const mockDefineApi = vi.fn();
vi.mock("@/lib/llm/client", () => ({
  detectApi: (...args: unknown[]) => mockDetectApi(...args),
  defineApi: (...args: unknown[]) => mockDefineApi(...args),
  NoKeyError: class NoKeyError extends Error {
    constructor(message = "未配置 API Key") {
      super(message);
      this.name = "NoKeyError";
    }
  },
}));

vi.mock("@/lib/history/glossary", () => ({
  findEntryBySurface: () => null,
}));

import { useApp } from "@/lib/store";
import { useSelectionLookup } from "@/lib/tasks/selectionLookup";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import LookupPopover from "../LookupPopover";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

const LOOKUP_ID = "test-lookup-zerohit";
const ZERO_HIT = { expressions: [], terms: [] };

describe("LookupPopover — zero-hit state (field bug fix)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mockDetectApi.mockReset();
    mockDefineApi.mockReset();
    useApp.setState({
      customEntries: [],
      lookup: {
        id: LOOKUP_ID,
        text: "keep the ball rolling",
        contextText: "let's keep the ball rolling on this",
        x: 10,
        y: 10,
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root!.unmount());
    container!.remove();
    container = null;
    root = null;
    useApp.setState({ lookup: null });
    useSelectionLookup.setState({ byId: {} });
  });

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function seedDone(dictFallback: boolean): void {
    useSelectionLookup.setState({
      byId: { [LOOKUP_ID]: { status: "done", result: ZERO_HIT, dictFallback } },
    });
  }

  it("aiDetect on, real AI zero-hit: 词典与 AI 均未命中所选内容 + AI 解释并加入词典", async () => {
    useApp.setState({ settings: makeSettings({ aiDetect: true }) });
    seedDone(false);
    await act(async () => {
      root!.render(<LookupPopover />);
    });
    await flush();

    expect(container!.textContent).toContain("词典与 AI 均未命中所选内容");
    const btn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "AI 解释并加入词典",
    );
    expect(btn).toBeTruthy();
  });

  it("aiDetect off: 未检测到已收录的表达 + 手动添加到词典", async () => {
    useApp.setState({ settings: makeSettings({ aiDetect: false }) });
    seedDone(false);
    await act(async () => {
      root!.render(<LookupPopover />);
    });
    await flush();

    expect(container!.textContent).toContain("未检测到已收录的表达");
    const btn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "手动添加到词典",
    );
    expect(btn).toBeTruthy();
  });

  it("aiDetect on but dictFallback (NoKeyError path): 未检测到已收录的表达 + 手动添加到词典", async () => {
    useApp.setState({ settings: makeSettings({ aiDetect: true }) });
    seedDone(true);
    await act(async () => {
      root!.render(<LookupPopover />);
    });
    await flush();

    expect(container!.textContent).toContain("未检测到已收录的表达");
    const btn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "手动添加到词典",
    );
    expect(btn).toBeTruthy();
  });

  it('保存 allows an empty 中文解释 — the manual draft saves with chinese_explanation: ""', async () => {
    useApp.setState({ settings: makeSettings({ aiDetect: false }) });
    seedDone(false);
    const addCustomEntry = vi.fn().mockResolvedValue(undefined);
    useApp.setState({ addCustomEntry });

    await act(async () => {
      root!.render(<LookupPopover />);
    });
    await flush();

    const openDraftBtn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "手动添加到词典",
    ) as HTMLButtonElement | undefined;
    if (!openDraftBtn) throw new Error("手动添加到词典 button not found");
    await act(async () => {
      openDraftBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const saveBtn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "保存",
    ) as HTMLButtonElement | undefined;
    if (!saveBtn) throw new Error("保存 button not found");
    expect(saveBtn.disabled).toBe(false); // the old `!chinese_explanation.trim()` gate is gone

    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(addCustomEntry).toHaveBeenCalledTimes(1);
    const [entry] = addCustomEntry.mock.calls[0];
    expect(entry.chinese_explanation).toBe("");
    expect(entry.headword).toBe("keep the ball rolling");
  });
});

// Fix round (Sol MEDIUM): with the 保存-requires-explanation gate gone,
// a blank manual save of a phrase the BUILT-IN dictionary knows would
// enroll a blank-backed card that shadows the built-in gloss (personal
// entries win). manualDraft now seeds the draft from an offline
// scanDictionary hit, so blank saves are left only for genuinely
// unknown phrases.
describe("LookupPopover — manual draft seeds from the built-in dictionary", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({
      customEntries: [],
      settings: { ...DEFAULT_SETTINGS, aiDetect: false },
      lookup: {
        id: LOOKUP_ID,
        // In the core pack ("get the ball rolling") — unlike the other
        // suite's "keep the ball rolling", which deliberately misses.
        text: "get the ball rolling",
        contextText: "let's get the ball rolling on this",
        x: 10,
        y: 10,
      },
    });
    useSelectionLookup.setState({
      byId: { [LOOKUP_ID]: { status: "done", result: { expressions: [], terms: [] }, dictFallback: true } },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root!.unmount());
    container!.remove();
    container = null;
    root = null;
    useApp.setState({ lookup: null });
    useSelectionLookup.setState({ byId: {} });
  });

  it("aiDetect off + dictionary-known phrase: 中文解释 arrives prefilled from the built-in gloss", async () => {
    await act(async () => {
      root!.render(<LookupPopover />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const openDraftBtn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "手动添加到词典",
    );
    if (!openDraftBtn) throw new Error("手动添加到词典 button not found");
    await act(async () => {
      openDraftBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const textarea = container!.querySelector("textarea") as HTMLTextAreaElement | null;
    if (!textarea) throw new Error("中文解释 textarea not found");
    expect(textarea.value.length).toBeGreaterThan(0);
  });
});
