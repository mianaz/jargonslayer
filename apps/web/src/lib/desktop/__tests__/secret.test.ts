// v0.5.1 desktop keychain custody design — secret.ts's IS_DESKTOP guard,
// exercised in the test env's default (NEXT_PUBLIC_DESKTOP unset) state,
// same "ambient, no vi.mock gymnastics" posture mlxCaps.test.ts's own
// probeMlxCaps describe block uses for the identical constraint. The
// REAL read/write/migration behavior (needs IS_DESKTOP=true + a fake
// invoke) lives in secret.desktop.test.ts, mirroring mlxCaps.desktop.
// test.ts's own split from mlxCaps.test.ts.

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import { hydrateSecrets, readSecrets, SECRET_NAMES, writeSecret } from "../secret";

describe("secret.ts — IS_DESKTOP guard (ambient, IS_DESKTOP false in this test env)", () => {
  // Translation-rework wave 1: deeplKey joins this list on the TS side
  // (types.ts's own doc). v0.7.1 translation train-2: youdaoAppKey/
  // youdaoAppSecret join it the same way — secret.rs's own ALLOWED array
  // (Rust, apps/desktop/src-tauri) mirrors this list byte-for-byte.
  it("SECRET_NAMES pins the exact field names secret.rs's own ALLOWED list mirrors", () => {
    expect(SECRET_NAMES).toEqual([
      "apiKey",
      "hfToken",
      "sonioxKey",
      "deepgramKey",
      "elevenLabsKey",
      "agentToken",
      "deeplKey",
      "youdaoAppKey",
      "youdaoAppSecret",
    ]);
  });

  it("readSecrets() resolves {} immediately, never reaching getInvoke()", async () => {
    await expect(readSecrets()).resolves.toEqual({});
  });

  it("writeSecret() resolves false immediately for every SECRET_NAMES field", async () => {
    for (const name of SECRET_NAMES) {
      await expect(writeSecret(name, "some-value")).resolves.toBe(false);
    }
  });

  it("hydrateSecrets() never migrates anything outside a desktop build — writeSecret's own false leaves values live but out of custody", async () => {
    const settings = { ...DEFAULT_SETTINGS, apiKey: "sk-plaintext" };
    const result = await hydrateSecrets(settings);

    expect(result.settings.apiKey).toBe("sk-plaintext"); // unchanged — nothing migrated
    expect(result.custodyNames).toEqual([]);
    expect(result.migratedAndClean).toBe(false);
  });
});
