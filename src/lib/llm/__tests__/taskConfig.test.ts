// resolveTaskCreds (#56): pure inheritance resolver, unit-tested FIRST
// per the design's non-negotiable — including a byte-for-byte
// round-trip proof against the pre-#56 authHeaders shape (client.ts)
// for every domain, since an absent taskLlm must be indistinguishable
// from today's behavior.
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, PROVIDER_HEADERS, type LlmTaskDomain, type Settings } from "../../types";
import { resolveTaskCreds } from "../taskConfig";

const DOMAINS: LlmTaskDomain[] = ["translate", "detect", "summary"];

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

/** The pre-#56 header builder (client.ts's authHeaders, reproduced
 *  verbatim here as the legacy oracle) — NOT imported from client.ts,
 *  because client.ts is being migrated to build headers off
 *  resolveTaskCreds itself in this same change; importing it would
 *  test the new code against itself instead of against the old
 *  contract. This is the "old settings.provider/baseUrl/apiKey" shape
 *  the round-trip test below asserts resolveTaskCreds still produces
 *  when taskLlm is absent. */
function legacyAuthHeaders(settings: Settings): Record<string, string> {
  const headers: Record<string, string> = {
    [PROVIDER_HEADERS.provider]: settings.provider,
  };
  if (settings.apiKey) {
    headers[PROVIDER_HEADERS.key] = settings.apiKey;
  }
  if (settings.provider === "openai-compat" && settings.baseUrl) {
    headers[PROVIDER_HEADERS.baseUrl] = settings.baseUrl;
  }
  return headers;
}

/** Build the same header shape from a ResolvedTaskCreds — mirrors what
 *  client.ts's taskHeaders (Q3) does with resolveTaskCreds' output. */
function headersFromResolved(creds: { provider: string; baseUrl: string; apiKey: string }): Record<string, string> {
  const headers: Record<string, string> = {
    [PROVIDER_HEADERS.provider]: creds.provider,
  };
  if (creds.apiKey) {
    headers[PROVIDER_HEADERS.key] = creds.apiKey;
  }
  if (creds.provider === "openai-compat" && creds.baseUrl) {
    headers[PROVIDER_HEADERS.baseUrl] = creds.baseUrl;
  }
  return headers;
}

describe("resolveTaskCreds — round-trip equivalence (absent taskLlm ≡ legacy)", () => {
  const legacyShapedSettings: Partial<Settings>[] = [
    {}, // pure defaults: anthropic, no key
    { provider: "openai-compat", baseUrl: "https://api.deepseek.com", apiKey: "sk-legacy" },
    { provider: "anthropic", apiKey: "sk-ant-legacy" },
    // openai-compat with NO baseUrl set — legacy authHeaders omits the
    // base-url header in this case; resolver must match exactly.
    { provider: "openai-compat", baseUrl: "", apiKey: "sk-legacy" },
  ];

  for (const domain of DOMAINS) {
    for (const [i, overrides] of legacyShapedSettings.entries()) {
      it(`domain=${domain}, settings variant #${i}: headers are byte-for-byte identical to the old authHeaders(settings) output`, () => {
        const settings = makeSettings(overrides);
        const resolved = resolveTaskCreds(settings, domain);
        expect(headersFromResolved(resolved)).toEqual(legacyAuthHeaders(settings));
      });
    }
  }

  it("detect: model matches settings.detectModel exactly (legacy site read settings.detectModel directly)", () => {
    const settings = makeSettings({ detectModel: "claude-haiku-4-5" });
    expect(resolveTaskCreds(settings, "detect").model).toBe(settings.detectModel);
  });

  it("summary: model matches settings.summaryModel exactly", () => {
    const settings = makeSettings({ summaryModel: "claude-sonnet-5" });
    expect(resolveTaskCreds(settings, "summary").model).toBe(settings.summaryModel);
  });

  it("translate: model is empty string when taskLlm is absent (translate has no legacy top-level model field — today's TranslateRequest never sent one)", () => {
    const settings = makeSettings();
    expect(resolveTaskCreds(settings, "translate").model).toBe("");
  });
});

describe("resolveTaskCreds — disabled/absent entry falls through to primary", () => {
  it("an entry present but enabled:false behaves exactly like no entry at all, for every field", () => {
    const withNoEntry = makeSettings({ detectModel: "claude-haiku-4-5" });
    const withDisabledEntry = makeSettings({
      detectModel: "claude-haiku-4-5",
      taskLlm: {
        detect: { enabled: false, provider: "openai-compat", baseUrl: "https://evil.example.com", apiKey: "leaked-key", model: "leaked-model" },
      },
    });
    expect(resolveTaskCreds(withDisabledEntry, "detect")).toEqual(resolveTaskCreds(withNoEntry, "detect"));
  });

  it("SECURITY: {enabled:false, provider:'openai-compat'} must NOT leak the override provider/baseUrl/model into the resolved result", () => {
    const settings = makeSettings({
      provider: "anthropic",
      baseUrl: "",
      apiKey: "primary-key",
      taskLlm: {
        translate: {
          enabled: false,
          provider: "openai-compat",
          baseUrl: "https://attacker.example.com/v1",
          apiKey: "attacker-key",
          model: "attacker-model",
        },
      },
    });
    const resolved = resolveTaskCreds(settings, "translate");
    expect(resolved.provider).toBe("anthropic"); // NOT openai-compat
    expect(resolved.baseUrl).toBe(""); // NOT the attacker baseUrl
    expect(resolved.apiKey).toBe("primary-key"); // NOT the attacker key
    expect(resolved.model).toBe(""); // NOT the attacker model — inherited default
  });

  it("no taskLlm map at all (undefined) resolves identically to an empty map", () => {
    const settingsUndefined = makeSettings({ taskLlm: undefined });
    const settingsEmptyMap = makeSettings({ taskLlm: {} });
    for (const domain of DOMAINS) {
      expect(resolveTaskCreds(settingsUndefined, domain)).toEqual(resolveTaskCreds(settingsEmptyMap, domain));
    }
  });
});

describe("resolveTaskCreds — enabled override inheritance, field by field", () => {
  it("enabled:true with every field set overrides the primary entirely", () => {
    const settings = makeSettings({
      provider: "anthropic",
      baseUrl: "",
      apiKey: "primary-key",
      detectModel: "claude-haiku-4-5",
      taskLlm: {
        detect: {
          enabled: true,
          provider: "openai-compat",
          baseUrl: "https://api.deepseek.com",
          apiKey: "domain-key",
          model: "deepseek-chat",
        },
      },
    });
    expect(resolveTaskCreds(settings, "detect")).toEqual({
      provider: "openai-compat",
      baseUrl: "https://api.deepseek.com",
      apiKey: "domain-key",
      model: "deepseek-chat",
    });
  });

  it("enabled:true with a blank apiKey inherits the PRIMARY key (documented 'blank per-domain key = inherit primary key' rule)", () => {
    const settings = makeSettings({
      apiKey: "primary-key",
      taskLlm: { summary: { enabled: true, apiKey: "" } },
    });
    expect(resolveTaskCreds(settings, "summary").apiKey).toBe("primary-key");
  });

  it("enabled:true with only `model` set inherits provider/baseUrl/apiKey from primary, overrides only the model", () => {
    const settings = makeSettings({
      provider: "anthropic",
      baseUrl: "",
      apiKey: "primary-key",
      summaryModel: "claude-sonnet-5",
      taskLlm: { summary: { enabled: true, model: "claude-opus-4-8" } },
    });
    expect(resolveTaskCreds(settings, "summary")).toEqual({
      provider: "anthropic",
      baseUrl: "",
      apiKey: "primary-key",
      model: "claude-opus-4-8",
    });
  });

  it("enabled:true with no model set falls back to the domain's PRIMARY model field, not empty string (detect/summary)", () => {
    const settings = makeSettings({
      detectModel: "claude-haiku-4-5",
      taskLlm: { detect: { enabled: true, provider: "openai-compat", baseUrl: "https://api.deepseek.com" } },
    });
    expect(resolveTaskCreds(settings, "detect").model).toBe("claude-haiku-4-5");
  });

  it("enabled:true for translate with no model set resolves to '' (translate's inheritance root, same as disabled)", () => {
    const settings = makeSettings({
      taskLlm: { translate: { enabled: true, provider: "openai-compat", baseUrl: "https://api.deepseek.com" } },
    });
    expect(resolveTaskCreds(settings, "translate").model).toBe("");
  });

  it("domains are fully independent — configuring one domain never affects another's resolution", () => {
    const settings = makeSettings({
      detectModel: "claude-haiku-4-5",
      summaryModel: "claude-sonnet-5",
      taskLlm: {
        detect: { enabled: true, provider: "openai-compat", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
      },
    });
    // summary and translate were never touched — must resolve exactly
    // as if taskLlm.detect didn't exist.
    expect(resolveTaskCreds(settings, "summary")).toEqual({
      provider: "anthropic",
      baseUrl: "",
      apiKey: "",
      model: "claude-sonnet-5",
    });
    expect(resolveTaskCreds(settings, "translate")).toEqual({
      provider: "anthropic",
      baseUrl: "",
      apiKey: "",
      model: "",
    });
  });
});
