// Pure-logic coverage for onboardingSettings.ts — deliberately free of
// any dependency on connectOpenRouterDesktop/openExternal (S10 Chunk
// A's not-yet-written modules), unlike OnboardingByokStep.render.test.tsx
// / OnboardingDiarizeStep.render.test.tsx (same dir), which import the
// real step components and therefore can't resolve until those two
// modules exist — see this worker's own report for the full rationale.

import { describe, expect, it } from "vitest";
import { buildByokKeyPatch, buildHfTokenPatch, describeOAuthFailure } from "../onboardingSettings";

describe("buildByokKeyPatch", () => {
  it("trims and returns the EXACT settings shape the web OAuth callback writes (provider/baseUrl/apiKey)", () => {
    expect(buildByokKeyPatch("  sk-or-abc123  ")).toEqual({
      provider: "openai-compat",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-abc123",
    });
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(buildByokKeyPatch("")).toBeNull();
    expect(buildByokKeyPatch("   ")).toBeNull();
  });
});

describe("buildHfTokenPatch", () => {
  it("trims and returns { hfToken }", () => {
    expect(buildHfTokenPatch("  hf_abc123  ")).toEqual({ hfToken: "hf_abc123" });
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(buildHfTokenPatch("")).toBeNull();
    expect(buildHfTokenPatch("   ")).toBeNull();
  });
});

describe("describeOAuthFailure", () => {
  it("maps every pinned connectOpenRouterDesktop() failure reason to a zh label, always pointing at the paste field", () => {
    const cases: Record<string, string> = {
      timeout: "连接超时",
      cancelled: "已取消登录",
      "exchange-failed": "换取 Key 失败",
      "port-bind-failed": "本机端口被占用，无法启动登录",
    };
    for (const [reason, label] of Object.entries(cases)) {
      const hint = describeOAuthFailure(reason);
      expect(hint.startsWith(label)).toBe(true);
      expect(hint).toContain("可以在下方粘贴已有的 API Key");
    }
  });

  it("appends an optional message after the label", () => {
    expect(describeOAuthFailure("timeout", "loopback server never received a callback")).toBe(
      "连接超时：loopback server never received a callback，可以在下方粘贴已有的 API Key",
    );
  });

  it("degrades to a generic label for an unrecognized reason rather than throwing", () => {
    expect(describeOAuthFailure("something-new")).toContain("登录失败");
  });
});
