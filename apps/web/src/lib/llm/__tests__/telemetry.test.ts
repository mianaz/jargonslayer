import { afterEach, describe, expect, it } from "vitest";
import {
  recordLlmCall,
  recordLlmQcDrop,
  resetLlmTelemetry,
  useLlmTelemetry,
} from "../telemetry";

afterEach(() => resetLlmTelemetry());

describe("llm telemetry store", () => {
  it("starts every domain empty (null status, zero counts)", () => {
    const s = useLlmTelemetry.getState();
    for (const d of ["detect", "define", "translate", "summary"] as const) {
      expect(s[d]).toEqual({
        calls: 0,
        failures: 0,
        qcDropped: 0,
        lastStatus: null,
        lastAt: null,
      });
    }
  });

  it("records a success: calls++ , status ok, no error kind", () => {
    recordLlmCall("detect", "ok");
    const d = useLlmTelemetry.getState().detect;
    expect(d.calls).toBe(1);
    expect(d.failures).toBe(0);
    expect(d.lastStatus).toBe("ok");
    expect(d.lastErrorKind).toBeUndefined();
    expect(d.lastAt).not.toBeNull();
  });

  it("records a failure: calls++ , failures++ , status fail, stamps kind", () => {
    recordLlmCall("translate", { kind: "ratelimit" });
    const t = useLlmTelemetry.getState().translate;
    expect(t.calls).toBe(1);
    expect(t.failures).toBe(1);
    expect(t.lastStatus).toBe("fail");
    expect(t.lastErrorKind).toBe("ratelimit");
  });

  it("a success after a failure clears the stale error kind", () => {
    recordLlmCall("summary", { kind: "upstream" });
    recordLlmCall("summary", "ok");
    const s = useLlmTelemetry.getState().summary;
    expect(s.calls).toBe(2);
    expect(s.failures).toBe(1);
    expect(s.lastStatus).toBe("ok");
    expect(s.lastErrorKind).toBeUndefined();
  });

  it("keeps domains isolated — recording detect never touches define", () => {
    recordLlmCall("detect", { kind: "nokey" });
    expect(useLlmTelemetry.getState().define).toEqual({
      calls: 0,
      failures: 0,
      qcDropped: 0,
      lastStatus: null,
      lastAt: null,
    });
  });

  it("accumulates QC drops without counting them as calls", () => {
    recordLlmQcDrop("detect", 2);
    recordLlmQcDrop("detect", 3);
    const d = useLlmTelemetry.getState().detect;
    expect(d.qcDropped).toBe(5);
    expect(d.calls).toBe(0);
    expect(d.lastStatus).toBeNull();
  });

  it("ignores a non-positive QC drop (a clean batch never churns the store)", () => {
    recordLlmQcDrop("detect", 0);
    recordLlmQcDrop("detect", -1);
    expect(useLlmTelemetry.getState().detect.qcDropped).toBe(0);
  });

  it("reset returns every domain to empty", () => {
    recordLlmCall("detect", "ok");
    recordLlmQcDrop("summary", 4);
    resetLlmTelemetry();
    const s = useLlmTelemetry.getState();
    expect(s.detect.calls).toBe(0);
    expect(s.summary.qcDropped).toBe(0);
  });
});
