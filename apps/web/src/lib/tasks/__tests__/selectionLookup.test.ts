// Background 划词 card generation (v0.5 closeout) — runSelectionLookup
// is the pipeline LookupPopover.tsx's own component effect used to own;
// these tests pin the exact behavior that extraction preserves (moved,
// not reimplemented — see that module's own header) plus the new
// popover-independent bits (keyed progress, task registry, toast).
//
// Only lib/llm/client is mocked (the one genuine network seam) — every
// other piece (the real useApp store, the real task registry) runs for
// real, mirroring LookupPopover.defineModel.test.tsx's own "exercise the
// real store" precedent: assertions land on actual cards/terms/toast
// state, not on a mock's call args.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDetectApi = vi.fn();
vi.mock("../../llm/client", () => ({
  detectApi: (...args: unknown[]) => mockDetectApi(...args),
  NoKeyError: class NoKeyError extends Error {
    constructor(message = "未配置 API Key") {
      super(message);
      this.name = "NoKeyError";
    }
  },
}));

import { useApp, type LookupRequest } from "../../store";
import { useTasks } from "../registry";
import { runSelectionLookup, useSelectionLookup } from "../selectionLookup";
import { NoKeyError } from "../../llm/client";
import { DEFAULT_SETTINGS, type DetectResponse, type Settings } from "@jargonslayer/core/types";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function makeReq(overrides: Partial<LookupRequest> = {}): LookupRequest {
  return {
    id: "lookup-1",
    text: "circle back",
    contextText: "let's circle back on this",
    x: 10,
    y: 10,
    ...overrides,
  };
}

const HIT: DetectResponse = {
  expressions: [
    {
      expression: "circle back",
      category: "phrase",
      meaning: "return to a topic later",
      chinese_explanation: "回头再聊",
      plain_english: "come back to this later",
      tone: "neutral",
      confidence: 0.9,
      source_sentence: "let's circle back on this",
    },
  ],
  terms: [],
};

const NO_HIT: DetectResponse = { expressions: [], terms: [] };

describe("runSelectionLookup — AI path", () => {
  beforeEach(() => {
    mockDetectApi.mockReset();
    useSelectionLookup.setState({ byId: {} });
    useTasks.setState({ tasks: {} });
    useApp.setState({ cards: [], terms: [], lookup: null, toast: null });
  });

  it("applies hits via the real store and marks the progress entry done", async () => {
    mockDetectApi.mockResolvedValue(HIT);
    const req = makeReq();
    await runSelectionLookup(req, makeSettings({ aiDetect: true }));

    expect(useSelectionLookup.getState().byId[req.id]).toEqual({
      status: "done",
      result: HIT,
      dictFallback: false,
    });
    expect(useApp.getState().cards.map((c) => c.expression)).toEqual(["circle back"]);
  });

  it("registers a selection-lookup task and completes it on success", async () => {
    mockDetectApi.mockResolvedValue(NO_HIT);
    const req = makeReq({ id: "lookup-task-1" });
    const runPromise = runSelectionLookup(req, makeSettings({ aiDetect: true }));
    expect(useTasks.getState().tasks[req.id]).toMatchObject({
      kind: "selection-lookup",
      label: "解释所选",
      status: "running",
    });
    await runPromise;
    expect(useTasks.getState().tasks[req.id].status).toBe("done");
  });

  it("completes after the popover has already closed — applyDetection still fires, and a toast fills in for the missing popover", async () => {
    mockDetectApi.mockResolvedValue(HIT);
    const req = makeReq({ id: "lookup-closed" });
    useApp.setState({ lookup: null }); // popover already closed before this resolves
    await runSelectionLookup(req, makeSettings({ aiDetect: true }));

    expect(useApp.getState().cards.map((c) => c.expression)).toEqual(["circle back"]);
    expect(useApp.getState().toast).toBe("划词解释完成，已加入卡片");
  });

  it("zero hits after the popover has closed toasts the 未检出 message instead", async () => {
    mockDetectApi.mockResolvedValue(NO_HIT);
    const req = makeReq({ id: "lookup-closed-empty" });
    useApp.setState({ lookup: null });
    await runSelectionLookup(req, makeSettings({ aiDetect: true }));

    expect(useApp.getState().toast).toBe("所选内容未检出术语");
  });

  it("no toast while the popover is still open on this exact request — it renders the result itself", async () => {
    mockDetectApi.mockResolvedValue(HIT);
    const req = makeReq({ id: "lookup-open" });
    useApp.setState({ lookup: req });
    await runSelectionLookup(req, makeSettings({ aiDetect: true }));

    expect(useApp.getState().toast).toBeNull();
  });

  it("NoKeyError falls back to the dictionary scan, completes (not fails) the task, and flags dictFallback", async () => {
    mockDetectApi.mockRejectedValue(new NoKeyError());
    const req = makeReq({ id: "lookup-nokey", text: "zzz-not-a-dictionary-entry-zzz" });
    await runSelectionLookup(req, makeSettings({ aiDetect: true }));

    const progress = useSelectionLookup.getState().byId[req.id];
    expect(progress?.status).toBe("done");
    expect(progress).toMatchObject({ dictFallback: true });
    expect(useTasks.getState().tasks[req.id].status).toBe("done");
  });

  it("a generic (non-NoKeyError) failure marks the progress entry AND the task as error", async () => {
    mockDetectApi.mockRejectedValue(new Error("网络错误"));
    const req = makeReq({ id: "lookup-error" });
    await runSelectionLookup(req, makeSettings({ aiDetect: true }));

    expect(useSelectionLookup.getState().byId[req.id]).toEqual({
      status: "error",
      error: "网络错误",
    });
    expect(useTasks.getState().tasks[req.id]).toMatchObject({ status: "error", error: "网络错误" });
  });

  it("re-entrance guard: a second call for the SAME request id is a no-op (no second detectApi round trip)", async () => {
    mockDetectApi.mockResolvedValue(NO_HIT);
    const req = makeReq({ id: "lookup-dup" });
    await Promise.all([
      runSelectionLookup(req, makeSettings({ aiDetect: true })),
      runSelectionLookup(req, makeSettings({ aiDetect: true })),
    ]);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);
  });

  it("bounded memory: a new lookup prunes prior done/error entries but keeps a still-loading sibling", async () => {
    useSelectionLookup.setState({
      byId: {
        "old-done": { status: "done", result: NO_HIT, dictFallback: false },
        "old-error": { status: "error", error: "x" },
      },
    });
    let resolveDetect!: (v: DetectResponse) => void;
    mockDetectApi.mockReturnValue(new Promise((resolve) => (resolveDetect = resolve)));
    const stillLoadingReq = makeReq({ id: "still-loading" });
    const inFlight = runSelectionLookup(stillLoadingReq, makeSettings({ aiDetect: true }));

    mockDetectApi.mockResolvedValueOnce(NO_HIT);
    const newReq = makeReq({ id: "new-one" });
    await runSelectionLookup(newReq, makeSettings({ aiDetect: true }));

    const byId = useSelectionLookup.getState().byId;
    expect(byId["old-done"]).toBeUndefined();
    expect(byId["old-error"]).toBeUndefined();
    expect(byId["still-loading"]).toEqual({ status: "loading" });
    expect(byId["new-one"]?.status).toBe("done");

    resolveDetect(NO_HIT);
    await inFlight;
  });
});

describe("runSelectionLookup — dictionary path", () => {
  beforeEach(() => {
    mockDetectApi.mockReset();
    useSelectionLookup.setState({ byId: {} });
    useTasks.setState({ tasks: {} });
    useApp.setState({ cards: [], terms: [], lookup: null, toast: null });
  });

  it("aiDetect:false never calls detectApi and never registers a task (dictionary-only is instant, not tray noise)", async () => {
    const req = makeReq({ id: "lookup-dict", text: "zzz-not-a-dictionary-entry-zzz" });
    await runSelectionLookup(req, makeSettings({ aiDetect: false }));

    expect(mockDetectApi).not.toHaveBeenCalled();
    expect(useTasks.getState().tasks[req.id]).toBeUndefined();
    expect(useSelectionLookup.getState().byId[req.id]?.status).toBe("done");
  });
});

afterEach(() => {
  useSelectionLookup.setState({ byId: {} });
  useTasks.setState({ tasks: {} });
  useApp.setState({ cards: [], terms: [], lookup: null, toast: null });
});
