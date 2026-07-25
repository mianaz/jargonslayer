// @vitest-environment jsdom
//
// UsagePanel — props-driven render states. createRoot/act pattern (no
// @testing-library/react in this repo's test stack — see
// AnkiConnectSection.test.tsx's own header comment, which this mirrors).
// lib/usage/ledger's impure getUsage/clearUsage are mocked so this file
// controls exactly what's "recorded" without touching IndexedDB; the
// PURE summarizeUsage/dateKeyDaysAgo/dateKey run for real (already unit-
// tested directly in usage/__tests__/ledger.test.ts) so this file stays
// focused on rendering/wiring, not re-proving the aggregation math.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { UsageRecord } from "@/lib/usage/ledger";

const getUsageMock = vi.fn<() => Promise<UsageRecord[]>>();
const clearUsageMock = vi.fn<() => Promise<void>>();
vi.mock("@/lib/usage/ledger", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usage/ledger")>("@/lib/usage/ledger");
  return {
    ...actual,
    getUsage: () => getUsageMock(),
    clearUsage: () => clearUsageMock(),
  };
});

import UsagePanel from "../UsagePanel";
import { dateKey } from "@/lib/usage/ledger";

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const TODAY = dateKey(new Date());

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return { day: TODAY, provider: "soniox", kind: "stt", metric: "seconds", value: 600, ...overrides };
}

describe("UsagePanel", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    getUsageMock.mockReset();
    clearUsageMock.mockReset();
  });

  async function mount(value: boolean, onChange: (v: boolean) => void) {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<UsagePanel value={value} onChange={onChange} />));
    await flush();
    return container;
  }

  it("renders the toggle reflecting `value` and forwards a click to onChange — props-driven, never mutated locally", async () => {
    getUsageMock.mockResolvedValue([]);
    const onChange = vi.fn();
    const el = await mount(true, onChange);

    const toggle = el.querySelector('button[role="switch"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("shows an honest empty state when nothing has ever been recorded, with no clear button", async () => {
    getUsageMock.mockResolvedValue([]);
    const el = await mount(true, () => {});

    expect(el.querySelector('[data-testid="usage-panel-empty"]')).not.toBeNull();
    expect(Array.from(el.querySelectorAll("button")).some((b) => b.textContent?.includes("清除使用记录"))).toBe(
      false,
    );
  });

  it("renders per-provider 7-day/30-day totals (STT minutes; LLM calls + tokens) and the covered date range", async () => {
    getUsageMock.mockResolvedValue([
      record({ provider: "soniox", kind: "stt", metric: "seconds", value: 600 }), // 10 minutes
      record({ provider: "openrouter.ai", kind: "llm", metric: "calls", value: 5 }),
      record({ provider: "openrouter.ai", kind: "llm", metric: "inputTokens", value: 2000 }),
      record({ provider: "openrouter.ai", kind: "llm", metric: "outputTokens", value: 300 }),
    ]);
    const el = await mount(true, () => {});

    expect(el.querySelector('[data-testid="usage-panel-empty"]')).toBeNull();
    expect(el.textContent).toContain("记录范围");
    expect(el.textContent).toContain(TODAY);
    expect(el.textContent).toContain("soniox");
    expect(el.textContent).toContain("语音识别 10.0 分钟");
    expect(el.textContent).toContain("openrouter.ai");
    expect(el.textContent).toContain("调用 5 次");
    expect(el.textContent).toContain("2,000");
    expect(el.textContent).toContain("300");
    expect(el.textContent).toContain("近 7 天");
    expect(el.textContent).toContain("近 30 天");
  });

  it("off (value=false) still shows existing history alongside the 已关闭 hint", async () => {
    getUsageMock.mockResolvedValue([record()]);
    const el = await mount(false, () => {});

    expect(el.textContent).toContain("已关闭");
    expect(el.textContent).toContain("soniox");
  });

  it("清除使用记录 requires a second click to confirm, then calls clearUsage() and reloads", async () => {
    getUsageMock.mockResolvedValue([record()]);
    const el = await mount(true, () => {});

    const clearBtn = () =>
      Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.includes("清除"))!;

    await act(async () => {
      clearBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(clearBtn().textContent).toBe("确认清除？");
    expect(clearUsageMock).not.toHaveBeenCalled();

    clearUsageMock.mockResolvedValue(undefined);
    getUsageMock.mockResolvedValue([]); // what the reload after clearing should see
    await act(async () => {
      clearBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(clearUsageMock).toHaveBeenCalledTimes(1);
    expect(getUsageMock).toHaveBeenCalledTimes(2); // initial load + post-clear reload
    expect(el.querySelector('[data-testid="usage-panel-empty"]')).not.toBeNull();
  });
});
