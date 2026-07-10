// isEngineControlBusy — the shared "meeting is live enough that
// switching engines or opening the import hub would be unsafe" gate
// (#62 item 2). Previously inlined 3x across EnginePillGroup/
// MobileEngineSelect/HamburgerMenu; now one exported pure function so
// the new 导入 pill/button (desktop peer of the engine pills + mobile
// icon button) reuses the exact same gating logic instead of a 4th
// inline copy.

import { describe, expect, it } from "vitest";
import { isEngineControlBusy } from "../Header";

describe("isEngineControlBusy", () => {
  it("is busy while a meeting is connecting or listening", () => {
    expect(isEngineControlBusy("connecting")).toBe(true);
    expect(isEngineControlBusy("listening")).toBe(true);
  });

  it("is not busy idle or stopped — engine switching and the import hub are both open", () => {
    expect(isEngineControlBusy("idle")).toBe(false);
    expect(isEngineControlBusy("stopped")).toBe(false);
  });
});
