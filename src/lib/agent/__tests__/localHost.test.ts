import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../../types";
import {
  agentDefine,
  agentDetect,
  agentHealth,
  AgentNoKeyError,
  AgentRateLimitError,
  AgentUnreachableError,
  isRemotelyKilled,
} from "../localHost";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    subscriptionDirect: true,
    subscriptionProvider: "claude-sub",
    agentUrl: "http://127.0.0.1:8767",
    agentToken: "test-token",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------
// SUBSCRIPTION_DIRECT_BUILT — kill-switch layer 2 (build flag).
//
// This is deliberately a plain module-level const (not a function
// each call site invokes — see localHost.ts's comment on why: a
// function wrapper left the runtime result correct everywhere but only
// INCONSISTENTLY eliminated the dead branches guarded by it at BUILD
// time across client.ts/store.ts/SettingsDialog.tsx's 3 call sites,
// verified empirically 2026-07-06 via `npm run build` bundle
// inspection — a webpack/Terser cross-module-inlining heuristic, not a
// functional bug). Because it's a const, it's evaluated ONCE when the
// module first loads — exactly like a real Next.js build only reads
// process.env once — so testing "the flag's value depends on env"
// requires vi.resetModules() + a fresh dynamic import per case, rather
// than stubbing the env and re-reading a live function result.
// ---------------------------------------------------------------

describe("SUBSCRIPTION_DIRECT_BUILT", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("is false when NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT is unset (the default/experience-tier build)", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT", "");
    const { SUBSCRIPTION_DIRECT_BUILT } = await import("../localHost");
    expect(SUBSCRIPTION_DIRECT_BUILT).toBe(false);
  });

  it("is true only when the flag is exactly '1'", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT", "1");
    const { SUBSCRIPTION_DIRECT_BUILT } = await import("../localHost");
    expect(SUBSCRIPTION_DIRECT_BUILT).toBe(true);
  });

  it("is false for any other truthy-looking string (e.g. 'true') — only the literal '1' enables it", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT", "true");
    const { SUBSCRIPTION_DIRECT_BUILT } = await import("../localHost");
    expect(SUBSCRIPTION_DIRECT_BUILT).toBe(false);
  });
});

// ---------------------------------------------------------------
// agentHealth — 3s-timeout probe, mirrors fetchSidecarHealth's
// "never throws, null on any failure" contract
// ---------------------------------------------------------------

describe("agentHealth", () => {
  it("returns the parsed health payload on a 200 response", async () => {
    const health = {
      ok: true,
      claude_sdk_available: true,
      claude_logged_in: true,
      codex_available: true,
      codex_logged_in: false,
      warns: [],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(health)));

    const result = await agentHealth(makeSettings());
    expect(result).toEqual(health);
  });

  it("returns null (never throws) when the sidecar is unreachable (fetch rejects)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const result = await agentHealth(makeSettings());
    expect(result).toBeNull();
  });

  it("returns null on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, 500)));

    const result = await agentHealth(makeSettings());
    expect(result).toBeNull();
  });

  it("hits the configured agentUrl, not a hardcoded one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await agentHealth(makeSettings({ agentUrl: "http://127.0.0.1:9999" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/agent/health",
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------
// agentDetect — error mapping (401/403 -> AgentNoKeyError, 429 ->
// AgentRateLimitError, network failure -> AgentUnreachableError)
// ---------------------------------------------------------------

describe("agentDetect", () => {
  const body = { context: "", new_text: "let's circle back" };

  it("returns the parsed DetectResponse on success and sends the connection token + provider", async () => {
    const detectResponse = { expressions: [], terms: [] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(detectResponse));
    vi.stubGlobal("fetch", fetchMock);

    const result = await agentDetect(body, makeSettings({ agentToken: "abc123" }));

    expect(result).toEqual(detectResponse);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8767/agent/detect");
    expect((init.headers as Record<string, string>)["X-JS-Agent-Token"]).toBe("abc123");
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.provider).toBe("claude-sub");
    expect(sentBody.new_text).toBe("let's circle back");
  });

  it("maps a 401 response to AgentNoKeyError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "未登录", code: "no_key" }, 401)),
    );
    await expect(agentDetect(body, makeSettings())).rejects.toBeInstanceOf(AgentNoKeyError);
  });

  it("maps a 403 response (Origin/token gate rejection) to AgentNoKeyError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "连接码不正确" }, 403)),
    );
    await expect(agentDetect(body, makeSettings())).rejects.toBeInstanceOf(AgentNoKeyError);
  });

  it("maps a 429 response to AgentRateLimitError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "额度已用尽", code: "rate_limit" }, 429)),
    );
    await expect(agentDetect(body, makeSettings())).rejects.toBeInstanceOf(AgentRateLimitError);
  });

  it("maps a network-level fetch failure (sidecar not running) to AgentUnreachableError, "
    + "NOT AgentUpstreamError — this is the signal client.ts's routing branch uses to fall "
    + "through to the existing Next.js path SILENTLY", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(agentDetect(body, makeSettings())).rejects.toBeInstanceOf(AgentUnreachableError);
  });

  it("maps an AbortSignal timeout to AgentUnreachableError too (folded into the same silent-fallback case)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new DOMException("aborted", "AbortError"))),
    );
    await expect(agentDetect(body, makeSettings())).rejects.toBeInstanceOf(AgentUnreachableError);
  });
});

// ---------------------------------------------------------------
// agentDefine — same error-mapping contract as agentDetect
// ---------------------------------------------------------------

describe("agentDefine", () => {
  const body = { phrase: "boil the ocean", context: "let's not boil the ocean" };

  it("returns the parsed DefineResult on success", async () => {
    const defineResult = {
      kind: "expression" as const,
      headword: "boil the ocean",
      variants: [],
      chinese_explanation: "z",
      example: "e",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(defineResult)));

    const result = await agentDefine(body, makeSettings());
    expect(result).toEqual(defineResult);
  });

  it("maps a 401 to AgentNoKeyError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "x" }, 401)));
    await expect(agentDefine(body, makeSettings())).rejects.toBeInstanceOf(AgentNoKeyError);
  });

  it("maps a 429 to AgentRateLimitError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "x" }, 429)));
    await expect(agentDefine(body, makeSettings())).rejects.toBeInstanceOf(AgentRateLimitError);
  });

  it("maps a network-level failure to AgentUnreachableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(agentDefine(body, makeSettings())).rejects.toBeInstanceOf(AgentUnreachableError);
  });
});

// ---------------------------------------------------------------
// isRemotelyKilled — kill-switch layer 3 (remote flags.json).
// Fail-open: any failure/404/malformed response = allowed (false).
// Only an explicit {"subscriptionDirect": false} = killed (true).
// ---------------------------------------------------------------

describe("isRemotelyKilled", () => {
  it("returns true when flags.json explicitly returns subscriptionDirect: false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ subscriptionDirect: false })));
    expect(await isRemotelyKilled()).toBe(true);
  });

  it("returns false when flags.json returns subscriptionDirect: true", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ subscriptionDirect: true })));
    expect(await isRemotelyKilled()).toBe(false);
  });

  it("returns false (allowed) on a 404 — a missing flags.json must never brick the feature", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "not found" }, 404)));
    expect(await isRemotelyKilled()).toBe(false);
  });

  it("returns false (allowed) when the fetch itself fails/times out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await isRemotelyKilled()).toBe(false);
  });

  it("returns false (allowed) when the response body is malformed JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json", { status: 200 })),
    );
    expect(await isRemotelyKilled()).toBe(false);
  });

  it("returns false (allowed) when the JSON body omits subscriptionDirect entirely", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));
    expect(await isRemotelyKilled()).toBe(false);
  });

  it("hits the default GitHub Pages URL when NEXT_PUBLIC_SUBSCRIPTION_FLAGS_URL is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUBSCRIPTION_FLAGS_URL", "");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ subscriptionDirect: true }));
    vi.stubGlobal("fetch", fetchMock);

    await isRemotelyKilled();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://mianaz.github.io/jargonslayer/flags.json",
      expect.anything(),
    );
  });

  it("hits a configured override URL when NEXT_PUBLIC_SUBSCRIPTION_FLAGS_URL is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUBSCRIPTION_FLAGS_URL", "https://example.com/my-flags.json");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ subscriptionDirect: true }));
    vi.stubGlobal("fetch", fetchMock);

    await isRemotelyKilled();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/my-flags.json",
      expect.anything(),
    );
  });
});
