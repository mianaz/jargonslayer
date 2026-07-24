// v0.5.1 desktop keychain custody design — autoExport.ts's desktop-only
// keychain routing (buildFullBackup's readSecrets() overlay,
// restoreFullBackup's routeRestoredSecretsToKeychain), IS_DESKTOP
// genuinely TRUE. IS_DESKTOP is a module-scope import-time const
// (lib/platform/desktop.ts) — vi.mock affects this whole file, so this
// lives in its own file rather than a describe block inside
// autoExport.test.ts, which needs the REAL (false) value for its own
// ambient (ordinary web backup/restore) coverage — same split
// mlxCaps.desktop.test.ts/mlxCaps.test.ts already established for the
// identical constraint (see that pair's own header comments).
//
// lib/desktop/secret.ts is mocked with a small in-memory "fake
// Keychain" — the actual read/write ALGORITHM is covered directly in
// secret.desktop.test.ts, no need to re-derive it here; this suite only
// proves autoExport.ts's OWN call sites (when it reads/writes, what it
// does with the result).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";

vi.mock("../../platform/desktop", () => ({ IS_DESKTOP: true }));

const SECRET_NAMES = ["apiKey", "hfToken", "sonioxKey", "deepgramKey", "agentToken"] as const;
type SecretName = (typeof SECRET_NAMES)[number];

let keychain: Map<string, string>;
let failWriteNames: Set<string>;
const mockReadSecrets = vi.fn(async () => {
  const out: Partial<Record<SecretName, string>> = {};
  for (const [k, v] of keychain) out[k as SecretName] = v;
  return out;
});
const mockWriteSecret = vi.fn(async (name: SecretName, value: string) => {
  if (failWriteNames.has(name)) return false;
  if (value) keychain.set(name, value);
  else keychain.delete(name);
  return true;
});
vi.mock("../../desktop/secret", () => ({
  SECRET_NAMES,
  readSecrets: () => mockReadSecrets(),
  writeSecret: (name: SecretName, value: string) => mockWriteSecret(name, value),
}));

// Same in-memory idb-keyval mock as autoExport.test.ts itself.
const memStore = new Map<string, unknown>();
vi.mock("idb-keyval", () => ({
  get: vi.fn(async (key: string) => memStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    memStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    memStore.delete(key);
  }),
}));

function keyedSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    apiKey: "sk-ant-secret",
    hfToken: "hf-secret",
    sonioxKey: "soniox-secret",
    deepgramKey: "deepgram-secret",
    agentToken: "agent-secret",
    ...overrides,
  };
}

beforeEach(() => {
  memStore.clear();
  keychain = new Map();
  failWriteNames = new Set();
  mockReadSecrets.mockClear();
  mockWriteSecret.mockClear();
  (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
});

afterEach(() => {
  vi.clearAllMocks();
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

describe("buildFullBackup — desktop keychain overlay (v0.5.1)", () => {
  it("includeKeys:true overlays the Keychain's own values onto the exported settings", async () => {
    const storage = await import("../storage");
    // Post-migration shape: the IDB blob itself is keyless, the real
    // values only live in the (mocked) Keychain.
    await storage.saveSettings({ ...DEFAULT_SETTINGS, apiKey: "", hfToken: "" });
    keychain.set("apiKey", "sk-from-keychain");
    keychain.set("hfToken", "hf-from-keychain");

    const autoExport = await import("../autoExport");
    const json = await autoExport.buildFullBackup({ includeKeys: true });
    const parsed = JSON.parse(json) as { settings: Settings };

    expect(parsed.settings.apiKey).toBe("sk-from-keychain");
    expect(parsed.settings.hfToken).toBe("hf-from-keychain");
  });

  it("an IDB value present alongside a Keychain value still exports the IDB value (readSecrets is just an overlay onto the loaded blob, not a full substitute)", async () => {
    const storage = await import("../storage");
    await storage.saveSettings({ ...DEFAULT_SETTINGS, apiKey: "sk-in-idb" });
    keychain.set("apiKey", "sk-in-keychain-stale");

    const autoExport = await import("../autoExport");
    const json = await autoExport.buildFullBackup({ includeKeys: true });
    const parsed = JSON.parse(json) as { settings: Settings };

    expect(parsed.settings.apiKey).toBe("sk-in-idb");
  });

  it("includeKeys:false never reads the Keychain at all — stripping makes it pointless", async () => {
    const storage = await import("../storage");
    await storage.saveSettings(keyedSettings());

    const autoExport = await import("../autoExport");
    const json = await autoExport.buildFullBackup({ includeKeys: false });
    const parsed = JSON.parse(json) as { settings: Settings };

    expect(mockReadSecrets).not.toHaveBeenCalled();
    expect(parsed.settings.apiKey).toBe("");
    expect(parsed.settings.hfToken).toBe("");
  });

  it("no settings record at all — includeKeys:true is a graceful no-op (settings stays null, no crash)", async () => {
    const autoExport = await import("../autoExport");
    const json = await autoExport.buildFullBackup({ includeKeys: true });
    const parsed = JSON.parse(json) as { settings: Settings | null };

    expect(parsed.settings).toBeNull();
    expect(mockReadSecrets).not.toHaveBeenCalled();
  });
});

describe("restoreFullBackup — desktop keychain routing (v0.5.1)", () => {
  it("routes every non-empty apiKey/hfToken/sonioxKey/deepgramKey to the Keychain and blanks them on the object that gets saved to IDB; also deletes any stale Keychain agentToken (F6 fix, keychain-custody fix round)", async () => {
    const storage = await import("../storage");
    const saveSpy = vi.spyOn(storage, "saveSettings");
    const autoExport = await import("../autoExport");
    keychain.set("agentToken", "stale-agent-token"); // leftover from a PREVIOUS pairing
    const backup = JSON.stringify({
      schemaVersion: 1,
      kind: "jargonslayer-backup",
      sessions: [],
      glossary: [],
      settings: keyedSettings(),
    });

    await autoExport.restoreFullBackup(backup);

    expect(mockWriteSecret).toHaveBeenCalledWith("apiKey", "sk-ant-secret");
    expect(mockWriteSecret).toHaveBeenCalledWith("hfToken", "hf-secret");
    expect(mockWriteSecret).toHaveBeenCalledWith("sonioxKey", "soniox-secret");
    expect(mockWriteSecret).toHaveBeenCalledWith("deepgramKey", "deepgram-secret");
    // F6 fix: agentToken is force-cleared in the BLOB by
    // sanitizeRestoredSettings (never a non-empty value to route the
    // ordinary way above), but a stale Keychain entry from an earlier
    // pairing survives that blanking unless explicitly deleted too.
    expect(mockWriteSecret).toHaveBeenCalledWith("agentToken", "");

    const saved = saveSpy.mock.calls[0][0];
    expect(saved.apiKey).toBe("");
    expect(saved.hfToken).toBe("");
    expect(saved.sonioxKey).toBe("");
    expect(saved.deepgramKey).toBe("");
    expect(saved.agentToken).toBe(""); // sanitizeRestoredSettings' own force-clear
    expect(saved.secretDeletePending).toEqual([]); // every routed name (including agentToken) resolved cleanly

    expect(keychain.get("apiKey")).toBe("sk-ant-secret");
    expect(keychain.get("hfToken")).toBe("hf-secret");
    expect(keychain.has("agentToken")).toBe(false); // the stale entry is now actually gone
  });

  it("a write failure on one field leaves ITS plaintext value in the object saved to IDB (fail-open) while the others still route+blank", async () => {
    failWriteNames.add("hfToken");
    const storage = await import("../storage");
    const saveSpy = vi.spyOn(storage, "saveSettings");
    const autoExport = await import("../autoExport");
    const backup = JSON.stringify({
      schemaVersion: 1,
      kind: "jargonslayer-backup",
      sessions: [],
      glossary: [],
      settings: keyedSettings(),
    });

    await autoExport.restoreFullBackup(backup);

    const saved = saveSpy.mock.calls[0][0];
    expect(saved.apiKey).toBe(""); // routed fine
    expect(saved.hfToken).toBe("hf-secret"); // write failed — stays plaintext
    expect(keychain.has("hfToken")).toBe(false);
  });

  it("empty BYOK key fields in the backup never call writeSecret for those names (agentToken's own unconditional delete is separate — F6 fix)", async () => {
    const autoExport = await import("../autoExport");
    const backup = JSON.stringify({
      schemaVersion: 1,
      kind: "jargonslayer-backup",
      sessions: [],
      glossary: [],
      settings: { ...DEFAULT_SETTINGS }, // every BYOK key field already blank
    });

    await autoExport.restoreFullBackup(backup);

    expect(mockWriteSecret).not.toHaveBeenCalledWith("apiKey", expect.anything());
    expect(mockWriteSecret).not.toHaveBeenCalledWith("hfToken", expect.anything());
    expect(mockWriteSecret).not.toHaveBeenCalledWith("sonioxKey", expect.anything());
    expect(mockWriteSecret).not.toHaveBeenCalledWith("deepgramKey", expect.anything());
    // F6 fix: attempted regardless of what the rest of the backup contains.
    expect(mockWriteSecret).toHaveBeenCalledWith("agentToken", "");
  });
});

// F2 fix (Sol HIGH #4, migration/backup interplay) — a restore replaces
// the whole settings blob; THIS machine's own pre-restore
// secretDeletePending tombstones must survive that unless the restore's
// own routing resolves them, or a stale, still-undeleted Keychain entry
// loses its retry-on-next-hydrate tracking and gets silently re-adopted
// post-restore (see routeRestoredSecretsToKeychain's own doc).
describe("restoreFullBackup — secretDeletePending carries forward across a restore (F2 migration/backup interplay)", () => {
  it("carries a pre-existing local tombstone forward when this restore doesn't itself resolve that name", async () => {
    const storage = await import("../storage");
    await storage.saveSettings({ ...DEFAULT_SETTINGS, secretDeletePending: ["hfToken"] });
    const saveSpy = vi.spyOn(storage, "saveSettings");
    const autoExport = await import("../autoExport");
    const backup = JSON.stringify({
      schemaVersion: 1,
      kind: "jargonslayer-backup",
      sessions: [],
      glossary: [],
      settings: { ...DEFAULT_SETTINGS, apiKey: "sk-ant-secret" }, // hfToken absent/blank in the donor backup
    });

    await autoExport.restoreFullBackup(backup);

    // .at(-1), not [0]: a prior test's own vi.spyOn on this same method
    // is never vi.restoreAllMocks()'d by this file's shared afterEach
    // (only cleared) — this seed call above still lands as an earlier
    // recorded call on that same leftover spy. The restore's own save is
    // always the LAST call regardless.
    const saved = saveSpy.mock.calls.at(-1)?.[0];
    expect(saved?.secretDeletePending).toEqual(["hfToken"]); // carried forward, not silently dropped
  });

  it("a restore that DOES write a fresh value for a previously-tombstoned name clears that name's tombstone", async () => {
    const storage = await import("../storage");
    await storage.saveSettings({ ...DEFAULT_SETTINGS, secretDeletePending: ["hfToken"] });
    const saveSpy = vi.spyOn(storage, "saveSettings");
    const autoExport = await import("../autoExport");
    const backup = JSON.stringify({
      schemaVersion: 1,
      kind: "jargonslayer-backup",
      sessions: [],
      glossary: [],
      settings: { ...DEFAULT_SETTINGS, hfToken: "hf-fresh-from-backup" },
    });

    await autoExport.restoreFullBackup(backup);

    const saved = saveSpy.mock.calls.at(-1)?.[0]; // see the sibling test's own note on why .at(-1)
    expect(saved?.secretDeletePending).toEqual([]);
    expect(keychain.get("hfToken")).toBe("hf-fresh-from-backup");
  });
});
