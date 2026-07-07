// Routing-branch tests for detectApi/defineApi's subscription-direct
// pre-branch (v0.2.2). Mocks ../agent/localHost and ../../store so
// these exercise ONLY the decision logic in client.ts — which path
// gets called, in what order, and how each localHost outcome maps to
// a caller-visible result — without a real fetch/network call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../../types";

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
    getState: () => ({ showToast: mockShowToast }),
  },
}));

// client.ts's own /api/* fetch calls (the existing Next.js path) —
// stubbed globally so detectViaNext/defineViaNext never make a real
// network request when a test falls through to them.
const mockFetch = vi.fn();

import { detectApi, defineApi, NoKeyError, resetSubscriptionToastLatch } from "../client";

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
  resetSubscriptionToastLatch();
  mockAgentHealth.mockReset();
  mockAgentDetect.mockReset();
  mockAgentDefine.mockReset();
  mockShowToast.mockReset();
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
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

    expect(mockShowToast).toHaveBeenCalledWith("订阅额度暂不可用，已切换离线词典");
    expect(mockFetch).not.toHaveBeenCalled(); // NEVER silently falls back to BYOK/Next
  });

  it("throws NoKeyError and fires the toast on AgentNoKeyError (expired/missing login) too", async () => {
    mockAgentHealth.mockResolvedValue({ ok: true, claude_sdk_available: true, claude_logged_in: false, codex_available: false, codex_logged_in: null, warns: [] });
    mockAgentDetect.mockRejectedValue(new AgentNoKeyError());

    await expect(
      detectApi({ context: "", new_text: "hi" }, makeSettings({ subscriptionDirect: true })),
    ).rejects.toBeInstanceOf(NoKeyError);

    expect(mockShowToast).toHaveBeenCalledWith("订阅额度暂不可用，已切换离线词典");
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

    expect(mockShowToast).toHaveBeenCalledWith("订阅额度暂不可用，已切换离线词典");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
