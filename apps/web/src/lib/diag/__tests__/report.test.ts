import { beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../../../../package.json";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import { clearDiag, diagLog } from "../log";
import { buildDiagnosticReport, copyDiagnosticReport, DIAG_REPORT_ENTRIES } from "../report";

// Sentinel secret VALUES — if any of these literal strings ever show
// up in a built report, a key/token leaked. Distinct per field so a
// failure pinpoints exactly which field's stripping regressed.
const SENTINELS = {
  apiKey: "sk-SENTINEL-APIKEY-VALUE",
  hfToken: "hf-SENTINEL-HFTOKEN-VALUE",
  agentToken: "SENTINEL-AGENTTOKEN-VALUE",
  webhookUrl: "https://example.com/SENTINEL-WEBHOOK-PATH",
  taskApiKey: "sk-SENTINEL-TASKLLM-APIKEY-VALUE",
};

function settingsWithSecrets(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    apiKey: SENTINELS.apiKey,
    hfToken: SENTINELS.hfToken,
    agentToken: SENTINELS.agentToken,
    webhookUrl: SENTINELS.webhookUrl,
    taskLlm: {
      detect: { enabled: true, provider: "openai-compat", apiKey: SENTINELS.taskApiKey },
    },
  };
}

describe("diag/report.ts — buildDiagnosticReport", () => {
  beforeEach(() => {
    clearDiag();
  });

  describe("privacy rule — no secret VALUE ever appears in the report", () => {
    it("strips apiKey/hfToken/agentToken/webhookUrl to presence booleans", () => {
      const report = buildDiagnosticReport(settingsWithSecrets());
      expect(report).not.toContain(SENTINELS.apiKey);
      expect(report).not.toContain(SENTINELS.hfToken);
      expect(report).not.toContain(SENTINELS.agentToken);
      expect(report).not.toContain(SENTINELS.webhookUrl);
      expect(report).toContain('"hasApiKey": true');
      expect(report).toContain('"hasHfToken": true');
      expect(report).toContain('"hasAgentToken": true');
      expect(report).toContain('"hasWebhookUrl": true');
    });

    it("strips a per-domain taskLlm override's own apiKey too", () => {
      const report = buildDiagnosticReport(settingsWithSecrets());
      expect(report).not.toContain(SENTINELS.taskApiKey);
      expect(report).toContain('"hasApiKey": true');
    });

    it("profile free text ships as char counts only, never content", () => {
      const report = buildDiagnosticReport({
        ...DEFAULT_SETTINGS,
        profile: {
          enabled: true,
          industry: "SENTINEL-INDUSTRY-生物信息",
          role: "SENTINEL-ROLE-博士生",
          englishLevel: "intermediate",
          familiarDomains: "SENTINEL-FAMILIAR-测序",
          weakDomains: "SENTINEL-WEAK-金融",
        },
      });
      expect(report).not.toContain("SENTINEL-INDUSTRY");
      expect(report).not.toContain("SENTINEL-ROLE");
      expect(report).not.toContain("SENTINEL-FAMILIAR");
      expect(report).not.toContain("SENTINEL-WEAK");
      expect(report).toContain('"industryChars": 22');
      expect(report).toContain('"enabled": true');
      expect(report).toContain('"englishLevel": "intermediate"');
    });

    it("reports hasApiKey:false etc. for default (empty-string) settings", () => {
      const report = buildDiagnosticReport(DEFAULT_SETTINGS);
      expect(report).toContain('"hasApiKey": false');
      expect(report).toContain('"hasHfToken": false');
      expect(report).toContain('"hasAgentToken": false');
      expect(report).toContain('"hasWebhookUrl": false');
    });

    // Field bug fix (iOS TestFlight: hasApiKey:true next to an ambiguous
    // 401 — a truncated/whitespace-mangled key still reads "configured"
    // via hasApiKey alone) — length only, never the key content, and
    // apiKey-only (not extended to hfToken/agentToken/etc.).
    it("apiKeyChars reports the key's length, never its content", () => {
      const report = buildDiagnosticReport(settingsWithSecrets());
      expect(report).not.toContain(SENTINELS.apiKey);
      expect(report).toContain(`"apiKeyChars": ${SENTINELS.apiKey.length}`);
    });

    it("apiKeyChars is 0 for an unconfigured (empty-string) apiKey", () => {
      const report = buildDiagnosticReport(DEFAULT_SETTINGS);
      expect(report).toContain('"apiKeyChars": 0');
    });

    it("does not extend the Chars treatment to other secret-shaped fields", () => {
      const report = buildDiagnosticReport(settingsWithSecrets());
      expect(report).not.toContain("hfTokenChars");
      expect(report).not.toContain("agentTokenChars");
    });

    it("never leaks a secret VALUE even when a diag entry's own detail happens to mention the field name", () => {
      // A malformed/future call site could log something referencing a
      // field name — the report must still never contain the sentinel
      // secret VALUE anywhere, from settings OR from ring-buffer text.
      diagLog("error", "test", "provider auth failed", "provider=openai-compat model=x");
      const report = buildDiagnosticReport(settingsWithSecrets());
      expect(report).not.toContain(SENTINELS.apiKey);
    });
  });

  describe("content — version/tier/browser/theme/diag entries", () => {
    it("includes the app version from package.json", () => {
      const report = buildDiagnosticReport(DEFAULT_SETTINGS);
      expect(report).toContain(pkg.version);
    });

    it("includes themeId and uiMode", () => {
      const report = buildDiagnosticReport({ ...DEFAULT_SETTINGS, themeId: "clarity", uiMode: "advanced" });
      expect(report).toContain("clarity");
      expect(report).toContain("advanced");
    });

    it("includes the last N diag entries, most recent still present when the buffer exceeds N", () => {
      for (let i = 0; i < DIAG_REPORT_ENTRIES + 5; i++) {
        diagLog("info", "seq", `entry-${i}`);
      }
      const report = buildDiagnosticReport(DEFAULT_SETTINGS);
      expect(report).toContain(`entry-${DIAG_REPORT_ENTRIES + 4}`); // most recent
      expect(report).not.toContain("entry-0"); // dropped from the last-N window
    });

    it("reports '（暂无记录）' when the diag buffer is empty", () => {
      const report = buildDiagnosticReport(DEFAULT_SETTINGS);
      expect(report).toContain("（暂无记录）");
    });

    it("includes an entry's ref when present", () => {
      const entry = diagLog("error", "test-tag", "boom");
      const report = buildDiagnosticReport(DEFAULT_SETTINGS);
      expect(report).toContain(entry.ref!);
    });
  });

  // Item 5: the owner saw "anthropic" (settings.provider's default)
  // paired with hasApiKey:false on the server-managed preview tier —
  // reads as "configured for anthropic" when in fact nothing was
  // configured and a real request would run through the server's own
  // credential instead.
  describe("item 5 — provider only names a real value when a key is actually configured", () => {
    it("reports the literal '(未配置)' string, never settings.provider, when no key is configured (default settings)", () => {
      const report = buildDiagnosticReport(DEFAULT_SETTINGS);
      // R2 field fix (v0.4.4): DEFAULT_SETTINGS.provider is now
      // "openai-compat" (paired with the OpenRouter baseUrl, coherent
      // with the DeepSeek OpenRouter model slugs) rather than the old
      // misleading "anthropic" — the assertion below must hold
      // regardless of the raw default value: no key configured means
      // the report NEVER echoes the idle settings.provider string.
      expect(DEFAULT_SETTINGS.provider).toBe("openai-compat");
      // W2: DEFAULT_SETTINGS is untouched here, so provider ALSO carries
      // the new （默认） tag on top of this pre-existing "(未配置)" override
      // — see the "默认 tags" describe block below for the dedicated
      // coverage of that.
      expect(report).toContain('"provider": "(未配置)（默认）"');
      expect(report).not.toContain(`"provider": "${DEFAULT_SETTINGS.provider}"`);
    });

    it("reports the real provider once a key IS configured", () => {
      // W2: "anthropic" here (rather than "openai-compat", the
      // DEFAULT_SETTINGS.provider value) keeps this assertion decoupled
      // from the （默认） tagging feature below — this test is about the
      // has-a-key override, not about default-value tagging.
      const report = buildDiagnosticReport({
        ...DEFAULT_SETTINGS,
        provider: "anthropic",
        apiKey: SENTINELS.apiKey,
      });
      expect(report).toContain('"provider": "anthropic"');
      expect(report).not.toContain('"provider": "(未配置)"');
      expect(report).not.toContain(SENTINELS.apiKey); // still never the key VALUE itself
    });
  });

  // Feature ask: "in the future, please include FULL config in debug
  // log that user can export and raise an issue" — the settings
  // section now iterates every Settings key generically instead of a
  // curated allow-list (see report.ts's redactSettingsObject policy).
  describe("完整配置 — generic full-config snapshot", () => {
    it("renames the section header from the old 设置摘要 to 完整配置", () => {
      const report = buildDiagnosticReport(DEFAULT_SETTINGS);
      expect(report).toContain("## 完整配置");
    });

    it("includes previously-omitted plain settings fields verbatim — proves this is genuinely FULLER than the old allow-list, not just renamed", () => {
      const report = buildDiagnosticReport({
        ...DEFAULT_SETTINGS,
        // W2: "zh-CN" (not DEFAULT_SETTINGS.language's own "en-US")
        // keeps this a genuinely CHANGED value — untagged — decoupled
        // from the （默认） tagging feature covered separately below.
        language: "zh-CN",
        detectModel: "distinctive-detect-model-id",
        summaryModel: "distinctive-summary-model-id",
        minConfidence: 0.77,
        micId: "distinctive-mic-device-id",
      });
      expect(report).toContain('"language": "zh-CN"');
      expect(report).toContain('"detectModel": "distinctive-detect-model-id"');
      expect(report).toContain('"summaryModel": "distinctive-summary-model-id"');
      expect(report).toContain('"minConfidence": 0.77');
      expect(report).toContain('"micId": "distinctive-mic-device-id"');
    });

    describe("URL-valued keys — included but reduced to origin + a '/…' marker for any non-root path (codex v2 review F3)", () => {
      it("whisperUrl keeps its origin verbatim but collapses a non-root path to '/…', dropping an embedded query string with it", () => {
        const report = buildDiagnosticReport({
          ...DEFAULT_SETTINGS,
          whisperUrl: "ws://localhost:8765/some/path?SENTINEL_QUERY=leak-me",
        });
        expect(report).not.toContain("SENTINEL_QUERY");
        expect(report).not.toContain("leak-me");
        expect(report).not.toContain("/some/path");
        expect(report).toContain("ws://localhost:8765/…");
      });

      it("a root-path whisperUrl renders as the bare origin — no '/…' marker for a path that carries nothing", () => {
        // W2: localhost:9999 (not DEFAULT_SETTINGS.whisperUrl's own
        // :8765) keeps this a genuinely CHANGED value — untagged —
        // decoupled from the （默认） tagging feature covered separately
        // below, while still exercising the same root-path shape.
        const report = buildDiagnosticReport({ ...DEFAULT_SETTINGS, whisperUrl: "ws://localhost:9999" });
        expect(report).toContain('"whisperUrl": "ws://localhost:9999"');
      });

      it("agentUrl and baseUrl are likewise userinfo-stripped and path-collapsed, not treated as secret", () => {
        const report = buildDiagnosticReport({
          ...DEFAULT_SETTINGS,
          agentUrl: "http://user:SENTINEL_PASS@127.0.0.1:8767?SENTINEL_Q=1",
          baseUrl: "https://api.deepseek.com/v1?SENTINEL_KEY=abc",
        });
        expect(report).not.toContain("SENTINEL_PASS");
        expect(report).not.toContain("SENTINEL_Q");
        expect(report).not.toContain("SENTINEL_KEY");
        expect(report).not.toContain("/v1"); // baseUrl's path is non-root — collapsed
        expect(report).toContain("http://127.0.0.1:8767"); // agentUrl: root path, no marker
        expect(report).toContain("https://api.deepseek.com/…"); // baseUrl: non-root path collapsed
        // Confirms this field wasn't collapsed to a has* presence
        // boolean (that's the secret-key branch, a different one).
        expect(report).not.toContain("hasBaseUrl");
        expect(report).not.toContain("hasAgentUrl");
      });

      it("a scheme-less URL with an embedded key is recovered via the https:// retry — sentinel absent, '/…' redaction marker present (codex v2 review F3)", () => {
        const report = buildDiagnosticReport({
          ...DEFAULT_SETTINGS,
          baseUrl: "api.example.com/v1?api_key=sk-live",
        });
        expect(report).not.toContain("sk-live");
        expect(report).not.toContain("api_key");
        expect(report).toContain("https://api.example.com/…");
      });

      it("a value that still doesn't yield a real host even after the https:// retry collapses to the literal unparseable marker, never the raw value (codex v2 review F3)", () => {
        const report = buildDiagnosticReport({
          ...DEFAULT_SETTINGS,
          baseUrl: "not a url with spaces",
        });
        expect(report).not.toContain("not a url with spaces");
        expect(report).toContain('"baseUrl": "(无法解析的地址，已隐去)"');
      });

      it("a path-embedded token/credential (no query string at all) is stripped too — origin + '/…' only", () => {
        const report = buildDiagnosticReport({
          ...DEFAULT_SETTINGS,
          baseUrl: "https://host/token/sk-live",
        });
        expect(report).not.toContain("sk-live");
        expect(report).not.toContain("/token/");
        expect(report).toContain("https://host/…");
      });

      it("webhookUrl is the documented exception: presence-only, NOT query-stripped-and-included — its path can itself embed a capability token (n8n/飞书-style), unlike a plain connection endpoint", () => {
        const webhookWithPathToken = "https://hooks.example.com/services/T00/B00/SENTINEL-PATH-TOKEN";
        const report = buildDiagnosticReport({ ...DEFAULT_SETTINGS, webhookUrl: webhookWithPathToken });
        expect(report).not.toContain("SENTINEL-PATH-TOKEN");
        expect(report).not.toContain("hooks.example.com");
        expect(report).toContain('"hasWebhookUrl": true');
      });
    });

    it("an unknown/future key whose name looks secret (matches /token|key|secret|password/i) is redacted to has<Key> presence-only — the sentinel VALUE never appears", () => {
      const SENTINEL = "SENTINEL-UNKNOWN-FUTURE-SECRET-VALUE";
      const settingsWithUnknownSecret = {
        ...DEFAULT_SETTINGS,
        superSecretApiToken: SENTINEL,
      } as unknown as Settings;
      const report = buildDiagnosticReport(settingsWithUnknownSecret);
      expect(report).not.toContain(SENTINEL);
      expect(report).toContain('"hasSuperSecretApiToken": true');
    });

    it("an unknown/future key whose name does NOT look secret is included verbatim (the documented safe default)", () => {
      const settingsWithUnknownField = {
        ...DEFAULT_SETTINGS,
        someFutureNonSecretFlag: true,
      } as unknown as Settings;
      const report = buildDiagnosticReport(settingsWithUnknownField);
      expect(report).toContain('"someFutureNonSecretFlag": true');
    });

    it("an array-of-OBJECTS field (hypothetical future 'list of user-authored entries') collapses to a count only — no entry content", () => {
      const settingsWithArrayField = {
        ...DEFAULT_SETTINGS,
        futureSavedPresets: [
          { id: "1", name: "SENTINEL-PRESET-ONE" },
          { id: "2", name: "SENTINEL-PRESET-TWO" },
        ],
      } as unknown as Settings;
      const report = buildDiagnosticReport(settingsWithArrayField);
      expect(report).not.toContain("SENTINEL-PRESET-ONE");
      expect(report).not.toContain("SENTINEL-PRESET-TWO");
      expect(report).toContain('"futureSavedPresetsCount": 2');
    });

    it("an array of PRIMITIVES (enabledPacks — built-in pack ids, not user content) is included verbatim, not counted", () => {
      const report = buildDiagnosticReport({ ...DEFAULT_SETTINGS, enabledPacks: ["biz", "tech"] });
      expect(report).toContain('"enabledPacks": [\n    "biz",\n    "tech"\n  ]');
    });

    it("a nested settings object (taskLlm's per-domain override) applies the SAME policy recursively — nested apiKey redacted, nested baseUrl query-stripped, other fields verbatim", () => {
      const report = buildDiagnosticReport({
        ...DEFAULT_SETTINGS,
        taskLlm: {
          detect: {
            enabled: true,
            provider: "openai-compat",
            baseUrl: "https://x.example.com?SENTINEL_NESTED_Q=1",
            apiKey: SENTINELS.taskApiKey,
            model: "distinctive-nested-model-id",
          },
        },
      });
      expect(report).not.toContain(SENTINELS.taskApiKey);
      expect(report).not.toContain("SENTINEL_NESTED_Q");
      expect(report).toContain('"hasApiKey": true');
      expect(report).toContain('"baseUrl": "https://x.example.com"'); // root path — no marker
      expect(report).toContain('"distinctive-nested-model-id"');
    });
  });

  // W2 field-debugging postmortem: a user reading a copied report saw
  // the default OpenRouter baseUrl and read it as deliberate custom
  // config — nothing distinguished "still whatever the app ships with"
  // from "I actually changed this". report.ts's tagDefaultValues closes
  // that gap.
  describe("（默认） tags — distinguishes factory defaults from user configuration", () => {
    it("default settings: baseUrl/provider/detectModel lines all carry （默认）", () => {
      const report = buildDiagnosticReport(DEFAULT_SETTINGS);
      expect(report).toContain('"baseUrl": "https://openrouter.ai/…（默认）"');
      expect(report).toContain('"provider": "(未配置)（默认）"');
      expect(report).toContain(`"detectModel": "${DEFAULT_SETTINGS.detectModel}（默认）"`);
    });

    it("a changed value never carries the （默认） tag", () => {
      // Only baseUrl/detectModel are changed here — every OTHER field
      // (provider included) stays at its own default and legitimately
      // keeps carrying the tag elsewhere in the same report, so this
      // checks the two CHANGED fields' own lines specifically rather
      // than asserting "（默认）" is absent from the whole report.
      const report = buildDiagnosticReport({
        ...DEFAULT_SETTINGS,
        baseUrl: "https://api.deepseek.com", // root path — bare origin, no "/…" marker to account for
        detectModel: "distinctive-detect-model-id",
      });
      expect(report).toContain('"baseUrl": "https://api.deepseek.com"');
      expect(report).not.toContain('"baseUrl": "https://api.deepseek.com（默认）"');
      expect(report).toContain('"detectModel": "distinctive-detect-model-id"');
      expect(report).not.toContain('"detectModel": "distinctive-detect-model-id（默认）"');
    });

    it("tags a plain boolean/number field at its own default too, not just strings", () => {
      const report = buildDiagnosticReport(DEFAULT_SETTINGS);
      expect(report).toContain(`"minConfidence": "${DEFAULT_SETTINGS.minConfidence}（默认）"`);
      expect(report).toContain(`"autoDetect": "${DEFAULT_SETTINGS.autoDetect}（默认）"`);
    });

    it("never tags a secret-shaped field's has<Key> presence boolean — it stays a real, untagged JSON boolean", () => {
      const report = buildDiagnosticReport(DEFAULT_SETTINGS);
      expect(report).toContain('"hasApiKey": false');
      expect(report).not.toContain('"hasApiKey": "false');
    });

    it("never tags an object/array field — customThemes/taskLlm carry no marker even though the whole object is untouched from default", () => {
      const report = buildDiagnosticReport(DEFAULT_SETTINGS);
      expect(report).toContain('"customThemes": []');
    });
  });

  // W2 desktop proxy support — proxyUrl commonly carries basic-auth
  // userinfo (`http://user:pass@host:port`), so it rides the SAME
  // url-shaped field policy (point 2) as baseUrl/whisperUrl/agentUrl
  // above — this just pins that it does, and that the field name
  // pattern picks it up automatically (proxyUrl was added after the
  // policy itself, never touched isUrlShapedKey/sanitizeUrl).
  describe("proxyUrl redaction (SECURITY: a manual proxy URL commonly carries user:pass@ basic-auth)", () => {
    it("origin-only like every other url-shaped field — neither the username nor the password ever appears in the report", () => {
      const report = buildDiagnosticReport({
        ...DEFAULT_SETTINGS,
        proxyUrl: "http://SENTINEL-PROXY-USER:SENTINEL-PROXY-PASS@127.0.0.1:7890",
      });
      expect(report).not.toContain("SENTINEL-PROXY-USER");
      expect(report).not.toContain("SENTINEL-PROXY-PASS");
      expect(report).toContain('"proxyUrl": "http://127.0.0.1:7890"');
    });

    it("URL.origin itself never carries userinfo — asserted directly against the WHATWG URL API sanitizeUrl is built on", () => {
      const url = new URL("http://SENTINEL-PROXY-USER:SENTINEL-PROXY-PASS@127.0.0.1:7890/some/path");
      expect(url.origin).not.toContain("SENTINEL-PROXY-USER");
      expect(url.origin).not.toContain("SENTINEL-PROXY-PASS");
      expect(url.origin).toBe("http://127.0.0.1:7890");
    });

    it("not treated as a secret field — included verbatim (sanitized), never collapsed to a hasProxyUrl presence boolean", () => {
      const report = buildDiagnosticReport({ ...DEFAULT_SETTINGS, proxyUrl: "http://127.0.0.1:7890" });
      expect(report).not.toContain("hasProxyUrl");
      expect(report).toContain('"proxyUrl": "http://127.0.0.1:7890"');
    });
  });
});

describe("diag/report.ts — copyDiagnosticReport", () => {
  it("writes the built report to the clipboard and resolves true on success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText }, userAgent: "test-agent" });

    const ok = await copyDiagnosticReport(DEFAULT_SETTINGS);

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("JargonSlayer 诊断信息");

    vi.unstubAllGlobals();
  });

  it("resolves false (never throws) when the Clipboard API is unavailable", async () => {
    vi.stubGlobal("navigator", { userAgent: "test-agent" });
    await expect(copyDiagnosticReport(DEFAULT_SETTINGS)).resolves.toBe(false);
    vi.unstubAllGlobals();
  });

  it("resolves false (never throws) when writeText rejects (permission denied)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("permission denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText }, userAgent: "test-agent" });
    await expect(copyDiagnosticReport(DEFAULT_SETTINGS)).resolves.toBe(false);
    vi.unstubAllGlobals();
  });
});
