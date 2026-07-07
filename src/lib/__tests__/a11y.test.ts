import { describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { handleButtonKeyDown, isActivationKey } from "../a11y";

// Minimal stand-in for React's synthetic KeyboardEvent: a11y.ts only
// reads key/target/currentTarget and calls preventDefault, so a plain
// object suffices — no jsdom, matching the repo's node test env.
function fakeKeyEvent(opts: {
  key: string;
  fromChild?: boolean;
}): KeyboardEvent<HTMLElement> {
  const container = { tag: "container" };
  const child = { tag: "child" };
  return {
    key: opts.key,
    currentTarget: container,
    target: opts.fromChild ? child : container,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent<HTMLElement>;
}

describe("isActivationKey", () => {
  it("treats Enter and Space as activation keys", () => {
    expect(isActivationKey("Enter")).toBe(true);
    expect(isActivationKey(" ")).toBe(true);
  });

  it("ignores every other key (including the legacy 'Spacebar' name)", () => {
    for (const k of ["Tab", "Escape", "a", "ArrowDown", "Spacebar", ""]) {
      expect(isActivationKey(k)).toBe(false);
    }
  });
});

describe("handleButtonKeyDown", () => {
  it("activates and prevents default on Enter", () => {
    const onActivate = vi.fn();
    const e = fakeKeyEvent({ key: "Enter" });
    handleButtonKeyDown(e, onActivate);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("activates and prevents default on Space (suppresses page scroll)", () => {
    const onActivate = vi.fn();
    const e = fakeKeyEvent({ key: " " });
    handleButtonKeyDown(e, onActivate);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("ignores non-activation keys", () => {
    const onActivate = vi.fn();
    const e = fakeKeyEvent({ key: "Tab" });
    handleButtonKeyDown(e, onActivate);
    expect(onActivate).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("does not fire when the key bubbled up from a nested control (e.g. the delete button inside a history row)", () => {
    const onActivate = vi.fn();
    const e = fakeKeyEvent({ key: "Enter", fromChild: true });
    handleButtonKeyDown(e, onActivate);
    expect(onActivate).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
