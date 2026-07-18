// @vitest-environment jsdom
//
// v0.4.5 ambient AI-status surface (docs/design-explorations/
// v045-ai-transparency-qc.md, Part A). createRoot/act pattern, no
// @testing-library/react in this repo's test stack (mirrors
// StatusLine.test.tsx / SettingsDialog.test.tsx).

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "../../lib/store";
import { recordLlmCall, recordLlmQcDrop, resetLlmTelemetry } from "../../lib/llm/telemetry";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import AiStatusPanel, {
  AI_STATUS_ERROR_KIND_LABEL,
  AI_STATUS_ZERO_CONFIG_BANNER,
  describeRouting,
} from "../AiStatusPanel";

function resetStore() {
  useApp.setState((s) => ({ settings: { ...DEFAULT_SETTINGS } }));
  resetLlmTelemetry();
}

describe("AiStatusPanel", () => {
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
    resetStore();
  });

  function render() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  function dot(domain: string): HTMLElement {
    const el = container!.querySelector(`[data-testid="ai-status-dot-${domain}"]`);
    if (!el) throw new Error(`dot for ${domain} not found`);
    return el as HTMLElement;
  }

  function row(domain: string): HTMLElement {
    const el = container!.querySelector(`[data-testid="ai-status-row-${domain}"]`);
    if (!el) throw new Error(`row for ${domain} not found`);
    return el as HTMLElement;
  }

  it("renders all 4 rows (检测/解释/翻译/报告) with the resolved provider + model", async () => {
    useApp.setState((s) => ({
      settings: {
        ...s.settings,
        provider: "anthropic",
        apiKey: "sk-test",
        detectModel: "claude-haiku-4-5",
        summaryModel: "claude-sonnet-5",
      },
    }));
    render();
    await act(async () => {
      root!.render(<AiStatusPanel />);
    });

    expect(row("detect").textContent).toContain("Anthropic");
    expect(row("detect").textContent).toContain("claude-haiku-4-5");
    expect(row("define").textContent).toContain("claude-haiku-4-5");
    expect(row("define").textContent).toContain("与检测共用配置");
    // translate has no top-level model of its own — inherits detectModel
    // absent an enabled taskLlm.translate override (taskConfig.ts R1).
    expect(row("translate").textContent).toContain("claude-haiku-4-5");
    expect(row("summary").textContent).toContain("claude-sonnet-5");
    expect(row("summary").textContent).toContain("内部分 3 步：摘要 / 翻译 / 补充扫描");
  });

  it("grey dot + 尚未调用 when a domain was never called", async () => {
    render();
    await act(async () => {
      root!.render(<AiStatusPanel />);
    });

    expect(dot("detect").className).toContain("bg-mut2");
  });

  it("green dot after a recorded success", async () => {
    recordLlmCall("detect", "ok");
    render();
    await act(async () => {
      root!.render(<AiStatusPanel />);
    });

    expect(dot("detect").className).toContain("bg-lab-green");
  });

  it("amber dot after a REAL failure (ratelimit/upstream)", async () => {
    recordLlmCall("translate", { kind: "ratelimit" });
    render();
    await act(async () => {
      root!.render(<AiStatusPanel />);
    });

    expect(dot("translate").className).toContain("bg-lab-orange");
  });

  // The whole point of deriveHealthStatus's 3-state collapse: client.ts
  // DOES call recordLlmCall(domain, {kind:"nokey"}) for a keyless full/
  // desktop row (verified against client.ts directly) — this must still
  // render GREY, not amber/red, per the owner's ruling (a designed
  // dictionary degrade, not a fault).
  it("keyless detect (a real recorded nokey 'failure') renders GREY, not amber/red", async () => {
    useApp.setState((s) => ({ settings: { ...s.settings, apiKey: "" } }));
    recordLlmCall("detect", { kind: "nokey" });
    render();
    await act(async () => {
      root!.render(<AiStatusPanel />);
    });

    expect(dot("detect").className).toContain("bg-mut2");
    expect(dot("detect").className).not.toContain("bg-lab-orange");
    // The per-session count/reason line stays honest regardless of the
    // dot's grey collapse — it did record one failed call.
    expect(row("detect").textContent).toContain("失败 1");
    expect(row("detect").textContent).toContain(AI_STATUS_ERROR_KIND_LABEL.nokey);
  });

  it("per-session counts (calls/failures/qcDropped) + lastErrorKind render", async () => {
    recordLlmCall("summary", "ok");
    recordLlmCall("summary", "ok");
    recordLlmCall("summary", { kind: "upstream" });
    recordLlmQcDrop("summary", 3);
    render();
    await act(async () => {
      root!.render(<AiStatusPanel />);
    });

    const text = row("summary").textContent ?? "";
    expect(text).toContain("调用 3");
    expect(text).toContain("失败 1");
    expect(text).toContain("QC 丢弃 3");
    expect(text).toContain(AI_STATUS_ERROR_KIND_LABEL.upstream);
  });

  it("zero-config banner shows the full/desktop keyless copy when apiKey is empty (ambient test env is not preview tier)", async () => {
    useApp.setState((s) => ({ settings: { ...s.settings, apiKey: "" } }));
    render();
    await act(async () => {
      root!.render(<AiStatusPanel />);
    });

    const banner = container!.querySelector('[data-testid="ai-status-zero-config-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toBe(AI_STATUS_ZERO_CONFIG_BANNER.keyless);
  });

  it("no zero-config banner once an apiKey is set", async () => {
    useApp.setState((s) => ({ settings: { ...s.settings, apiKey: "sk-real" } }));
    render();
    await act(async () => {
      root!.render(<AiStatusPanel />);
    });

    expect(container!.querySelector('[data-testid="ai-status-zero-config-banner"]')).toBeNull();
  });

  // F6 (Sol+Opus review, MINOR): the banner used to gate on the primary
  // settings.apiKey alone — a user who left it empty but set a
  // per-task override (taskLlm.translate here) has that row correctly
  // resolve to a key (自带 Key), so the banner must not claim
  // translation/report are unavailable. Derived from resolveTaskCreds
  // across every row instead.
  it("no zero-config banner when the primary key is empty but a per-task key is set", async () => {
    useApp.setState((s) => ({
      settings: {
        ...s.settings,
        apiKey: "",
        taskLlm: { ...s.settings.taskLlm, translate: { enabled: true, apiKey: "sk-task-only" } },
      },
    }));
    render();
    await act(async () => {
      root!.render(<AiStatusPanel />);
    });

    expect(container!.querySelector('[data-testid="ai-status-zero-config-banner"]')).toBeNull();
    expect(row("translate").textContent).toContain("自带 Key");
  });
});

// ---------------------------------------------------------------
// describeRouting tier-awareness. PREVIEW_TIER (lib/deployTier.ts) is a
// module-level `const` frozen at import time from process.env.
// NEXT_PUBLIC_DEPLOY_TIER — same constraint SettingsDialog.test.tsx's own
// data-ui-level completeness test and engineOptions.test.ts document
// (a runtime vi.stubEnv can't flip an already-evaluated const). Unlike
// those, this exercises the PREVIEW branch for real via vi.resetModules
// + a dynamic re-import done AFTER setting the env var (mirrors
// nextConfigDesktopFlag.test.ts's identical technique for an env-gated
// module) — vitest evaluates deployTier.ts as plain source (no webpack
// DefinePlugin inlining the way a real Next.js production build does),
// so a fresh module instance genuinely re-reads process.env.
// ---------------------------------------------------------------

describe("AiStatusPanel — describeRouting is tier-aware", () => {
  const originalTier = process.env.NEXT_PUBLIC_DEPLOY_TIER;

  afterEach(() => {
    if (originalTier === undefined) delete process.env.NEXT_PUBLIC_DEPLOY_TIER;
    else process.env.NEXT_PUBLIC_DEPLOY_TIER = originalTier;
    vi.resetModules();
  });

  it("full/desktop tier (this file's own ordinary static import, ambient env): empty key -> 未配置 Key", () => {
    expect(describeRouting("")).toBe("未配置 Key");
  });

  it("preview tier (dynamic re-import under NEXT_PUBLIC_DEPLOY_TIER=preview): empty key -> 服务端代理（体验版）", async () => {
    process.env.NEXT_PUBLIC_DEPLOY_TIER = "preview";
    vi.resetModules();
    const mod = await import("../AiStatusPanel");
    expect(mod.describeRouting("")).toBe("服务端代理（体验版）");
  });

  it("a present apiKey always wins regardless of tier -> 自带 Key", () => {
    expect(describeRouting("sk-real")).toBe("自带 Key");
  });
});
