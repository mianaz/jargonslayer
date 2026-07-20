// @vitest-environment jsdom
//
// v0.5 Wave-1 Features 1+2 (TranscriptPanel header: selection-mode bulk
// assign, live latch visibility, AI 校正 button gating — docs/design-
// explorations/v05-wave1-blueprint.md §1 F1/F2). Real zustand store
// (LookupPopover.defineModel.test.tsx's precedent) — CorrectionReview's
// own client-transport call is mocked so this file never needs a real
// network layer; F2's actual review-surface behavior is covered by
// CorrectionReview.test.tsx instead.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/llm/client", () => ({
  correctApi: vi.fn().mockResolvedValue({ corrections: [] }),
  translateApi: vi.fn().mockResolvedValue({ translations: [] }),
  NoKeyError: class NoKeyError extends Error {},
  RateLimitApiError: class RateLimitApiError extends Error {},
  UpstreamError: class UpstreamError extends Error {},
}));

import { useApp } from "@/lib/store";
import { DEFAULT_SETTINGS, type Settings, type TranscriptSegment } from "@jargonslayer/core/types";
import TranscriptPanel from "../TranscriptPanel";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

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

describe("TranscriptPanel — selection mode / bulk assign / live latch / AI 校正 gating", () => {
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
    useApp.setState({
      segments: [],
      speakerRoster: [],
      activeSpeaker: null,
      status: "idle",
      settings: DEFAULT_SETTINGS,
      correctionBusy: false,
    });
  });

  async function renderPanel() {
    await act(async () => {
      root!.render(<TranscriptPanel />);
    });
  }

  // ---------------- selection mode + bulk assign ----------------

  it("选择 toggle enters selection mode (checkboxes appear) and exiting clears any selection", async () => {
    useApp.setState({
      segments: [seg({ id: "s1" }), seg({ id: "s2" })],
      status: "stopped",
      settings: makeSettings(),
    });
    await renderPanel();

    expect(container!.querySelector('[data-testid="segment-select-s1"]')).toBeNull();

    const toggleBtn = container!.querySelector('[data-testid="btn-select-mode"]') as HTMLButtonElement;
    await act(async () => toggleBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const cb1 = container!.querySelector('[data-testid="segment-select-s1"]') as HTMLInputElement;
    expect(cb1).toBeTruthy();

    await act(async () => cb1.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect((container!.querySelector('[data-testid="segment-select-s1"]') as HTMLInputElement).checked).toBe(
      true,
    );

    // Exit selection mode — checkboxes disappear.
    await act(async () => toggleBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container!.querySelector('[data-testid="segment-select-s1"]')).toBeNull();
  });

  it("bulk assign via 指派给… calls assignSegmentsSpeaker(selectedIds, name) and exits selection mode after", async () => {
    useApp.setState({
      segments: [seg({ id: "s1" }), seg({ id: "s2" }), seg({ id: "s3" })],
      speakerRoster: ["Alice"],
      status: "stopped",
      settings: makeSettings(),
    });
    await renderPanel();

    await act(async () =>
      (container!.querySelector('[data-testid="btn-select-mode"]') as HTMLButtonElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      ),
    );
    await act(async () =>
      (container!.querySelector('[data-testid="segment-select-s1"]') as HTMLInputElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      ),
    );
    await act(async () =>
      (container!.querySelector('[data-testid="segment-select-s3"]') as HTMLInputElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      ),
    );

    const bulkBtn = container!.querySelector('[data-testid="btn-bulk-assign"]') as HTMLButtonElement;
    expect(bulkBtn.disabled).toBe(false);
    await act(async () => bulkBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const pickBtn = container!.querySelector('[data-testid="speaker-assign-pick-Alice"]') as HTMLButtonElement;
    expect(pickBtn).toBeTruthy();
    // Bulk request has no `single` — following/rename-all extras absent.
    expect(container!.querySelector('[data-testid="speaker-assign-following-Alice"]')).toBeNull();
    await act(async () => pickBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const segments = useApp.getState().segments;
    expect(segments.find((s) => s.id === "s1")?.speaker).toBe("Alice");
    expect(segments.find((s) => s.id === "s2")?.speaker).toBeUndefined();
    expect(segments.find((s) => s.id === "s3")?.speaker).toBe("Alice");

    // Selection mode exited — checkboxes gone.
    expect(container!.querySelector('[data-testid="segment-select-s1"]')).toBeNull();
    expect(container!.querySelector('[data-testid="btn-select-mode"]')?.textContent).toBe("选择");
  });

  // ---------------- live latch visibility gating ----------------

  it("latch picker shows while listening with no diarized speakers", async () => {
    useApp.setState({ segments: [seg({ id: "s1" })], status: "listening", settings: makeSettings() });
    await renderPanel();
    expect(container!.querySelector('[data-testid="active-speaker-latch"]')).toBeTruthy();
  });

  it("latch picker hidden when not listening (e.g. stopped)", async () => {
    useApp.setState({ segments: [seg({ id: "s1" })], status: "stopped", settings: makeSettings() });
    await renderPanel();
    expect(container!.querySelector('[data-testid="active-speaker-latch"]')).toBeNull();
  });

  it("latch picker hidden while listening once a diarized (non-manual) speaker is present", async () => {
    useApp.setState({
      segments: [seg({ id: "s1", speaker: "SPEAKER_1" })],
      status: "listening",
      settings: makeSettings(),
    });
    await renderPanel();
    expect(container!.querySelector('[data-testid="active-speaker-latch"]')).toBeNull();
  });

  it("latch picker still shows while listening when the only speaker present is a MANUAL (locked) assignment", async () => {
    useApp.setState({
      segments: [seg({ id: "s1", speaker: "Alice", speakerLocked: true })],
      status: "listening",
      settings: makeSettings(),
    });
    await renderPanel();
    expect(container!.querySelector('[data-testid="active-speaker-latch"]')).toBeTruthy();
  });

  it("+ 新建… in the latch picker calls addSpeakerToRoster and setActiveSpeaker with the resolved name", async () => {
    useApp.setState({ segments: [seg({ id: "s1" })], status: "listening", settings: makeSettings() });
    await renderPanel();

    const select = container!.querySelector('[data-testid="active-speaker-latch"]') as HTMLSelectElement;
    select.value = "__new__";
    await act(async () => select.dispatchEvent(new Event("change", { bubbles: true })));

    expect(useApp.getState().activeSpeaker).toBe("说话人 1");
    expect(useApp.getState().speakerRoster).toContain("说话人 1");
  });

  // ---------------- AI 校正 button gating ----------------

  it("AI 校正 button hidden when status !== stopped even with a key configured", async () => {
    useApp.setState({
      segments: [seg({ id: "s1" })],
      status: "listening",
      settings: makeSettings({ apiKey: "byok-key" }),
    });
    await renderPanel();
    expect(container!.querySelector('[data-testid="btn-ai-correct"]')).toBeNull();
  });

  it("AI 校正 button hidden when stopped but no key is configured (full-tier, non-preview test env)", async () => {
    useApp.setState({
      segments: [seg({ id: "s1" })],
      status: "stopped",
      settings: makeSettings({ apiKey: "", provider: "anthropic" }),
    });
    await renderPanel();
    expect(container!.querySelector('[data-testid="btn-ai-correct"]')).toBeNull();
  });

  it("AI 校正 button shown when stopped with a top-level apiKey configured", async () => {
    useApp.setState({
      segments: [seg({ id: "s1" })],
      status: "stopped",
      settings: makeSettings({ apiKey: "byok-key" }),
    });
    await renderPanel();
    expect(container!.querySelector('[data-testid="btn-ai-correct"]')).toBeTruthy();
  });

  it("AI 校正 button shown when stopped with only a per-domain (detect) taskLlm override key — resolveTaskCreds, not the raw settings.apiKey field", async () => {
    useApp.setState({
      segments: [seg({ id: "s1" })],
      status: "stopped",
      settings: makeSettings({
        apiKey: "",
        taskLlm: { detect: { enabled: true, apiKey: "detect-only-key" } },
      }),
    });
    await renderPanel();
    expect(container!.querySelector('[data-testid="btn-ai-correct"]')).toBeTruthy();
  });

  it("AI 校正 button hidden when there are no segments even if stopped + configured", async () => {
    useApp.setState({ segments: [], status: "stopped", settings: makeSettings({ apiKey: "byok-key" }) });
    await renderPanel();
    expect(container!.querySelector('[data-testid="btn-ai-correct"]')).toBeNull();
  });
});
