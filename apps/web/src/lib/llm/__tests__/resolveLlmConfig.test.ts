import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callJsonWithFallback,
  pickModel,
  resolveLlmConfig,
  type ResolvedLlmConfig,
} from "../anthropic";
import { allowDailyBudget, allowRequest, clientIp, resetRateLimiter } from "../rateLimit";
import { DetectResponseSchema } from "../anthropic";

const SERVER_ENV = {
  JARGONSLAYER_API_KEY: "server-secret",
  JARGONSLAYER_PROVIDER: "openai-compat",
  JARGONSLAYER_BASE_URL: "https://openrouter.ai/api/v1",
  JARGONSLAYER_DETECT_MODEL: "minimax/minimax-m2.5",
  JARGONSLAYER_SUMMARY_MODEL: "minimax/minimax-m3",
} as const;

function reqWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/detect", { headers });
}

describe("resolveLlmConfig", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    // Neutralize any real env leaking into the test process.
    for (const name of [
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
    ]) {
      vi.stubEnv(name, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when neither a user key nor a server key exists", () => {
    expect(resolveLlmConfig(reqWithHeaders({}), "detect")).toBeNull();
  });

  it("user key: honors client provider/baseUrl headers, never forces a model", () => {
    const cfg = resolveLlmConfig(
      reqWithHeaders({
        "x-jargonslayer-key": "user-key",
        "x-jargonslayer-provider": "openai-compat",
        "x-jargonslayer-base-url": "https://api.deepseek.com/v1",
      }),
      "detect",
    );
    expect(cfg).toEqual({
      apiKey: "user-key",
      provider: "openai-compat",
      baseUrl: "https://api.deepseek.com/v1",
      forcedModel: null,
      allowedModels: [],
      fallbackModel: null,
      isServerKey: false,
    });
  });

  it("SECURITY: server key never pairs with client-supplied provider/baseUrl headers", () => {
    for (const [name, value] of Object.entries(SERVER_ENV)) {
      vi.stubEnv(name, value);
    }
    // Attacker sends no key but points baseUrl at their own endpoint
    // and requests an expensive model via headers.
    const cfg = resolveLlmConfig(
      reqWithHeaders({
        "x-jargonslayer-provider": "openai-compat",
        "x-jargonslayer-base-url": "https://evil.example.com/v1",
      }),
      "detect",
    );
    expect(cfg).not.toBeNull();
    expect(cfg!.apiKey).toBe("server-secret");
    expect(cfg!.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg!.isServerKey).toBe(true);
    expect(cfg!.forcedModel).toBe("minimax/minimax-m2.5");
    // OpenRouter server-key mode carries the data-policy override…
    expect(cfg!.extraBody).toEqual({ provider: { data_collection: "allow" } });
  });

  it("extraBody is never set for BYOK, and only for openrouter base URLs", () => {
    for (const [name, value] of Object.entries(SERVER_ENV)) {
      vi.stubEnv(name, value);
    }
    const byok = resolveLlmConfig(
      reqWithHeaders({
        "x-jargonslayer-key": "user-key",
        "x-jargonslayer-provider": "openai-compat",
        "x-jargonslayer-base-url": "https://openrouter.ai/api/v1",
      }),
      "detect",
    );
    expect(byok!.extraBody).toBeUndefined();

    vi.stubEnv("JARGONSLAYER_BASE_URL", "http://localhost:11434/v1");
    const ollama = resolveLlmConfig(reqWithHeaders({}), "detect");
    expect(ollama!.extraBody).toBeUndefined();
  });

  it("SECURITY/F6: the openrouter check is an exact hostname match, not a substring — a lookalike host containing 'openrouter.ai' does NOT get the data-policy extraBody", () => {
    vi.stubEnv("JARGONSLAYER_API_KEY", "server-secret");
    vi.stubEnv("JARGONSLAYER_PROVIDER", "openai-compat");
    vi.stubEnv("JARGONSLAYER_BASE_URL", "https://openrouter.ai.evil.example.com/api/v1");
    const cfg = resolveLlmConfig(reqWithHeaders({}), "detect");
    expect(cfg!.extraBody).toBeUndefined();
  });

  it("F6: a malformed JARGONSLAYER_BASE_URL doesn't throw — resolveLlmConfig degrades to isOpenRouter=false", () => {
    vi.stubEnv("JARGONSLAYER_API_KEY", "server-secret");
    vi.stubEnv("JARGONSLAYER_BASE_URL", "not a valid url");
    expect(() => resolveLlmConfig(reqWithHeaders({}), "detect")).not.toThrow();
    expect(resolveLlmConfig(reqWithHeaders({}), "detect")!.extraBody).toBeUndefined();
  });

  it("no kind gets reasoning-off at the RESOLVER level — it moved to the translate route, post-pickModel, minimax-only (v0.2.3 fix: deepseek-v4-flash 502s on the param)", () => {
    for (const [name, value] of Object.entries(SERVER_ENV)) {
      vi.stubEnv(name, value);
    }
    const req = reqWithHeaders({});
    for (const kind of ["translate", "detect", "define", "summary"] as const) {
      expect(resolveLlmConfig(req, kind)!.extraBody).toEqual({
        provider: { data_collection: "allow" },
      });
    }
  });

  it("translate kind: BYOK never gets extraBody (reasoning-off included)", () => {
    for (const [name, value] of Object.entries(SERVER_ENV)) {
      vi.stubEnv(name, value);
    }
    const byok = resolveLlmConfig(
      reqWithHeaders({
        "x-jargonslayer-key": "user-key",
        "x-jargonslayer-provider": "openai-compat",
        "x-jargonslayer-base-url": "https://openrouter.ai/api/v1",
      }),
      "translate",
    );
    expect(byok!.extraBody).toBeUndefined();
  });

  it("server key: per-kind forced models; define and translate fall back to the detect-class model", () => {
    for (const [name, value] of Object.entries(SERVER_ENV)) {
      vi.stubEnv(name, value);
    }
    const req = reqWithHeaders({});
    expect(resolveLlmConfig(req, "detect")!.forcedModel).toBe("minimax/minimax-m2.5");
    expect(resolveLlmConfig(req, "summary")!.forcedModel).toBe("minimax/minimax-m3");
    expect(resolveLlmConfig(req, "define")!.forcedModel).toBe("minimax/minimax-m2.5");
    expect(resolveLlmConfig(req, "translate")!.forcedModel).toBe("minimax/minimax-m2.5");
  });

  it("JARGONSLAYER_TRANSLATE_MODEL, when set, takes precedence over the detect-class model for translate only", () => {
    for (const [name, value] of Object.entries(SERVER_ENV)) {
      vi.stubEnv(name, value);
    }
    vi.stubEnv("JARGONSLAYER_TRANSLATE_MODEL", "minimax/minimax-m2.5-translate");
    const req = reqWithHeaders({});
    expect(resolveLlmConfig(req, "translate")!.forcedModel).toBe(
      "minimax/minimax-m2.5-translate",
    );
    expect(resolveLlmConfig(req, "detect")!.forcedModel).toBe("minimax/minimax-m2.5");
  });

  it("legacy env shape (ANTHROPIC_API_KEY only) keeps anthropic provider and no forced model", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "legacy-key");
    const cfg = resolveLlmConfig(reqWithHeaders({}), "summary");
    expect(cfg).toEqual({
      apiKey: "legacy-key",
      provider: "anthropic",
      baseUrl: "",
      forcedModel: null,
      allowedModels: [],
      fallbackModel: null,
      isServerKey: true,
    });
    expect(resolveLlmConfig(reqWithHeaders({}), "translate")!.forcedModel).toBeNull();
  });

  it("JARGONSLAYER_API_KEY takes precedence over the legacy env name", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "legacy-key");
    vi.stubEnv("JARGONSLAYER_API_KEY", "preferred-key");
    expect(resolveLlmConfig(reqWithHeaders({}), "detect")!.apiKey).toBe("preferred-key");
  });

  it("user key present: server env is ignored entirely", () => {
    for (const [name, value] of Object.entries(SERVER_ENV)) {
      vi.stubEnv(name, value);
    }
    const cfg = resolveLlmConfig(
      reqWithHeaders({ "x-jargonslayer-key": "user-key" }),
      "detect",
    );
    expect(cfg!.apiKey).toBe("user-key");
    expect(cfg!.isServerKey).toBe(false);
    expect(cfg!.forcedModel).toBeNull();
    // No provider header sent -> first-party default, not env provider.
    expect(cfg!.provider).toBe("anthropic");
  });
});

describe("rateLimit", () => {
  beforeEach(() => resetRateLimiter());

  it("allows up to the limit within a window, then rejects", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(allowRequest("detect:1.2.3.4", 5, t0 + i)).toBe(true);
    }
    expect(allowRequest("detect:1.2.3.4", 5, t0 + 10)).toBe(false);
  });

  it("resets after the window rolls over", () => {
    const t0 = 1_000_000;
    expect(allowRequest("k", 1, t0)).toBe(true);
    expect(allowRequest("k", 1, t0 + 59_999)).toBe(false);
    expect(allowRequest("k", 1, t0 + 60_000)).toBe(true);
  });

  it("isolates buckets by key", () => {
    const t0 = 1_000_000;
    expect(allowRequest("detect:a", 1, t0)).toBe(true);
    expect(allowRequest("detect:b", 1, t0)).toBe(true);
    expect(allowRequest("summarize:a", 1, t0)).toBe(true);
    expect(allowRequest("detect:a", 1, t0 + 1)).toBe(false);
  });

  it("clientIp prefers x-real-ip, then first x-forwarded-for hop", () => {
    expect(
      clientIp(new Request("http://x/", { headers: { "x-real-ip": "9.9.9.9" } })),
    ).toBe("9.9.9.9");
    expect(
      clientIp(
        new Request("http://x/", {
          headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" },
        }),
      ),
    ).toBe("1.1.1.1");
    expect(clientIp(new Request("http://x/"))).toBe("unknown");
  });
});

describe("allowDailyBudget — global daily spend budget", () => {
  beforeEach(() => resetRateLimiter());

  // Mid-day UTC, arbitrary — avoids day-boundary edge cases except in
  // the rollover test below, which constructs its own boundary time.
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);

  it("exhausting one task's own cap (define: 400) blocks that task but not others, until the shared total cap", () => {
    for (let i = 0; i < 400; i++) {
      expect(allowDailyBudget("define", t0 + i)).toBe(true);
    }
    expect(allowDailyBudget("define", t0 + 400)).toBe(false);
    // A different task only shares the TOTAL bucket (400/3000 so far)
    // — define's own exhausted cap doesn't touch it.
    expect(allowDailyBudget("detect", t0 + 401)).toBe(true);
  });

  it("the shared total cap (default 3000) blocks every task once reached, even one nowhere near its own per-task cap", () => {
    for (let i = 0; i < 1500; i++) {
      expect(allowDailyBudget("detect", t0 + i)).toBe(true);
    }
    for (let i = 0; i < 1500; i++) {
      expect(allowDailyBudget("translate", t0 + i)).toBe(true);
    }
    // Total is now exactly 3000 (detect's + translate's own caps sum
    // to it) — define (own cap 400, still at 0) is blocked purely by
    // the shared total.
    expect(allowDailyBudget("define", t0)).toBe(false);
  });

  it("resets at UTC day rollover, not 24h after the first hit", () => {
    for (let i = 0; i < 100; i++) {
      expect(allowDailyBudget("summarize", t0 + i)).toBe(true);
    }
    expect(allowDailyBudget("summarize", t0 + 100)).toBe(false);
    const nextUtcMidnight = t0 - (t0 % 86_400_000) + 86_400_000;
    expect(allowDailyBudget("summarize", nextUtcMidnight)).toBe(true);
  });

  it("resetRateLimiter clears the daily budget state too", () => {
    for (let i = 0; i < 100; i++) {
      expect(allowDailyBudget("summarize", t0 + i)).toBe(true);
    }
    expect(allowDailyBudget("summarize", t0 + 100)).toBe(false);
    resetRateLimiter();
    expect(allowDailyBudget("summarize", t0 + 100)).toBe(true);
  });
});

// ---------------------------------------------------------------
// #61 preview tier: model allowlist + pickModel + server fallback
// ---------------------------------------------------------------

describe("resolveLlmConfig — #61 model allowlist envs", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    for (const name of [
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
    ]) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("JARGONSLAYER_API_KEY", "server-secret");
    vi.stubEnv(
      "JARGONSLAYER_MODEL_ALLOWLIST",
      "minimax/minimax-m3, deepseek/deepseek-v4-flash",
    );
    vi.stubEnv("JARGONSLAYER_MODEL_ALLOWLIST_SUMMARY", "deepseek/deepseek-v4-pro");
    vi.stubEnv("JARGONSLAYER_FALLBACK_MODEL", "deepseek/deepseek-v4-flash");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function req(headers: Record<string, string> = {}): Request {
    return new Request("http://localhost/api/detect", { headers });
  }

  it("server key: live kinds get the base allowlist (whitespace-tolerant), summary gets base + summary extras", () => {
    const detect = resolveLlmConfig(req(), "detect")!;
    expect(detect.allowedModels).toEqual([
      "minimax/minimax-m3",
      "deepseek/deepseek-v4-flash",
    ]);
    const translate = resolveLlmConfig(req(), "translate")!;
    expect(translate.allowedModels).toEqual(detect.allowedModels);

    const summary = resolveLlmConfig(req(), "summary")!;
    expect(summary.allowedModels).toEqual([
      "minimax/minimax-m3",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
    ]);
  });

  it("SECURITY: BYOK never carries the allowlist or fallback — a user key means client config, no server machinery", () => {
    const cfg = resolveLlmConfig(req({ "x-jargonslayer-key": "user-key" }), "detect")!;
    expect(cfg.allowedModels).toEqual([]);
    expect(cfg.fallbackModel).toBeNull();
  });

  it("SECURITY: the allowlist does NOT relax provider/baseUrl — server-key requests still ignore client headers entirely", () => {
    vi.stubEnv("JARGONSLAYER_PROVIDER", "openai-compat");
    vi.stubEnv("JARGONSLAYER_BASE_URL", "https://openrouter.ai/api/v1");
    const cfg = resolveLlmConfig(
      req({
        "x-jargonslayer-provider": "openai-compat",
        "x-jargonslayer-base-url": "https://evil.example.com/v1",
      }),
      "detect",
    )!;
    expect(cfg.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.isServerKey).toBe(true);
  });

  it("fallbackModel comes from env in server-key mode", () => {
    const cfg = resolveLlmConfig(req(), "detect")!;
    expect(cfg.fallbackModel).toBe("deepseek/deepseek-v4-flash");
  });
});

describe("pickModel — #61 amended iron law", () => {
  function cfg(overrides: Partial<ResolvedLlmConfig> = {}): ResolvedLlmConfig {
    return {
      apiKey: "k",
      provider: "openai-compat",
      baseUrl: "https://openrouter.ai/api/v1",
      forcedModel: "minimax/minimax-m3",
      allowedModels: [],
      fallbackModel: null,
      isServerKey: true,
      ...overrides,
    };
  }

  it("BYOK: requested model always honored; default only when absent", () => {
    const byok = cfg({ isServerKey: false, forcedModel: null });
    expect(pickModel(byok, "anything/i-want", "claude-haiku-4-5")).toBe("anything/i-want");
    expect(pickModel(byok, undefined, "claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("SECURITY (pre-#61 regression): server key with NO allowlist never honors a client model — forced model wins", () => {
    expect(pickModel(cfg(), "openai/o5-preview", "claude-haiku-4-5")).toBe(
      "minimax/minimax-m3",
    );
  });

  it("server key + allowlist: on-list client model is honored", () => {
    const c = cfg({ allowedModels: ["minimax/minimax-m3", "deepseek/deepseek-v4-flash"] });
    expect(pickModel(c, "deepseek/deepseek-v4-flash", "claude-haiku-4-5")).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("SECURITY: server key + allowlist: off-list client model falls back to the forced model, never honored", () => {
    const c = cfg({ allowedModels: ["minimax/minimax-m3", "deepseek/deepseek-v4-flash"] });
    expect(pickModel(c, "anthropic/claude-opus-4-8", "claude-haiku-4-5")).toBe(
      "minimax/minimax-m3",
    );
    // Exact string membership — prefix/superstring tricks don't pass.
    expect(pickModel(c, "minimax/minimax-m3-extended", "x")).toBe("minimax/minimax-m3");
    expect(pickModel(c, "minimax/minimax-m", "x")).toBe("minimax/minimax-m3");
  });

  it("server key, off-list model, no forced model configured: falls to the route default", () => {
    const c = cfg({ forcedModel: null, allowedModels: ["a/b"] });
    expect(pickModel(c, "not/allowed", "claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });
});

describe("callJsonWithFallback — #61 server-side model fallback (openai-compat path)", () => {
  const okBody = JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({ expressions: [], terms: [] }),
        },
      },
    ],
  });

  function baseOpts(model: string) {
    return {
      apiKey: "k",
      model,
      system: "s",
      user: "u",
      schema: DetectResponseSchema,
      maxTokens: 100,
      provider: "openai-compat" as const,
      baseUrl: "https://example.test/v1",
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("upstream 502 on the primary model retries once on the fallback model and succeeds", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        calls.push(body.model);
        if (body.model === "primary/model") {
          return new Response("bad gateway", { status: 502 });
        }
        return new Response(okBody, { status: 200 });
      }),
    );

    const res = await callJsonWithFallback(baseOpts("primary/model"), "fallback/model");
    expect(res).toEqual({ expressions: [], terms: [] });
    expect(calls).toEqual(["primary/model", "fallback/model"]);
  });

  it("SECURITY: 401 on the primary does NOT retry on the fallback — the key is the problem, not the model", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        calls.push(body.model);
        return new Response("unauthorized", { status: 401 });
      }),
    );

    await expect(
      callJsonWithFallback(baseOpts("primary/model"), "fallback/model"),
    ).rejects.toMatchObject({ status: 401 });
    expect(calls).toEqual(["primary/model"]);
  });

  it("no fallback model (BYOK posture): the primary's error propagates untouched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502 })),
    );
    await expect(callJsonWithFallback(baseOpts("primary/model"), null)).rejects.toMatchObject(
      { status: 502 },
    );
  });

  it("fallback equal to the primary never double-calls", async () => {
    const fetchMock = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      callJsonWithFallback(baseOpts("same/model"), "same/model"),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
