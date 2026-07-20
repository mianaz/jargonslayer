import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import type { LlmDomainStat } from "@/lib/llm/telemetry";
import {
  credsMatch,
  deriveKeyStatus,
  domainUsesOwnKey,
  KEY_STATUS_LABEL,
  llmKeyEvidence,
  primaryTelemetryDomains,
  TASK_DOMAIN_TELEMETRY,
  type CredsTriple,
} from "../keyStatus";

function stat(overrides: Partial<LlmDomainStat> = {}): LlmDomainStat {
  return { calls: 0, failures: 0, qcDropped: 0, lastStatus: null, lastAt: null, ...overrides };
}

describe("deriveKeyStatus", () => {
  it("empty value is always unconfigured, regardless of evidence", () => {
    expect(deriveKeyStatus("")).toBe("unconfigured");
    expect(deriveKeyStatus("", { hasSuccess: true })).toBe("unconfigured");
    expect(deriveKeyStatus("", { hasFailure: true })).toBe("unconfigured");
  });

  it("present value with no evidence is configured", () => {
    expect(deriveKeyStatus("sk-real")).toBe("configured");
    expect(deriveKeyStatus("sk-real", {})).toBe("configured");
  });

  it("present value + hasSuccess is active", () => {
    expect(deriveKeyStatus("sk-real", { hasSuccess: true })).toBe("active");
  });

  it("present value + hasFailure (no success) is error", () => {
    expect(deriveKeyStatus("sk-real", { hasFailure: true })).toBe("error");
  });

  it("a success always wins over a failure on the same credential", () => {
    expect(deriveKeyStatus("sk-real", { hasSuccess: true, hasFailure: true })).toBe("active");
  });
});

describe("KEY_STATUS_LABEL", () => {
  it("covers all four statuses with the exact zh copy", () => {
    expect(KEY_STATUS_LABEL.unconfigured).toBe("未配置");
    expect(KEY_STATUS_LABEL.configured).toBe("已配置");
    expect(KEY_STATUS_LABEL.active).toBe("正常");
    expect(KEY_STATUS_LABEL.error).toBe("异常");
  });
});

describe("llmKeyEvidence", () => {
  it("no stats, no testConnection: no success, no failure", () => {
    expect(llmKeyEvidence([])).toEqual({ hasSuccess: false, hasFailure: false });
  });

  it("a stat with lastStatus ok -> hasSuccess", () => {
    expect(llmKeyEvidence([stat({ lastStatus: "ok" })]).hasSuccess).toBe(true);
  });

  it("a stat with a real failure (ratelimit/upstream) -> hasFailure", () => {
    expect(llmKeyEvidence([stat({ lastStatus: "fail", lastErrorKind: "ratelimit" })]).hasFailure).toBe(true);
    expect(llmKeyEvidence([stat({ lastStatus: "fail", lastErrorKind: "upstream" })]).hasFailure).toBe(true);
  });

  // Mirrors AiStatusPanel.tsx's deriveHealthStatus: a "nokey" failure is
  // often the subscription-direct dictionary-fallback signal, not
  // evidence THIS key is bad — must not count as hasFailure.
  it("excludes a nokey failure from hasFailure", () => {
    expect(llmKeyEvidence([stat({ lastStatus: "fail", lastErrorKind: "nokey" })])).toEqual({
      hasSuccess: false,
      hasFailure: false,
    });
  });

  it("testConnectionOk:true upgrades to hasSuccess even when every stat failed", () => {
    const evidence = llmKeyEvidence(
      [stat({ lastStatus: "fail", lastErrorKind: "ratelimit" })],
      true,
    );
    expect(evidence.hasSuccess).toBe(true);
  });

  it("testConnectionOk:false does not force hasFailure — a stale success still stands", () => {
    const evidence = llmKeyEvidence([stat({ lastStatus: "ok" })], false);
    expect(evidence.hasSuccess).toBe(true);
    expect(evidence.hasFailure).toBe(false);
  });

  it("folds multiple attributed domains (e.g. detect + define riding one credential)", () => {
    const evidence = llmKeyEvidence([stat({ lastStatus: null }), stat({ lastStatus: "ok" })]);
    expect(evidence.hasSuccess).toBe(true);
  });
});

// FINDING 5 (S14 fix round, 2026-07-19): backs the evidence-validity
// rule SettingsDialog.tsx applies at every deriveKeyStatus call site —
// a chip may only be handed telemetry/testConnection evidence when the
// draft's resolved credential triple for it still equals the SAVED
// settings' resolved triple (stale evidence attribution: test key A,
// paste key B must not show B's chip as 正常 off A's evidence).
describe("credsMatch", () => {
  function triple(overrides: Partial<CredsTriple> = {}): CredsTriple {
    return { provider: "openai-compat", baseUrl: "https://api.deepseek.com", apiKey: "sk-a", ...overrides };
  }

  it("identical triples match", () => {
    expect(credsMatch(triple(), triple())).toBe(true);
  });

  it("a different apiKey does not match — the core stale-evidence case (test key A, paste key B)", () => {
    expect(credsMatch(triple(), triple({ apiKey: "sk-b" }))).toBe(false);
  });

  it("a different provider does not match", () => {
    expect(credsMatch(triple(), triple({ provider: "anthropic" }))).toBe(false);
  });

  it("a different baseUrl does not match", () => {
    expect(credsMatch(triple(), triple({ baseUrl: "https://api.openai.com/v1" }))).toBe(false);
  });
});

describe("domainUsesOwnKey", () => {
  function settingsWith(taskLlm: Settings["taskLlm"]): Settings {
    return { ...DEFAULT_SETTINGS, taskLlm };
  }

  it("no taskLlm entry at all -> false (inherits primary)", () => {
    expect(domainUsesOwnKey(settingsWith(undefined), "detect")).toBe(false);
  });

  it("entry present but enabled:false -> false", () => {
    expect(domainUsesOwnKey(settingsWith({ detect: { enabled: false, apiKey: "sk-x" } }), "detect")).toBe(
      false,
    );
  });

  it("enabled:true but a blank own apiKey -> false (resolveTaskCreds' own `t.apiKey || settings.apiKey` fallback)", () => {
    expect(domainUsesOwnKey(settingsWith({ detect: { enabled: true, apiKey: "" } }), "detect")).toBe(false);
  });

  it("enabled:true with a real own apiKey -> true", () => {
    expect(domainUsesOwnKey(settingsWith({ detect: { enabled: true, apiKey: "sk-own" } }), "detect")).toBe(
      true,
    );
  });
});

describe("primaryTelemetryDomains", () => {
  it("no overrides: every telemetry bucket attributes to primary", () => {
    const domains = primaryTelemetryDomains(DEFAULT_SETTINGS);
    expect(domains.sort()).toEqual(["define", "detect", "summary", "translate"].sort());
  });

  it("an enabled+keyed detect override excludes detect AND define (define rides detect's creds)", () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      taskLlm: { detect: { enabled: true, apiKey: "sk-detect-own" } },
    };
    const domains = primaryTelemetryDomains(settings);
    expect(domains).not.toContain("detect");
    expect(domains).not.toContain("define");
    expect(domains.sort()).toEqual(["summary", "translate"].sort());
  });

  it("an enabled but blank-key override does NOT exclude its domain (still inherits primary)", () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      taskLlm: { translate: { enabled: true, apiKey: "" } },
    };
    expect(primaryTelemetryDomains(settings).sort()).toEqual(
      ["define", "detect", "summary", "translate"].sort(),
    );
  });
});

describe("TASK_DOMAIN_TELEMETRY", () => {
  it("detect covers define too; translate/summary are 1:1", () => {
    expect(TASK_DOMAIN_TELEMETRY.detect.sort()).toEqual(["define", "detect"].sort());
    expect(TASK_DOMAIN_TELEMETRY.translate).toEqual(["translate"]);
    expect(TASK_DOMAIN_TELEMETRY.summary).toEqual(["summary"]);
  });
});
