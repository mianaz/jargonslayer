// v0.4 S2 design constraint #4 (prompt-cache preservation, PLAN-v0.4
// risk #4) — REWRITTEN (F3, codex v04-integration review): the
// original version of this file called the same run*Task function
// twice with two hand-built CallJsonOptions-shaped inputs. That can
// only prove runDetectTask/runDefineTask/runTranslateTask/
// runSummarizeTask are themselves deterministic — route.ts and
// client.ts both call that SAME shared function, so it could never
// catch either adapter diverging on how it ASSEMBLES that function's
// input (e.g. one side forgetting to thread `profile`/`lang` from its
// own source of truth, or silently dropping the cacheSystem flag on
// its way into the actual wire request).
//
// This version goes through the REAL adapter boundary on both sides:
//
// - SERVER: imports the route module's own `POST` (app/api/*/route.ts)
//   and invokes it with a fixture Request, having stubbed just enough
//   server env for resolveLlmConfig to resolve a server credential
//   (provider left at its "anthropic" default — no BYOK header sent).
//   callJson's PRIMARY path constructs a real `new Anthropic(...)` per
//   call and reads whatever `fetch` currently resolves to (verified
//   against the installed SDK — see anthropic.ts re: getDefaultFetch),
//   so `vi.stubGlobal("fetch", ...)` captures the REAL outgoing
//   request body, including the structured-output primary path (not
//   just the manual-extraction fallback).
// - CLIENT: calls the exported detectApi/defineApi/translateApi/
//   summarizeApi with llmTransport.ts's client-transport override
//   forced on (BYOK settings) — these are the ONLY exported entry
//   points into detectViaClient/defineViaClient/translateViaClient/
//   summarizeViaClient (all four are module-private), so going through
//   them IS going through the real client-side adapter, not a
//   reimplementation of it. The injected Transport (setTransport)
//   captures the real outgoing request body.
//
// Both sides use provider "anthropic" (the default for both
// resolveLlmConfig and BYOK settings) so the SAME request-body shape
// (buildAnthropicMessagesRequestBody) is captured on both sides,
// letting `system`/`messages` be compared byte-for-byte, including
// detect's cache_control wrapping (risk #4's literal guarantee).
//
// Model ids are DELIBERATELY made to differ between the server fixture
// (env-forced) and the client fixture (BYOK-chosen) in every test
// below — model choice is allowed to legitimately differ server vs
// client (server-side allowlisting/forcing vs. the user's own BYOK
// choice), so this file never asserts model-id equality; only prompt
// bytes (system/messages) and other model-INVOCATION fields that
// really should stay shape-identical (max_tokens) are compared. Each
// assertion block below says so again inline.
//
// Route invocability: all four routes proved directly invokable under
// vitest with zero workarounds (confirmed empirically before writing
// this file) — no fallback to comparing route.ts's input-assembly
// function against the client's was needed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDefineSystemPrompt,
  buildDefineUserMessage,
  buildDetectSystemPrompt,
  buildDetectUserMessage,
  buildSweepSystemPrompt,
  buildSweepUserMessage,
  buildTranslateSystemPrompt,
  buildTranslateUserMessage,
  SUMMARY_SYSTEM_PROMPT,
  TRANSLATE_SYSTEM_PROMPT,
} from "@jargonslayer/core/llm/prompts";
import { renderProfileHint } from "@jargonslayer/core/llm/profileHint";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import { POST as detectPOST } from "../../../../app/api/detect/route";
import { POST as definePOST } from "../../../../app/api/define/route";
import { POST as translatePOST } from "../../../../app/api/translate/route";
import { POST as summarizePOST } from "../../../../app/api/summarize/route";
import { detectApi, defineApi, translateApi, summarizeApi } from "../../client";
import { resetTransport, setClientTransportOverride, setTransport } from "../../llmTransport";
import { resetRateLimiter } from "../../rateLimit";

// ---------------------------------------------------------------
// Shared fixtures / helpers
// ---------------------------------------------------------------

/** Minimal shape of what BOTH callJson's Anthropic-SDK primary path
 *  (server) and clientProvider.ts's callAnthropicDirect (client) POST
 *  to api.anthropic.com/v1/messages — see providerCore.ts's
 *  buildAnthropicMessagesRequestBody, the one function both paths
 *  share. `system` is typed `unknown` rather than the exact union
 *  (plain string vs. buildSystemParam's cache_control-wrapped array)
 *  since every assertion below only ever compares it, never narrows
 *  it. `output_config` (present only on the server's structured-output
 *  primary-path attempt, never on the client's manual-extraction-only
 *  path) is deliberately NOT in this type — nothing here asserts on it. */
interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system: unknown;
  messages: { role: string; content: string }[];
}

function anthropicMessage(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function requestBodyOf(call: unknown[]): AnthropicRequestBody {
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string) as AnthropicRequestBody;
}

function makeRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SERVER_ENV_VARS = [
  "JARGONSLAYER_API_KEY",
  "ANTHROPIC_API_KEY",
  "JARGONSLAYER_PROVIDER",
  "JARGONSLAYER_BASE_URL",
  "JARGONSLAYER_DETECT_MODEL",
  "JARGONSLAYER_SUMMARY_MODEL",
  "JARGONSLAYER_TRANSLATE_MODEL",
  "JARGONSLAYER_MODEL_ALLOWLIST",
  "JARGONSLAYER_MODEL_ALLOWLIST_SUMMARY",
  "JARGONSLAYER_FALLBACK_MODEL",
] as const;

/** Neutralizes every server-credential env var, then applies
 *  `overrides` — mirrors resolveLlmConfig.test.ts's own neutralization
 *  pattern so a real ANTHROPIC_API_KEY/etc. leaking from the ambient
 *  shell environment can never make this file's assertions vacuous. */
function stubServerEnv(overrides: Partial<Record<(typeof SERVER_ENV_VARS)[number], string>>): void {
  for (const name of SERVER_ENV_VARS) {
    vi.stubEnv(name, overrides[name] ?? "");
  }
}

// A representative background profile — rendered ONCE via the real
// renderProfileHint so the server-side fixture (which just wants the
// already-rendered STRING, matching the real wire contract of
// DetectRequest.profile/DefineRequest.profile/SummarizeRequest.profile)
// and the client-side fixture (which wants the raw OBJECT, since
// detectViaClient/defineViaClient/summarizeViaClient render it
// themselves via this exact function) are provably the same input.
const PROFILE_OBJ: NonNullable<Settings["profile"]> = {
  enabled: true,
  industry: "互联网",
  role: "产品经理",
};
const PROFILE_STRING = renderProfileHint(PROFILE_OBJ)!;

function byokSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    apiKey: "byok-client-parity-test-key",
    provider: "anthropic",
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  stubServerEnv({});
  resetRateLimiter();
  resetTransport();
  setClientTransportOverride(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetTransport();
  setClientTransportOverride(null);
  resetRateLimiter();
});

// ---------------------------------------------------------------
// detect
// ---------------------------------------------------------------

describe("detect — real route (server) vs real client path: byte-identical system + user", () => {
  it("system matches buildDetectSystemPrompt AND carries cacheSystem's cache_control wrapping on BOTH sides (risk #4's literal guarantee, verified on the actual wire body); user matches buildDetectUserMessage on both sides", async () => {
    const context = "We discussed the roadmap yesterday.";
    const new_text = "Let's circle back on the pricing model.";
    const fixture = { expressions: [], terms: [] };

    // --- server: real POST /api/detect -> resolveLlmConfig -> callJson
    // -> real Anthropic SDK -> intercepted global fetch.
    stubServerEnv({
      JARGONSLAYER_API_KEY: "server-side-parity-key",
      JARGONSLAYER_DETECT_MODEL: "server-only/detect-model",
    });
    const serverFetch = vi.fn().mockResolvedValue(anthropicMessage(JSON.stringify(fixture)));
    vi.stubGlobal("fetch", serverFetch);

    const serverRes = await detectPOST(
      makeRequest("/api/detect", { context, new_text, lang: "zh", profile: PROFILE_STRING }),
    );
    expect(serverRes.status).toBe(200);
    expect(serverFetch).toHaveBeenCalledTimes(1);
    const serverBody = requestBodyOf(serverFetch.mock.calls[0]);

    // --- client: real detectApi -> real (module-private) detectViaClient
    // -> real runDetectTask -> real callProviderDirect -> injected Transport.
    setClientTransportOverride(true);
    const clientFetch = vi.fn().mockResolvedValue(anthropicMessage(JSON.stringify(fixture)));
    setTransport(clientFetch);

    await detectApi(
      { context, new_text, model: "client-chosen-detect-model" },
      // lang comes from settings.explainLanguage on the client path
      // (detectViaClient), NOT from a `lang` field in the DetectRequest
      // body — mirrored by detectViaNext's own body construction, which
      // likewise always overrides `lang` from settings before it ever
      // reaches the wire. That's why the server fixture above sends
      // `lang` directly in its JSON body (routes have no "settings", so
      // they trust the wire value) while the client fixture sets
      // explainLanguage instead.
      byokSettings({ explainLanguage: "zh", profile: PROFILE_OBJ }),
    );
    expect(clientFetch).toHaveBeenCalledTimes(1);
    const clientBody = requestBodyOf(clientFetch.mock.calls[0]);

    // --- parity assertions: prompt bytes only, never model id (see
    // header comment) ---
    expect(serverBody.system).toEqual(clientBody.system);
    expect(serverBody.system).toEqual([
      { type: "text", text: buildDetectSystemPrompt("zh"), cache_control: { type: "ephemeral" } },
    ]);

    expect(serverBody.messages).toEqual(clientBody.messages);
    const expectedUser = buildDetectUserMessage(context, new_text, PROFILE_STRING);
    expect(serverBody.messages).toEqual([{ role: "user", content: expectedUser }]);

    expect(serverBody.max_tokens).toBe(clientBody.max_tokens);

    // Sanity: this fixture genuinely exercises two different models
    // (env-forced server model vs. BYOK client model) — the equality
    // assertions above are therefore not vacuously true because the
    // two sides happened to pick the same model.
    expect(serverBody.model).toBe("server-only/detect-model");
    expect(clientBody.model).toBe("client-chosen-detect-model");
  });
});

// ---------------------------------------------------------------
// define
// ---------------------------------------------------------------

describe("define — real route (server) vs real client path: byte-identical system + user", () => {
  it("system matches buildDefineSystemPrompt and user matches buildDefineUserMessage on both sides", async () => {
    const phrase = "circle back";
    const context = "We should circle back on this next week.";
    const fixture = {
      kind: "expression",
      headword: "circle back",
      variants: [],
      chinese_explanation: "回头再说",
      example: "Let's circle back on this next week.",
    };

    // define rides the detect-class server-side model (no dedicated
    // JARGONSLAYER_DEFINE_MODEL env — see anthropic.ts's
    // resolveLlmConfig doc comment) — JARGONSLAYER_DETECT_MODEL is the
    // one that actually governs it here.
    stubServerEnv({
      JARGONSLAYER_API_KEY: "server-side-parity-key",
      JARGONSLAYER_DETECT_MODEL: "server-only/define-model",
    });
    const serverFetch = vi.fn().mockResolvedValue(anthropicMessage(JSON.stringify(fixture)));
    vi.stubGlobal("fetch", serverFetch);

    const serverRes = await definePOST(
      makeRequest("/api/define", { phrase, context, lang: "en", profile: PROFILE_STRING }),
    );
    expect(serverRes.status).toBe(200);
    expect(serverFetch).toHaveBeenCalledTimes(1);
    const serverBody = requestBodyOf(serverFetch.mock.calls[0]);

    setClientTransportOverride(true);
    const clientFetch = vi.fn().mockResolvedValue(anthropicMessage(JSON.stringify(fixture)));
    setTransport(clientFetch);

    await defineApi(
      { phrase, context, model: "client-chosen-define-model" },
      // lang comes from settings.explainLanguage on the client path
      // (defineViaClient) — see detect's identical comment above.
      byokSettings({ explainLanguage: "en", profile: PROFILE_OBJ }),
    );
    expect(clientFetch).toHaveBeenCalledTimes(1);
    const clientBody = requestBodyOf(clientFetch.mock.calls[0]);

    expect(serverBody.system).toBe(clientBody.system);
    expect(serverBody.system).toBe(buildDefineSystemPrompt("en"));

    const expectedUser = buildDefineUserMessage(phrase, context, PROFILE_STRING);
    expect(serverBody.messages).toEqual(clientBody.messages);
    expect(serverBody.messages).toEqual([{ role: "user", content: expectedUser }]);

    expect(serverBody.max_tokens).toBe(clientBody.max_tokens);

    expect(serverBody.model).toBe("server-only/define-model");
    expect(clientBody.model).toBe("client-chosen-define-model");
  });
});

// ---------------------------------------------------------------
// translate
// ---------------------------------------------------------------

describe("translate — real route (server) vs real client path: byte-identical system + user", () => {
  it("system matches buildTranslateSystemPrompt and user matches buildTranslateUserMessage on both sides", async () => {
    const segments = [{ id: "seg-0", text: "We shipped the ARR dashboard." }];
    const fixture = { translations: [{ id: "seg-0", text: "我们发布了 ARR 仪表盘。" }] };

    stubServerEnv({
      JARGONSLAYER_API_KEY: "server-side-parity-key",
      JARGONSLAYER_TRANSLATE_MODEL: "server-only/translate-model",
    });
    const serverFetch = vi.fn().mockResolvedValue(anthropicMessage(JSON.stringify(fixture)));
    vi.stubGlobal("fetch", serverFetch);

    const serverRes = await translatePOST(makeRequest("/api/translate", { segments, lang: "zh" }));
    expect(serverRes.status).toBe(200);
    expect(serverFetch).toHaveBeenCalledTimes(1);
    const serverBody = requestBodyOf(serverFetch.mock.calls[0]);

    setClientTransportOverride(true);
    const clientFetch = vi.fn().mockResolvedValue(anthropicMessage(JSON.stringify(fixture)));
    setTransport(clientFetch);

    // Unlike detect/define/summarize, translate's `lang` DOES come
    // straight from the TranslateRequest body on both translateApi's
    // Next.js path (no settings-derived override — see client.ts's
    // translateApi, which forwards `body` mostly unchanged) and
    // translateViaClient (`lang: body.lang`) — so it must be passed
    // here explicitly, matching the server fixture's own `lang` field.
    //
    // R1 field fix: translate's resolved creds.model now normally
    // inherits settings.detectModel (see taskConfig.ts's
    // resolveTaskCreds) and wins over this request's own `model` in
    // translateViaClient's `creds.model || (body.model ?? DEFAULT)`
    // fallback chain — byokSettings' detectModel is explicitly blanked
    // here so this test can still isolate and prove the body.model ??
    // DEFAULT_TRANSLATE_MODEL fallback parity below (a real, if now
    // rarer, path — see ResolvedTaskCreds.model's own doc comment).
    await translateApi(
      { segments, lang: "zh", model: "client-chosen-translate-model" },
      byokSettings({ detectModel: "" }),
    );
    expect(clientFetch).toHaveBeenCalledTimes(1);
    const clientBody = requestBodyOf(clientFetch.mock.calls[0]);

    expect(serverBody.system).toBe(clientBody.system);
    expect(serverBody.system).toBe(buildTranslateSystemPrompt("zh"));

    const expectedUser = buildTranslateUserMessage(segments);
    expect(serverBody.messages).toEqual(clientBody.messages);
    expect(serverBody.messages).toEqual([{ role: "user", content: expectedUser }]);
    expect(expectedUser).toBe(JSON.stringify(segments));

    expect(serverBody.max_tokens).toBe(clientBody.max_tokens);

    expect(serverBody.model).toBe("server-only/translate-model");
    expect(clientBody.model).toBe("client-chosen-translate-model");
  });
});

// ---------------------------------------------------------------
// summarize — three-stage orchestration (summary + chunked translation
// + sweep). One full round trip per side captures all three upstream
// calls; each is matched to its counterpart on the OTHER side by its
// system prompt content (never by call order — Promise.all's actual
// dispatch order is an implementation detail neither side's real code
// guarantees, so asserting on it would make this test fragile for the
// wrong reason).
// ---------------------------------------------------------------

describe("summarize — real route (server) vs real client path: byte-identical system + user for all 3 stages", () => {
  it("summary/translation-chunk/sweep stages are all byte-identical between the real route and the real client path", async () => {
    const segments = [{ index: 0, text: "We shipped the ARR dashboard." }];
    const expressions = [
      {
        expression: "circle back",
        category: "phrase" as const,
        meaning: "m",
        chinese_explanation: "z",
        plain_english: "p",
        tone: "t",
        confidence: 0.9,
        source_sentence: "s",
      },
    ];
    const terms: never[] = [];

    function fixtureFor(system: unknown): unknown {
      if (system === SUMMARY_SYSTEM_PROMPT) {
        return { topic: { en: "t", zh: "t" }, key_points: [], decisions: [], action_items: [] };
      }
      if (system === TRANSLATE_SYSTEM_PROMPT) {
        return { translations: [{ i: 0, zh: "我们发布了 ARR 仪表盘。" }] };
      }
      return { expressions: [], terms: [] }; // sweep
    }

    function routedAnthropicFetch() {
      return vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as AnthropicRequestBody;
        return anthropicMessage(JSON.stringify(fixtureFor(body.system)));
      });
    }

    function findBySystem(bodies: AnthropicRequestBody[], system: unknown): AnthropicRequestBody {
      const found = bodies.find((b) => b.system === system);
      if (!found) throw new Error(`no captured upstream call carried system=${String(system)}`);
      return found;
    }

    // --- server ---
    stubServerEnv({
      JARGONSLAYER_API_KEY: "server-side-parity-key",
      JARGONSLAYER_SUMMARY_MODEL: "server-only/summary-model",
    });
    const serverFetch = routedAnthropicFetch();
    vi.stubGlobal("fetch", serverFetch);

    const serverRes = await summarizePOST(
      makeRequest("/api/summarize", {
        segments,
        expressions,
        terms,
        lang: "en",
        profile: PROFILE_STRING,
      }),
    );
    expect(serverRes.status).toBe(200);
    const serverBodies = serverFetch.mock.calls.map(requestBodyOf);
    expect(serverBodies).toHaveLength(3); // summary + 1 translate chunk + sweep, no repair pass

    // --- client ---
    setClientTransportOverride(true);
    const clientFetch = routedAnthropicFetch();
    setTransport(clientFetch);

    await summarizeApi(
      { segments, expressions, terms, model: "client-chosen-summary-model" },
      // lang/profile come from settings on the client path
      // (summarizeViaClient) — see detect's identical comment above.
      byokSettings({ explainLanguage: "en", profile: PROFILE_OBJ }),
    );
    const clientBodies = clientFetch.mock.calls.map(requestBodyOf);
    expect(clientBodies).toHaveLength(3);

    // Stage a — summary. formatSegmentsForSummary is a tasks/
    // summarize.ts-internal, un-exported helper, so (matching the OLD
    // version of this test's own choice for this exact stage) this
    // compares the two REAL captured payloads against EACH OTHER
    // rather than an externally-recomputed third value.
    const serverSummary = findBySystem(serverBodies, SUMMARY_SYSTEM_PROMPT);
    const clientSummary = findBySystem(clientBodies, SUMMARY_SYSTEM_PROMPT);
    expect(serverSummary.messages).toEqual(clientSummary.messages);
    expect(serverSummary.max_tokens).toBe(clientSummary.max_tokens);

    // Stage b — translation chunk. The chunk payload shape (`{i,en}[]`)
    // IS externally reproducible (translateChunk's own one-liner), so
    // this cross-checks against it too, not just against the client.
    const serverTranslate = findBySystem(serverBodies, TRANSLATE_SYSTEM_PROMPT);
    const clientTranslate = findBySystem(clientBodies, TRANSLATE_SYSTEM_PROMPT);
    expect(serverTranslate.messages).toEqual(clientTranslate.messages);
    expect(serverTranslate.messages).toEqual([
      { role: "user", content: JSON.stringify(segments.map((s) => ({ i: s.index, en: s.text }))) },
    ]);
    expect(serverTranslate.max_tokens).toBe(clientTranslate.max_tokens);

    // Stage c — sweep.
    const sweepSystem = buildSweepSystemPrompt("en");
    const serverSweep = findBySystem(serverBodies, sweepSystem);
    const clientSweep = findBySystem(clientBodies, sweepSystem);
    expect(serverSweep.messages).toEqual(clientSweep.messages);
    const expectedSweepUser = buildSweepUserMessage(
      segments.map((s) => s.text).join("\n"),
      ["circle back"],
      PROFILE_STRING,
    );
    expect(serverSweep.messages).toEqual([{ role: "user", content: expectedSweepUser }]);
    expect(serverSweep.max_tokens).toBe(clientSweep.max_tokens);

    // Sanity: two different models exercised (see detect's identical note).
    expect(serverSummary.model).toBe("server-only/summary-model");
    expect(clientSummary.model).toBe("client-chosen-summary-model");
  });
});
