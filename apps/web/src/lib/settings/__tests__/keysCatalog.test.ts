import { describe, expect, it } from "vitest";
import {
  ALL_KEYS_CATALOG,
  keysCatalogFieldId,
  PROVIDER_KEY_CATALOG,
  SERVICE_KEY_CATALOG,
  TASK_KEY_CATALOG,
} from "../keysCatalog";
import { PROVIDER_API_KEY_NAMES } from "@/lib/llm/providerKeys";

describe("keysCatalog — completeness of the dedicated 密钥 hub", () => {
  it("covers every PROVIDER_API_KEY_NAMES entry exactly once", () => {
    expect(PROVIDER_KEY_CATALOG.map((e) => e.field).sort()).toEqual(
      [...PROVIDER_API_KEY_NAMES].sort(),
    );
  });

  it("lists the three taskLlm override domains", () => {
    expect(TASK_KEY_CATALOG.map((e) => e.domain).sort()).toEqual(
      ["detect", "summary", "translate"].sort(),
    );
  });

  it("lists every non-LLM service credential (plus gated agentToken)", () => {
    expect(SERVICE_KEY_CATALOG.map((e) => e.field).sort()).toEqual(
      [
        "agentToken",
        "deeplKey",
        "deepgramKey",
        "elevenLabsKey",
        "hfToken",
        "sonioxKey",
        "youdaoAppKey",
        "youdaoAppSecret",
      ].sort(),
    );
  });

  it("ALL_KEYS_CATALOG field ids are unique", () => {
    const ids = ALL_KEYS_CATALOG.map(keysCatalogFieldId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
