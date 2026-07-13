import { beforeEach, describe, expect, it } from "vitest";

import { DIAG_MAX_ENTRIES, clearDiag, diagLog, getDiagEntries } from "../diag";

describe("diag ring buffer", () => {
  beforeEach(() => {
    clearDiag();
  });

  it("starts empty", () => {
    expect(getDiagEntries()).toEqual([]);
  });

  it("records level/tag/message/detail and a timestamp", () => {
    diagLog("warn", "stt-interim-shrink", "non-final transcript shrank", "byChars=5");
    const entries = getDiagEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: "warn",
      tag: "stt-interim-shrink",
      message: "non-final transcript shrank",
      detail: "byChars=5",
    });
    expect(entries[0].ts).toBeGreaterThan(0);
  });

  it("detail is optional", () => {
    diagLog("info", "stt-ondevice", "开始下载设备端语音识别模型");
    expect(getDiagEntries()[0].detail).toBeUndefined();
  });

  it("preserves insertion order oldest-first", () => {
    diagLog("info", "a", "first");
    diagLog("info", "b", "second");
    diagLog("info", "c", "third");
    expect(getDiagEntries().map((e) => e.tag)).toEqual(["a", "b", "c"]);
  });

  it("caps at DIAG_MAX_ENTRIES, dropping the oldest first", () => {
    for (let i = 0; i < DIAG_MAX_ENTRIES + 10; i += 1) {
      diagLog("info", "tag", `entry-${i}`);
    }
    const entries = getDiagEntries();
    expect(entries).toHaveLength(DIAG_MAX_ENTRIES);
    expect(entries[0].message).toBe("entry-10"); // the first 10 were dropped
    expect(entries[entries.length - 1].message).toBe(`entry-${DIAG_MAX_ENTRIES + 9}`);
  });

  it("getDiagEntries returns a fresh array each call (no internal-state leak)", () => {
    diagLog("info", "a", "first");
    const snapshot = getDiagEntries();
    snapshot.push({ ts: 0, level: "error", tag: "injected", message: "should not persist" });
    expect(getDiagEntries()).toHaveLength(1);
  });

  it("clearDiag empties the buffer", () => {
    diagLog("info", "a", "first");
    clearDiag();
    expect(getDiagEntries()).toEqual([]);
  });
});
