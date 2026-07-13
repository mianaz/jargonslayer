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

// canPause matrix (B4, STT protocol v2): demo -> false; webspeech ->
// true; tabaudio/appaudio -> true (soft pause, no re-picker); whisper ->
// true EXCEPT when realtime diarization is on (seg_id namespace reset on
// reattach would collide with pre-pause diarization ids).
describe("canPause — pause-button availability by engine (B4, STT protocol v2)", () => {
  it("allows pause for webspeech — its stop() drains the working tail synchronously", () => {
    expect(canPause("webspeech", { realtimeDiarize: false })).toBe(true);
    expect(canPause("webspeech", { realtimeDiarize: true })).toBe(true);
  });

  it("allows pause for tabaudio — SOFT pause (wsTransport pauseFeed/resumeFeed), never re-opens the OS share picker", () => {
    expect(canPause("tabaudio", { realtimeDiarize: false })).toBe(true);
    expect(canPause("tabaudio", { realtimeDiarize: true })).toBe(true);
  });

  it("allows pause for appaudio (S9/D7) — SOFT pause too (same wsTransport pauseFeed/resumeFeed), the helper process keeps running untouched", () => {
    expect(canPause("appaudio", { realtimeDiarize: false })).toBe(true);
    expect(canPause("appaudio", { realtimeDiarize: true })).toBe(true);
  });

  it("allows pause for whisper when realtime diarization is OFF", () => {
    expect(canPause("whisper", { realtimeDiarize: false })).toBe(true);
  });

  it("hides pause for whisper when realtime diarization is ON — a teardown reattach resets the sidecar's seg_id namespace", () => {
    expect(canPause("whisper", { realtimeDiarize: true })).toBe(false);
  });

  it("hides pause for demo — a scripted replay only knows how to restart, not resume", () => {
    expect(canPause("demo", { realtimeDiarize: false })).toBe(false);
    expect(canPause("demo", { realtimeDiarize: true })).toBe(false);
  });

  it("hides pause for soniox — SonioxEngine (v0.4 S4) implements no pause()/resume(), teardown-pause fallback via useMeeting instead", () => {
    expect(canPause("soniox", { realtimeDiarize: false })).toBe(false);
    expect(canPause("soniox", { realtimeDiarize: true })).toBe(false);
  });
});
