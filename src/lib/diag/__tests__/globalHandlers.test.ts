// @vitest-environment jsdom
//
// window.addEventListener("error"/"unhandledrejection") needs a real
// `window`/`ErrorEvent`/`PromiseRejectionEvent` to dispatch against —
// see lib/theme/__tests__/apply.test.ts's identical docblock rationale.

import { beforeEach, describe, expect, it } from "vitest";
import { clearDiag, getDiagEntries } from "../log";
import { installGlobalDiagHandlers, resetGlobalDiagHandlersLatch } from "../globalHandlers";

describe("diag/globalHandlers.ts — installGlobalDiagHandlers", () => {
  beforeEach(() => {
    clearDiag();
    resetGlobalDiagHandlersLatch();
  });

  it("logs a window 'error' event to the diag ring buffer", () => {
    installGlobalDiagHandlers();
    window.dispatchEvent(
      new ErrorEvent("error", { message: "boom", filename: "app.js", lineno: 1, colno: 2 }),
    );
    const entries = getDiagEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: "error", tag: "window", message: "boom" });
    expect(entries[0].ref).toMatch(/^JS-/);
  });

  it("logs an 'unhandledrejection' event, reading the Error's message", () => {
    installGlobalDiagHandlers();
    const rejected = Promise.reject(new Error("rejected boom"));
    rejected.catch(() => {}); // prevent this test itself from surfacing an unhandled rejection
    window.dispatchEvent(
      new PromiseRejectionEvent("unhandledrejection", { promise: rejected, reason: new Error("rejected boom") }),
    );
    const entries = getDiagEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: "error", tag: "window", message: "rejected boom" });
  });

  it("handles a non-Error rejection reason gracefully (string reason)", () => {
    installGlobalDiagHandlers();
    const rejected = Promise.reject("string reason");
    rejected.catch(() => {});
    window.dispatchEvent(
      new PromiseRejectionEvent("unhandledrejection", { promise: rejected, reason: "string reason" }),
    );
    expect(getDiagEntries()[0].message).toBe("string reason");
  });

  it("is idempotent — calling it twice does not register duplicate listeners", () => {
    installGlobalDiagHandlers();
    installGlobalDiagHandlers();
    window.dispatchEvent(new ErrorEvent("error", { message: "once only" }));
    expect(getDiagEntries()).toHaveLength(1);
  });
});
