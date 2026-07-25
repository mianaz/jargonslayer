// v0.5.1 desktop keychain custody design — store.ts's syncSecretCustody/
// settingsForPersist strip, IS_DESKTOP genuinely FALSE (the test env's
// default). Proves the new code paths are completely inert on a web
// build — never touches lib/desktop/secret.ts at all. The REAL desktop
// behavior (custody bookkeeping, migration, flushSecrets, the failure
// toast) lives in store.secretCustody.desktop.test.ts, mirroring
// mlxCaps.test.ts/mlxCaps.desktop.test.ts's own ambient/desktop split
// (see that pair's own header comments for why IS_DESKTOP, a
// module-scope import-time const, needs its own file once mocked true).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../store";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import * as storageModule from "../history/storage";

const mockWriteSecret = vi.fn();
const mockHydrateSecrets = vi.fn();
vi.mock("../desktop/secret", () => ({
  SECRET_NAMES: ["apiKey", "hfToken", "sonioxKey", "deepgramKey", "agentToken"],
  readSecrets: vi.fn(async () => ({})),
  writeSecret: (name: string, value: string) => mockWriteSecret(name, value),
  hydrateSecrets: (settings: unknown) => mockHydrateSecrets(settings),
}));

describe("updateSettings / settingsForPersist — web build (IS_DESKTOP false)", () => {
  beforeEach(() => {
    useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: true });
    mockWriteSecret.mockClear();
    mockHydrateSecrets.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: false });
  });

  it("changing a SECRET_NAMES field never touches lib/desktop/secret.ts", async () => {
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    useApp.getState().updateSettings({ apiKey: "sk-plain" });
    await useApp.getState().flushSecrets(); // no-op on web — nothing was ever enqueued

    expect(mockWriteSecret).not.toHaveBeenCalled();
    // The plaintext value persists exactly as before this feature
    // existed — nothing on web is ever stripped.
    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-plain" }));
  });

  it("flushSecrets() resolves immediately — nothing was ever enqueued to wait on", async () => {
    await expect(useApp.getState().flushSecrets()).resolves.toBeUndefined();
  });

  it("hydrate() never calls hydrateSecrets()", async () => {
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue({ ...DEFAULT_SETTINGS, apiKey: "sk-plain" });

    await useApp.getState().hydrate();

    expect(mockHydrateSecrets).not.toHaveBeenCalled();
    expect(useApp.getState().settings.apiKey).toBe("sk-plain"); // passes through untouched
  });
});
