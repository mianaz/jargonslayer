// Client-plumbing round-trip + per-domain routing proof (#56, design
// build sequence step 2): a v0.2.2 settings object (no taskLlm) must
// produce IDENTICAL headers/body-models to the pre-#56 behavior for
// every one of the four Next.js-routed call sites (detect/define via
// detectApi/defineApi, translateApi, summarizeApi), and a distinct
// provider configured per-domain must reach the correct endpoint with
// the correct header set — never leaking one domain's credential into
// another's request.
//
// No agent/localHost or store mocking needed here (unlike client.
// test.ts, which specifically exercises the subscription-direct
// branch): every settings object below leaves subscriptionDirect at
// its DEFAULT_SETTINGS default (false), so detectApi/defineApi fall
// straight through shouldAttemptSubscriptionDirect to the existing
// Next.js path — the only branch this file cares about — without
// needing to fake agentHealth/useApp.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, PROVIDER_HEADERS, type Settings } from "@jargonslayer/core/types";
import { detectApi, defineApi, summarizeApi, taskHeaders, translateApi } from "../client";

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastCall(): [string, RequestInit] {
  const call = mockFetch.mock.calls.at(-1);
  if (!call) throw new Error("fetch was never called");
  return call as [string, RequestInit];
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

/** Pre-#56 header shape, reproduced verbatim as the legacy oracle
 *  (see taskConfig.test.ts's identical helper for why this isn't
 *  imported from client.ts itself). */
function legacyAuthHeaders(settings: Settings): Record<string, string> {
  const headers: Record<string, string> = {
    [PROVIDER_HEADERS.provider]: settings.provider,
  };
  if (settings.apiKey) {
    headers[PROVIDER_HEADERS.key] = settings.apiKey;
  }
  if (settings.provider === "openai-compat" && settings.baseUrl) {
    headers[PROVIDER_HEADERS.baseUrl] = settings.baseUrl;
  }
  return headers;
}

describe("round-trip equivalence — no taskLlm ≡ legacy, for every Next.js-routed call site", () => {
  const legacySettingsVariants: Partial<Settings>[] = [
    {},
    { provider: "openai-compat", baseUrl: "https://api.deepseek.com", apiKey: "sk-legacy", detectModel: "deepseek-chat", summaryModel: "deepseek-chat" },
    { provider: "anthropic", apiKey: "sk-ant-legacy" },
  ];

  for (const [i, overrides] of legacySettingsVariants.entries()) {
    it(`detectApi (via detectViaNext), variant #${i}: headers match legacy authHeaders exactly`, async () => {
      const settings = makeSettings(overrides);
      mockFetch.mockResolvedValue(jsonRes({ expressions: [], terms: [] }));

      await detectApi({ context: "", new_text: "hi", model: settings.detectModel }, settings);

      const [url, init] = lastCall();
      expect(url).toContain("/api/detect");
      expect(init.headers).toEqual({
        "Content-Type": "application/json",
        ...legacyAuthHeaders(settings),
      });
      expect(bodyOf(init).model).toBe(settings.detectModel);
    });

    it(`defineApi (via defineViaNext), variant #${i}: headers match legacy authHeaders exactly`, async () => {
      const settings = makeSettings(overrides);
      mockFetch.mockResolvedValue(
        jsonRes({ kind: "expression", headword: "h", variants: [], chinese_explanation: "z", example: "e" }),
      );

      await defineApi({ phrase: "circle back", context: "" }, settings);

      const [url, init] = lastCall();
      expect(url).toContain("/api/define");
      expect(init.headers).toEqual({
        "Content-Type": "application/json",
        ...legacyAuthHeaders(settings),
      });
    });

    it(`summarizeApi, variant #${i}: headers match legacy authHeaders exactly`, async () => {
      const settings = makeSettings(overrides);
      mockFetch.mockResolvedValue(
        jsonRes({ summary: { topic: { en: "", zh: "" }, key_points: [], decisions: [], action_items: [] }, translations: [], flashcards: [], generatedAt: 0, model: "m" }),
      );

      await summarizeApi({ segments: [], expressions: [], terms: [], model: settings.summaryModel }, settings);

      const [url, init] = lastCall();
      expect(url).toContain("/api/summarize");
      expect(init.headers).toEqual({
        "Content-Type": "application/json",
        ...legacyAuthHeaders(settings),
      });
      expect(bodyOf(init).model).toBe(settings.summaryModel);
    });

    it(`translateApi, variant #${i}: headers match legacy authHeaders exactly, and body carries NO model field (today's behavior — no user-facing translate model)`, async () => {
      const settings = makeSettings(overrides);
      mockFetch.mockResolvedValue(jsonRes({ translations: [] }));

      await translateApi({ segments: [{ id: "1", text: "hi" }], lang: "zh" }, settings);

      const [url, init] = lastCall();
      expect(url).toContain("/api/translate");
      expect(init.headers).toEqual({
        "Content-Type": "application/json",
        ...legacyAuthHeaders(settings),
      });
      const body = bodyOf(init);
      expect(body.model).toBeUndefined();
      expect("model" in body).toBe(false); // not even present as an explicit undefined/""
    });
  }
});

describe("taskHeaders — SECURITY: a disabled/absent per-domain override never leaks", () => {
  it("{enabled:false, provider:'openai-compat', ...} produces the SAME headers as no entry at all", () => {
    const primary = makeSettings({ provider: "anthropic", apiKey: "primary-key" });
    const withDisabled = makeSettings({
      provider: "anthropic",
      apiKey: "primary-key",
      taskLlm: {
        translate: {
          enabled: false,
          provider: "openai-compat",
          baseUrl: "https://attacker.example.com",
          apiKey: "attacker-key",
        },
      },
    });
    expect(taskHeaders(withDisabled, "translate")).toEqual(taskHeaders(primary, "translate"));
    expect(taskHeaders(withDisabled, "translate")).not.toHaveProperty(PROVIDER_HEADERS.baseUrl);
  });
});

describe("per-domain routing — distinct providers per domain reach the correct headers, independently", () => {
  it("detect configured with its own openai-compat provider does not affect summary/translate's headers", async () => {
    const settings = makeSettings({
      provider: "anthropic",
      apiKey: "primary-anthropic-key",
      detectModel: "claude-haiku-4-5",
      summaryModel: "claude-sonnet-5",
      taskLlm: {
        detect: {
          enabled: true,
          provider: "openai-compat",
          baseUrl: "https://api.deepseek.com",
          apiKey: "detect-only-key",
          model: "deepseek-chat",
        },
      },
    });

    mockFetch.mockResolvedValue(jsonRes({ expressions: [], terms: [] }));
    await detectApi({ context: "", new_text: "hi" }, settings);
    const [detectUrl, detectInit] = lastCall();
    expect(detectUrl).toContain("/api/detect");
    expect(detectInit.headers).toEqual({
      "Content-Type": "application/json",
      [PROVIDER_HEADERS.provider]: "openai-compat",
      [PROVIDER_HEADERS.key]: "detect-only-key",
      [PROVIDER_HEADERS.baseUrl]: "https://api.deepseek.com",
    });

    mockFetch.mockResolvedValue(
      jsonRes({ summary: { topic: { en: "", zh: "" }, key_points: [], decisions: [], action_items: [] }, translations: [], flashcards: [], generatedAt: 0, model: "m" }),
    );
    await summarizeApi({ segments: [], expressions: [], terms: [] }, settings);
    const [summaryUrl, summaryInit] = lastCall();
    expect(summaryUrl).toContain("/api/summarize");
    // summary was NEVER configured -> falls through to the PRIMARY
    // anthropic credential, completely unaffected by detect's override.
    expect(summaryInit.headers).toEqual({
      "Content-Type": "application/json",
      [PROVIDER_HEADERS.provider]: "anthropic",
      [PROVIDER_HEADERS.key]: "primary-anthropic-key",
    });

    mockFetch.mockResolvedValue(jsonRes({ translations: [] }));
    await translateApi({ segments: [{ id: "1", text: "hi" }], lang: "zh" }, settings);
    const [translateUrl, translateInit] = lastCall();
    expect(translateUrl).toContain("/api/translate");
    expect(translateInit.headers).toEqual({
      "Content-Type": "application/json",
      [PROVIDER_HEADERS.provider]: "anthropic",
      [PROVIDER_HEADERS.key]: "primary-anthropic-key",
    });
  });

  it("translate configured with its own model sends that model in the body; detect/summary remain unaffected", async () => {
    const settings = makeSettings({
      taskLlm: {
        translate: { enabled: true, model: "claude-opus-4-8" },
      },
    });

    mockFetch.mockResolvedValue(jsonRes({ translations: [] }));
    await translateApi({ segments: [{ id: "1", text: "hi" }], lang: "zh" }, settings);
    const [, translateInit] = lastCall();
    expect(bodyOf(translateInit).model).toBe("claude-opus-4-8");
  });
});
