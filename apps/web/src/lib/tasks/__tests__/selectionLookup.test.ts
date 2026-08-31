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

// Mutable so individual tests can simulate a same-language pair (the
// offline no-op path) without re-mocking the module.
const mockLangPair = { source: "en", target: "zh" };

vi.mock("../../translate/providers", () => ({
  langPairFromSettings: () => ({ ...mockLangPair }),
  resolveTranslationProvider: (...args: unknown[]) => mockResolveTranslationProvider(...args),
  SystemTranslatorUnavailableError: class SystemTranslatorUnavailableError extends Error {
    reason: "unavailable" | "downloading";
    constructor(reason: "unavailable" | "downloading" = "unavailable", message = "系统翻译不可用") {
      super(message);
      this.name = "SystemTranslatorUnavailableError";
      this.reason = reason;
    }
  },
}));

import { useApp, getMeetingDomainTracker, type LookupRequest } from "../../store";
import { useTasks } from "../registry";
import { runSelectionLookup, useSelectionLookup } from "../selectionLookup";
import { NoKeyError } from "../../llm/client";
import { SystemTranslatorUnavailableError } from "../../translate/providers";
import { scanDictionary } from "@jargonslayer/core/detect/dictionary";
import { setLoadedRemotePacks } from "@jargonslayer/core/detect/remotePacksRegistry";
import { setCachedEntries } from "@jargonslayer/core/history/glossaryLookup";
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

  it("lists an explicit dictionary hit immediately, never calls AI, and still translates the selection (offline 划词翻译)", async () => {
    const req = makeReq({ id: "lookup-dictionary-hit", text: "circle back" });
    mockProviderTranslate.mockResolvedValueOnce([{ id: req.id, text: "回头再说" }]);
    await runSelectionLookup(req, makeSettings({ aiDetect: true }));

    const progress = useSelectionLookup.getState().byId[req.id];
    expect(progress?.status).toBe("done");
    expect(progress?.status === "done" && progress.result.expressions.map((entry) => entry.expression)).toContain(
      "circle back",
    );
    expect(mockDefineApi).not.toHaveBeenCalled();
    // The translation is a silent in-place upgrade after the hit — no
    // task registered (the primary answer was already on screen).
    expect(mockProviderTranslate).toHaveBeenCalledWith([{ id: req.id, text: req.text }], "zh");
    expect(progress?.status === "done" && progress.translation).toBe("回头再说");
    expect(useTasks.getState().tasks[req.id]).toBeUndefined();
  });

  it("a dictionary hit is finished/applied even when its follow-up translation fails, quietly", async () => {
    const req = makeReq({ id: "lookup-hit-translate-fails", text: "circle back" });
    mockProviderTranslate.mockRejectedValueOnce(new Error("翻译服务挂了"));
    await runSelectionLookup(req, makeSettings({ aiDetect: false }));

    const progress = useSelectionLookup.getState().byId[req.id];
    expect(progress?.status).toBe("done");
    expect(progress?.status === "done" && progress.translation).toBeUndefined();
    // The hit itself still landed as a card.
    expect(useApp.getState().cards.some((c) => c.expression === "circle back")).toBe(true);
  });

  it("bypasses common-word suppression for an explicit dictionary lookup", async () => {
    const req = makeReq({ id: "lookup-attention", text: "attention" });
    await runSelectionLookup(req, makeSettings({ aiDetect: false }));

    const progress = useSelectionLookup.getState().byId[req.id];
    expect(progress?.status === "done" && progress.result.terms.some((term) => term.term === "attention")).toBe(
      true,
    );
  });

  // Finding 5: an explicit lookup used to omit the meeting-domain signal,
  // so it could contradict the transcript card for the SAME term in the
  // SAME meeting (e.g. the transcript correctly reads CAC as Cancer-
  // Associated Cachexia in a pharma talk, but the 划词 popover ranked
  // 获客成本 first because it never saw the active domain).
  it("feeds the meeting-domain signal into the lookup so it agrees with the transcript card", async () => {
    // Prime the SAME tracker the live transcript pipeline feeds
    // (scheduler.ts's own domainTracker.observe call) with two
    // pharma-pack hits, exactly as an acronym-dense pharma talk would
    // before the user selects "CAC" to double-check it.
    getMeetingDomainTracker().observe(scanDictionary("The IND, BLA, and PK plans are ready."));

    const req = makeReq({ id: "lookup-domain-signal", text: "CAC" });
    await runSelectionLookup(req, makeSettings({ aiDetect: true }));

    const progress = useSelectionLookup.getState().byId[req.id];
    const cac = progress?.status === "done" ? progress.result.terms.find((t) => t.term === "CAC") : undefined;
    expect(cac?.gloss_zh).toBe("癌症相关恶病质");
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

  it("with AI disabled, a dictionary miss still translates the selection through the configured (offline-capable) provider — no AI request", async () => {
    const req = makeReq({ id: "lookup-offline" });
    mockProviderTranslate.mockResolvedValueOnce([{ id: req.id, text: "离线翻译结果" }]);
    await runSelectionLookup(req, makeSettings({ aiDetect: false }));

    expect(mockDefineApi).not.toHaveBeenCalled();
    expect(mockProviderTranslate).toHaveBeenCalledWith([{ id: req.id, text: req.text }], "zh");
    expect(useSelectionLookup.getState().byId[req.id]).toEqual({
      status: "done",
      result: { expressions: [], terms: [] },
      dictFallback: false,
      translation: "离线翻译结果",
    });
    // The user IS waiting on this one (no dictionary answer yet), so the
    // translation-only round registers a task, labeled honestly.
    expect(useTasks.getState().tasks[req.id]).toMatchObject({ status: "done", label: "翻译所选" });
  });

  it("with AI disabled AND a same-language pair, a miss finishes instantly with no task and no provider call", async () => {
    const req = makeReq({ id: "lookup-offline-same-lang" });
    mockLangPair.source = "zh";
    try {
      await runSelectionLookup(req, makeSettings({ aiDetect: false }));
    } finally {
      mockLangPair.source = "en";
    }

    expect(mockDefineApi).not.toHaveBeenCalled();
    expect(mockProviderTranslate).not.toHaveBeenCalled();
    expect(mockResolveTranslationProvider).not.toHaveBeenCalled();
    expect(useTasks.getState().tasks[req.id]).toBeUndefined();
    expect(useSelectionLookup.getState().byId[req.id]).toEqual({
      status: "done",
      result: { expressions: [], terms: [] },
      dictFallback: false,
    });
  });

  it("surfaces the user's own personal-glossary entry (which shadows the built-in dictionary) without re-applying it to cards", async () => {
    const now = Date.now();
    setCachedEntries([
      {
        id: "custom-1",
        kind: "expression",
        packId: "personal",
        headword: "circle back",
        variants: [],
        chinese_explanation: "我自己的解释",
        example: "",
        context: "",
        note: "",
        createdAt: now,
        updatedAt: now,
        source: "manual",
        mastered: false,
        reviewCount: 0,
      },
    ]);
    try {
      const req = makeReq({ id: "lookup-personal-entry", text: "circle back" });
      await runSelectionLookup(req, makeSettings({ aiDetect: false }));

      const progress = useSelectionLookup.getState().byId[req.id];
      expect(
        progress?.status === "done" &&
          progress.result.expressions.some(
            (e) => e.expression === "circle back" && e.chinese_explanation === "我自己的解释",
          ),
      ).toBe(true);
      // The custom hit is display-only here: the transcript scan owns
      // emitting/counting custom cards, so the lookup must not add one.
      expect(useApp.getState().cards).toHaveLength(0);
    } finally {
      setCachedEntries([]);
    }
  });

  it("searches installed (downloaded) dictionary packs during an offline lookup", async () => {
    setLoadedRemotePacks([
      {
        id: "__test_downloaded_pack__",
        name: "已下载词典",
        version: 1,
        expressions: [],
        terms: [
          {
            term: "zzzdownloadedterm",
            type: "other",
            gloss_en: "a term only the downloaded pack knows",
            gloss_zh: "只有已下载词典收录的词",
            pack: "__test_downloaded_pack__",
          },
        ],
      },
    ]);
    try {
      const req = makeReq({ id: "lookup-downloaded-pack", text: "zzzdownloadedterm" });
      await runSelectionLookup(req, makeSettings({ aiDetect: false }));

      const progress = useSelectionLookup.getState().byId[req.id];
      expect(mockDefineApi).not.toHaveBeenCalled();
      expect(
        progress?.status === "done" &&
          progress.result.terms.some(
            (t) => t.term === "zzzdownloadedterm" && t.gloss_zh === "只有已下载词典收录的词",
          ),
      ).toBe(true);
    } finally {
      setLoadedRemotePacks([]);
    }
  });

  it("quietly omits the translation line when the llm translate engine has no key (NoKeyError)", async () => {
    const req = makeReq({ id: "lookup-offline-nokey" });
    mockProviderTranslate.mockRejectedValueOnce(new NoKeyError());
    await runSelectionLookup(req, makeSettings({ aiDetect: false }));

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

  // Finding 7: a genuinely UNAVAILABLE translation provider (model still
  // downloading, or the browser has no Translator API at all) is not
  // something the user can act on — the fix omits the translation line
  // entirely instead of rendering a permanent red error, while any OTHER
  // translation failure (e.g. a real provider error) still surfaces.
  it("omits the translation line (no error shown) when the provider is genuinely unavailable", async () => {
    const req = makeReq({ id: "lookup-translator-unavailable" });
    mockProviderTranslate.mockRejectedValueOnce(new SystemTranslatorUnavailableError("downloading"));
    await runSelectionLookup(req, makeSettings({ aiDetect: true }));

    expect(useSelectionLookup.getState().byId[req.id]).toEqual({
      status: "done",
      result: { expressions: [], terms: [] },
      dictFallback: false,
      definition: DEFINITION,
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

    resolveDefinition(DEFINITION);
    await Promise.all([first, second]);

    // Translation is sequenced AFTER definition settles (not raced
    // against it — see runSelectionLookup's own doc), so it only shows
    // up once both requests have fully resolved.
    expect(mockProviderTranslate).toHaveBeenCalledTimes(1);
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
  // getMeetingDomainTracker() is a module-level singleton (store.ts),
  // not zustand state — newMeeting()'s own reset is the only way to
  // clear it, same as a real meeting boundary. Needed so a test that
  // primes it (Finding 5) can't leak active domains into a later test.
  useApp.getState().newMeeting();
});
