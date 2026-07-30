// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

const mockDefineApi = vi.fn();
vi.mock("@/lib/llm/client", () => ({
  defineApi: (...args: unknown[]) => mockDefineApi(...args),
  NoKeyError: class NoKeyError extends Error {},
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

const LOOKUP_ID = "test-lookup";
const LOOKUP = {
  id: LOOKUP_ID,
  text: "we had lunch and went home",
  contextText: "After the meeting, we had lunch and went home.",
  x: 10,
  y: 10,
};

describe("LookupPopover — dictionary-first answers", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mockDefineApi.mockReset();
    useApp.setState({ customEntries: [], settings: makeSettings({ aiDetect: true }), lookup: LOOKUP });
    useSelectionLookup.setState({ byId: {} });
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

  async function render(): Promise<void> {
    await act(async () => {
      root!.render(<LookupPopover />);
      await Promise.resolve();
    });
  }

  it("shows every matching dictionary pack and every sense", async () => {
    useSelectionLookup.setState({
      byId: {
        [LOOKUP_ID]: {
          status: "done",
          dictFallback: false,
          result: {
            expressions: [],
            terms: [
              {
                term: "SAM",
                pack: "business-terms",
                type: "acronym",
                gloss_en: "Serviceable Addressable Market",
                gloss_zh: "可服务市场规模",
              },
              {
                term: "SAM",
                pack: "bioinformatics-edam",
                type: "acronym",
                gloss_en: "Sequence Alignment/Map",
                gloss_zh: "序列比对图格式",
                senses: [
                  {
                    senseId: "alignment",
                    gloss_en: "Sequence Alignment/Map format",
                    gloss_zh: "序列比对图格式",
                    domain: "genomics",
                    score: 0.9,
                  },
                  {
                    senseId: "market",
                    gloss_en: "Serviceable Addressable Market",
                    gloss_zh: "可服务市场规模",
                    domain: "finance",
                    score: 0.3,
                  },
                ],
              },
            ],
          },
        },
      },
    });
    await render();

    expect(container!.textContent).toContain("商务术语");
    expect(container!.textContent).toContain("生物信息学术语");
    expect(container!.textContent).toContain("序列比对图格式");
    expect(container!.textContent).toContain("可服务市场规模");
  });

  it("renders the automatic contextual definition and translation, then saves that definition without calling AI again", async () => {
    const addCustomEntry = vi.fn().mockResolvedValue(undefined);
    useApp.setState({ addCustomEntry });
    useSelectionLookup.setState({
      byId: {
        [LOOKUP_ID]: {
          status: "done",
          dictFallback: false,
          result: { expressions: [], terms: [] },
          definition: {
            kind: "expression",
            headword: LOOKUP.text,
            variants: [],
            chinese_explanation: "我们吃完午饭就回家了。",
            example: "We had lunch and went home after the meeting.",
          },
          translation: "我们吃完午饭就回家了。",
        },
      },
    });
    await render();

    expect(container!.textContent).toContain("我们吃完午饭就回家了。");
    expect(container!.textContent).toContain("翻译");
    const addButton = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent === "＋ 加入我的词典",
    ) as HTMLButtonElement | undefined;
    if (!addButton) throw new Error("add-to-glossary button not found");
    await act(async () => {
      addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockDefineApi).not.toHaveBeenCalled();
    const textarea = container!.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(textarea?.value).toBe("我们吃完午饭就回家了。");
    const saveButton = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent === "保存",
    ) as HTMLButtonElement | undefined;
    if (!saveButton) throw new Error("save button not found");
    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(addCustomEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        headword: LOOKUP.text,
        chinese_explanation: "我们吃完午饭就回家了。",
        source: "ai",
      }),
    );
  });

  it("keeps an offline system translation visible and honestly identifies a missing AI explanation key", async () => {
    useSelectionLookup.setState({
      byId: {
        [LOOKUP_ID]: {
          status: "done",
          dictFallback: true,
          result: { expressions: [], terms: [] },
          translation: "系统翻译结果",
          definitionError: "未配置 API Key",
        },
      },
    });
    await render();

    expect(container!.textContent).toContain("系统翻译结果");
    expect(container!.textContent).toContain("AI 解释不可用：未配置 API Key");
    expect(container!.textContent).toContain("＋ 加入我的词典");
  });

  it("is honest when the dictionary misses while AI detection is switched off", async () => {
    useApp.setState({ settings: makeSettings({ aiDetect: false }) });
    useSelectionLookup.setState({
      byId: {
        [LOOKUP_ID]: {
          status: "done",
          dictFallback: false,
          result: { expressions: [], terms: [] },
        },
      },
    });
    await render();

    expect(container!.textContent).toContain("词典未收录所选内容；AI 解释已关闭");
  });
});
