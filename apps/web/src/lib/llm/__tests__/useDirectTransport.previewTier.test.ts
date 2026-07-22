// D1 (preview BYOK client-direct transport) — the PREVIEW_TIER:true
// half of useDirectTransport's matrix (see useDirectTransport.test.ts
// for the full-tier/desktop half and why this needs its own file).
// store.ts (imported transitively via client.ts's `useApp`) reads
// PREVIEW_TIER and SONIOX_PREVIEW_LANE from this same module at import
// time — both are supplied here so the mock fully replaces
// deployTier.ts's shape rather than leaving store.ts's import
// undefined.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/deployTier", () => ({ PREVIEW_TIER: true, SONIOX_PREVIEW_LANE: false }));

import { afterEach, beforeEach } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import { SUMMARY_SYSTEM_PROMPT } from "@jargonslayer/core/llm/prompts";
import { detectApi, defineApi, translateApi, summarizeApi, correctApi } from "../client";
import { setClientTransportOverride } from "../llmTransport";

const mockFetch = vi.fn();

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function detectRouteFixture(): Response {
  return new Response(JSON.stringify({ expressions: [], terms: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function anthropicDirectFixture(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  setClientTransportOverride(null);
  vi.unstubAllGlobals();
});

describe("useDirectTransport — preview tier", () => {
  it("keyless: routes through /api/detect (the shared-key trial lane, unchanged)", async () => {
    mockFetch.mockResolvedValue(detectRouteFixture());

    await detectApi({ context: "", new_text: "hi" }, makeSettings({ apiKey: "" }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/api/detect");
    expect(String(url)).not.toContain("api.anthropic.com");
  });

  it("with a configured key: calls the provider directly — targets api.anthropic.com, never /api/*", async () => {
    mockFetch.mockResolvedValue(anthropicDirectFixture(JSON.stringify({ expressions: [], terms: [] })));

    await detectApi(
      { context: "", new_text: "hi" },
      makeSettings({ apiKey: "sk-ant-preview-byok-key", provider: "anthropic" }),
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
  });

  it("keyless, but desktop's client-transport flag on: still direct — the flag alone suffices independent of PREVIEW_TIER/key", async () => {
    setClientTransportOverride(true);
    mockFetch.mockResolvedValue(anthropicDirectFixture(JSON.stringify({ expressions: [], terms: [] })));

    await detectApi(
      { context: "", new_text: "hi" },
      makeSettings({ apiKey: "sk-ant-desktop-key", provider: "anthropic" }),
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
  });
});

// ---------------------------------------------------------------
// Cross-function pin: every one of the five call sites wires its own
// resolveTaskCreds result into useDirectTransport (detect/define/
// correct didn't resolve creds before this branch pre-D1 — see
// client.ts's detectApiImpl/defineApiImpl/correctApi) — so unlike the
// single-function matrix above, this proves each of the five
// individually threads a keyed preview request to the provider instead
// of /api/*.
// ---------------------------------------------------------------

describe("useDirectTransport — preview tier, with a key: every *Api call site goes direct", () => {
  it("defineApi", async () => {
    mockFetch.mockResolvedValue(
      anthropicDirectFixture(
        JSON.stringify({
          kind: "expression",
          headword: "circle back",
          variants: [],
          chinese_explanation: "回头再说",
          example: "e",
        }),
      ),
    );

    await defineApi(
      { phrase: "circle back", context: "c" },
      makeSettings({ apiKey: "sk-ant-preview-byok-key", provider: "anthropic" }),
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toBe("https://api.anthropic.com/v1/messages");
  });

  it("translateApi", async () => {
    mockFetch.mockResolvedValue(
      anthropicDirectFixture(JSON.stringify({ translations: [{ id: "1", text: "你好" }] })),
    );

    await translateApi(
      { segments: [{ id: "1", text: "hi" }], lang: "zh" },
      makeSettings({ apiKey: "sk-ant-preview-byok-key", provider: "anthropic" }),
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toBe("https://api.anthropic.com/v1/messages");
  });

  it("summarizeApi", async () => {
    // Summary + sweep dispatch concurrently (Promise.all) — a shared
    // Response instance can only have its body read once, so this
    // needs a FRESH Response per call (unlike the single-call tests
    // above), routed by system prompt so both stages get a
    // schema-shaped reply instead of the sweep silently degrading on a
    // mismatch (see tasks/summarize.ts's runSweepStage catch).
    mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { system?: unknown };
      const fixture =
        body.system === SUMMARY_SYSTEM_PROMPT
          ? { topic: { en: "t", zh: "t" }, key_points: [], decisions: [], action_items: [] }
          : { expressions: [], terms: [] }; // sweep
      return anthropicDirectFixture(JSON.stringify(fixture));
    });

    await summarizeApi(
      { segments: [], expressions: [], terms: [] },
      makeSettings({ apiKey: "sk-ant-preview-byok-key", provider: "anthropic" }),
    );

    // Summary is a multi-stage orchestration (summary + translation +
    // sweep) — every dispatched call must go direct, none through /api/*.
    expect(mockFetch.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockFetch.mock.calls) {
      expect(String(call[0])).toBe("https://api.anthropic.com/v1/messages");
    }
  });

  it("correctApi", async () => {
    mockFetch.mockResolvedValue(anthropicDirectFixture(JSON.stringify({ corrections: [] })));

    await correctApi(
      { segments: [{ id: "1", text: "hi" }], context: "", lexicon: [] },
      makeSettings({ apiKey: "sk-ant-preview-byok-key", provider: "anthropic" }),
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toBe("https://api.anthropic.com/v1/messages");
  });
});
