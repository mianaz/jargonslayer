// Routing-branch tests for detectApi/defineApi's subscription-direct
// pre-branch (v0.2.2). Mocks ../agent/localHost and ../../store so
// these exercise ONLY the decision logic in client.ts — which path
// gets called, in what order, and how each localHost outcome maps to
// a caller-visible result — without a real fetch/network call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";

// vi.mock factories are hoisted above regular top-level declarations,
// so every value a factory below references must itself be declared
// via vi.hoisted() (hoisted alongside the mock calls, in the same
// order) rather than a plain const/class — otherwise the factory
// throws "Cannot access '...' before initialization" at module-init
// time (this is a vitest hoisting rule, not a bug in the mocked code).
const {
  mockAgentHealth,
  mockAgentDetect,
  mockAgentDefine,
  mockShowToast,
  AgentNoKeyError,
  AgentRateLimitError,
  AgentUnreachableError,
  AgentUpstreamError,
  getFeatureBuilt,
  setFeatureBuilt,
  getKillCheckSettled,
  setKillCheckSettled,
} = vi.hoisted(() => {
  class AgentNoKeyError extends Error {
    constructor(message = "未登录或凭据无效") {
      super(message);
      this.name = "AgentNoKeyError";
    }
  }
  class AgentRateLimitError extends Error {
    constructor(message = "订阅额度暂不可用") {
      super(message);
      this.name = "AgentRateLimitError";
    }
  }
  class AgentUnreachableError extends Error {
    constructor(message = "无法连接订阅直连 sidecar") {
      super(message);
      this.name = "AgentUnreachableError";
    }
  }
  class AgentUpstreamError extends Error {
    constructor(message = "订阅直连请求失败") {
      super(message);
      this.name = "AgentUpstreamError";
    }
  }
  let featureBuilt = true;
  // Defaults to true (settled) so every EXISTING test — which cares
  // about the build-flag/subscriptionDirect/reachability decisions,
  // not this specific race window — keeps its already-correct
  // behavior unchanged; the race-guard-specific tests below flip this
  // to false explicitly.
  let killCheckSettled = true;
  return {
    mockAgentHealth: vi.fn(),
    mockAgentDetect: vi.fn(),
    mockAgentDefine: vi.fn(),
    mockShowToast: vi.fn(),
    AgentNoKeyError,
    AgentRateLimitError,
    AgentUnreachableError,
    AgentUpstreamError,
    getFeatureBuilt: () => featureBuilt,
    setFeatureBuilt: (v: boolean) => {
      featureBuilt = v;
    },
    getKillCheckSettled: () => killCheckSettled,
    setKillCheckSettled: (v: boolean) => {
      killCheckSettled = v;
    },
  };
});

vi.mock("../../agent/localHost", () => ({
  agentHealth: (...args: unknown[]) => mockAgentHealth(...args),
  agentDetect: (...args: unknown[]) => mockAgentDetect(...args),
  agentDefine: (...args: unknown[]) => mockAgentDefine(...args),
  AgentNoKeyError,
  AgentRateLimitError,
  AgentUnreachableError,
  AgentUpstreamError,
  // SUBSCRIPTION_DIRECT_BUILT is a plain const in production (see
  // localHost.ts's comment on why it's not a function) — client.ts
  // reads it as a value, not by calling it, so this mock needs a
  // getter (rather than a plain object-literal property, which would
  // only capture setFeatureBuilt's value at mock-creation time) so
  // setFeatureBuilt(false) in a later test is actually observed.
  get SUBSCRIPTION_DIRECT_BUILT() {
    return getFeatureBuilt();
  },
}));

vi.mock("../../store", () => ({
  useApp: {
    getState: () => ({
      showToast: mockShowToast,
      // subscriptionKillCheckSettled — see the race-guard tests below
      // (kill-switch race, adversarial-review finding) for why this
      // exists and defaults true.
      get subscriptionKillCheckSettled() {
        return getKillCheckSettled();
      },
    }),
  },
}));

// client.ts's own /api/* fetch calls (the existing Next.js path) —
// stubbed globally so detectViaNext/defineViaNext never make a real
// network request when a test falls through to them.
const mockFetch = vi.fn();

import {
  detectApi,
  defineApi,
  summarizeApi,
  translateApi,
  testConnection,
  NoKeyError,
  RateLimitApiError,
  resetSubscriptionToastLatch,
} from "../client";
import { clearDiag, getDiagEntries } from "../../diag/log";
import { useLlmTelemetry, resetLlmTelemetry } from "../telemetry";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function detectResponseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  setFeatureBuilt(true);
  setKillCheckSettled(true);
  resetSubscriptionToastLatch();
  mockAgentHealth.mockReset();
  mockAgentDetect.mockReset();
  mockAgentDefine.mockReset();
  mockShowToast.mockReset();
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  clearDiag();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetLlmTelemetry();
});

// ---------------------------------------------------------------
// Kill switch 2: build flag off -> subscriptionDirect branch never
// even probes the sidecar; goes straight to the existing Next.js path.
// ---------------------------------------------------------------

describe("detectApi — kill switch: build flag off", () => {
  it("never calls agentHealth/agentDetect when isFeatureBuilt() is false, even with subscriptionDirect: true", async () => {
    setFeatureBuilt(false);
    mockFetch.mockResolvedValue(detectResponseJson({ expressions: [], terms: [] }));

    const result = await detectApi(
      { context: "", new_text: "hi" },
      makeSettings({ subscriptionDirect: true }),
    );

    expect(mockAgentHealth).not.toHaveBeenCalled();
    expect(mockAgentDetect).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1); // went to the existing /api/detect route
    expect(result).toEqual({ expressions: [], terms: [] });
  });
});

// ---------------------------------------------------------------
// Kill switch 1: user's own on/off toggle.
// ---------------------------------------------------------------

describe("detectApi — kill switch: settings.subscriptionDirect off", () => {
  it("never calls agentHealth/agentDetect when subscriptionDirect is false, even with the build flag on", async () => {
    mockFetch.mockResolvedValue(detectResponseJson({ expressions: [], terms: [] }));

    await detectApi({ context: "", new_text: "hi" }, makeSettings({ subscriptionDirect: false }));

    expect(mockAgentHealth).not.toHaveBeenCalled();
    expect(mockAgentDetect).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------
// Host unreachable -> silent fall-through to the existing Next.js
// path (no toast, no error).
// ---------------------------------------------------------------

describe("detectApi — host unreachable", () => {
  it("falls through silently to the existing Next.js path when agentHealth returns null", async () => {
    mockAgentHealth.mockResolvedValue(null);
    mockFetch.mockResolvedValue(detectResponseJson({ expressions: [], terms: [] }));

    const result = await detectApi(
      { context: "", new_text: "hi" },
      makeSettings({ subscriptionDirect: true }),
    );

    expect(mockAgentDetect).not.toHaveBeenCalled(); // never even attempted the real call
    expect(mockShowToast).not.toHaveBeenCalled(); // no toast for "host not running"
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ expressions: [], terms: [] });
  });

  it("also falls through silently when the sidecar is reachable (health OK) but agentDetect itself throws AgentUnreachableError mid-call", async () => {
    mockAgentHealth.mockResolvedValue({ ok: true, claude_sdk_available: true, claude_logged_in: true, codex_available: false, codex_logged_in: null, warns: [] });
    mockAgentDetect.mockRejectedValue(new AgentUnreachableError());
    mockFetch.mockResolvedValue(detectResponseJson({ expressions: [], terms: [] }));

    const result = await detectApi(
      { context: "", new_text: "hi" },
      makeSettings({ subscriptionDirect: true }),
    );

    expect(mockShowToast).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ expressions: [], terms: [] });
  });
});

// ---------------------------------------------------------------
// Reachable + success -> the sidecar's result is returned directly,
// the existing Next.js path is never touched.
// ---------------------------------------------------------------

describe("detectApi — subscription-direct success", () => {
  it("returns the sidecar's DetectResponse directly and never calls the Next.js route", async () => {
    mockAgentHealth.mockResolvedValue({ ok: true, claude_sdk_available: true, claude_logged_in: true, codex_available: false, codex_logged_in: null, warns: [] });
    const subResponse = { expressions: [{ expression: "circle back", category: "phrase", meaning: "m", chinese_explanation: "z", plain_english: "p", tone: "t", confidence: 0.9, source_sentence: "s" }], terms: [] };
    mockAgentDetect.mockResolvedValue(subResponse);

    const result = await detectApi(
      { context: "", new_text: "let's circle back" },
      makeSettings({ subscriptionDirect: true }),
    );

    expect(result).toEqual(subResponse);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// Reachable but quota/auth failed -> dictionary fallback (via
// NoKeyError, matching every existing detectApi caller's contract)
// + exactly one toast with the required subscription-specific wording
// — NEVER a silent fall-through to BYOK/the Next.js path.
// ---------------------------------------------------------------

describe("detectApi — subscription quota/auth failure", () => {
  it("throws NoKeyError (dictionary-mode signal) and fires the required toast on AgentRateLimitError (quota exhausted)", async () => {
    mockAgentHealth.mockResolvedValue({ ok: true, claude_sdk_available: true, claude_logged_in: true, codex_available: false, codex_logged_in: null, warns: [] });
    mockAgentDetect.mockRejectedValue(new AgentRateLimitError());

    await expect(
      detectApi({ context: "", new_text: "hi" }, makeSettings({ subscriptionDirect: true })),
    ).rejects.toBeInstanceOf(NoKeyError);

    expect(mockShowToast).toHaveBeenCalledWith("订阅额度暂不可用，已回退至词典检测");
    expect(mockFetch).not.toHaveBeenCalled(); // NEVER silently falls back to BYOK/Next
  });

  it("throws NoKeyError and fires the toast on AgentNoKeyError (expired/missing login) too", async () => {
    mockAgentHealth.mockResolvedValue({ ok: true, claude_sdk_available: true, claude_logged_in: false, codex_available: false, codex_logged_in: null, warns: [] });
    mockAgentDetect.mockRejectedValue(new AgentNoKeyError());

    await expect(
      detectApi({ context: "", new_text: "hi" }, makeSettings({ subscriptionDirect: true })),
    ).rejects.toBeInstanceOf(NoKeyError);

    expect(mockShowToast).toHaveBeenCalledWith("订阅额度暂不可用，已回退至词典检测");
  });

  it("fires the toast only ONCE across consecutive failures, then again after a success resets the latch", async () => {
    mockAgentHealth.mockResolvedValue({ ok: true, claude_sdk_available: true, claude_logged_in: true, codex_available: false, codex_logged_in: null, warns: [] });
    const settings = makeSettings({ subscriptionDirect: true });

    mockAgentDetect.mockRejectedValue(new AgentRateLimitError());
    await expect(detectApi({ context: "", new_text: "a" }, settings)).rejects.toBeInstanceOf(NoKeyError);
    await expect(detectApi({ context: "", new_text: "b" }, settings)).rejects.toBeInstanceOf(NoKeyError);
    expect(mockShowToast).toHaveBeenCalledTimes(1); // NOT spammed on every consecutive failure

    // A success resets the latch...
    mockAgentDetect.mockResolvedValue({ expressions: [], terms: [] });
    await detectApi({ context: "", new_text: "c" }, settings);

    // ...so a LATER failure episode gets its own toast again.
    mockAgentDetect.mockRejectedValue(new AgentRateLimitError());
    await expect(detectApi({ context: "", new_text: "d" }, settings)).rejects.toBeInstanceOf(NoKeyError);
    expect(mockShowToast).toHaveBeenCalledTimes(2);
  });

  it("propagates any OTHER error (e.g. AgentUpstreamError from a JSON-parse failure) unchanged, not swallowed as dictionary fallback", async () => {
    mockAgentHealth.mockResolvedValue({ ok: true, claude_sdk_available: true, claude_logged_in: true, codex_available: false, codex_logged_in: null, warns: [] });
    mockAgentDetect.mockRejectedValue(new AgentUpstreamError("模型输出解析失败"));

    await expect(
      detectApi({ context: "", new_text: "hi" }, makeSettings({ subscriptionDirect: true })),
    ).rejects.toBeInstanceOf(AgentUpstreamError);

    expect(mockShowToast).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// defineApi mirrors the exact same routing contract as detectApi.
// ---------------------------------------------------------------

describe("defineApi — subscription-direct routing", () => {
  function defineResponseJson(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("falls through silently to the Next.js path when unreachable", async () => {
    mockAgentHealth.mockResolvedValue(null);
    const defineResult = { kind: "expression", headword: "h", variants: [], chinese_explanation: "z", example: "e" };
    mockFetch.mockResolvedValue(defineResponseJson(defineResult));

    const result = await defineApi(
      { phrase: "boil the ocean", context: "" },
      makeSettings({ subscriptionDirect: true }),
    );

    expect(mockAgentDefine).not.toHaveBeenCalled();
    expect(result).toEqual(defineResult);
  });

  it("returns the sidecar's DefineResult directly on success, never touching the Next.js route", async () => {
    mockAgentHealth.mockResolvedValue({ ok: true, claude_sdk_available: true, claude_logged_in: true, codex_available: false, codex_logged_in: null, warns: [] });
    const subResult = { kind: "expression", headword: "boil the ocean", variants: [], chinese_explanation: "z", example: "e" };
    mockAgentDefine.mockResolvedValue(subResult);

    const result = await defineApi(
      { phrase: "boil the ocean", context: "" },
      makeSettings({ subscriptionDirect: true }),
    );

    expect(result).toEqual(subResult);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws NoKeyError + toasts once on quota exhaustion, never silently falls back to BYOK", async () => {
    mockAgentHealth.mockResolvedValue({ ok: true, claude_sdk_available: true, claude_logged_in: true, codex_available: false, codex_logged_in: null, warns: [] });
    mockAgentDefine.mockRejectedValue(new AgentRateLimitError());

    await expect(
      defineApi({ phrase: "x", context: "" }, makeSettings({ subscriptionDirect: true })),
    ).rejects.toBeInstanceOf(NoKeyError);

    expect(mockShowToast).toHaveBeenCalledWith("订阅额度暂不可用，已回退至词典检测");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// Diagnostics choke point (item 2): the plain Next.js path
// (detectViaNext, going through throwForStatus) logs every request
// failure — status code + provider/model id, never the request/
// response body — to the diag ring buffer (lib/diag/log.ts).
// subscription-direct is off in every test here (default settings)
// so these exercise the SAME path every non-experimental build uses.
// ---------------------------------------------------------------

function errorResponseJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("detectApi — Next.js path status-code failures log to the diag ring buffer", () => {
  it("a 401 (no_key) response logs an 'error' diag entry with a ref, tagged llm-detect", async () => {
    mockFetch.mockResolvedValue(
      errorResponseJson({ error: "未配置 API Key", code: "no_key", requestId: "abc123" }, 401),
    );

    await expect(detectApi({ context: "", new_text: "hi" }, makeSettings())).rejects.toBeInstanceOf(
      NoKeyError,
    );

    const entries = getDiagEntries().filter((e) => e.tag === "llm-detect");
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("error");
    expect(entries[0].ref).toMatch(/^JS-/);
    // requestId (item 5) chains into the diag detail, never the message.
    expect(entries[0].detail).toContain("requestId=abc123");
    expect(entries[0].detail).toContain("status=401");
  });

  it("a 429 response throws RateLimitApiError and also logs a diag entry", async () => {
    mockFetch.mockResolvedValue(
      errorResponseJson({ error: "请求过于频繁，请稍后重试", code: "rate_limit" }, 429),
    );

    await expect(detectApi({ context: "", new_text: "hi" }, makeSettings())).rejects.toBeInstanceOf(
      RateLimitApiError,
    );

    const entries = getDiagEntries().filter((e) => e.tag === "llm-detect");
    expect(entries).toHaveLength(1);
  });

  it("never logs the request body content (only the small fixed zh error phrase + status/provider/model)", async () => {
    mockFetch.mockResolvedValue(errorResponseJson({ error: "服务异常", code: "upstream" }, 502));

    await expect(
      detectApi({ context: "SENTINEL-TRANSCRIPT-TEXT", new_text: "another SENTINEL" }, makeSettings()),
    ).rejects.toThrow();

    const entries = getDiagEntries().filter((e) => e.tag === "llm-detect");
    expect(entries).toHaveLength(1);
    expect(entries[0].message).not.toContain("SENTINEL");
    expect(entries[0].detail ?? "").not.toContain("SENTINEL");
  });

  // ---------------------------------------------------------------
  // Tag-blocker BLOCKER 2 (privacy): body.error can be a raw upstream
  // response-body slice for openai-compat providers (see anthropic.ts's
  // requestChatContent — up to 500 chars of whatever the provider sent
  // back), which can echo request content. That value must never reach
  // diagLog — only a FIXED zh category message keyed off HTTP status.
  // The THROWN error (toast path) is a SEPARATE, unchanged contract:
  // it still carries body.error verbatim.
  // ---------------------------------------------------------------

  describe("throwForStatus — diag gets a fixed category message, never body.error", () => {
    const SENTINEL = "SENTINEL-UPSTREAM-BODY-LEAK-TRANSCRIPT-FRAGMENT";

    it("401: diag message is the fixed 'API Key 无效或未配置' phrase; the thrown NoKeyError still carries body.error", async () => {
      mockFetch.mockResolvedValue(errorResponseJson({ error: SENTINEL, code: "no_key" }, 401));

      await expect(
        detectApi({ context: "", new_text: "hi" }, makeSettings()),
      ).rejects.toMatchObject({ message: SENTINEL });

      const entries = getDiagEntries().filter((e) => e.tag === "llm-detect");
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe("API Key 无效或未配置");
      expect(entries[0].message).not.toContain(SENTINEL);
      expect(entries[0].detail ?? "").not.toContain(SENTINEL);
    });

    it("429: diag message is the fixed '请求过于频繁' phrase; the thrown RateLimitApiError still carries body.error", async () => {
      mockFetch.mockResolvedValue(errorResponseJson({ error: SENTINEL, code: "rate_limit" }, 429));

      await expect(
        detectApi({ context: "", new_text: "hi" }, makeSettings()),
      ).rejects.toMatchObject({ message: SENTINEL });

      const entries = getDiagEntries().filter((e) => e.tag === "llm-detect");
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe("请求过于频繁");
      expect(entries[0].message).not.toContain(SENTINEL);
    });

    it("other status (e.g. 502, the openai-compat raw-body-slice case): diag message is the fixed '请求失败（status）' phrase, sentinel never reaches getDiagEntries() or buildDiagnosticReport()", async () => {
      mockFetch.mockResolvedValue(errorResponseJson({ error: SENTINEL, code: "upstream" }, 502));

      await expect(
        detectApi({ context: "", new_text: "hi" }, makeSettings()),
      ).rejects.toMatchObject({ message: SENTINEL });

      const entries = getDiagEntries().filter((e) => e.tag === "llm-detect");
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe("请求失败（502）");
      expect(entries[0].message).not.toContain(SENTINEL);
      expect(entries[0].detail ?? "").not.toContain(SENTINEL);

      const { buildDiagnosticReport } = await import("../../diag/report");
      const report = buildDiagnosticReport(makeSettings());
      expect(report).not.toContain(SENTINEL);
    });

    it("403 (defensive — server today always normalizes upstream 401/403 to client status 401, but the diag category covers 403 too): diag message is the fixed 'API Key 无效或未配置' phrase", async () => {
      mockFetch.mockResolvedValue(errorResponseJson({ error: SENTINEL, code: "forbidden" }, 403));

      await expect(detectApi({ context: "", new_text: "hi" }, makeSettings())).rejects.toThrow();

      const entries = getDiagEntries().filter((e) => e.tag === "llm-detect");
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe("API Key 无效或未配置");
      expect(entries[0].message).not.toContain(SENTINEL);
    });
  });
});

// ---------------------------------------------------------------
// Item 5: a request with no client-side key runs KEYLESS through the
// Next.js route, which falls back to ITS OWN server-managed credential
// (anthropic.ts's resolveLlmConfig) — the client's idle settings.
// provider never actually serves that request, so the diag ctx must
// say "server", not echo the idle setting. subscriptionDirect is off
// in every test here (default settings), so these hit the plain
// Next.js path exercised above.
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// R1 field fix: testConnection used to call detectApi with no
// `model` at all, silently probing the task-wide (DeepSeek-slug)
// default rather than the user's own configured detect model — a
// non-OpenRouter openai-compat/Anthropic-direct user's 测试连接 could
// 404 even though their real model/key pairing was fine.
// ---------------------------------------------------------------

describe("testConnection — forwards the resolved detect-domain model", () => {
  it("sends resolveTaskCreds(settings, \"detect\").model as the request body's model field", async () => {
    mockFetch.mockResolvedValue(detectResponseJson({ expressions: [], terms: [] }));

    await testConnection(
      makeSettings({
        provider: "openai-compat",
        baseUrl: "https://api.deepseek.com/v1",
        detectModel: "deepseek-chat",
      }),
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.model).toBe("deepseek-chat");
  });
});

describe("diag ctx.provider (item 5) — 'server' when the request ran keyless, the real provider when a key was actually sent", () => {
  it("detectApi: no apiKey configured -> diag detail says provider=server, never the idle settings.provider (anthropic)", async () => {
    mockFetch.mockResolvedValue(errorResponseJson({ error: "x", code: "upstream" }, 502));

    await expect(
      detectApi({ context: "", new_text: "hi" }, makeSettings({ apiKey: "" })),
    ).rejects.toThrow();

    const entries = getDiagEntries().filter((e) => e.tag === "llm-detect");
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toContain("provider=server");
    expect(entries[0].detail).not.toContain("provider=anthropic");
  });

  it("detectApi: an apiKey IS configured -> diag detail names the real provider, not 'server'", async () => {
    mockFetch.mockResolvedValue(errorResponseJson({ error: "x", code: "upstream" }, 502));

    // R2 field fix: DEFAULT_SETTINGS.provider is now "openai-compat" —
    // explicitly pin "anthropic" here so this test still exercises the
    // real-provider-named case regardless of what the idle default is.
    await expect(
      detectApi(
        { context: "", new_text: "hi" },
        makeSettings({ apiKey: "sk-real-key", provider: "anthropic" }),
      ),
    ).rejects.toThrow();

    const entries = getDiagEntries().filter((e) => e.tag === "llm-detect");
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toContain("provider=anthropic");
    expect(entries[0].detail).not.toContain("provider=server");
  });

  it("summarizeApi: no apiKey configured -> provider=server", async () => {
    mockFetch.mockResolvedValue(errorResponseJson({ error: "x", code: "upstream" }, 502));

    await expect(
      summarizeApi({ segments: [], expressions: [], terms: [] }, makeSettings({ apiKey: "" })),
    ).rejects.toThrow();

    const entries = getDiagEntries().filter((e) => e.tag === "llm-summary");
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toContain("provider=server");
  });

  it("translateApi: no apiKey configured -> provider=server (uses its own translateCreds variable, not detect's creds)", async () => {
    mockFetch.mockResolvedValue(errorResponseJson({ error: "x", code: "upstream" }, 502));

    await expect(
      translateApi({ segments: [], lang: "zh" }, makeSettings({ apiKey: "" })),
    ).rejects.toThrow();

    const entries = getDiagEntries().filter((e) => e.tag === "llm-translate");
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toContain("provider=server");
  });

  it("defineApi: no apiKey configured -> provider=server (rides detect's config, same ctxProvider fix applies)", async () => {
    mockFetch.mockResolvedValue(errorResponseJson({ error: "x", code: "upstream" }, 502));

    await expect(
      defineApi({ phrase: "boil the ocean", context: "" }, makeSettings({ apiKey: "" })),
    ).rejects.toThrow();

    const entries = getDiagEntries().filter((e) => e.tag === "llm-define");
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toContain("provider=server");
  });
});

// ---------------------------------------------------------------
// v0.4.5 telemetry wiring — each of the 4 exported *Api functions
// records exactly one recordLlmCall(domain, outcome) per resolved
// call, domain-mapped detect/define/translate/summary (telemetry.ts's
// own FOUR-buckets comment covers why define gets its own bucket
// despite riding detect's creds). Default settings (subscriptionDirect:
// false) route every call here through the plain Next.js /api/* path,
// same as the diag-ring-buffer tests above — errorResponseJson's
// status code drives which of NoKeyError/RateLimitApiError/
// UpstreamError the shared throwForStatus throws, which client.ts's
// telemetryKind then maps to nokey/ratelimit/upstream.
// ---------------------------------------------------------------

describe("LLM telemetry wiring", () => {
  it("detectApi: records detect/ok on success", async () => {
    mockFetch.mockResolvedValue(detectResponseJson({ expressions: [], terms: [] }));
    await detectApi({ context: "", new_text: "hi" }, makeSettings());
    expect(useLlmTelemetry.getState().detect).toMatchObject({
      calls: 1,
      failures: 0,
      lastStatus: "ok",
    });
  });

  it("defineApi: records define/ok on success", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ kind: "expression", headword: "h", variants: [], chinese_explanation: "z", example: "e" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await defineApi({ phrase: "x", context: "" }, makeSettings());
    expect(useLlmTelemetry.getState().define).toMatchObject({
      calls: 1,
      failures: 0,
      lastStatus: "ok",
    });
  });

  it("translateApi: records translate/ok on success", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ segments: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await translateApi({ segments: [], lang: "zh" }, makeSettings());
    expect(useLlmTelemetry.getState().translate).toMatchObject({
      calls: 1,
      failures: 0,
      lastStatus: "ok",
    });
  });

  it("summarizeApi: records summary/ok on success", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await summarizeApi({ segments: [], expressions: [], terms: [] }, makeSettings());
    expect(useLlmTelemetry.getState().summary).toMatchObject({
      calls: 1,
      failures: 0,
      lastStatus: "ok",
    });
  });

  const errorCases: Array<{ status: number; kind: "nokey" | "ratelimit" | "upstream" }> = [
    { status: 401, kind: "nokey" },
    { status: 429, kind: "ratelimit" },
    { status: 502, kind: "upstream" },
  ];

  it.each(errorCases)(
    "detectApi: records detect/{kind: $kind} on a $status response",
    async ({ status, kind }) => {
      mockFetch.mockResolvedValue(errorResponseJson({ error: "x", code: "e" }, status));
      await expect(detectApi({ context: "", new_text: "hi" }, makeSettings())).rejects.toThrow();
      expect(useLlmTelemetry.getState().detect).toMatchObject({
        calls: 1,
        failures: 1,
        lastStatus: "fail",
        lastErrorKind: kind,
      });
    },
  );

  it.each(errorCases)(
    "defineApi: records define/{kind: $kind} on a $status response",
    async ({ status, kind }) => {
      mockFetch.mockResolvedValue(errorResponseJson({ error: "x", code: "e" }, status));
      await expect(defineApi({ phrase: "x", context: "" }, makeSettings())).rejects.toThrow();
      expect(useLlmTelemetry.getState().define).toMatchObject({
        calls: 1,
        failures: 1,
        lastStatus: "fail",
        lastErrorKind: kind,
      });
    },
  );

  it.each(errorCases)(
    "translateApi: records translate/{kind: $kind} on a $status response",
    async ({ status, kind }) => {
      mockFetch.mockResolvedValue(errorResponseJson({ error: "x", code: "e" }, status));
      await expect(translateApi({ segments: [], lang: "zh" }, makeSettings())).rejects.toThrow();
      expect(useLlmTelemetry.getState().translate).toMatchObject({
        calls: 1,
        failures: 1,
        lastStatus: "fail",
        lastErrorKind: kind,
      });
    },
  );

  it.each(errorCases)(
    "summarizeApi: records summary/{kind: $kind} on a $status response",
    async ({ status, kind }) => {
      mockFetch.mockResolvedValue(errorResponseJson({ error: "x", code: "e" }, status));
      await expect(
        summarizeApi({ segments: [], expressions: [], terms: [] }, makeSettings()),
      ).rejects.toThrow();
      expect(useLlmTelemetry.getState().summary).toMatchObject({
        calls: 1,
        failures: 1,
        lastStatus: "fail",
        lastErrorKind: kind,
      });
    },
  );

  it("detectApi: a subscription-direct NoKeyError (the designed dictionary-fallback signal, not a crash) still records detect/{kind:'nokey'} — not suppressed", async () => {
    mockAgentHealth.mockResolvedValue({
      ok: true,
      claude_sdk_available: true,
      claude_logged_in: true,
      codex_available: false,
      codex_logged_in: null,
      warns: [],
    });
    mockAgentDetect.mockRejectedValue(new AgentRateLimitError());

    await expect(
      detectApi({ context: "", new_text: "hi" }, makeSettings({ subscriptionDirect: true })),
    ).rejects.toBeInstanceOf(NoKeyError);

    expect(useLlmTelemetry.getState().detect).toMatchObject({
      calls: 1,
      failures: 1,
      lastStatus: "fail",
      lastErrorKind: "nokey",
    });
  });
});

// ---------------------------------------------------------------
// v0.4.5 detect-span QC (item 6) — F3/F4 field fixes.
// ---------------------------------------------------------------

function summaryResponseJson(overrides: Partial<Record<string, unknown>> = {}): Response {
  return new Response(
    JSON.stringify({
      summary: { topic: { en: "t", zh: "t" }, key_points: [], decisions: [], action_items: [] },
      translations: [],
      flashcards: [],
      generatedAt: 0,
      model: "m",
      sweepQcDropped: 0,
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("summarizeApi — F3: threads the user's idiom caps to the server route", () => {
  it("sends spanQcCaps: { idiomMaxWords, idiomMaxChars } from settings in the /api/summarize request body", async () => {
    mockFetch.mockResolvedValue(summaryResponseJson());

    await summarizeApi(
      { segments: [], expressions: [], terms: [] },
      makeSettings({ detectIdiomMaxWords: 8, detectIdiomMaxChars: 60 }),
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.spanQcCaps).toEqual({ idiomMaxWords: 8, idiomMaxChars: 60 });
  });
});

describe("summarizeApi — F4: records the sweep's QC-dropped count client-side (the sweep stage itself no longer touches telemetry — see tasks/summarize.ts)", () => {
  it("a resolved result with sweepQcDropped > 0 bumps telemetry summary.qcDropped and logs a 'summary-ai-oversize' diag entry", async () => {
    mockFetch.mockResolvedValue(summaryResponseJson({ sweepQcDropped: 3 }));

    await summarizeApi({ segments: [], expressions: [], terms: [] }, makeSettings());

    expect(useLlmTelemetry.getState().summary.qcDropped).toBe(3);
    const entries = getDiagEntries().filter((e) => e.tag === "summary-ai-oversize");
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toBe("dropped=3");
  });

  it("a resolved result with sweepQcDropped === 0 (the common case) records nothing — no diag entry, qcDropped stays 0", async () => {
    mockFetch.mockResolvedValue(summaryResponseJson({ sweepQcDropped: 0 }));

    await summarizeApi({ segments: [], expressions: [], terms: [] }, makeSettings());

    expect(useLlmTelemetry.getState().summary.qcDropped).toBe(0);
    expect(getDiagEntries().filter((e) => e.tag === "summary-ai-oversize")).toHaveLength(0);
  });
});
