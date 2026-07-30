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

  it("applies a successful dictionary hit through the real store and marks its progress done", async () => {
    const req = makeReq({ id: "lookup-store-hit", text: "circle back" });
    await runSelectionLookup(req, makeSettings({ aiDetect: true }));

    expect(useSelectionLookup.getState().byId[req.id]?.status).toBe("done");
    expect(useApp.getState().cards.map((card) => card.expression)).toContain("circle back");
    expect(mockDefineApi).not.toHaveBeenCalled();
  });

  it("registers a task while a contextual lookup is running and completes it with the result", async () => {
    let resolveDefinition!: (value: DefineResult) => void;
    mockDefineApi.mockReturnValueOnce(new Promise<DefineResult>((resolve) => (resolveDefinition = resolve)));
    const req = makeReq({ id: "lookup-task-progress" });
    const run = runSelectionLookup(req, makeSettings({ aiDetect: true }));

    expect(useTasks.getState().tasks[req.id]).toMatchObject({
      kind: "selection-lookup",
      label: "解释所选",
      status: "running",
    });

    resolveDefinition(DEFINITION);
    await run;
    expect(useTasks.getState().tasks[req.id]?.status).toBe("done");
  });

  it("marks both progress and its task as error when contextual lookup setup fails", async () => {
    const req = makeReq({ id: "lookup-setup-error" });
    mockResolveTranslationProvider.mockImplementationOnce(() => {
      throw new Error("翻译器初始化失败");
    });

    await runSelectionLookup(req, makeSettings({ aiDetect: true }));

    expect(useSelectionLookup.getState().byId[req.id]).toEqual({
      status: "error",
      error: "翻译器初始化失败",
    });
    expect(useTasks.getState().tasks[req.id]).toMatchObject({
      status: "error",
      error: "翻译器初始化失败",
    });
  });

  it("uses the request-id re-entrance guard while the first contextual request is in flight", async () => {
    let resolveDefinition!: (value: DefineResult) => void;
    mockDefineApi.mockReturnValueOnce(new Promise<DefineResult>((resolve) => (resolveDefinition = resolve)));
    const req = makeReq({ id: "lookup-request-id-guard" });

    const first = runSelectionLookup(req, makeSettings({ aiDetect: true }));
    const second = runSelectionLookup(req, makeSettings({ aiDetect: true }));
    expect(mockDefineApi).toHaveBeenCalledTimes(1);
    expect(mockProviderTranslate).toHaveBeenCalledTimes(1);

    resolveDefinition(DEFINITION);
    await Promise.all([first, second]);
  });

  it("keeps a completed id rejected after a new lookup prunes its done progress entry", async () => {
    const completed = makeReq({ id: "lookup-pruned-completed" });
    await runSelectionLookup(completed, makeSettings({ aiDetect: true }));
    expect(mockDefineApi).toHaveBeenCalledTimes(1);

    await runSelectionLookup(makeReq({ id: "lookup-prunes-previous" }), makeSettings({ aiDetect: true }));
    expect(useSelectionLookup.getState().byId[completed.id]).toBeUndefined();
    expect(mockDefineApi).toHaveBeenCalledTimes(2);

    await runSelectionLookup(completed, makeSettings({ aiDetect: true }));
    expect(mockDefineApi).toHaveBeenCalledTimes(2);
  });

  it("caps completed request ids with FIFO eviction", async () => {
    for (let index = 0; index < 33; index += 1) {
      await runSelectionLookup(makeReq({ id: `lookup-completed-cap-${index}` }), makeSettings({ aiDetect: true }));
    }
    mockDefineApi.mockClear();

    await runSelectionLookup(makeReq({ id: "lookup-completed-cap-0" }), makeSettings({ aiDetect: true }));
    expect(mockDefineApi).toHaveBeenCalledTimes(1);

    await runSelectionLookup(makeReq({ id: "lookup-completed-cap-32" }), makeSettings({ aiDetect: true }));
    expect(mockDefineApi).toHaveBeenCalledTimes(1);
  });

  it("prunes old done and error progress while retaining a still-loading sibling", async () => {
    useSelectionLookup.setState({
      byId: {
        "old-done": { status: "done", result: { expressions: [], terms: [] }, dictFallback: false },
        "old-error": { status: "error", error: "old failure" },
      },
    });
    let resolveFirstDefinition!: (value: DefineResult) => void;
    mockDefineApi.mockReturnValueOnce(
      new Promise<DefineResult>((resolve) => (resolveFirstDefinition = resolve)),
    );
    const loading = makeReq({ id: "lookup-still-loading" });
    const firstRun = runSelectionLookup(loading, makeSettings({ aiDetect: true }));

    const next = makeReq({ id: "lookup-prune-new" });
    await runSelectionLookup(next, makeSettings({ aiDetect: true }));

    const byId = useSelectionLookup.getState().byId;
    expect(byId["old-done"]).toBeUndefined();
    expect(byId["old-error"]).toBeUndefined();
    expect(byId[loading.id]).toEqual({ status: "loading" });
    expect(byId[next.id]?.status).toBe("done");

    resolveFirstDefinition(DEFINITION);
    await firstRun;
  });

  it("skips applying dictionary hits when the captured meeting generation has changed", async () => {
    const req = makeReq({ id: "lookup-meeting-switch-hit", text: "circle back" });
    useApp.setState({ lookup: null, meetingGen: 0, cards: [], terms: [] });
    const originalGetState = useApp.getState;
    const getStateSpy = vi.spyOn(useApp, "getState");
    getStateSpy.mockImplementationOnce(() => {
      const beforeSwitch = originalGetState();
      useApp.setState({ meetingGen: beforeSwitch.meetingGen + 1, cards: [], terms: [] });
      return beforeSwitch;
    });

    try {
      await runSelectionLookup(req, makeSettings({ aiDetect: true }));
    } finally {
      getStateSpy.mockRestore();
    }

    expect(useApp.getState().cards).toEqual([]);
    expect(useApp.getState().terms).toEqual([]);
    expect(useApp.getState().toast).toBe("解释完成，但会议已切换，未自动加入卡片");
  });

  it("keeps a zero-hit result on the ordinary not-found path after a meeting switch", async () => {
    let rejectDefinition!: (reason?: unknown) => void;
    let rejectTranslation!: (reason?: unknown) => void;
    mockDefineApi.mockReturnValueOnce(new Promise<DefineResult>((_resolve, reject) => (rejectDefinition = reject)));
    mockProviderTranslate.mockReturnValueOnce(
      new Promise<never>((_resolve, reject) => (rejectTranslation = reject)),
    );
    const req = makeReq({ id: "lookup-meeting-switch-empty" });
    useApp.setState({ lookup: null });
    const run = runSelectionLookup(req, makeSettings({ aiDetect: true }));

    useApp.setState((state) => ({ meetingGen: state.meetingGen + 1, cards: [], terms: [] }));
    rejectDefinition(new Error("定义服务不可用"));
    rejectTranslation(new Error("翻译服务不可用"));
    await run;

    expect(useApp.getState().cards).toEqual([]);
    expect(useApp.getState().terms).toEqual([]);
    expect(useApp.getState().toast).toBe("词典未收录所选内容");
  });

  it("keeps the no-key dictionary fallback on its normal path after a meeting switch", async () => {
    let rejectDefinition!: (reason?: unknown) => void;
    mockDefineApi.mockReturnValueOnce(new Promise<DefineResult>((_resolve, reject) => (rejectDefinition = reject)));
    mockProviderTranslate.mockRejectedValueOnce(new Error("翻译服务不可用"));
    const req = makeReq({ id: "lookup-meeting-switch-no-key" });
    useApp.setState({ lookup: null });
    const run = runSelectionLookup(req, makeSettings({ aiDetect: true }));

    useApp.setState((state) => ({ meetingGen: state.meetingGen + 1, cards: [], terms: [] }));
    rejectDefinition(new NoKeyError());
    await run;

    expect(useSelectionLookup.getState().byId[req.id]).toMatchObject({
      status: "done",
      dictFallback: true,
    });
    expect(useApp.getState().cards).toEqual([]);
    expect(useApp.getState().terms).toEqual([]);
    expect(useApp.getState().toast).toBe("词典未收录，AI 解释暂不可用");
  });

  it("only toasts after this request's popover has closed", async () => {
    const openReq = makeReq({ id: "lookup-popover-open" });
    useApp.setState({ lookup: openReq });
    await runSelectionLookup(openReq, makeSettings({ aiDetect: true }));
    expect(useApp.getState().toast).toBeNull();

    let resolveDefinition!: (value: DefineResult) => void;
    mockDefineApi.mockReturnValueOnce(new Promise<DefineResult>((resolve) => (resolveDefinition = resolve)));
    const closedReq = makeReq({ id: "lookup-popover-closed" });
    useApp.setState({ lookup: closedReq });
    const run = runSelectionLookup(closedReq, makeSettings({ aiDetect: true }));
    useApp.setState({ lookup: null });
    resolveDefinition(DEFINITION);
    await run;

    expect(useApp.getState().toast).toBe("划词解释完成");
  });
});

afterEach(() => {
  useSelectionLookup.setState({ byId: {} });
  useTasks.setState({ tasks: {} });
  useApp.setState({ cards: [], terms: [], lookup: null, toast: null });
});
