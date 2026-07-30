// Selection lookup is a dictionary first answer flow. These tests keep
// the network/translation seams mocked, while the real dictionary and
// zustand stores verify the integration around them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDefineApi = vi.fn();
const mockProviderPrepare = vi.fn();
const mockProviderTranslate = vi.fn();
const mockResolveTranslationProvider = vi.fn();

vi.mock("../../llm/client", () => ({
  defineApi: (...args: unknown[]) => mockDefineApi(...args),
  NoKeyError: class NoKeyError extends Error {
    constructor(message = "未配置 API Key") {
      super(message);
      this.name = "NoKeyError";
    }
  },
}));

vi.mock("../../translate/providers", () => ({
  langPairFromSettings: () => ({ source: "en", target: "zh" }),
  resolveTranslationProvider: (...args: unknown[]) => mockResolveTranslationProvider(...args),
}));

import { useApp, type LookupRequest } from "../../store";
import { useTasks } from "../registry";
import { runSelectionLookup, useSelectionLookup } from "../selectionLookup";
import { NoKeyError } from "../../llm/client";
import { DEFAULT_SETTINGS, type DefineResult, type Settings } from "@jargonslayer/core/types";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function makeReq(overrides: Partial<LookupRequest> = {}): LookupRequest {
  return {
    id: "lookup-1",
    text: "we had lunch and went home",
    contextText: "After the meeting, we had lunch and went home.",
    x: 10,
    y: 10,
    ...overrides,
  };
}

const DEFINITION: DefineResult = {
  kind: "expression",
  headword: "we had lunch and went home",
  variants: [],
  chinese_explanation: "我们吃完午饭就回家了。",
  example: "We had lunch and went home after the meeting.",
};

describe("runSelectionLookup", () => {
  beforeEach(() => {
    mockDefineApi.mockReset().mockResolvedValue(DEFINITION);
    mockProviderPrepare.mockReset();
    mockProviderTranslate.mockReset().mockResolvedValue([{ id: "lookup-1", text: "我们吃完午饭就回家了。" }]);
    mockResolveTranslationProvider.mockReset().mockReturnValue({
      kind: "system",
      prepare: mockProviderPrepare,
      translate: mockProviderTranslate,
    });
    useSelectionLookup.setState({ byId: {} });
    useTasks.setState({ tasks: {} });
    useApp.setState({ cards: [], terms: [], lookup: null, toast: null, meetingGen: 0 });
  });

  it("lists an explicit dictionary hit immediately and never calls AI or translation", async () => {
    const req = makeReq({ id: "lookup-dictionary-hit", text: "circle back" });
    await runSelectionLookup(req, makeSettings({ aiDetect: true }));

    const progress = useSelectionLookup.getState().byId[req.id];
    expect(progress?.status).toBe("done");
    expect(progress?.status === "done" && progress.result.expressions.map((entry) => entry.expression)).toContain(
      "circle back",
    );
    expect(mockDefineApi).not.toHaveBeenCalled();
    expect(mockProviderTranslate).not.toHaveBeenCalled();
    expect(useTasks.getState().tasks[req.id]).toBeUndefined();
  });

  it("bypasses common-word suppression for an explicit dictionary lookup", async () => {
    const req = makeReq({ id: "lookup-attention", text: "attention" });
    await runSelectionLookup(req, makeSettings({ aiDetect: false }));

    const progress = useSelectionLookup.getState().byId[req.id];
    expect(progress?.status === "done" && progress.result.terms.some((term) => term.term === "attention")).toBe(
      true,
    );
  });

  it("on a genuine miss automatically defines in context and uses the configured translation provider", async () => {
    const req = makeReq({ id: "lookup-ai-fallback" });
    mockProviderTranslate.mockResolvedValueOnce([{ id: req.id, text: "我们吃完午饭就回家了。" }]);
    await runSelectionLookup(req, makeSettings({ aiDetect: true, detectModel: "lookup-model" }));

    expect(mockDefineApi).toHaveBeenCalledWith(
      expect.objectContaining({
        phrase: req.text,
        context: req.contextText,
        lang: "zh",
        model: "lookup-model",
      }),
      expect.any(Object),
    );
    expect(mockResolveTranslationProvider).toHaveBeenCalledTimes(1);
    expect(mockProviderPrepare).toHaveBeenCalledWith({ source: "en", target: "zh" });
    expect(mockProviderTranslate).toHaveBeenCalledWith([{ id: req.id, text: req.text }], "zh");
    expect(useSelectionLookup.getState().byId[req.id]).toEqual({
      status: "done",
      result: { expressions: [], terms: [] },
      definition: DEFINITION,
      translation: "我们吃完午饭就回家了。",
      dictFallback: false,
    });
    expect(useTasks.getState().tasks[req.id].status).toBe("done");
  });

  it("with no AI key, keeps an available system translation and records an honest explanation error", async () => {
    const req = makeReq({ id: "lookup-no-key" });
    mockDefineApi.mockRejectedValueOnce(new NoKeyError());
    mockProviderTranslate.mockResolvedValueOnce([{ id: req.id, text: "系统翻译结果" }]);
    await runSelectionLookup(req, makeSettings({ aiDetect: true, translateEngine: "system" }));

    const progress = useSelectionLookup.getState().byId[req.id];
    expect(progress).toMatchObject({
      status: "done",
      dictFallback: true,
      translation: "系统翻译结果",
      definitionError: "未配置 API Key",
    });
    expect(useTasks.getState().tasks[req.id].status).toBe("done");
  });

  it("with AI disabled, returns the dictionary miss without a network request", async () => {
    const req = makeReq({ id: "lookup-offline" });
    await runSelectionLookup(req, makeSettings({ aiDetect: false }));

    expect(mockDefineApi).not.toHaveBeenCalled();
    expect(mockProviderTranslate).not.toHaveBeenCalled();
    expect(useTasks.getState().tasks[req.id]).toBeUndefined();
    expect(useSelectionLookup.getState().byId[req.id]).toEqual({
      status: "done",
      result: { expressions: [], terms: [] },
      dictFallback: false,
    });
  });

  it("turns service failures into readable completed lookup details instead of a dead end", async () => {
    const req = makeReq({ id: "lookup-services-failed" });
    mockDefineApi.mockRejectedValueOnce(new Error("定义服务离线"));
    mockProviderTranslate.mockRejectedValueOnce(new Error("系统翻译不可用"));
    await runSelectionLookup(req, makeSettings({ aiDetect: true }));

    expect(useSelectionLookup.getState().byId[req.id]).toEqual({
      status: "done",
      result: { expressions: [], terms: [] },
      dictFallback: false,
      definitionError: "定义服务离线",
      translationError: "系统翻译不可用",
    });
  });

  it("does not run the fallback twice when the same selection is submitted twice", async () => {
    const req = makeReq({ id: "lookup-duplicate" });
    await Promise.all([
      runSelectionLookup(req, makeSettings({ aiDetect: true })),
      runSelectionLookup(req, makeSettings({ aiDetect: true })),
    ]);

    expect(mockDefineApi).toHaveBeenCalledTimes(1);
    expect(mockProviderTranslate).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  useSelectionLookup.setState({ byId: {} });
  useTasks.setState({ tasks: {} });
  useApp.setState({ cards: [], terms: [], lookup: null, toast: null });
});
