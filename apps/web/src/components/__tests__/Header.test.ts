// isEngineControlBusy — the shared "meeting is live enough that
// switching engines or opening the import hub would be unsafe" gate
// (#62 item 2). Previously inlined 3x across EnginePillGroup/
// MobileEngineSelect/HamburgerMenu; now one exported pure function so
// the new 导入 pill/button (desktop peer of the engine pills + mobile
// icon button) reuses the exact same gating logic instead of a 4th
// inline copy.

import { describe, expect, it } from "vitest";
import { canPause, isEngineControlBusy } from "../Header";

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

describe("canPause — pause-button availability by engine (B4)", () => {
  it("allows pause only for webspeech — its stop() drains the working tail synchronously", () => {
    expect(canPause("webspeech")).toBe(true);
  });

  it("hides pause for whisper — no stop-drain ack protocol yet (codex review 2026-07-10)", () => {
    expect(canPause("whisper")).toBe(false);
  });

  it("hides pause for tabaudio — resume would have to re-open the OS share picker", () => {
    expect(canPause("tabaudio")).toBe(false);
  });

  it("hides pause for demo — a scripted replay only knows how to restart, not resume", () => {
    expect(canPause("demo")).toBe(false);
  });
});
