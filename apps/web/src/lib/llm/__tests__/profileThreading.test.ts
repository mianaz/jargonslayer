// #48 step 3 — background profile threading through client.ts. Same
// mock-fetch pattern as taskHeaders.roundtrip.test.ts; every settings
// object below leaves subscriptionDirect at its default (false), so
// detectApi/defineApi fall straight through to the existing
// detectViaNext/defineViaNext Next.js path — no agent/localHost or
// store mocking needed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import { detectApi, defineApi, summarizeApi } from "../client";
import { renderProfileHint } from "@jargonslayer/core/llm/profileHint";

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

function lastCallBody(): Record<string, unknown> {
  const call = mockFetch.mock.calls.at(-1);
  if (!call) throw new Error("fetch was never called");
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const enabledProfile: NonNullable<Settings["profile"]> = {
  enabled: true,
  industry: "互联网",
  role: "产品经理",
  englishLevel: "intermediate",
};

describe("profile.enabled: false — no profile field is ever sent", () => {
  it("detectApi: body carries no 'profile' key at all (JSON.stringify drops the undefined value)", async () => {
    mockFetch.mockResolvedValue(jsonRes({ expressions: [], terms: [] }));
    await detectApi(
      { context: "", new_text: "hi" },
      makeSettings({ profile: { enabled: false, industry: "互联网" } }),
    );
    expect("profile" in lastCallBody()).toBe(false);
  });

  it("defineApi: body carries no 'profile' key", async () => {
    mockFetch.mockResolvedValue(
      jsonRes({ kind: "expression", headword: "h", variants: [], chinese_explanation: "z", example: "e" }),
    );
    await defineApi(
      { phrase: "circle back", context: "" },
      makeSettings({ profile: { enabled: false, role: "工程师" } }),
    );
    expect("profile" in lastCallBody()).toBe(false);
  });

  it("summarizeApi: body carries no 'profile' key", async () => {
    mockFetch.mockResolvedValue(
      jsonRes({ summary: { topic: { en: "", zh: "" }, key_points: [], decisions: [], action_items: [] }, translations: [], flashcards: [], generatedAt: 0, model: "m" }),
    );
    await summarizeApi(
      { segments: [], expressions: [], terms: [] },
      makeSettings({ profile: { enabled: false } }),
    );
    expect("profile" in lastCallBody()).toBe(false);
  });

  it("Settings.profile absent entirely (DEFAULT_SETTINGS default) — no profile field sent", async () => {
    mockFetch.mockResolvedValue(jsonRes({ expressions: [], terms: [] }));
    await detectApi({ context: "", new_text: "hi" }, makeSettings());
    expect("profile" in lastCallBody()).toBe(false);
  });
});

describe("profile.enabled: true — the rendered hint is threaded exactly like `lang`", () => {
  it("detectApi: body.profile equals renderProfileHint(settings.profile)", async () => {
    mockFetch.mockResolvedValue(jsonRes({ expressions: [], terms: [] }));
    const settings = makeSettings({ profile: enabledProfile });
    await detectApi({ context: "", new_text: "hi" }, settings);
    expect(lastCallBody().profile).toBe(renderProfileHint(enabledProfile));
    expect(lastCallBody().profile).toBe("行业：互联网；角色：产品经理；英语水平：中级");
  });

  it("defineApi: body.profile equals renderProfileHint(settings.profile)", async () => {
    mockFetch.mockResolvedValue(
      jsonRes({ kind: "expression", headword: "h", variants: [], chinese_explanation: "z", example: "e" }),
    );
    const settings = makeSettings({ profile: enabledProfile });
    await defineApi({ phrase: "circle back", context: "" }, settings);
    expect(lastCallBody().profile).toBe(renderProfileHint(enabledProfile));
  });

  it("summarizeApi: body.profile equals renderProfileHint(settings.profile)", async () => {
    mockFetch.mockResolvedValue(
      jsonRes({ summary: { topic: { en: "", zh: "" }, key_points: [], decisions: [], action_items: [] }, translations: [], flashcards: [], generatedAt: 0, model: "m" }),
    );
    const settings = makeSettings({ profile: enabledProfile });
    await summarizeApi({ segments: [], expressions: [], terms: [] }, settings);
    expect(lastCallBody().profile).toBe(renderProfileHint(enabledProfile));
  });

  it("enabled: true but every field blank — hint is empty, so no profile key is sent (matches renderProfileHint's undefined return)", async () => {
    mockFetch.mockResolvedValue(jsonRes({ expressions: [], terms: [] }));
    await detectApi({ context: "", new_text: "hi" }, makeSettings({ profile: { enabled: true } }));
    expect("profile" in lastCallBody()).toBe(false);
  });
});
