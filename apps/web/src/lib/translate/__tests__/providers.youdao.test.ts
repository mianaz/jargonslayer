// @vitest-environment jsdom
//
// v0.7.1 translation train-2 (docs/design-explorations/
// v071-translation-train2-blueprint.md's own 有道 API contract) —
// YoudaoTranslationProvider. Mirrors providers.test.ts's own
// DeepLTranslationProvider describe block (jsonResponse helper,
// setTransport/resetTransport, makeSettings) — see that file's own
// header for the shared conventions this reuses.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";

vi.mock("../../llm/client", () => ({
  translateApi: vi.fn(),
  // YoudaoTranslationProvider throws these directly (providers.ts
  // imports them statically from this module) — same fake-class shape
  // providers.test.ts's own DeepL block uses.
  NoKeyError: class NoKeyError extends Error {
    constructor(message = "未配置 API Key") {
      super(message);
      this.name = "NoKeyError";
    }
  },
  RateLimitApiError: class RateLimitApiError extends Error {
    constructor(message = "请求过于频繁，请稍后重试") {
      super(message);
      this.name = "RateLimitApiError";
    }
  },
}));

import { NoKeyError, RateLimitApiError } from "../../llm/client";
import { resetTransport, setTransport } from "../../llm/llmTransport";
import { YoudaoTranslationProvider, resolveTranslationProvider, youdaoTruncateForSign } from "../providers";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Independently re-derives 有道's own sign formula (NOT imported from
 *  providers.ts — a real second implementation, so this actually checks
 *  the production code rather than trivially agreeing with itself). */
async function expectedSign(appKey: string, q: string, salt: string, curtime: string, appSecret: string): Promise<string> {
  const truncated = q.length <= 20 ? q : q.slice(0, 10) + String(q.length) + q.slice(-10);
  const raw = appKey + truncated + salt + curtime + appSecret;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("youdaoTruncateForSign", () => {
  it("returns q unchanged at/under 20 chars", () => {
    expect(youdaoTruncateForSign("good")).toBe("good");
    expect(youdaoTruncateForSign("a".repeat(20))).toBe("a".repeat(20));
  });

  it("slice(0,10) + length + slice(-10) once over 20 chars — the documented vector", () => {
    expect(youdaoTruncateForSign("hello world, this is a test")).toBe("hello worl27 is a test");
  });
});

describe("YoudaoTranslationProvider", () => {
  afterEach(() => {
    resetTransport();
    vi.restoreAllMocks();
  });

  it("kind is 'youdao'", () => {
    expect(new YoudaoTranslationProvider(() => makeSettings()).kind).toBe("youdao");
  });

  it("prepare() is a harmless no-op (nothing to prime)", () => {
    const provider = new YoudaoTranslationProvider(() => makeSettings());
    expect(() => provider.prepare({ source: "en", target: "zh" })).not.toThrow();
  });

  it("missing appKey -> NoKeyError, without ever calling the transport", async () => {
    const mockTransport = vi.fn();
    setTransport(mockTransport);
    const provider = new YoudaoTranslationProvider(() =>
      makeSettings({ youdaoAppKey: "", youdaoAppSecret: "secret" }),
    );

    await expect(provider.translate([{ id: "1", text: "hi" }], "zh")).rejects.toBeInstanceOf(NoKeyError);
    expect(mockTransport).not.toHaveBeenCalled();
  });

  it("missing appSecret -> NoKeyError, without ever calling the transport", async () => {
    const mockTransport = vi.fn();
    setTransport(mockTransport);
    const provider = new YoudaoTranslationProvider(() =>
      makeSettings({ youdaoAppKey: "key", youdaoAppSecret: "" }),
    );

    await expect(provider.translate([{ id: "1", text: "hi" }], "zh")).rejects.toBeInstanceOf(NoKeyError);
    expect(mockTransport).not.toHaveBeenCalled();
  });

  describe("signing + request shape (deterministic salt/curtime)", () => {
    beforeEach(() => {
      vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-0000-0000-000000000000");
      vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    });

    it("posts form-urlencoded to the single-item endpoint with a sign matching an independent SHA-256 computation", async () => {
      const mockTransport = vi.fn().mockResolvedValue(jsonResponse({ errorCode: "0", translation: ["你好"] }));
      setTransport(mockTransport);
      const settings = makeSettings({
        youdaoAppKey: "app-key",
        youdaoAppSecret: "app-secret",
        language: "en-US",
        explainLanguage: "zh",
      });
      const provider = new YoudaoTranslationProvider(() => settings);

      const result = await provider.translate([{ id: "a", text: "hello" }], "zh");

      expect(result).toEqual([{ id: "a", text: "你好" }]);
      expect(mockTransport).toHaveBeenCalledTimes(1);
      const [url, init] = mockTransport.mock.calls[0];
      expect(url).toBe("https://openapi.youdao.com/api");
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      const body = init.body as URLSearchParams;
      expect(body.get("q")).toBe("hello");
      expect(body.get("from")).toBe("en");
      expect(body.get("to")).toBe("zh-CHS");
      expect(body.get("appKey")).toBe("app-key");
      expect(body.get("salt")).toBe("00000000-0000-0000-0000-000000000000");
      expect(body.get("curtime")).toBe("1700000000");
      expect(body.get("signType")).toBe("v3");
      const expected = await expectedSign(
        "app-key",
        "hello",
        "00000000-0000-0000-0000-000000000000",
        "1700000000",
        "app-secret",
      );
      expect(body.get("sign")).toBe(expected);
    });

    it("explainLanguage 'en' -> to='en', from='zh-CHS' (source derived from settings.language, mirroring DeepL's own source_lang derivation)", async () => {
      const mockTransport = vi.fn().mockResolvedValue(jsonResponse({ errorCode: "0", translation: ["hi"] }));
      setTransport(mockTransport);
      const settings = makeSettings({
        youdaoAppKey: "app-key",
        youdaoAppSecret: "app-secret",
        language: "zh",
        explainLanguage: "en",
      });
      const provider = new YoudaoTranslationProvider(() => settings);

      await provider.translate([{ id: "a", text: "你好" }], "en");

      const body = mockTransport.mock.calls[0][1].body as URLSearchParams;
      expect(body.get("from")).toBe("zh-CHS");
      expect(body.get("to")).toBe("en");
    });

    it("a long q (>20 chars) truncates the SAME way inside the sign — cross-checked against the documented vector", async () => {
      const mockTransport = vi.fn().mockResolvedValue(jsonResponse({ errorCode: "0", translation: ["ok"] }));
      setTransport(mockTransport);
      const settings = makeSettings({ youdaoAppKey: "app-key", youdaoAppSecret: "app-secret" });
      const provider = new YoudaoTranslationProvider(() => settings);
      const q = "hello world, this is a test";

      await provider.translate([{ id: "a", text: q }], "zh");

      const body = mockTransport.mock.calls[0][1].body as URLSearchParams;
      const expected = await expectedSign(
        "app-key",
        q,
        "00000000-0000-0000-0000-000000000000",
        "1700000000",
        "app-secret",
      );
      expect(body.get("sign")).toBe(expected);
    });

    it("batch of N items fires one request PER item, preserving id/order in the result regardless of the transport mock's own call order", async () => {
      const settings = makeSettings({ youdaoAppKey: "app-key", youdaoAppSecret: "app-secret" });
      const provider = new YoudaoTranslationProvider(() => settings);
      const mockTransport = vi.fn().mockImplementation((_url: string, init: { body: URLSearchParams }) => {
        const q = init.body.get("q");
        return Promise.resolve(jsonResponse({ errorCode: "0", translation: [`zh:${q}`] }));
      });
      setTransport(mockTransport);

      const result = await provider.translate(
        [
          { id: "a", text: "one" },
          { id: "b", text: "two" },
        ],
        "zh",
      );

      expect(mockTransport).toHaveBeenCalledTimes(2);
      expect(result).toEqual([
        { id: "a", text: "zh:one" },
        { id: "b", text: "zh:two" },
      ]);
    });
  });

  describe("error-code mapping (HTTP is always 200 — errors ride the JSON body)", () => {
    function settingsWithKeys(): Settings {
      return makeSettings({ youdaoAppKey: "app-key", youdaoAppSecret: "app-secret" });
    }

    it.each(["108", "111", "112", "201", "202", "110", "205", "203", "401"])(
      "errorCode %s -> NoKeyError",
      async (code) => {
        setTransport(vi.fn().mockResolvedValue(jsonResponse({ errorCode: code })));
        const provider = new YoudaoTranslationProvider(() => settingsWithKeys());

        await expect(provider.translate([{ id: "1", text: "hi" }], "zh")).rejects.toBeInstanceOf(NoKeyError);
      },
    );

    it.each(["411", "412"])("errorCode %s -> RateLimitApiError", async (code) => {
      setTransport(vi.fn().mockResolvedValue(jsonResponse({ errorCode: code })));
      const provider = new YoudaoTranslationProvider(() => settingsWithKeys());

      await expect(provider.translate([{ id: "1", text: "hi" }], "zh")).rejects.toBeInstanceOf(
        RateLimitApiError,
      );
    });

    it("an unmapped errorCode (e.g. 303) -> generic Error naming the code", async () => {
      setTransport(vi.fn().mockResolvedValue(jsonResponse({ errorCode: "303" })));
      const provider = new YoudaoTranslationProvider(() => settingsWithKeys());

      await expect(provider.translate([{ id: "1", text: "hi" }], "zh")).rejects.toThrow(/303/);
    });

    it("non-200 HTTP -> generic Error, never NoKeyError/RateLimitApiError", async () => {
      setTransport(vi.fn().mockResolvedValue(new Response("", { status: 500 })));
      const provider = new YoudaoTranslationProvider(() => settingsWithKeys());

      const err = await provider.translate([{ id: "1", text: "hi" }], "zh").catch((e) => e);
      expect(err).not.toBeInstanceOf(NoKeyError);
      expect(err).not.toBeInstanceOf(RateLimitApiError);
      expect(err).toBeInstanceOf(Error);
    });

    it("an unparseable JSON body -> generic Error", async () => {
      setTransport(vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
      const provider = new YoudaoTranslationProvider(() => settingsWithKeys());

      await expect(provider.translate([{ id: "1", text: "hi" }], "zh")).rejects.toBeInstanceOf(Error);
    });

    it("one item's NoKeyError fails the WHOLE batch (Promise.all propagation)", async () => {
      const mockTransport = vi.fn().mockImplementation((_url: string, init: { body: URLSearchParams }) => {
        const q = init.body.get("q");
        return Promise.resolve(
          q === "bad" ? jsonResponse({ errorCode: "108" }) : jsonResponse({ errorCode: "0", translation: ["ok"] }),
        );
      });
      setTransport(mockTransport);
      const provider = new YoudaoTranslationProvider(() => settingsWithKeys());

      await expect(
        provider.translate(
          [
            { id: "a", text: "good" },
            { id: "b", text: "bad" },
          ],
          "zh",
        ),
      ).rejects.toBeInstanceOf(NoKeyError);
    });
  });
});

describe("resolveTranslationProvider — youdao", () => {
  it("translateEngine:'youdao' -> YoudaoTranslationProvider", () => {
    const provider = resolveTranslationProvider(() => makeSettings({ translateEngine: "youdao" }));
    expect(provider).toBeInstanceOf(YoudaoTranslationProvider);
  });
});
