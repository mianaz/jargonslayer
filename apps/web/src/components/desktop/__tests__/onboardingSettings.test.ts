// Pure-logic coverage for onboardingSettings.ts — deliberately free of
// any dependency on connectOpenRouterDesktop/openExternal (S10 Chunk
// A's not-yet-written modules), unlike OnboardingByokStep.render.test.tsx
// / OnboardingDiarizeStep.render.test.tsx (same dir), which import the
// real step components and therefore can't resolve until those two
// modules exist — see this worker's own report for the full rationale.

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import { buildByokKeyPatch, buildHfTokenPatch, describeOAuthFailure } from "../onboardingSettings";

describe("buildByokKeyPatch", () => {
  it("trims and returns the EXACT settings shape the web OAuth callback writes (provider/baseUrl/apiKey), unchanged when the current models are already slash-shaped", () => {
    expect(
      buildByokKeyPatch("  sk-or-abc123  ", {
        detectModel: "deepseek/deepseek-v4-flash",
        summaryModel: "deepseek/deepseek-v4-pro",
      }),
    ).toEqual({
      provider: "openai-compat",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-abc123",
    });
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(buildByokKeyPatch("", DEFAULT_SETTINGS)).toBeNull();
    expect(buildByokKeyPatch("   ", DEFAULT_SETTINGS)).toBeNull();
  });

  // R4 field fix (v0.4.4): this onboarding paste-key path was the one
  // OpenRouter-completion site that never remapped a bare Anthropic-
  // flavored detectModel/summaryModel — mirrors both REAL sites
  // (openrouterDesktop.ts's connectOpenRouterDesktopWith,
  // app/oauth/openrouter/page.tsx's handleConnect effect), which both
  // already spread remapOpenRouterModelDefaults(currentSettings)
  // alongside the identical provider/baseUrl/apiKey write.
  it("R4: remaps bare legacy (pre-fix) detectModel/summaryModel to the DeepSeek OpenRouter defaults", () => {
    const patch = buildByokKeyPatch("sk-or-abc123", {
      detectModel: "claude-haiku-4-5",
      summaryModel: "claude-sonnet-5",
    });
    expect(patch).toEqual({
      provider: "openai-compat",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-abc123",
      detectModel: "deepseek/deepseek-v4-flash",
      summaryModel: "deepseek/deepseek-v4-pro",
    });
  });

  it("R4: never touches a user's own deliberate custom OpenRouter slug", () => {
    const patch = buildByokKeyPatch("sk-or-abc123", {
      detectModel: "openai/gpt-5.4",
      summaryModel: "anthropic/claude-opus-4.8",
    });
    expect(patch).toEqual({
      provider: "openai-compat",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-abc123",
    });
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
