// @vitest-environment jsdom
//
// R1 (model-blind call path fix, caller audit): LookupPopover's
// "＋ 加入我的词典" flow used to call defineApi with NO `model` field at
// all — defineApi rides detect's config (resolveTaskCreds(settings,
// "detect")), same bug class as stt/upload.ts's own pre-fix detectApi
// call: a non-OpenRouter openai-compat/Anthropic-direct user would
// silently probe the task-wide (DeepSeek-slug) server/task default
// instead of their own configured detect model and 404. This suite
// exercises the REAL zustand store (see SettingsDialog.desktop.test.tsx's
// own precedent for this pattern) with only llm/client + history/glossary
// mocked, so the assertion is against the actual wire call the component
// makes.

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
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import LookupPopover from "../LookupPopover";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("LookupPopover — 加入我的词典 forwards the resolved detect-domain model to defineApi", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mockDetectApi.mockReset().mockResolvedValue({ expressions: [], terms: [] });
    mockDefineApi.mockReset().mockResolvedValue({
      kind: "expression",
      headword: "circle back",
      variants: [],
      chinese_explanation: "z",
      example: "e",
    });
    useApp.setState({
      settings: makeSettings({
        aiDetect: true,
        provider: "openai-compat",
        baseUrl: "https://api.deepseek.com/v1",
        detectModel: "deepseek-chat",
      }),
      customEntries: [],
      lookup: { text: "circle back", contextText: "let's circle back on this", x: 10, y: 10 },
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
  });

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("sends resolveTaskCreds(settings, \"detect\").model as defineApi's request model", async () => {
    await act(async () => {
      root!.render(<LookupPopover />);
    });
    await flush();

    const btn = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("加入我的词典"),
    ) as HTMLButtonElement | undefined;
    if (!btn) throw new Error("＋ 加入我的词典 button not found");

    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockDefineApi).toHaveBeenCalledTimes(1);
    const [body] = mockDefineApi.mock.calls[0];
    expect(body.model).toBe("deepseek-chat");
  });
});
