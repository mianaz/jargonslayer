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
      expect(DEFAULT_SETTINGS.provider).toBe("anthropic"); // sanity: this is the misleading default
      expect(report).toContain('"provider": "(未配置)"');
      expect(report).not.toContain('"provider": "anthropic"');
    });

    it("reports the real provider once a key IS configured", () => {
      const report = buildDiagnosticReport({
        ...DEFAULT_SETTINGS,
        provider: "openai-compat",
        apiKey: SENTINELS.apiKey,
      });
      expect(report).toContain('"provider": "openai-compat"');
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
        language: "en-US",
        detectModel: "distinctive-detect-model-id",
        summaryModel: "distinctive-summary-model-id",
        minConfidence: 0.77,
        micId: "distinctive-mic-device-id",
      });
      expect(report).toContain('"language": "en-US"');
      expect(report).toContain('"detectModel": "distinctive-detect-model-id"');
      expect(report).toContain('"summaryModel": "distinctive-summary-model-id"');
      expect(report).toContain('"minConfidence": 0.77');
      expect(report).toContain('"micId": "distinctive-mic-device-id"');
    });

    describe("URL-valued keys — included but query string + userinfo stripped", () => {
      it("whisperUrl keeps its origin+path but strips an embedded query string", () => {
        const report = buildDiagnosticReport({
          ...DEFAULT_SETTINGS,
          whisperUrl: "ws://localhost:8765/some/path?SENTINEL_QUERY=leak-me",
        });
        expect(report).not.toContain("SENTINEL_QUERY");
        expect(report).not.toContain("leak-me");
        expect(report).toContain("ws://localhost:8765/some/path");
      });

      it("agentUrl and baseUrl are likewise query/userinfo-stripped, not treated as secret", () => {
        const report = buildDiagnosticReport({
          ...DEFAULT_SETTINGS,
          agentUrl: "http://user:SENTINEL_PASS@127.0.0.1:8767?SENTINEL_Q=1",
          baseUrl: "https://api.deepseek.com/v1?SENTINEL_KEY=abc",
        });
        expect(report).not.toContain("SENTINEL_PASS");
        expect(report).not.toContain("SENTINEL_Q");
        expect(report).not.toContain("SENTINEL_KEY");
        expect(report).toContain("api.deepseek.com/v1");
        // Confirms this field wasn't collapsed to a has* presence
        // boolean (that's the secret-key branch, a different one).
        expect(report).not.toContain("hasBaseUrl");
        expect(report).not.toContain("hasAgentUrl");
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
      expect(report).toContain("https://x.example.com/");
      expect(report).toContain('"distinctive-nested-model-id"');
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
