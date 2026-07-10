import { beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../../../../package.json";
import { DEFAULT_SETTINGS, type Settings } from "../../types";
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
