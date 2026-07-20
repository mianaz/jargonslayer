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

// H2 (Sol review 2026-07-20, v0.5 closeout): select text in meeting A,
// look it up, start meeting B before the ~20s AI round trip resolves —
// applyDetection has no idea which meeting `cards`/`terms` belong to,
// so an unguarded call would merge A's hit into B's live cards.
describe("runSelectionLookup — H2: meetingGen guards applyDetection against a meeting switch mid-flight", () => {
  beforeEach(() => {
    mockDetectApi.mockReset();
    useSelectionLookup.setState({ byId: {} });
    useTasks.setState({ tasks: {} });
    useApp.setState({ cards: [], terms: [], lookup: null, toast: null, meetingGen: 0 });
  });

  it("a meetingGen bump before the AI response resolves skips applyDetection (no contamination) and toasts a distinct 'meeting switched' message", async () => {
    let resolveDetect!: (v: DetectResponse) => void;
    mockDetectApi.mockReturnValue(new Promise((resolve) => (resolveDetect = resolve)));
    const req = makeReq({ id: "lookup-gen-switch" });
    useApp.setState({ lookup: null }); // popover already closed — user moved on to meeting B
    const runPromise = runSelectionLookup(req, makeSettings({ aiDetect: true }));

    // Simulate ending meeting A and starting meeting B while the AI
    // round trip is still in flight — beginMeeting/newMeeting/
    // loadSession are the only real writers of meetingGen (store.ts);
    // bumping it directly here reproduces exactly that, including the
    // fresh (empty) cards/terms a new meeting starts with.
    useApp.setState((s) => ({ meetingGen: s.meetingGen + 1, cards: [], terms: [] }));

    resolveDetect(HIT);
    await runPromise;

    expect(useApp.getState().cards).toEqual([]); // NOT contaminated into meeting B
    expect(useApp.getState().terms).toEqual([]);
    expect(useApp.getState().toast).toBe("解释完成，但会议已切换，未自动加入卡片");
    expect(useTasks.getState().tasks[req.id].status).toBe("done"); // task still completes normally
    // The progress entry still lands "done" — a reopened popover for
    // this exact id would still render the raw explanation.
    expect(useSelectionLookup.getState().byId[req.id]).toEqual({
      status: "done",
      result: HIT,
      dictFallback: false,
    });
  });

  it("zero hits after a meetingGen bump still toasts the ordinary 未检出 message — nothing to contaminate", async () => {
    let resolveDetect!: (v: DetectResponse) => void;
    mockDetectApi.mockReturnValue(new Promise((resolve) => (resolveDetect = resolve)));
    const req = makeReq({ id: "lookup-gen-switch-empty" });
    useApp.setState({ lookup: null });
    const runPromise = runSelectionLookup(req, makeSettings({ aiDetect: true }));

    useApp.setState((s) => ({ meetingGen: s.meetingGen + 1 }));

    resolveDetect(NO_HIT);
    await runPromise;

    expect(useApp.getState().toast).toBe("所选内容未检出术语");
  });

  it("the switched-meeting toast still respects the popover-open guard — silent while this exact request's popover is open", async () => {
    let resolveDetect!: (v: DetectResponse) => void;
    mockDetectApi.mockReturnValue(new Promise((resolve) => (resolveDetect = resolve)));
    const req = makeReq({ id: "lookup-gen-switch-open" });
    useApp.setState({ lookup: req }); // this exact request's popover is (still) open
    const runPromise = runSelectionLookup(req, makeSettings({ aiDetect: true }));

    useApp.setState((s) => ({ meetingGen: s.meetingGen + 1, cards: [], terms: [] }));

    resolveDetect(HIT);
    await runPromise;

    expect(useApp.getState().toast).toBeNull();
    expect(useApp.getState().cards).toEqual([]); // still not contaminated
  });

  it("the NoKeyError dictionary-fallback path also respects the gen guard", async () => {
    let rejectDetect!: (err: unknown) => void;
    mockDetectApi.mockReturnValue(new Promise((_resolve, reject) => (rejectDetect = reject)));
    const req = makeReq({ id: "lookup-gen-nokey", text: "circle back" }); // a real dictionary hit
    useApp.setState({ lookup: null });
    const runPromise = runSelectionLookup(req, makeSettings({ aiDetect: true }));

    useApp.setState((s) => ({ meetingGen: s.meetingGen + 1, cards: [], terms: [] }));
    rejectDetect(new NoKeyError());
    await runPromise;

    expect(useApp.getState().cards).toEqual([]); // would have applied if not guarded
    expect(useApp.getState().toast).toBe("解释完成，但会议已切换，未自动加入卡片");
  });
});

// L1 (Sol review 2026-07-20, v0.5 closeout): startProgress's own prune
// (see this module's header comment) drops a completed id's byId entry
// the instant a fresh lookup starts — the completedIds Set survives
// that prune so a (currently impossible, but future-proofed) resubmit
// of an old id still can't re-run detection.
describe("runSelectionLookup — L1: re-entrance guard survives a byId prune", () => {
  beforeEach(() => {
    mockDetectApi.mockReset();
    useSelectionLookup.setState({ byId: {} });
    useTasks.setState({ tasks: {} });
    useApp.setState({ cards: [], terms: [], lookup: null, toast: null });
  });

  it("a completed id that has since been pruned from byId is still rejected on resubmission (no second detectApi round trip)", async () => {
    mockDetectApi.mockResolvedValue(NO_HIT);
    const req = makeReq({ id: "lookup-l1-prune" });
    await runSelectionLookup(req, makeSettings({ aiDetect: true }));
    expect(mockDetectApi).toHaveBeenCalledTimes(1);

    // A fresh, unrelated lookup starting prunes every TERMINAL byId
    // entry (startProgress's own doc) — including req's now-done one.
    await runSelectionLookup(makeReq({ id: "lookup-l1-unrelated" }), makeSettings({ aiDetect: true }));
    expect(useSelectionLookup.getState().byId[req.id]).toBeUndefined(); // confirms the prune actually happened
    expect(mockDetectApi).toHaveBeenCalledTimes(2);

    // Resubmitting the SAME (now-pruned) id must still be a no-op.
    await runSelectionLookup(req, makeSettings({ aiDetect: true }));
    expect(mockDetectApi).toHaveBeenCalledTimes(2); // no third call
  });

  it("caps completed-id memory at 32 (FIFO evict): the first of a 33-lookup run re-runs if resubmitted, the most recent still doesn't", async () => {
    mockDetectApi.mockResolvedValue(NO_HIT);
    for (let i = 0; i < 33; i++) {
      await runSelectionLookup(makeReq({ id: `lookup-l1-cap-${i}` }), makeSettings({ aiDetect: true }));
    }
    mockDetectApi.mockClear();

    // Eviction always consumes whatever's OLDEST first, so regardless
    // of how many OTHER ids this module has already seen this test
    // run, the FIRST of these 33 is guaranteed to be the one pushed out
    // of the 32-item cap — resubmitting it legitimately re-runs.
    await runSelectionLookup(makeReq({ id: "lookup-l1-cap-0" }), makeSettings({ aiDetect: true }));
    expect(mockDetectApi).toHaveBeenCalledTimes(1);

    // The most recent of the 33 is still well within the cap.
    await runSelectionLookup(makeReq({ id: "lookup-l1-cap-32" }), makeSettings({ aiDetect: true }));
    expect(mockDetectApi).toHaveBeenCalledTimes(1); // unchanged — no second call
  });
});

afterEach(() => {
  useSelectionLookup.setState({ byId: {} });
  useTasks.setState({ tasks: {} });
  useApp.setState({ cards: [], terms: [], lookup: null, toast: null });
});
