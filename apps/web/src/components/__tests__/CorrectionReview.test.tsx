// @vitest-environment jsdom
//
// v0.5 Wave-1 Feature 2 (AI transcript correction, batch/review-gated —
// docs/design-explorations/v05-wave1-blueprint.md §1 Feature 2 + §5
// A5). Mocks @/lib/llm/client (network layer) and drives the REAL
// zustand store (LookupPopover.defineModel.test.tsx's own precedent).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

const mockCorrectApi = vi.fn();
const mockTranslateApi = vi.fn();

// vi.mock factories are hoisted above every top-level statement in this
// file (including `const`/`class` declarations) — the error classes
// must be defined INSIDE the factory itself, same as LookupPopover.
// defineModel.test.tsx's own precedent, rather than referenced from an
// outer-scope declaration.
vi.mock("@/lib/llm/client", () => ({
  correctApi: (...args: unknown[]) => mockCorrectApi(...args),
  translateApi: (...args: unknown[]) => mockTranslateApi(...args),
  NoKeyError: class NoKeyError extends Error {
    constructor(message = "未配置 API Key") {
      super(message);
      this.name = "NoKeyError";
    }
  },
  RateLimitApiError: class RateLimitApiError extends Error {
    constructor(message = "请求过于频繁，请稍后重试") {
      super(message);
      this.name = "RateLimitApiError";
    }
  },
  UpstreamError: class UpstreamError extends Error {
    constructor(message = "模型请求失败") {
      super(message);
      this.name = "UpstreamError";
    }
  },
}));

import { useApp } from "@/lib/store";
import { DEFAULT_SETTINGS, type Settings, type TranscriptSegment } from "@jargonslayer/core/types";
import { NoKeyError } from "@/lib/llm/client";
import CorrectionReview from "../CorrectionReview";

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

describe("CorrectionReview", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mockCorrectApi.mockReset();
    mockTranslateApi.mockReset().mockResolvedValue({ translations: [] });
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
      status: "idle",
      settings: DEFAULT_SETTINGS,
      activeSessionId: null,
      translations: {},
      correctionBusy: false,
    });
  });

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function openReview(): Promise<void> {
    await act(async () => {
      root!.render(<CorrectionReview open={true} onClose={() => {}} />);
    });
    await flush();
  }

  // ---------------- changed computation (client-side, trimmed) ----------------

  it("computes `changed` client-side via trimmed inequality — a corrections entry identical (or whitespace-only different) to the original is filtered out, never shown as a row", async () => {
    useApp.setState({
      segments: [
        seg({ id: "s1", text: "scar an seek data" }),
        seg({ id: "s2", text: "  identical text  " }),
        seg({ id: "s3", text: "unchanged" }),
      ],
      status: "stopped",
      settings: makeSettings(),
      activeSessionId: "sess-1",
    });
    mockCorrectApi.mockResolvedValue({
      corrections: [
        { id: "s1", text: "scRNA-seq data" },
        // Model echoed the SAME text but with different surrounding
        // whitespace — trimmed comparison must treat this as unchanged.
        { id: "s2", text: "identical text" },
        { id: "s3", text: "unchanged" },
      ],
    });

    await openReview();

    expect(container!.querySelector('[data-testid="correction-row-s1"]')).toBeTruthy();
    expect(container!.querySelector('[data-testid="correction-row-s2"]')).toBeNull();
    expect(container!.querySelector('[data-testid="correction-row-s3"]')).toBeNull();
  });

  it("shows the empty state when every correction is unchanged", async () => {
    useApp.setState({
      segments: [seg({ id: "s1", text: "fine" })],
      status: "stopped",
      settings: makeSettings(),
      activeSessionId: "sess-1",
    });
    mockCorrectApi.mockResolvedValue({ corrections: [{ id: "s1", text: "fine" }] });

    await openReview();

    expect(container!.textContent).toContain("未发现需要校正的内容");
  });

  // ---------------- accept / ignore / accept-all ----------------

  it("接受 calls the EXISTING updateSegmentText with the proposed text and marks the row accepted", async () => {
    useApp.setState({
      segments: [seg({ id: "s1", text: "scar an seek" })],
      status: "stopped",
      settings: makeSettings(),
      activeSessionId: "sess-1",
    });
    mockCorrectApi.mockResolvedValue({ corrections: [{ id: "s1", text: "scRNA-seq" }] });
    await openReview();

    const acceptBtn = container!.querySelector('[data-testid="correction-accept-s1"]') as HTMLButtonElement;
    await act(async () => acceptBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(useApp.getState().segments.find((s) => s.id === "s1")?.text).toBe("scRNA-seq");
    expect(container!.querySelector('[data-testid="correction-row-s1"]')?.getAttribute("data-status")).toBe(
      "accepted",
    );
  });

  it("忽略 marks the row ignored WITHOUT calling updateSegmentText", async () => {
    useApp.setState({
      segments: [seg({ id: "s1", text: "scar an seek" })],
      status: "stopped",
      settings: makeSettings(),
      activeSessionId: "sess-1",
    });
    mockCorrectApi.mockResolvedValue({ corrections: [{ id: "s1", text: "scRNA-seq" }] });
    await openReview();

    const ignoreBtn = container!.querySelector('[data-testid="correction-ignore-s1"]') as HTMLButtonElement;
    await act(async () => ignoreBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(useApp.getState().segments.find((s) => s.id === "s1")?.text).toBe("scar an seek");
    expect(container!.querySelector('[data-testid="correction-row-s1"]')?.getAttribute("data-status")).toBe(
      "ignored",
    );
  });

  it("全部接受 accepts every pending row in one shot", async () => {
    useApp.setState({
      segments: [seg({ id: "s1", text: "a" }), seg({ id: "s2", text: "b" })],
      status: "stopped",
      settings: makeSettings(),
      activeSessionId: "sess-1",
    });
    mockCorrectApi.mockResolvedValue({
      corrections: [
        { id: "s1", text: "a-fixed" },
        { id: "s2", text: "b-fixed" },
      ],
    });
    await openReview();

    const acceptAllBtn = container!.querySelector('[data-testid="btn-correction-accept-all"]') as HTMLButtonElement;
    expect(acceptAllBtn.disabled).toBe(false);
    await act(async () => acceptAllBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(useApp.getState().segments.find((s) => s.id === "s1")?.text).toBe("a-fixed");
    expect(useApp.getState().segments.find((s) => s.id === "s2")?.text).toBe("b-fixed");
    expect(acceptAllBtn.disabled).toBe(true);
  });

  // ---------------- snapshot-conflict gating (A5) ----------------

  it("acceptance is refused with a 内容已变化 marker when the segment's text no longer matches the review snapshot", async () => {
    useApp.setState({
      segments: [seg({ id: "s1", text: "original" })],
      status: "stopped",
      settings: makeSettings(),
      activeSessionId: "sess-1",
    });
    mockCorrectApi.mockResolvedValue({ corrections: [{ id: "s1", text: "proposed-fix" }] });
    await openReview();

    // Something else edits the segment's text WHILE the review is open
    // (e.g. a manual double-click edit) — the snapshot no longer matches.
    useApp.setState({
      segments: [seg({ id: "s1", text: "edited by something else" })],
    });

    const acceptBtn = container!.querySelector('[data-testid="correction-accept-s1"]') as HTMLButtonElement;
    await act(async () => acceptBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    // The conflicting edit must survive untouched — never clobbered.
    expect(useApp.getState().segments.find((s) => s.id === "s1")?.text).toBe("edited by something else");
    const row = container!.querySelector('[data-testid="correction-row-s1"]');
    expect(row?.getAttribute("data-status")).toBe("conflict");
    expect(row?.textContent).toContain("内容已变化");
  });

  it("acceptance is refused with a conflict marker when the meeting moved on (meetingGen no longer matches)", async () => {
    useApp.setState({
      segments: [seg({ id: "s1", text: "original" })],
      status: "stopped",
      settings: makeSettings(),
      activeSessionId: "sess-1",
      meetingGen: 1,
    });
    mockCorrectApi.mockResolvedValue({ corrections: [{ id: "s1", text: "proposed-fix" }] });
    await openReview();

    // A brand new meeting begins while the review is still open.
    useApp.setState({ meetingGen: 2, segments: [seg({ id: "s1", text: "original" })] });

    const acceptBtn = container!.querySelector('[data-testid="correction-accept-s1"]') as HTMLButtonElement;
    await act(async () => acceptBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(container!.querySelector('[data-testid="correction-row-s1"]')?.getAttribute("data-status")).toBe(
      "conflict",
    );
  });

  // ---------------- one-shot batch retranslate of accepted rows ----------------

  it("accepting a row that HAD an existing translation fires a retranslate through translateApi and applies the result via applyTranslations", async () => {
    useApp.setState({
      segments: [seg({ id: "s1", text: "scar an seek" })],
      status: "stopped",
      settings: makeSettings({ apiKey: "byok-key", explainLanguage: "zh" }),
      activeSessionId: "sess-1",
      translations: { s1: "旧翻译" },
    });
    mockCorrectApi.mockResolvedValue({ corrections: [{ id: "s1", text: "scRNA-seq" }] });
    mockTranslateApi.mockResolvedValue({ translations: [{ id: "s1", text: "新翻译" }] });
    await openReview();

    const acceptBtn = container!.querySelector('[data-testid="correction-accept-s1"]') as HTMLButtonElement;
    await act(async () => acceptBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
    const [body] = mockTranslateApi.mock.calls[0];
    expect(body.segments).toEqual([{ id: "s1", text: "scRNA-seq" }]);
    expect(useApp.getState().translations.s1).toBe("新翻译");
  });

  it("accepting a row that never had a translation does NOT fire translateApi at all (bilingual mode was never on for it)", async () => {
    useApp.setState({
      segments: [seg({ id: "s1", text: "scar an seek" })],
      status: "stopped",
      settings: makeSettings({ apiKey: "byok-key" }),
      activeSessionId: "sess-1",
      translations: {},
    });
    mockCorrectApi.mockResolvedValue({ corrections: [{ id: "s1", text: "scRNA-seq" }] });
    await openReview();

    const acceptBtn = container!.querySelector('[data-testid="correction-accept-s1"]') as HTMLButtonElement;
    await act(async () => acceptBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(mockTranslateApi).not.toHaveBeenCalled();
  });

  it("does not attempt a retranslate at all when no translate-domain key is configured", async () => {
    useApp.setState({
      segments: [seg({ id: "s1", text: "scar an seek" })],
      status: "stopped",
      settings: makeSettings({ apiKey: "" }),
      activeSessionId: "sess-1",
      translations: { s1: "旧翻译" },
    });
    mockCorrectApi.mockResolvedValue({ corrections: [{ id: "s1", text: "scRNA-seq" }] });
    await openReview();

    const acceptBtn = container!.querySelector('[data-testid="correction-accept-s1"]') as HTMLButtonElement;
    await act(async () => acceptBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(mockTranslateApi).not.toHaveBeenCalled();
  });

  // ---------------- error surface ----------------

  it("shows a specific message on NoKeyError", async () => {
    useApp.setState({
      segments: [seg({ id: "s1" })],
      status: "stopped",
      settings: makeSettings(),
      activeSessionId: "sess-1",
    });
    mockCorrectApi.mockRejectedValue(new NoKeyError("未配置 API Key"));
    await openReview();

    expect(container!.textContent).toContain("需要 API Key");
  });
});
