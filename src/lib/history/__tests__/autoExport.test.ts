import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type CustomEntry, type MeetingSession, type Settings } from "../../types";

// Same in-memory idb-keyval mock as storage.test.ts/glossary.test.ts —
// buildFullBackup/restoreFullBackup call through storage.ts + glossary.ts,
// both idb-keyval-backed.
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

function makeSession(overrides: Partial<MeetingSession> = {}): MeetingSession {
  return {
    id: "s1",
    title: "Weekly sync",
    startedAt: 1000,
    endedAt: 2000,
    engine: "demo",
    segments: [],
    cards: [],
    terms: [],
    ...overrides,
  };
}

function makeEntry(overrides: Partial<CustomEntry> = {}): CustomEntry {
  return {
    id: "e1",
    kind: "expression",
    headword: "circle back",
    variants: [],
    chinese_explanation: "回头再聊",
    example: "Let's circle back later.",
    context: "",
    note: "",
    createdAt: 1000,
    updatedAt: 1000,
    source: "manual",
    ...overrides,
  };
}

const keyedSettings: Settings = {
  ...DEFAULT_SETTINGS,
  apiKey: "sk-ant-secret",
  hfToken: "hf_secret",
  agentToken: "agent-secret",
  taskLlm: {
    detect: { enabled: true, apiKey: "sk-detect-secret", provider: "anthropic" },
    summary: { enabled: false }, // no apiKey field at all — must survive untouched
  },
};

describe("autoExport.ts — backup/restore (#57)", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  describe("round-trip: build -> parse -> restore", () => {
    it("restoreFullBackup reproduces the sessions/glossary/settings a fresh buildFullBackup captured", async () => {
      const storage = await import("../storage");
      const glossary = await import("../glossary");
      await storage.saveSession(makeSession({ id: "s1", title: "First" }));
      await storage.saveSession(makeSession({ id: "s2", title: "Second", startedAt: 500 }));
      await glossary.upsertCustomEntry(makeEntry({ id: "e1" }));
      await storage.saveSettings(keyedSettings);

      const autoExport = await import("../autoExport");
      const json = await autoExport.buildFullBackup();

      // Wipe local state, then restore from the captured backup.
      memStore.clear();
      const emptySessions = await storage.listSessions();
      expect(emptySessions).toHaveLength(0);

      const result = await autoExport.restoreFullBackup(json);
      expect(result).toEqual({ sessions: 2, entries: 1, settingsRestored: true });

      const restoredSessions = await storage.listSessions();
      expect(restoredSessions.map((m) => m.id).sort()).toEqual(["s1", "s2"]);
      expect(await storage.getSession("s1")).toMatchObject({ title: "First" });

      const restoredGlossary = await glossary.loadCustomEntries();
      expect(restoredGlossary).toHaveLength(1);
      expect(restoredGlossary[0]).toMatchObject({ id: "e1", headword: "circle back" });

      expect(await storage.loadSettings()).toEqual(keyedSettings);
    });

    it("restoring twice does not duplicate sessions or glossary entries (upsert-by-id)", async () => {
      const storage = await import("../storage");
      const glossary = await import("../glossary");
      await storage.saveSession(makeSession({ id: "s1" }));
      await glossary.upsertCustomEntry(makeEntry({ id: "e1" }));

      const autoExport = await import("../autoExport");
      const json = await autoExport.buildFullBackup();

      await autoExport.restoreFullBackup(json);
      await autoExport.restoreFullBackup(json);

      expect(await storage.listSessions()).toHaveLength(1);
      expect(await glossary.loadCustomEntries()).toHaveLength(1);
    });

    it("a backup with no settings field leaves current settings untouched and reports settingsRestored:false", async () => {
      const storage = await import("../storage");
      await storage.saveSettings({ ...DEFAULT_SETTINGS, apiKey: "keep-me" });

      const autoExport = await import("../autoExport");
      const bareBackup = JSON.stringify({
        schemaVersion: 1,
        kind: "jargonslayer-backup",
        exportedAt: Date.now(),
        sessions: [],
        glossary: [],
        // settings intentionally omitted
      });

      const result = await autoExport.restoreFullBackup(bareBackup);
      expect(result.settingsRestored).toBe(false);
      expect(await storage.loadSettings()).toMatchObject({ apiKey: "keep-me" });
    });

    it("rejects a JSON file that isn't a jargonslayer/meetlingo backup", async () => {
      const autoExport = await import("../autoExport");
      await expect(autoExport.restoreFullBackup(JSON.stringify({ hello: "world" }))).rejects.toThrow(
        "不是有效的 JargonSlayer 备份文件",
      );
    });

    it("rejects malformed JSON with a zh-ready error", async () => {
      const autoExport = await import("../autoExport");
      await expect(autoExport.restoreFullBackup("{not json")).rejects.toThrow(
        "备份文件不是有效的 JSON",
      );
    });

    it("accepts the pre-rename 'meetlingo-backup' kind for backward compatibility", async () => {
      const autoExport = await import("../autoExport");
      const legacyKindBackup = JSON.stringify({
        schemaVersion: 1,
        kind: "meetlingo-backup",
        sessions: [],
        glossary: [],
      });
      await expect(autoExport.restoreFullBackup(legacyKindBackup)).resolves.toMatchObject({
        sessions: 0,
        entries: 0,
      });
    });
  });

  describe("previewBackup (confirmation-step counts, no writes)", () => {
    it("reports counts and hasSettings without touching storage", async () => {
      const storage = await import("../storage");
      const autoExport = await import("../autoExport");
      const json = JSON.stringify({
        schemaVersion: 1,
        kind: "jargonslayer-backup",
        sessions: [makeSession({ id: "s1" }), makeSession({ id: "s2" })],
        glossary: [makeEntry()],
        settings: keyedSettings,
      });

      const preview = autoExport.previewBackup(json);
      expect(preview).toEqual({ sessions: 2, entries: 1, hasSettings: true, hasApiKey: true });

      // No writes happened — the store this test's beforeEach set up
      // stays empty.
      expect(await storage.listSessions()).toHaveLength(0);
    });

    it("hasSettings is false when the backup carries no settings field", async () => {
      const autoExport = await import("../autoExport");
      const json = JSON.stringify({
        schemaVersion: 1,
        kind: "jargonslayer-backup",
        sessions: [],
        glossary: [],
      });
      expect(autoExport.previewBackup(json)).toEqual({
        sessions: 0,
        entries: 0,
        hasSettings: false,
        hasApiKey: false,
      });
    });

    it("hasApiKey inspects the FILE's own settings.apiKey, not any exporter checkbox state — false for a key-stripped backup even though hasSettings is true", async () => {
      const storage = await import("../storage");
      await storage.saveSettings(keyedSettings);

      const autoExport = await import("../autoExport");
      const strippedJson = await autoExport.buildFullBackup({ includeKeys: false });

      const preview = autoExport.previewBackup(strippedJson);
      expect(preview.hasSettings).toBe(true);
      expect(preview.hasApiKey).toBe(false);
    });
  });

  describe("includeKeys / key-stripping checkbox logic", () => {
    it("includeKeys:true (or omitted) — the export carries apiKey/hfToken/agentToken/taskLlm[*].apiKey as-is", async () => {
      const storage = await import("../storage");
      await storage.saveSettings(keyedSettings);

      const autoExport = await import("../autoExport");
      const jsonDefault = await autoExport.buildFullBackup();
      const jsonExplicit = await autoExport.buildFullBackup({ includeKeys: true });

      for (const json of [jsonDefault, jsonExplicit]) {
        const parsed = JSON.parse(json) as { settings: Settings };
        expect(parsed.settings.apiKey).toBe("sk-ant-secret");
        expect(parsed.settings.hfToken).toBe("hf_secret");
        expect(parsed.settings.agentToken).toBe("agent-secret");
        expect(parsed.settings.taskLlm?.detect?.apiKey).toBe("sk-detect-secret");
      }
    });

    it("includeKeys:false (the default-checked '不包含 API Key' box) strips every key field, including nested taskLlm overrides", async () => {
      const storage = await import("../storage");
      await storage.saveSettings(keyedSettings);

      const autoExport = await import("../autoExport");
      const json = await autoExport.buildFullBackup({ includeKeys: false });
      const parsed = JSON.parse(json) as { settings: Settings };

      expect(parsed.settings.apiKey).toBe("");
      expect(parsed.settings.hfToken).toBe("");
      expect(parsed.settings.agentToken).toBe("");
      expect(parsed.settings.taskLlm?.detect?.apiKey).toBeUndefined();
      // Non-key fields on the stripped domain block must survive.
      expect(parsed.settings.taskLlm?.detect?.enabled).toBe(true);
      expect(parsed.settings.taskLlm?.detect?.provider).toBe("anthropic");
      // A domain entry with no apiKey to begin with is untouched.
      expect(parsed.settings.taskLlm?.summary).toEqual({ enabled: false });
      // Everything else on Settings (non-key) round-trips unchanged.
      expect(parsed.settings.engine).toBe(keyedSettings.engine);
      expect(parsed.settings.detectModel).toBe(keyedSettings.detectModel);
    });

    it("stripping keys does not touch sessions or glossary entries", async () => {
      const storage = await import("../storage");
      const glossary = await import("../glossary");
      await storage.saveSession(makeSession({ id: "s1", title: "Has no keys anyway" }));
      await glossary.upsertCustomEntry(makeEntry());
      await storage.saveSettings(keyedSettings);

      const autoExport = await import("../autoExport");
      const json = await autoExport.buildFullBackup({ includeKeys: false });
      const parsed = JSON.parse(json) as { sessions: MeetingSession[]; glossary: CustomEntry[] };

      expect(parsed.sessions).toHaveLength(1);
      expect(parsed.sessions[0].title).toBe("Has no keys anyway");
      expect(parsed.glossary).toHaveLength(1);
    });

    it("when there is no settings record at all, includeKeys:false is a no-op (settings stays null)", async () => {
      const autoExport = await import("../autoExport");
      const json = await autoExport.buildFullBackup({ includeKeys: false });
      const parsed = JSON.parse(json) as { settings: Settings | null };
      expect(parsed.settings).toBeNull();
    });
  });
});
