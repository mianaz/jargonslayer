// v0.5.1 desktop keychain custody design — secret.ts's real read/write/
// migration behavior, IS_DESKTOP genuinely TRUE. IS_DESKTOP is a
// module-scope import-time const (lib/platform/desktop.ts) — vi.mock
// affects this whole file, so this lives in its own file rather than a
// describe block inside secret.test.ts, which needs the REAL (false)
// value for its own ambient guard coverage — same split mlxCaps.
// desktop.test.ts/mlxCaps.test.ts already established for the identical
// constraint (see that pair's own header comments).
//
// getInvoke is mocked with a small in-memory "fake Keychain" (a plain
// Map<name, value> behind secret_get/secret_set/secret_delete) rather
// than a bare fakeInvoke() per call, since hydrateSecrets' own migration
// scenarios need a STATEFUL backend that persists across multiple
// invoke() calls within one test (set then get-back, or "already has a
// value from an earlier boot").

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../platform/desktop", () => ({ IS_DESKTOP: true }));

let currentInvoke: import("../tauriApi").InvokeFn | null = null;
vi.mock("../tauriApi", () => ({
  getInvoke: () => {
    if (!currentInvoke) {
      return Promise.reject(new Error("secret.desktop.test.ts: getInvoke() called with no currentInvoke set"));
    }
    return Promise.resolve(currentInvoke);
  },
}));

import { hydrateSecrets, readSecrets, SECRET_NAMES, writeSecret, type SecretName } from "../secret";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import type { InvokeFn } from "../tauriApi";

/** A small in-memory stand-in for secret.rs's own backend (Keychain or
 *  its debug-file fallback — either way, the wire contract this module
 *  actually depends on is identical): secret_get/secret_set/
 *  secret_delete backed by one Map, so a test can drive a realistic
 *  multi-call sequence (write then read back, or seed a value as if an
 *  earlier boot already migrated it). `failNames` simulates a per-name
 *  failure (e.g. an ACL denial) on secret_set/secret_delete ONLY — never
 *  secret_get, matching the real Rust contract (a get never "fails" for
 *  a name that simply isn't there, see map_get_result's own NoEntry ->
 *  Ok(None) mapping; the get-failure path is exercised separately via
 *  failGetNames below). */
function makeFakeKeychain(
  initial: Partial<Record<SecretName, string>> = {},
  opts: { failNames?: Set<string>; failGetNames?: Set<string> } = {},
): { invoke: InvokeFn; store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(initial));
  const invoke: InvokeFn = (async (cmd: string, args?: Record<string, unknown>) => {
    const name = (args as { name: string }).name;
    if (cmd === "secret_get") {
      if (opts.failGetNames?.has(name)) throw new Error(`simulated secret_get failure for ${name}`);
      return store.has(name) ? store.get(name)! : null;
    }
    if (cmd === "secret_set") {
      if (opts.failNames?.has(name)) throw new Error(`simulated secret_set failure for ${name}`);
      store.set(name, (args as { value: string }).value);
      return null;
    }
    if (cmd === "secret_delete") {
      if (opts.failNames?.has(name)) throw new Error(`simulated secret_delete failure for ${name}`);
      store.delete(name);
      return null;
    }
    throw new Error(`unexpected command ${cmd}`);
  }) as InvokeFn;
  return { invoke, store };
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

beforeEach(() => {
  currentInvoke = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("readSecrets", () => {
  it("returns only the non-empty values, keyed by name", async () => {
    const fake = makeFakeKeychain({ apiKey: "sk-secret", hfToken: "" });
    currentInvoke = fake.invoke;

    await expect(readSecrets()).resolves.toEqual({ apiKey: "sk-secret" });
  });

  it("resolves {} when nothing is stored for any name", async () => {
    currentInvoke = makeFakeKeychain().invoke;
    await expect(readSecrets()).resolves.toEqual({});
  });

  it("omits a name whose secret_get call rejects, without failing the whole read", async () => {
    const fake = makeFakeKeychain(
      { apiKey: "sk-secret", hfToken: "hf-secret" },
      { failGetNames: new Set(["hfToken"]) },
    );
    currentInvoke = fake.invoke;

    await expect(readSecrets()).resolves.toEqual({ apiKey: "sk-secret" });
  });

  it("fail-opens to {} when getInvoke() itself fails", async () => {
    currentInvoke = null; // the mock above rejects when unset
    await expect(readSecrets()).resolves.toEqual({});
  });

  it("times out to {} rather than blocking forever when a read hangs (e.g. a locked keychain)", async () => {
    vi.useFakeTimers();
    currentInvoke = (async () => new Promise(() => {})) as InvokeFn; // never resolves
    const promise = readSecrets();

    await vi.advanceTimersByTimeAsync(3000);

    await expect(promise).resolves.toEqual({});
  });

  // F3 fix (Sol MEDIUM #11, keychain-custody fix round): a hang on ONE
  // name used to discard the other four good reads too (one shared race
  // around the whole Promise.all) — each name now races its OWN timer.
  it("a hung read for ONE name still returns the other four (per-key timeout, not one shared race)", async () => {
    vi.useFakeTimers();
    const fake = makeFakeKeychain({
      apiKey: "sk-secret",
      sonioxKey: "sx-secret",
      deepgramKey: "dg-secret",
      agentToken: "at-secret",
    });
    currentInvoke = (async (cmd: string, args?: Record<string, unknown>) => {
      const name = (args as { name: string }).name;
      if (cmd === "secret_get" && name === "hfToken") {
        return new Promise(() => {}); // hangs forever
      }
      return fake.invoke(cmd, args);
    }) as InvokeFn;

    const promise = readSecrets();
    await vi.advanceTimersByTimeAsync(3000);

    await expect(promise).resolves.toEqual({
      apiKey: "sk-secret",
      sonioxKey: "sx-secret",
      deepgramKey: "dg-secret",
      agentToken: "at-secret",
    });
  });
});

describe("writeSecret", () => {
  it("a non-empty value calls secret_set and resolves true", async () => {
    const fake = makeFakeKeychain();
    currentInvoke = fake.invoke;

    await expect(writeSecret("apiKey", "sk-new")).resolves.toBe(true);
    expect(fake.store.get("apiKey")).toBe("sk-new");
  });

  it("an empty value calls secret_delete (not secret_set) and resolves true", async () => {
    const fake = makeFakeKeychain({ apiKey: "sk-old" });
    currentInvoke = fake.invoke;

    await expect(writeSecret("apiKey", "")).resolves.toBe(true);
    expect(fake.store.has("apiKey")).toBe(false);
  });

  it("never throws — a rejected secret_set resolves false instead", async () => {
    const fake = makeFakeKeychain({}, { failNames: new Set(["apiKey"]) });
    currentInvoke = fake.invoke;

    await expect(writeSecret("apiKey", "sk-new")).resolves.toBe(false);
  });

  it("never throws — getInvoke() itself failing resolves false", async () => {
    currentInvoke = null;
    await expect(writeSecret("apiKey", "sk-new")).resolves.toBe(false);
  });
});

// The blueprint's own load-bearing migration matrix (a)-(d).
describe("hydrateSecrets — migration + custody", () => {
  it("(a) plaintext IDB + empty keychain: copies up, custody set, migratedAndClean true", async () => {
    const fake = makeFakeKeychain();
    currentInvoke = fake.invoke;
    const settings = makeSettings({ apiKey: "sk-plain", hfToken: "hf-plain" });

    const result = await hydrateSecrets(settings);

    expect(result.settings.apiKey).toBe("sk-plain");
    expect(result.settings.hfToken).toBe("hf-plain");
    expect(new Set(result.custodyNames)).toEqual(new Set(["apiKey", "hfToken"]));
    expect(result.migratedAndClean).toBe(true);
    expect(fake.store.get("apiKey")).toBe("sk-plain");
    expect(fake.store.get("hfToken")).toBe("hf-plain");
  });

  it("(b) a write failure on ONE field: the others still migrate, the failed one stays in IDB and OUT of custody, migratedAndClean false", async () => {
    const fake = makeFakeKeychain({}, { failNames: new Set(["hfToken"]) });
    currentInvoke = fake.invoke;
    const settings = makeSettings({ apiKey: "sk-plain", hfToken: "hf-plain", sonioxKey: "sx-plain" });

    const result = await hydrateSecrets(settings);

    expect(result.settings.apiKey).toBe("sk-plain");
    expect(result.settings.hfToken).toBe("hf-plain"); // stays live in memory either way
    expect(result.settings.sonioxKey).toBe("sx-plain");
    expect(result.custodyNames.sort()).toEqual(["apiKey", "sonioxKey"]);
    expect(result.custodyNames).not.toContain("hfToken");
    expect(result.migratedAndClean).toBe(false); // NOT all-or-nothing clean this boot
    expect(fake.store.get("apiKey")).toBe("sk-plain");
    expect(fake.store.has("hfToken")).toBe(false); // the failed write never landed
  });

  it("(c) a completed migration re-run (IDB already stripped, keychain already holds the values) is a no-op — adopts live, no writes, migratedAndClean false", async () => {
    const fake = makeFakeKeychain({ apiKey: "sk-already-migrated" });
    currentInvoke = fake.invoke;
    // Wrap to count secret_set calls specifically.
    let setCalls = 0;
    currentInvoke = (async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "secret_set") setCalls += 1;
      return fake.invoke(cmd, args);
    }) as InvokeFn;
    const settings = makeSettings({ apiKey: "" }); // already stripped from IDB

    const result = await hydrateSecrets(settings);

    expect(result.settings.apiKey).toBe("sk-already-migrated"); // adopted live from the keychain
    expect(result.custodyNames).toEqual(["apiKey"]);
    expect(result.migratedAndClean).toBe(false); // nothing NEW to migrate this boot
    expect(setCalls).toBe(0); // no redundant write
  });

  it("(d) a keychain read failure fail-opens the boot: fields stay whatever the IDB blob already had, nothing wiped, nothing migrated", async () => {
    currentInvoke = null; // readSecrets() -> {} (fail-open, see secret.test.ts's own coverage)
    const settings = makeSettings({ apiKey: "" }); // nothing in IDB either (already-migrated scenario)

    const result = await hydrateSecrets(settings);

    expect(result.settings.apiKey).toBe(""); // absent, not wiped from anywhere real
    expect(result.custodyNames).toEqual([]);
    expect(result.migratedAndClean).toBe(false);
  });

  it("every SECRET_NAMES field participates, not just apiKey", async () => {
    const fake = makeFakeKeychain();
    currentInvoke = fake.invoke;
    const settings = makeSettings(
      Object.fromEntries(SECRET_NAMES.map((name) => [name, `${name}-plain`])) as Partial<Settings>,
    );

    const result = await hydrateSecrets(settings);

    expect(new Set(result.custodyNames)).toEqual(new Set(SECRET_NAMES));
    expect(result.migratedAndClean).toBe(true);
    for (const name of SECRET_NAMES) {
      expect(fake.store.get(name)).toBe(`${name}-plain`);
    }
  });
});

// F2 fix (Sol HIGH #4, keychain-custody fix round) — secretDeletePending
// consult-first retry, see hydrateSecrets' own doc.
describe("hydrateSecrets — F2 delete-tombstone retry", () => {
  it("retries the delete instead of adopting the stale keychain value; success clears the tombstone", async () => {
    const fake = makeFakeKeychain({ apiKey: "sk-stale-undeleted" });
    currentInvoke = fake.invoke;
    const settings = makeSettings({ apiKey: "", secretDeletePending: ["apiKey"] });

    const result = await hydrateSecrets(settings);

    expect(result.settings.apiKey).toBe(""); // never adopted
    expect(result.custodyNames).not.toContain("apiKey");
    expect(result.settings.secretDeletePending).toEqual([]); // retry succeeded — tombstone cleared
    expect(fake.store.has("apiKey")).toBe(false); // actually gone from the keychain now
  });

  it("a retry that ALSO fails keeps the tombstone pending and still does not adopt", async () => {
    const fake = makeFakeKeychain({ apiKey: "sk-stale-undeleted" }, { failNames: new Set(["apiKey"]) });
    currentInvoke = fake.invoke;
    const settings = makeSettings({ apiKey: "", secretDeletePending: ["apiKey"] });

    const result = await hydrateSecrets(settings);

    expect(result.settings.apiKey).toBe(""); // still not adopted
    expect(result.settings.secretDeletePending).toEqual(["apiKey"]); // retry failed — stays pending
    expect(fake.store.get("apiKey")).toBe("sk-stale-undeleted"); // untouched
  });

  it("an unrelated tombstoned name is left alone and does not block ordinary migration of the others", async () => {
    const fake = makeFakeKeychain({ hfToken: "hf-stale-undeleted" });
    currentInvoke = fake.invoke;
    const settings = makeSettings({ apiKey: "sk-plain", hfToken: "", secretDeletePending: ["hfToken"] });

    const result = await hydrateSecrets(settings);

    expect(result.settings.apiKey).toBe("sk-plain");
    expect(result.custodyNames).toContain("apiKey");
    expect(result.settings.hfToken).toBe(""); // not adopted
    expect(result.settings.secretDeletePending).toEqual([]);
  });

  it("a garbage/non-SECRET_NAMES entry in secretDeletePending is ignored rather than crashing the hydrate", async () => {
    currentInvoke = makeFakeKeychain().invoke;
    const settings = makeSettings({ secretDeletePending: ["not-a-real-secret-name"] });

    const result = await hydrateSecrets(settings);

    expect(result.settings.secretDeletePending).toEqual([]);
  });
});
