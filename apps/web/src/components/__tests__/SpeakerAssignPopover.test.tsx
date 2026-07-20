// @vitest-environment jsdom
//
// v0.5 Wave-1 Feature 1 (per-segment speaker assignment, docs/design-
// explorations/v05-wave1-blueprint.md §1 Feature 1 + §5 A2). Exercises
// the REAL zustand store (mirrors LookupPopover.defineModel.test.tsx's
// own precedent for this pattern) — no mocks, since every action here
// is a pure store mutation, no network call.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "@/lib/store";
import type { TranscriptSegment } from "@jargonslayer/core/types";
import SpeakerAssignPopover, { type SpeakerAssignRequest } from "../SpeakerAssignPopover";

function seg(overrides: Partial<TranscriptSegment> & { id: string }): TranscriptSegment {
  return {
    index: 0,
    startedAt: 0,
    endedAt: 0,
    text: "hello",
    engine: "demo",
    ...overrides,
  };
}

describe("SpeakerAssignPopover", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root!.unmount());
    container!.remove();
    container = null;
    root = null;
    useApp.setState({ segments: [], speakerRoster: [], activeSpeaker: null });
  });

  async function render(request: SpeakerAssignRequest, extraProps: Partial<Parameters<typeof SpeakerAssignPopover>[0]> = {}) {
    const onClose = vi.fn();
    const onRenameAll = vi.fn();
    const onAssigned = extraProps.onAssigned;
    await act(async () => {
      root!.render(
        <SpeakerAssignPopover
          request={request}
          onClose={onClose}
          onRenameAll={onRenameAll}
          onAssigned={onAssigned}
        />,
      );
    });
    return { onClose, onRenameAll };
  }

  it("picking an existing roster name calls assignSegmentsSpeaker with a one-element array and closes", async () => {
    useApp.setState({
      segments: [seg({ id: "s1" })],
      speakerRoster: ["Alice", "Bob"],
    });
    const { onClose } = await render({
      segmentIds: ["s1"],
      single: { currentSpeaker: undefined, speakerLocked: false },
      x: 10,
      y: 10,
    });

    const btn = container!.querySelector('[data-testid="speaker-assign-pick-Alice"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    await act(async () => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(useApp.getState().segments.find((s) => s.id === "s1")?.speaker).toBe("Alice");
    expect(useApp.getState().segments.find((s) => s.id === "s1")?.speakerLocked).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("新建说话人 auto-numbers via addSpeakerToRoster and assigns the resolved name", async () => {
    useApp.setState({ segments: [seg({ id: "s1" })], speakerRoster: ["说话人 1"] });
    await render({ segmentIds: ["s1"], single: { currentSpeaker: undefined, speakerLocked: false }, x: 0, y: 0 });

    const btn = container!.querySelector('[data-testid="speaker-assign-new"]') as HTMLButtonElement;
    await act(async () => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    // 说话人 1 already taken -> auto-numbers to 说话人 2.
    expect(useApp.getState().speakerRoster).toContain("说话人 2");
    expect(useApp.getState().segments.find((s) => s.id === "s1")?.speaker).toBe("说话人 2");
  });

  it("应用到本句及之后 (following) calls assignSpeakerFollowing, not the bulk assign path", async () => {
    useApp.setState({
      segments: [seg({ id: "s1", index: 0 }), seg({ id: "s2", index: 1 }), seg({ id: "s3", index: 2 })],
      speakerRoster: ["Alice"],
    });
    await render({ segmentIds: ["s2"], single: { currentSpeaker: undefined, speakerLocked: false }, x: 0, y: 0 });

    const btn = container!.querySelector('[data-testid="speaker-assign-following-Alice"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    await act(async () => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const segments = useApp.getState().segments;
    expect(segments.find((s) => s.id === "s1")?.speaker).toBeUndefined();
    expect(segments.find((s) => s.id === "s2")?.speaker).toBe("Alice");
    expect(segments.find((s) => s.id === "s3")?.speaker).toBe("Alice");
  });

  it("跟随识别 (unlock) is shown only when request.single.speakerLocked, and calls unlockSegmentSpeaker", async () => {
    useApp.setState({
      segments: [seg({ id: "s1", speaker: "Alice", speakerLocked: true, sttSpeaker: "SPEAKER_1" })],
      speakerRoster: ["Alice"],
      speakerAliases: { SPEAKER_1: "识别到的名字" },
    });
    await render({
      segmentIds: ["s1"],
      single: { currentSpeaker: "Alice", speakerLocked: true },
      x: 0,
      y: 0,
    });

    const btn = container!.querySelector('[data-testid="speaker-assign-unlock"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    await act(async () => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const s1 = useApp.getState().segments.find((s) => s.id === "s1");
    expect(s1?.speakerLocked).toBe(false);
    expect(s1?.speaker).toBe("识别到的名字");
  });

  it("跟随识别 is absent when request.single.speakerLocked is false", async () => {
    useApp.setState({ segments: [seg({ id: "s1", speaker: "Alice" })], speakerRoster: ["Alice"] });
    await render({ segmentIds: ["s1"], single: { currentSpeaker: "Alice", speakerLocked: false }, x: 0, y: 0 });

    expect(container!.querySelector('[data-testid="speaker-assign-unlock"]')).toBeNull();
  });

  it("重命名该说话人的所有发言 calls onRenameAll with the current speaker, without mutating the store itself", async () => {
    useApp.setState({ segments: [seg({ id: "s1", speaker: "Alice" })], speakerRoster: ["Alice"] });
    const { onRenameAll } = await render({
      segmentIds: ["s1"],
      single: { currentSpeaker: "Alice", speakerLocked: false },
      x: 42,
      y: 84,
    });

    const btn = container!.querySelector('[data-testid="speaker-assign-rename-all"]') as HTMLButtonElement;
    await act(async () => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onRenameAll).toHaveBeenCalledWith("Alice", 42, 84);
    // Rename-all itself is the EXISTING renameSpeaker path, not this
    // popover's job — the segment's speaker is untouched here.
    expect(useApp.getState().segments.find((s) => s.id === "s1")?.speaker).toBe("Alice");
  });

  it("重命名该说话人的所有发言 is absent when the segment has no current speaker (the '+ 说话人' affordance case)", async () => {
    useApp.setState({ segments: [seg({ id: "s1" })], speakerRoster: [] });
    await render({ segmentIds: ["s1"], single: { currentSpeaker: undefined, speakerLocked: false }, x: 0, y: 0 });

    expect(container!.querySelector('[data-testid="speaker-assign-rename-all"]')).toBeNull();
  });

  it("bulk request (no `single`) omits following/unlock/rename-all, and assigns ALL segmentIds", async () => {
    useApp.setState({
      segments: [seg({ id: "s1" }), seg({ id: "s2" }), seg({ id: "s3" })],
      speakerRoster: ["Alice"],
    });
    const onAssigned = vi.fn();
    await render({ segmentIds: ["s1", "s3"], x: 0, y: 0 }, { onAssigned });

    expect(container!.querySelector('[data-testid="speaker-assign-following-Alice"]')).toBeNull();
    expect(container!.querySelector('[data-testid="speaker-assign-unlock"]')).toBeNull();
    expect(container!.querySelector('[data-testid="speaker-assign-rename-all"]')).toBeNull();

    const btn = container!.querySelector('[data-testid="speaker-assign-pick-Alice"]') as HTMLButtonElement;
    await act(async () => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const segments = useApp.getState().segments;
    expect(segments.find((s) => s.id === "s1")?.speaker).toBe("Alice");
    expect(segments.find((s) => s.id === "s2")?.speaker).toBeUndefined();
    expect(segments.find((s) => s.id === "s3")?.speaker).toBe("Alice");
    expect(onAssigned).toHaveBeenCalledTimes(1);
  });

  it("onAssigned fires on any successful assign when the caller supplies it, single or bulk — it's the CALLER's job (TranscriptPanel only passes it in select mode) to decide whether that's meaningful, not this component's", async () => {
    useApp.setState({ segments: [seg({ id: "s1" })], speakerRoster: ["Alice"] });
    const onAssigned = vi.fn();
    await render(
      { segmentIds: ["s1"], single: { currentSpeaker: undefined, speakerLocked: false }, x: 0, y: 0 },
      { onAssigned },
    );

    const btn = container!.querySelector('[data-testid="speaker-assign-pick-Alice"]') as HTMLButtonElement;
    await act(async () => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onAssigned).toHaveBeenCalledTimes(1);
  });

  it("onAssigned is simply never invoked when the caller omits it (the real per-segment chip flow's own wiring)", async () => {
    useApp.setState({ segments: [seg({ id: "s1" })], speakerRoster: ["Alice"] });
    await render({ segmentIds: ["s1"], single: { currentSpeaker: undefined, speakerLocked: false }, x: 0, y: 0 });

    const btn = container!.querySelector('[data-testid="speaker-assign-pick-Alice"]') as HTMLButtonElement;
    // No onAssigned prop supplied — asserting there's simply nothing to
    // call (would throw if the component tried to invoke undefined).
    await act(async () => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(useApp.getState().segments.find((s) => s.id === "s1")?.speaker).toBe("Alice");
  });

  it("roster list is the union of the manual roster + unique displayed segment speakers (§5 A2)", async () => {
    useApp.setState({
      segments: [seg({ id: "s1", speaker: "Diarized Name" }), seg({ id: "s2" })],
      speakerRoster: ["Alice"],
    });
    await render({ segmentIds: ["s2"], single: { currentSpeaker: undefined, speakerLocked: false }, x: 0, y: 0 });

    expect(container!.querySelector('[data-testid="speaker-assign-pick-Alice"]')).toBeTruthy();
    expect(container!.querySelector('[data-testid="speaker-assign-pick-Diarized Name"]')).toBeTruthy();
  });

  it("Escape closes the popover", async () => {
    useApp.setState({ segments: [seg({ id: "s1" })], speakerRoster: [] });
    const { onClose } = await render({
      segmentIds: ["s1"],
      single: { currentSpeaker: undefined, speakerLocked: false },
      x: 0,
      y: 0,
    });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
