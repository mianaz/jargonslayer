import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type CustomEntry, type MeetingSession, type Settings } from "../../types";
import type { LearnRecord } from "../../learn/types";

// Same in-memory idb-keyval mock as storage.test.ts/glossary.test.ts —
// buildFullBackup/restoreFullBackup call through storage.ts + glossary.ts
// + learn/store.ts (#48 step 4), all idb-keyval-backed.
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

function makeLearnRecord(overrides: Partial<LearnRecord> = {}): LearnRecord {
  return {
    learnKey: "expression:circle back",
    kind: "expression",
    surface: "circle back",
    familiarity: 0.5,
    suppressed: false,
    reps: 1,
    intervalDays: 1,
    ease: 2.5,
    dueAt: 2000,
    lapses: 0,
    createdAt: 1000,
    updatedAt: 1000,
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
    it("restoreFullBackup reproduces the sessions/glossary/learnset/settings a fresh buildFullBackup captured", async () => {
      const storage = await import("../storage");
      const glossary = await import("../glossary");
      const learnset = await import("../../learn/store");
      await storage.saveSession(makeSession({ id: "s1", title: "First" }));
      await storage.saveSession(makeSession({ id: "s2", title: "Second", startedAt: 500 }));
      await glossary.upsertCustomEntry(makeEntry({ id: "e1" }));
      await learnset.upsertLearnRecord(makeLearnRecord());
      await storage.saveSettings(keyedSettings);

      const autoExport = await import("../autoExport");
      const json = await autoExport.buildFullBackup();

      // Wipe local state, then restore from the captured backup.
      memStore.clear();
      const emptySessions = await storage.listSessions();
      expect(emptySessions).toHaveLength(0);

      const result = await autoExport.restoreFullBackup(json);
      expect(result).toEqual({ sessions: 2, entries: 1, learnset: 1, settingsRestored: true });

      const restoredSessions = await storage.listSessions();
      expect(restoredSessions.map((m) => m.id).sort()).toEqual(["s1", "s2"]);
      expect(await storage.getSession("s1")).toMatchObject({ title: "First" });

      const restoredGlossary = await glossary.loadCustomEntries();
      expect(restoredGlossary).toHaveLength(1);
      expect(restoredGlossary[0]).toMatchObject({ id: "e1", headword: "circle back" });

      const restoredLearnset = await learnset.loadLearnset();
      expect(restoredLearnset).toEqual({ "expression:circle back": makeLearnRecord() });

      // sanitizeRestoredSettings force-resets the machine-local
      // pairing/kill-switch trio on every restore (Codex v0.2.3
      // MEDIUM) — everything else round-trips exactly.
      expect(await storage.loadSettings()).toEqual({
        ...keyedSettings,
        subscriptionDirect: false,
        agentUrl: DEFAULT_SETTINGS.agentUrl,
        agentToken: "",
      });
    });

    it("restoring twice does not duplicate sessions, glossary entries, or learn-set records (upsert-by-id/learnKey)", async () => {
      const storage = await import("../storage");
      const glossary = await import("../glossary");
      const learnset = await import("../../learn/store");
      await storage.saveSession(makeSession({ id: "s1" }));
      await glossary.upsertCustomEntry(makeEntry({ id: "e1" }));
      await learnset.upsertLearnRecord(makeLearnRecord());

      const autoExport = await import("../autoExport");
      const json = await autoExport.buildFullBackup();

      await autoExport.restoreFullBackup(json);
      await autoExport.restoreFullBackup(json);

      expect(await storage.listSessions()).toHaveLength(1);
      expect(await glossary.loadCustomEntries()).toHaveLength(1);
      expect(Object.keys(await learnset.loadLearnset())).toHaveLength(1);
    });

    it("restoring an OLD backup (no learnset key at all) leaves the current learn-set completely untouched", async () => {
      const storage = await import("../storage");
      const learnset = await import("../../learn/store");
      const existingRecord = makeLearnRecord({ learnKey: "term:ARR", surface: "ARR" });
      await learnset.upsertLearnRecord(existingRecord);

      const autoExport = await import("../autoExport");
      // A pre-#48 backup: sessions/glossary/settings only, no `learnset`
      // field at all (not even an empty object).
      const oldBackup = JSON.stringify({
        schemaVersion: 1,
        kind: "jargonslayer-backup",
        exportedAt: Date.now(),
        sessions: [],
        glossary: [],
      });

      const result = await autoExport.restoreFullBackup(oldBackup);
      expect(result.learnset).toBe(0);

      expect(await learnset.loadLearnset()).toEqual({
        "term:ARR": existingRecord,
      });
      // sanity: storage.listSessions still resolves fine post-restore.
      expect(await storage.listSessions()).toHaveLength(0);
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

  describe("learn-set record validation on restore (#48 s1 review item 4)", () => {
    function makeHonestRawRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        learnKey: "expression:circle back",
        kind: "expression",
        surface: "circle back",
        familiarity: 0.5,
        suppressed: false,
        reps: 1,
        intervalDays: 1,
        ease: 2.5,
        dueAt: 2000,
        lapses: 0,
        createdAt: 1000,
        updatedAt: 1000,
        ...overrides,
      };
    }

    function makeBackup(learnsetDict: Record<string, unknown>): string {
      return JSON.stringify({
        schemaVersion: 1,
        kind: "jargonslayer-backup",
        sessions: [],
        glossary: [],
        learnset: learnsetDict,
      });
    }

    it("accepts a sane record and drops nothing", async () => {
      const learnset = await import("../../learn/store");
      const autoExport = await import("../autoExport");
      const honest = makeHonestRawRecord();

      const result = await autoExport.restoreFullBackup(makeBackup({ [honest.learnKey as string]: honest }));

      expect(result.learnset).toBe(1);
      expect(await learnset.loadLearnset()).toEqual({
        [honest.learnKey as string]: honest,
      });
    });

    it("drops a record with a non-string/empty surface", async () => {
      const autoExport = await import("../autoExport");
      const hostile = makeHonestRawRecord({ surface: 12345 });

      const result = await autoExport.restoreFullBackup(makeBackup({ "expression:circle back": hostile }));

      expect(result.learnset).toBe(0);
    });

    it("drops a record with an invalid kind", async () => {
      const autoExport = await import("../autoExport");
      const hostile = makeHonestRawRecord({ kind: "malicious" });

      const result = await autoExport.restoreFullBackup(makeBackup({ "expression:circle back": hostile }));

      expect(result.learnset).toBe(0);
    });

    it("drops a record with a non-finite numeric field", async () => {
      const autoExport = await import("../autoExport");
      const hostile = makeHonestRawRecord({ dueAt: "not-a-number" });

      const result = await autoExport.restoreFullBackup(makeBackup({ "expression:circle back": hostile }));

      expect(result.learnset).toBe(0);
    });

    it("repairs (does not drop) a suppressed:true record missing suppressedAt — stamped with `now` so the 90d sweep can recover it", async () => {
      const learnset = await import("../../learn/store");
      const autoExport = await import("../autoExport");
      const suppressedNoTimestamp = makeHonestRawRecord({ suppressed: true, suppressedAt: undefined });
      delete suppressedNoTimestamp.suppressedAt;

      const result = await autoExport.restoreFullBackup(
        makeBackup({ "expression:circle back": suppressedNoTimestamp }),
      );

      expect(result.learnset).toBe(1);
      const restored = (await learnset.loadLearnset())["expression:circle back"];
      expect(restored.suppressed).toBe(true);
      expect(typeof restored.suppressedAt).toBe("number");
      expect(Number.isFinite(restored.suppressedAt)).toBe(true);
    });

    it("drops a suppressed:true record whose suppressedAt is present but non-finite", async () => {
      const autoExport = await import("../autoExport");
      const hostile = makeHonestRawRecord({ suppressed: true, suppressedAt: "yesterday" });

      const result = await autoExport.restoreFullBackup(makeBackup({ "expression:circle back": hostile }));

      expect(result.learnset).toBe(0);
    });

    it("rejects a record whose learnKey is a dangerous prototype-pollution key", async () => {
      const autoExport = await import("../autoExport");
      const hostile = makeHonestRawRecord({ learnKey: "__proto__" });

      const result = await autoExport.restoreFullBackup(makeBackup({ "__proto__": hostile }));

      expect(result.learnset).toBe(0);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("rejects a dict entry whose OWN key is __proto__/constructor/prototype even if the record body looks sane", async () => {
      const autoExport = await import("../autoExport");
      const json = JSON.stringify({
        schemaVersion: 1,
        kind: "jargonslayer-backup",
        sessions: [],
        glossary: [],
        learnset: JSON.parse(
          '{"__proto__": ' + JSON.stringify(makeHonestRawRecord({ learnKey: "expression:circle back" })) + "}",
        ),
      });

      const result = await autoExport.restoreFullBackup(json);

      expect(result.learnset).toBe(0);
    });

    it("a mixed backup drops only the malformed records, restoring every sane one and counting accurately", async () => {
      const learnset = await import("../../learn/store");
      const autoExport = await import("../autoExport");
      const sane1 = makeHonestRawRecord();
      const sane2 = makeHonestRawRecord({ learnKey: "term:ARR", kind: "term", surface: "ARR" });
      const malformed = makeHonestRawRecord({ learnKey: "expression:bad", surface: "" });

      const result = await autoExport.restoreFullBackup(
        makeBackup({
          [sane1.learnKey as string]: sane1,
          [sane2.learnKey as string]: sane2,
          "expression:bad": malformed,
        }),
      );

      expect(result.learnset).toBe(2);
      const loaded = await learnset.loadLearnset();
      expect(Object.keys(loaded).sort()).toEqual(["expression:circle back", "term:ARR"]);
    });
  });

  describe("previewBackup (confirmation-step counts, no writes)", () => {
    it("reports counts (including learnset) and hasSettings without touching storage", async () => {
      const storage = await import("../storage");
      const autoExport = await import("../autoExport");
      const json = JSON.stringify({
        schemaVersion: 1,
        kind: "jargonslayer-backup",
        sessions: [makeSession({ id: "s1" }), makeSession({ id: "s2" })],
        glossary: [makeEntry()],
        learnset: { "expression:circle back": makeLearnRecord() },
        settings: keyedSettings,
      });

      const preview = autoExport.previewBackup(json);
      expect(preview).toEqual({
        sessions: 2,
        entries: 1,
        learnset: 1,
        hasSettings: true,
        hasApiKey: true,
      });

      // No writes happened — the store this test's beforeEach set up
      // stays empty.
      expect(await storage.listSessions()).toHaveLength(0);
    });

    it("learnset count is 0 when the backup carries no learnset field at all (pre-#48 backup)", async () => {
      const autoExport = await import("../autoExport");
      const json = JSON.stringify({
        schemaVersion: 1,
        kind: "jargonslayer-backup",
        sessions: [],
        glossary: [],
      });
      expect(autoExport.previewBackup(json).learnset).toBe(0);
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
        learnset: 0,
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

describe("sanitizeRestoredSettings — Codex v0.2.3 MEDIUM (untrusted backup settings)", () => {
  it("force-resets the subscription-direct pairing fields regardless of what the backup claims", async () => {
    const autoExport = await import("../autoExport");
    const hostile = {
      ...DEFAULT_SETTINGS,
      subscriptionDirect: true,
      agentUrl: "https://evil.example.com",
      agentToken: "stolen-token",
    };
    const out = autoExport.sanitizeRestoredSettings(hostile);
    expect(out.subscriptionDirect).toBe(false);
    expect(out.agentUrl).toBe(DEFAULT_SETTINGS.agentUrl);
    expect(out.agentToken).toBe("");
  });

  it("drops unknown/attacker-added keys instead of persisting them", async () => {
    const autoExport = await import("../autoExport");
    const hostile = { language: "en-US", __proto_pollution: "x", evilFlag: true } as never;
    const out = autoExport.sanitizeRestoredSettings(hostile) as Record<string, unknown>;
    expect(out.language).toBe("en-US");
    expect("__proto_pollution" in out).toBe(false);
    expect("evilFlag" in out).toBe(false);
  });

  it("keeps taskLlm (deliberately absent from DEFAULT_SETTINGS) and ordinary fields", async () => {
    const autoExport = await import("../autoExport");
    const honest = {
      language: "en-GB",
      taskLlm: { detect: { enabled: true, model: "m" } },
    } as never;
    const out = autoExport.sanitizeRestoredSettings(honest);
    expect(out.language).toBe("en-GB");
    expect(out.taskLlm?.detect?.model).toBe("m");
  });
});

describe("stripKeyMaterial — Codex v0.2.3 LOW (webhookUrl is credential-like)", () => {
  it("strips webhookUrl along with the key fields", async () => {
    // this describe sits outside the main block's beforeEach — shim
    // indexedDB the same way so storage.saveSettings doesn't no-op
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
    const autoExport = await import("../autoExport");
    const storage = await import("../storage");
    memStore.clear();
    await storage.saveSettings({
      ...DEFAULT_SETTINGS,
      webhookUrl: "https://hooks.example.com/secret-token-path",
      apiKey: "sk-x",
    });
    const json = await autoExport.buildFullBackup({ includeKeys: false });
    const backup = JSON.parse(json) as { settings: { webhookUrl: string; apiKey: string } };
    expect(backup.settings.webhookUrl).toBe("");
    expect(backup.settings.apiKey).toBe("");
  });
});
