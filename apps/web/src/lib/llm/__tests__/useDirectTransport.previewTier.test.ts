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

// ---------------------------------------------------------------
// Per-domain split (#56 taskLlm overrides x D1): useDirectTransport
// decides per-CALL off that call's own resolveTaskCreds(settings,
// domain) result (see client.ts's own comment on this), so a
// taskLlm override on one domain must never drag a sibling domain's
// routing lane along with it.
// ---------------------------------------------------------------

describe("useDirectTransport — preview tier, per-domain split (taskLlm overrides)", () => {
  it("primary keyless + one taskLlm domain keyed: only that domain goes direct, sibling domains stay on /api/*", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/detect")) return detectRouteFixture();
      return anthropicDirectFixture(JSON.stringify({ translations: [{ id: "1", text: "你好" }] }));
    });

    const settings = makeSettings({
      apiKey: "", // primary keyless — detect (no override) stays on the trial lane
      taskLlm: {
        translate: { enabled: true, provider: "anthropic", apiKey: "sk-ant-translate-only-key" },
      },
    });

    await detectApi({ context: "", new_text: "hi" }, settings);
    await translateApi({ segments: [{ id: "1", text: "hi" }], lang: "zh" }, settings);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [detectUrl] = mockFetch.mock.calls[0];
    const [translateUrl] = mockFetch.mock.calls[1];
    expect(String(detectUrl)).toContain("/api/detect"); // untouched by translate's own override
    expect(String(translateUrl)).toBe("https://api.anthropic.com/v1/messages"); // the keyed domain alone goes direct
  });

  // The mirror direction ("primary keyed + one taskLlm domain override
  // with a blank key -> that domain goes viaNext") is NOT constructible:
  // resolveTaskCreds (taskConfig.ts) makes a per-domain BLANK key
  // inherit the primary key by design (`t.apiKey || settings.apiKey` —
  // see that file's own doc comment and taskConfig.test.ts's
  // "documented 'blank per-domain key = inherit primary key' rule"
  // case), so a blank override key on a keyed primary still resolves
  // to that primary key and therefore still goes direct. This test
  // pins that invariant instead: a blank-key override can never carve
  // a domain OUT of the direct lane once the primary itself is keyed.
  it("primary keyed + a taskLlm domain override with a blank key: that domain still inherits the primary key and goes direct too (not viaNext)", async () => {
    mockFetch.mockResolvedValue(anthropicDirectFixture(JSON.stringify({ expressions: [], terms: [] })));

    const settings = makeSettings({
      apiKey: "sk-ant-primary-key",
      provider: "anthropic",
      taskLlm: { detect: { enabled: true, apiKey: "" } },
    });

    await detectApi({ context: "", new_text: "hi" }, settings);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toBe("https://api.anthropic.com/v1/messages");
  });
});
