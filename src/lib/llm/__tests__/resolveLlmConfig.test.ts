import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLlmConfig } from "../anthropic";
import { allowRequest, clientIp, resetRateLimiter } from "../rateLimit";

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

  it("server key: per-kind forced models; define falls back to the detect-class model", () => {
    for (const [name, value] of Object.entries(SERVER_ENV)) {
      vi.stubEnv(name, value);
    }
    const req = reqWithHeaders({});
    expect(resolveLlmConfig(req, "detect")!.forcedModel).toBe("minimax/minimax-m2.5");
    expect(resolveLlmConfig(req, "summary")!.forcedModel).toBe("minimax/minimax-m3");
    expect(resolveLlmConfig(req, "define")!.forcedModel).toBe("minimax/minimax-m2.5");
  });

  it("legacy env shape (ANTHROPIC_API_KEY only) keeps anthropic provider and no forced model", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "legacy-key");
    const cfg = resolveLlmConfig(reqWithHeaders({}), "summary");
    expect(cfg).toEqual({
      apiKey: "legacy-key",
      provider: "anthropic",
      baseUrl: "",
      forcedModel: null,
      isServerKey: true,
    });
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
