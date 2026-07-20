// Background 划词 card generation (v0.5 closeout) — setLookup itself is
// the pipeline's trigger (store.ts's own doc comment on that action);
// this pins that end-to-end wiring (setLookup -> dynamic import ->
// runSelectionLookup) separately from selectionLookup.test.ts's own
// direct-call tests, since it exercises a different seam (the dynamic
// import store.ts uses specifically to avoid a real cycle with
// lib/llm/client.ts — see LookupRequest's own doc + triggerSelectionLookup's
// comment in store.ts).
//
// Kept in its own small file (mirrors LookupPopover.defineModel.test.tsx's
// own precedent) rather than folded into the much larger, deliberately
// mock-free store.test.ts — this is the one corner of that file's
// surface that needs lib/llm/client mocked at all.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDetectApi = vi.fn();
vi.mock("../llm/client", () => ({
  detectApi: (...args: unknown[]) => mockDetectApi(...args),
  NoKeyError: class NoKeyError extends Error {
    constructor(message = "未配置 API Key") {
      super(message);
      this.name = "NoKeyError";
    }
  },
}));

import { useApp, type LookupRequest } from "../store";
import { useTasks } from "../tasks/registry";
import { useSelectionLookup } from "../tasks/selectionLookup";

function makeReq(overrides: Partial<LookupRequest> = {}): LookupRequest {
  return {
    id: "trigger-1",
    text: "circle back",
    contextText: "let's circle back on this",
    x: 10,
    y: 10,
    ...overrides,
  };
}

describe("setLookup (store.ts) — single trigger for the selection-lookup pipeline", () => {
  beforeEach(() => {
    mockDetectApi.mockReset().mockResolvedValue({ expressions: [], terms: [] });
    useSelectionLookup.setState({ byId: {} });
    useTasks.setState({ tasks: {} });
    useApp.setState((s) => ({
      lookup: null,
      settings: { ...s.settings, aiDetect: true },
    }));
  });

  afterEach(() => {
    useApp.setState({ lookup: null });
    useSelectionLookup.setState({ byId: {} });
    useTasks.setState({ tasks: {} });
  });

  it("calling setLookup with a non-null request kicks off the pipeline exactly once", async () => {
    const req = makeReq();
    useApp.getState().setLookup(req);

    expect(useApp.getState().lookup).toEqual(req);
    await vi.waitFor(() => {
      expect(useTasks.getState().tasks[req.id]?.status).toBe("done");
    });
    expect(mockDetectApi).toHaveBeenCalledTimes(1);
  });

  it("re-setting the SAME request id does not double-run the pipeline", async () => {
    const req = makeReq({ id: "trigger-dup" });
    useApp.getState().setLookup(req);
    useApp.getState().setLookup(req);

    await vi.waitFor(() => {
      expect(useTasks.getState().tasks[req.id]?.status).toBe("done");
    });
    expect(mockDetectApi).toHaveBeenCalledTimes(1);
  });

  it("setLookup(null) never starts a pipeline run", async () => {
    useApp.getState().setLookup(null);
    // Nothing to await — this is a synchronous no-op; give any stray
    // microtask a chance to run before asserting the negative.
    await Promise.resolve();
    expect(mockDetectApi).not.toHaveBeenCalled();
    expect(useTasks.getState().tasks).toEqual({});
  });

  it("dictionary-only settings (aiDetect:false) run through setLookup without registering a task", async () => {
    useApp.setState((s) => ({ settings: { ...s.settings, aiDetect: false } }));
    const req = makeReq({ id: "trigger-dict", text: "zzz-not-a-dictionary-entry-zzz" });
    useApp.getState().setLookup(req);

    await vi.waitFor(() => {
      expect(useSelectionLookup.getState().byId[req.id]?.status).toBe("done");
    });
    expect(mockDetectApi).not.toHaveBeenCalled();
    expect(useTasks.getState().tasks[req.id]).toBeUndefined();
  });
});
