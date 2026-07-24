// v0.5.1 desktop keychain custody design — store.ts's syncSecretCustody/
// settingsForPersist strip/flushSecrets/hydrate() migration orchestration,
// IS_DESKTOP genuinely TRUE. IS_DESKTOP is a module-scope import-time
// const (lib/platform/desktop.ts) — vi.mock affects this whole file, so
// this lives in its own file, mirroring mlxCaps.desktop.test.ts's own
// split from mlxCaps.test.ts (see that pair's own header comments).
//
// lib/desktop/secret.ts itself is mocked — this suite only proves
// store.ts's OWN orchestration (what it does with writeSecret's
// success/failure, what it does with hydrateSecrets' returned envelope);
// the actual read/write/migration ALGORITHM is covered directly in
// secret.desktop.test.ts, no need to re-derive it here.
//
// `secretCustody`/`pendingSecretWrites` are module-level state in
// store.ts, NOT part of AppState (deliberately — see that module's own
// doc) — resetSecretCustodyForTests() is the test-only escape hatch for
// it, same "module-level state that must never leak between independent
// it() blocks" posture as tauriApi.ts's resetTauriApiCache.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform/desktop", () => ({ IS_DESKTOP: true }));

const mockWriteSecret = vi.fn(async (_name: string, _value: string) => true);
const mockReadSecrets = vi.fn(async () => ({}) as Record<string, string>);
const mockHydrateSecrets = vi.fn(async (settings: Settings) => ({
  settings,
  custodyNames: [] as string[],
  migratedAndClean: false,
}));
vi.mock("../desktop/secret", () => ({
  SECRET_NAMES: ["apiKey", "hfToken", "sonioxKey", "deepgramKey", "agentToken"],
  readSecrets: () => mockReadSecrets(),
  writeSecret: (name: string, value: string) => mockWriteSecret(name, value),
  hydrateSecrets: (settings: Settings) => mockHydrateSecrets(settings),
}));

import { useApp, resetSecretCustodyForTests } from "../store";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import * as storageModule from "../history/storage";

function resetAll() {
  useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: false });
  resetSecretCustodyForTests();
  mockWriteSecret.mockClear();
  mockWriteSecret.mockImplementation(async () => true);
  mockReadSecrets.mockClear();
  mockReadSecrets.mockImplementation(async () => ({}));
  mockHydrateSecrets.mockClear();
  mockHydrateSecrets.mockImplementation(async (settings: Settings) => ({
    settings,
    custodyNames: [],
    migratedAndClean: false,
  }));
}

describe("updateSettings — enqueues a Keychain write only for a changed SECRET_NAMES field", () => {
  beforeEach(resetAll);
  afterEach(() => {
    vi.restoreAllMocks();
    resetAll();
  });

  it("the SAME value is a no-op — no write enqueued", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, apiKey: "sk-same" }, hydrated: true });

    useApp.getState().updateSettings({ apiKey: "sk-same" });
    await useApp.getState().flushSecrets();

    expect(mockWriteSecret).not.toHaveBeenCalled();
  });

  it("a non-SECRET_NAMES field change never enqueues a write", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: true });

    useApp.getState().updateSettings({ aiDetect: false });
    await useApp.getState().flushSecrets();

    expect(mockWriteSecret).not.toHaveBeenCalled();
  });

  it("a genuinely changed value enqueues exactly one write with the new value", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, apiKey: "sk-old" }, hydrated: true });

    useApp.getState().updateSettings({ apiKey: "sk-new" });
    await useApp.getState().flushSecrets();

    expect(mockWriteSecret).toHaveBeenCalledTimes(1);
    expect(mockWriteSecret).toHaveBeenCalledWith("apiKey", "sk-new");
  });

  it("fires regardless of opts.persist:false", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, apiKey: "sk-old" }, hydrated: true });

    useApp.getState().updateSettings({ apiKey: "sk-new" }, { persist: false });
    await useApp.getState().flushSecrets();

    expect(mockWriteSecret).toHaveBeenCalledWith("apiKey", "sk-new");
  });

  it("a multi-field patch enqueues one write per CHANGED SECRET_NAMES field it touches", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, apiKey: "sk-old", hfToken: "" }, hydrated: true });

    useApp.getState().updateSettings({ apiKey: "sk-new", hfToken: "hf-new", aiDetect: false });
    await useApp.getState().flushSecrets();

    expect(mockWriteSecret).toHaveBeenCalledTimes(2);
    expect(mockWriteSecret).toHaveBeenCalledWith("apiKey", "sk-new");
    expect(mockWriteSecret).toHaveBeenCalledWith("hfToken", "hf-new");
  });
});

describe("settingsForPersist — custody-gated strip (never a field merely NAMED in SECRET_NAMES)", () => {
  beforeEach(resetAll);
  afterEach(() => {
    vi.restoreAllMocks();
    resetAll();
  });

  it("strips a field once its write succeeds; leaves an untouched SECRET_NAMES field alone", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: "", hfToken: "hf-plain" },
      hydrated: true,
    });
    useApp.getState().updateSettings({ apiKey: "sk-new" });
    await useApp.getState().flushSecrets();

    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    await useApp.getState().flushSettings();

    const saved = saveSpy.mock.calls[0][0];
    expect(saved.apiKey).toBe(""); // stripped — confirmed in custody
    expect(saved.hfToken).toBe("hf-plain"); // never confirmed — left as-is
  });

  it("a failed write never strips — the plaintext value keeps riding the persisted blob (fail-open)", async () => {
    mockWriteSecret.mockResolvedValueOnce(false);
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, apiKey: "" }, hydrated: true });
    useApp.getState().updateSettings({ apiKey: "sk-new" });
    await useApp.getState().flushSecrets();

    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    await useApp.getState().flushSettings();

    expect(saveSpy.mock.calls[0][0].apiKey).toBe("sk-new");
  });

  it("clearing a custody field (write success, empty value) removes it from custody — a plaintext value that reappears later is no longer incorrectly stripped", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, apiKey: "" }, hydrated: true });
    useApp.getState().updateSettings({ apiKey: "sk-new" }); // -> custody gains apiKey
    await useApp.getState().flushSecrets();

    useApp.getState().updateSettings({ apiKey: "" }); // clears it -> custody LOSES apiKey
    await useApp.getState().flushSecrets();

    // Simulate a plaintext value reappearing in live settings WITHOUT
    // going through updateSettings again (e.g. a restored backup) —
    // proves custody genuinely forgot the name, not merely that its
    // current value happens to be empty.
    useApp.setState({ settings: { ...useApp.getState().settings, apiKey: "sk-reappeared" } });
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    await useApp.getState().flushSettings();

    expect(saveSpy.mock.calls[0][0].apiKey).toBe("sk-reappeared");
  });
});

describe("write failure — fail-open custody + non-blocking toast", () => {
  beforeEach(resetAll);
  afterEach(() => {
    vi.restoreAllMocks();
    resetAll();
  });

  it("the value stays live in memory, stays in the persisted IDB blob, and shows the warning toast", async () => {
    mockWriteSecret.mockResolvedValueOnce(false);
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, apiKey: "" }, hydrated: true });
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    useApp.getState().updateSettings({ apiKey: "sk-new" });
    await useApp.getState().flushSecrets();

    expect(useApp.getState().settings.apiKey).toBe("sk-new");
    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-new" }));
    expect(useApp.getState().toast).toBe("API Key 未能存入系统钥匙串，已临时保存在本地");
  });
});

describe("flushSecrets — resolves only after every enqueued write has settled", () => {
  beforeEach(resetAll);
  afterEach(() => {
    vi.restoreAllMocks();
    resetAll();
  });

  it("does not resolve while a write is still pending, then resolves once it lands", async () => {
    const order: string[] = [];
    let resolveWrite: (() => void) | undefined;
    mockWriteSecret.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveWrite = () => {
            order.push("write");
            resolve(true);
          };
        }),
    );
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, apiKey: "" }, hydrated: true });

    useApp.getState().updateSettings({ apiKey: "sk-new" });
    const flushed = useApp.getState().flushSecrets().then(() => order.push("flush"));

    // A macrotask tick drains every pending microtask (the dynamic
    // import() + its .then chain) without resolving the gate itself.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([]);

    resolveWrite!();
    await flushed;

    expect(order).toEqual(["write", "flush"]);
  });
});

// The blueprint's own load-bearing migration matrix — store-level half:
// hydrate() uses hydrateSecrets' returned envelope correctly (the
// migration ALGORITHM itself is secret.desktop.test.ts's job).
describe("hydrate() — keychain migration orchestration", () => {
  beforeEach(resetAll);
  afterEach(() => {
    vi.restoreAllMocks();
    resetAll();
  });

  it("adopts hydrateSecrets' merged settings and, when migratedAndClean, flushes the now-stripped blob", async () => {
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue({ ...DEFAULT_SETTINGS, apiKey: "sk-plain" });
    mockHydrateSecrets.mockResolvedValueOnce({
      settings: { ...DEFAULT_SETTINGS, apiKey: "sk-plain" },
      custodyNames: ["apiKey"],
      migratedAndClean: true,
    });
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    await useApp.getState().hydrate();

    expect(useApp.getState().settings.apiKey).toBe("sk-plain");
    // The cleanup flush strips apiKey — custody now confirms it.
    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "" }));
  });

  it("migratedAndClean:false does NOT trigger a follow-up flush", async () => {
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue({ ...DEFAULT_SETTINGS, apiKey: "sk-plain" });
    mockHydrateSecrets.mockResolvedValueOnce({
      settings: { ...DEFAULT_SETTINGS, apiKey: "sk-plain" },
      custodyNames: [],
      migratedAndClean: false,
    });
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    await useApp.getState().hydrate();

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("custodyNames populates custody even when migratedAndClean is false (an already-migrated field from an earlier boot) — a LATER save still strips it", async () => {
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue({ ...DEFAULT_SETTINGS, apiKey: "" });
    mockHydrateSecrets.mockResolvedValueOnce({
      settings: { ...DEFAULT_SETTINGS, apiKey: "sk-from-keychain" },
      custodyNames: ["apiKey"],
      migratedAndClean: false,
    });

    await useApp.getState().hydrate();
    expect(useApp.getState().settings.apiKey).toBe("sk-from-keychain");

    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    await useApp.getState().flushSettings();
    expect(saveSpy.mock.calls[0][0].apiKey).toBe(""); // stripped — already in custody
  });

  it("a hydrateSecrets() failure fails open — hydrate() still completes, settings keep whatever the loaded blob already had", async () => {
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue({ ...DEFAULT_SETTINGS, apiKey: "sk-plain" });
    mockHydrateSecrets.mockRejectedValueOnce(new Error("keychain hydration boom"));

    await useApp.getState().hydrate();

    expect(useApp.getState().hydrated).toBe(true);
    expect(useApp.getState().settings.apiKey).toBe("sk-plain");
  });

  // F5 fix (Sol MEDIUM #13, keychain-custody fix round): custody is
  // REPLACED from hydrateSecrets' result on each hydrate, never merely
  // added to — a stale name from an earlier hydrate must not survive a
  // later one that no longer confirms it.
  it("a name custodied by an EARLIER hydrate is no longer stripped once a LATER hydrate's result stops confirming it", async () => {
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue({ ...DEFAULT_SETTINGS, apiKey: "" });
    mockHydrateSecrets.mockResolvedValueOnce({
      settings: { ...DEFAULT_SETTINGS, apiKey: "sk-from-keychain" },
      custodyNames: ["apiKey"],
      migratedAndClean: false,
    });
    await useApp.getState().hydrate(); // first hydrate — apiKey enters custody

    // A second hydrate (e.g. a re-hydrate after a restore) whose result
    // no longer confirms apiKey in the Keychain at all.
    mockHydrateSecrets.mockResolvedValueOnce({
      settings: { ...DEFAULT_SETTINGS, apiKey: "sk-plaintext-again" },
      custodyNames: [],
      migratedAndClean: false,
    });
    await useApp.getState().hydrate();

    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    await useApp.getState().flushSettings();

    expect(saveSpy.mock.calls[0][0].apiKey).toBe("sk-plaintext-again"); // NOT stripped — stale custody didn't linger
  });
});

// F1 fix (Sol HIGH #3, keychain-custody fix round): a custody transition
// now kicks its own flushSettings() from inside syncSecretCustody, so a
// non-dialog writer (OAuth callback, onboarding steps — a bare
// updateSettings({apiKey/hfToken}) with no flushSettings/flushSecrets of
// its own) still gets a durable, correctly-stripped-or-fail-open persist.
describe("F1 fix — a custody transition auto-persists without needing an explicit flushSettings call", () => {
  beforeEach(resetAll);
  afterEach(() => {
    vi.restoreAllMocks();
    resetAll();
  });

  it("a bare OAuth-style updateSettings(apiKey) lands a stripped IDB blob once the write settles, with no flushSettings call of its own", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, apiKey: "" }, hydrated: true });
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    useApp.getState().updateSettings({ apiKey: "sk-new" }); // e.g. oauth/openrouterDesktop.ts's callback
    await useApp.getState().flushSecrets(); // NOT flushSettings — proves the follow-up is automatic

    const stripped = saveSpy.mock.calls.find((call) => call[0].apiKey === "");
    expect(stripped).toBeDefined();
  });

  it("a write FAILURE on an already-custodied name still persists the NEW plaintext value (no missed-pagehide reversion to the old one)", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, apiKey: "" }, hydrated: true });
    useApp.getState().updateSettings({ apiKey: "sk-old" }); // -> custody gains apiKey
    await useApp.getState().flushSecrets();
    expect(useApp.getState().settings.apiKey).toBe("sk-old");

    mockWriteSecret.mockResolvedValueOnce(false); // this NEXT write (the new value) fails
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    useApp.getState().updateSettings({ apiKey: "sk-new" }); // no flushSettings call of its own

    // The FIRST fire-and-forget persist (still mid-flight custody, taken
    // synchronously inside updateSettings before the Keychain write even
    // starts) strips apiKey — that alone would be the old, buggy end
    // state. The point of this test is what happens AFTER the write
    // settles.
    await useApp.getState().flushSecrets();

    const landed = saveSpy.mock.calls.find((call) => call[0].apiKey === "sk-new");
    expect(landed).toBeDefined(); // the new value reached IDB — custody no longer strips it
  });
});

// F2 fix (Sol HIGH #4, keychain-custody fix round) — a failed Keychain
// DELETE (the user cleared a key) is worse than a failed SET: the OLD
// credential is still sitting in the Keychain and would otherwise
// silently resurrect on the next hydrate. See secret.desktop.test.ts's
// own "F2 delete-tombstone retry" suite for hydrateSecrets' own half.
describe("F2 fix — delete-failure toast + secretDeletePending tombstone bookkeeping", () => {
  beforeEach(resetAll);
  afterEach(() => {
    vi.restoreAllMocks();
    resetAll();
  });

  it("a failed delete shows the delete-specific toast and durably persists the tombstone", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, apiKey: "" }, hydrated: true });
    useApp.getState().updateSettings({ apiKey: "sk-old" }); // -> custody gains apiKey
    await useApp.getState().flushSecrets();

    mockWriteSecret.mockResolvedValueOnce(false); // the delete itself fails
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    useApp.getState().updateSettings({ apiKey: "" }); // user clears the key
    await useApp.getState().flushSecrets();

    expect(useApp.getState().toast).toBe("钥匙串中的旧 Key 删除失败，重启后可能重新出现，请重试清除");
    expect(useApp.getState().settings.secretDeletePending).toEqual(["apiKey"]);
    const persisted = saveSpy.mock.calls.find(
      (call) => Array.isArray(call[0].secretDeletePending) && call[0].secretDeletePending.includes("apiKey"),
    );
    expect(persisted).toBeDefined(); // landed in IDB, not just live in memory
  });

  it("a later successful re-set of the same name clears its tombstone", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, apiKey: "" }, hydrated: true });
    useApp.getState().updateSettings({ apiKey: "sk-old" });
    await useApp.getState().flushSecrets();

    mockWriteSecret.mockResolvedValueOnce(false);
    useApp.getState().updateSettings({ apiKey: "" }); // delete fails -> tombstoned
    await useApp.getState().flushSecrets();
    expect(useApp.getState().settings.secretDeletePending).toEqual(["apiKey"]);

    useApp.getState().updateSettings({ apiKey: "sk-new" }); // a fresh set succeeds this time
    await useApp.getState().flushSecrets();

    expect(useApp.getState().settings.secretDeletePending).toEqual([]);
  });

  it("a SET failure (non-empty value) still shows the ORIGINAL toast, not the delete-specific one", async () => {
    mockWriteSecret.mockResolvedValueOnce(false);
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, apiKey: "" }, hydrated: true });

    useApp.getState().updateSettings({ apiKey: "sk-new" });
    await useApp.getState().flushSecrets();

    expect(useApp.getState().toast).toBe("API Key 未能存入系统钥匙串，已临时保存在本地");
    expect(useApp.getState().settings.secretDeletePending ?? []).toEqual([]);
  });
});

// F4 fix (Sol MEDIUM #12, keychain-custody fix round): pendingSecretWrites
// now truly SERIALIZES separate syncSecretCustody calls (deferred start),
// not merely collects their already-running promises.
describe("F4 fix — pendingSecretWrites serializes across separate updateSettings calls", () => {
  beforeEach(resetAll);
  afterEach(() => {
    vi.restoreAllMocks();
    resetAll();
  });

  it("a second rapid write does not even START until the first one's own write has resolved", async () => {
    const order: string[] = [];
    let resolveFirst: (() => void) | undefined;
    mockWriteSecret.mockImplementation(async (name: string) => {
      order.push(`start:${name}`);
      if (name === "apiKey") {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      order.push(`end:${name}`);
      return true;
    });
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, apiKey: "", hfToken: "" }, hydrated: true });

    useApp.getState().updateSettings({ apiKey: "sk-new" });
    useApp.getState().updateSettings({ hfToken: "hf-new" });

    // A macrotask tick drains every pending microtask (both calls' own
    // dynamic import() + .then chains) without resolving the gate.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["start:apiKey"]); // the second write hasn't even started yet

    resolveFirst!();
    await useApp.getState().flushSecrets();

    expect(order).toEqual(["start:apiKey", "end:apiKey", "start:hfToken", "end:hfToken"]);
  });
});
