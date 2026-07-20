// @vitest-environment jsdom
//
// R5 (Sol F4): the 文稿 (text-import) completion toast used to render
// ONLY warnings[0] — importTranscriptText's own `warnings` array is
// parser warnings FIRST, with any later translate/AI-detect warning
// pushed on afterward (see importText.ts's importTranscriptText: `const
// warnings = [...parsed.warnings]` then later pushes) — so a parser
// warning silently hid a later AI-detect warning. Ruling: render every
// UNIQUE warning joined with "；", capped at 2, with an "等 N 条提示"
// suffix once there are more than that.
//
// Mocks @/lib/store (settings/loadSession/showToast/hydrate) and
// @/lib/ingest/importText's importTranscriptText (so this test controls
// exactly which warnings resolve, rather than driving the real parser/
// detect/translate pipeline) + @/lib/stt/upload (sidecar-health probe
// the mount effect fires regardless of active tab). @/lib/tasks/registry
// (runTrackedAsync) and @/lib/ingest/parseTranscript (the live preview)
// are left REAL — this is exercising the toast-building logic in
// handleConfirmText, not registry/parser internals.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";

const mockShowToast = vi.fn();
const mockLoadSession = vi.fn(async (_id: string) => {});
const mockHydrate = vi.fn(async () => {});
const storeState = {
  settings: { ...DEFAULT_SETTINGS },
  loadSession: (id: string) => mockLoadSession(id),
  showToast: (msg: string) => mockShowToast(msg),
  hydrate: () => mockHydrate(),
};
vi.mock("@/lib/store", () => {
  const useApp = ((selector: (s: typeof storeState) => unknown) => selector(storeState)) as unknown as {
    (selector: (s: typeof storeState) => unknown): unknown;
    getState: () => typeof storeState;
  };
  useApp.getState = () => storeState;
  return { useApp };
});

vi.mock("@/lib/stt/upload", () => ({
  fetchSidecarHealth: async () => null,
  importAndTrack: vi.fn(),
  importUrlAndTrack: vi.fn(),
  withSidecarHint: (msg: string) => msg,
}));

const mockImportTranscriptText = vi.fn();
vi.mock("@/lib/ingest/importText", () => ({
  importTranscriptText: (...args: unknown[]) => mockImportTranscriptText(...args),
}));

import { useTasks } from "@/lib/tasks/registry";
import ImportHub from "../ImportHub";

const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype,
  "value",
)!.set!;
function typeInto(el: HTMLTextAreaElement, value: string) {
  nativeTextareaValueSetter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ImportHub — 文稿 completion toast renders every unique warning, not just warnings[0]", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mockShowToast.mockReset();
    mockLoadSession.mockReset().mockResolvedValue(undefined);
    mockHydrate.mockReset().mockResolvedValue(undefined);
    mockImportTranscriptText.mockReset();
    useTasks.setState({ tasks: {} });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root!.unmount());
    container!.remove();
    container = null;
    root = null;
    useTasks.setState({ tasks: {} });
  });

  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350)); // clears the 300ms parse debounce
    });
  }

  function findNavButton(label: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === label);
    if (!btn) throw new Error(`tab button "${label}" not found`);
    return btn as HTMLButtonElement;
  }

  async function stageValidTranscript(): Promise<void> {
    await act(async () => {
      findNavButton("文稿").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const textarea = container!.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      typeInto(textarea, "Alice: 今天我们同步一下 ARR 目标\nBob: 好的，没问题");
    });
    await flush();
  }

  it("both a parser warning AND a later AI-detect warning are shown, joined with '；'", async () => {
    mockImportTranscriptText.mockResolvedValue({
      sessionId: "sess-1",
      warnings: ["检测到非标准时间戳格式，已按纯文本解析", "AI 检测未生效：未配置 API Key，本次仅词典检测"],
    });

    await act(async () => {
      root!.render(<ImportHub open={true} onClose={() => {}} />);
    });
    await flush();
    await stageValidTranscript();

    const confirmBtn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "导入并分析",
    ) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);

    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockShowToast).toHaveBeenCalledTimes(1);
    const toastMsg = mockShowToast.mock.calls[0][0] as string;
    expect(toastMsg).toContain("检测到非标准时间戳格式，已按纯文本解析");
    expect(toastMsg).toContain("AI 检测未生效：未配置 API Key，本次仅词典检测");
  });

  it("zero warnings: plain completion message, no trailing content", async () => {
    mockImportTranscriptText.mockResolvedValue({ sessionId: "sess-2", warnings: [] });

    await act(async () => {
      root!.render(<ImportHub open={true} onClose={() => {}} />);
    });
    await flush();
    await stageValidTranscript();

    const confirmBtn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "导入并分析",
    ) as HTMLButtonElement;
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockShowToast).toHaveBeenCalledWith("文稿已导入，分析完成");
  });

  it("more than 2 unique warnings: shows the first 2 plus an '等 N 条提示' suffix (N = total unique count)", async () => {
    mockImportTranscriptText.mockResolvedValue({
      sessionId: "sess-3",
      warnings: ["警告一", "警告二", "警告三"],
    });

    await act(async () => {
      root!.render(<ImportHub open={true} onClose={() => {}} />);
    });
    await flush();
    await stageValidTranscript();

    const confirmBtn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "导入并分析",
    ) as HTMLButtonElement;
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const toastMsg = mockShowToast.mock.calls[0][0] as string;
    expect(toastMsg).toContain("警告一");
    expect(toastMsg).toContain("警告二");
    expect(toastMsg).not.toContain("警告三");
    expect(toastMsg).toContain("等 3 条提示");
  });
});

// S14.1 field fix (item 6): the dialog previously had no backdrop-click
// dismissal and no visible 关闭 affordance — on the 文件 tab's
// pre-staging state (no file picked yet, tested by this file's default
// mount below) there's no footer either, so this was the ONLY state
// with truly zero mouse/touch-reachable way out (Escape existed, but
// is unreachable on iOS Safari). Reuses this file's own module-level
// mocks (@/lib/store, @/lib/stt/upload) — none of these tests reach
// the import pipeline.
describe("ImportHub — dismissal (S14.1 item 6)", () => {
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
  });

  it("clicking the backdrop itself (target === currentTarget) closes the dialog", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root!.render(<ImportHub open={true} onClose={onClose} />);
    });

    const backdrop = container!.firstElementChild as HTMLElement;
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("mousedown that lands INSIDE the panel does not close (a drag ending on the backdrop must not either)", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root!.render(<ImportHub open={true} onClose={onClose} />);
    });

    // "导入" heading text lives inside the panel, not the backdrop —
    // dispatching there means target !== currentTarget on the backdrop.
    const heading = Array.from(container!.querySelectorAll("span")).find(
      (s) => s.textContent === "导入",
    ) as HTMLElement;
    await act(async () => {
      heading.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("the header X button is present even in the 文件 tab's empty (pre-staging) state, and closes on click", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root!.render(<ImportHub open={true} onClose={onClose} />);
    });

    // Empty state: no file staged yet, so the footer's own 取消 button
    // (only rendered once stagedFiles.length > 0) is absent — the X is
    // the only affordance.
    expect(
      Array.from(container!.querySelectorAll("button")).some((b) => b.textContent === "取消"),
    ).toBe(false);

    const closeBtn = container!.querySelector('button[aria-label="关闭"]') as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();

    await act(async () => {
      closeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
