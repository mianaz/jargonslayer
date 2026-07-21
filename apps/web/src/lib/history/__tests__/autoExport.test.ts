import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type CustomEntry, type MeetingSession, type Settings } from "@jargonslayer/core/types";
import type { LearnRecord } from "@jargonslayer/core/learn/types";
import { THEME_TOKEN_KEYS } from "../../theme/schema";

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
    packId: "personal",
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
  // v0.4 S4 (blueprint decision E): Soniox BYOK key — hand-listed
  // stripped field, same as hfToken/agentToken (see stripKeyMaterial).
  sonioxKey: "soniox-secret",
  // v0.4.7 (Lane D): Deepgram BYOK key — same hand-listed strip.
  deepgramKey: "deepgram-secret",
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
      // packs: 1 — buildFullBackup's own glossary.loadCustomEntries()
      // call auto-creates+persists "personal" as a side effect (v0.5
      // Wave-1 F8), so even a backup with no custom packs carries it.
      expect(result).toEqual({ sessions: 2, entries: 1, learnset: 1, packs: 1, settingsRestored: true });

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

  describe("customPacks round-trip (v0.5 Wave-1 F8, §5 A7)", () => {
    it("a named pack created before export round-trips through build -> restore", async () => {
      const glossary = await import("../glossary");
      await glossary.createCustomPack("术语库 A");

      const autoExport = await import("../autoExport");
      const json = await autoExport.buildFullBackup();
      const parsed = JSON.parse(json) as { customPacks: unknown[] };
      expect(parsed.customPacks.map((p) => (p as { name: string }).name).sort()).toEqual([
        "个人词库",
        "术语库 A",
      ]);

      memStore.clear();
      const result = await autoExport.restoreFullBackup(json);
      expect(result.packs).toBe(2);

      const restoredPacks = await glossary.loadCustomPacks();
      expect(restoredPacks.map((p) => p.name).sort()).toEqual(["个人词库", "术语库 A"]);
      const restoredPack = restoredPacks.find((p) => p.name === "术语库 A")!;
      expect(restoredPack.enabled).toBe(true);
    });

    it("restoring twice does not duplicate packs (upsert-by-id)", async () => {
      const glossary = await import("../glossary");
      await glossary.createCustomPack("术语库 A");

      const autoExport = await import("../autoExport");
      const json = await autoExport.buildFullBackup();

      await autoExport.restoreFullBackup(json);
      await autoExport.restoreFullBackup(json);

      const packs = await glossary.loadCustomPacks();
      expect(packs.filter((p) => p.name === "术语库 A")).toHaveLength(1);
    });

    it("a legacy backup with no customPacks field restores 0 packs but 'personal' still exists (glossary.ts's own auto-create)", async () => {
      const glossary = await import("../glossary");
      const autoExport = await import("../autoExport");
      const legacyBackup = JSON.stringify({
        schemaVersion: 1,
        kind: "jargonslayer-backup",
        sessions: [],
        glossary: [],
        // customPacks intentionally omitted (pre-F8 backup).
      });

      const result = await autoExport.restoreFullBackup(legacyBackup);
      expect(result.packs).toBe(0);

      const packs = await glossary.loadCustomPacks();
      expect(packs.map((p) => p.id)).toEqual(["personal"]);
    });

    it("sanitizeRestoredCustomPack drops malformed rows and accepts sane ones", async () => {
      const autoExport = await import("../autoExport");
      const sane = { id: "p1", name: "Sane Pack", enabled: true, createdAt: 1000 };
      expect(autoExport.sanitizeRestoredCustomPack(sane)).toEqual(sane);

      expect(autoExport.sanitizeRestoredCustomPack(null)).toBeNull();
      expect(autoExport.sanitizeRestoredCustomPack({ ...sane, id: "" })).toBeNull();
      expect(autoExport.sanitizeRestoredCustomPack({ ...sane, id: "__proto__" })).toBeNull();
      expect(autoExport.sanitizeRestoredCustomPack({ ...sane, name: "  " })).toBeNull();
      expect(autoExport.sanitizeRestoredCustomPack({ ...sane, enabled: "yes" })).toBeNull();
      expect(autoExport.sanitizeRestoredCustomPack({ ...sane, createdAt: "yesterday" })).toBeNull();
    });

    it("a mixed customPacks array drops only the malformed rows, restoring every sane one and counting accurately", async () => {
      const glossary = await import("../glossary");
      const autoExport = await import("../autoExport");
      const backup = JSON.stringify({
        schemaVersion: 1,
        kind: "jargonslayer-backup",
        sessions: [],
        glossary: [],
        customPacks: [
          { id: "personal", name: "个人词库", enabled: true, createdAt: 1000 },
          { id: "p2", name: "Sane Pack", enabled: false, createdAt: 2000 },
          { id: "p3", name: "", enabled: true, createdAt: 3000 }, // malformed: blank name
        ],
      });

      const result = await autoExport.restoreFullBackup(backup);
      expect(result.packs).toBe(2);

      const packs = await glossary.loadCustomPacks();
      expect(packs.map((p) => p.id).sort()).toEqual(["p2", "personal"]);
      expect(packs.find((p) => p.id === "p2")?.enabled).toBe(false);
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
    it("includeKeys:true (or omitted) — the export carries apiKey/hfToken/sonioxKey/deepgramKey/agentToken/taskLlm[*].apiKey as-is", async () => {
      const storage = await import("../storage");
      await storage.saveSettings(keyedSettings);

      const autoExport = await import("../autoExport");
      const jsonDefault = await autoExport.buildFullBackup();
      const jsonExplicit = await autoExport.buildFullBackup({ includeKeys: true });

      for (const json of [jsonDefault, jsonExplicit]) {
        const parsed = JSON.parse(json) as { settings: Settings };
        expect(parsed.settings.apiKey).toBe("sk-ant-secret");
        expect(parsed.settings.hfToken).toBe("hf_secret");
        expect(parsed.settings.sonioxKey).toBe("soniox-secret");
        expect(parsed.settings.deepgramKey).toBe("deepgram-secret");
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
      expect(parsed.settings.sonioxKey).toBe("");
      expect(parsed.settings.deepgramKey).toBe("");
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

// v0.5.1 appearance sprint: customThemes/uiFont/monoFont/overlayGlass
// are allow-listed like any other Settings field, but each needs its
// own re-validation the generic allow-list pick above can't express.
describe("sanitizeRestoredSettings — v0.5.1 customThemes/uiFont/monoFont/overlayGlass", () => {
  function validTokens() {
    const tokens: Record<string, string> = {};
    for (const key of THEME_TOKEN_KEYS) tokens[key] = "#ffffff";
    return tokens;
  }

  it("re-mints a non-custom--prefixed theme id (so a restored file can never shadow a builtin id)", async () => {
    const autoExport = await import("../autoExport");
    const hostile = {
      ...DEFAULT_SETTINGS,
      customThemes: [{ id: "terminal", label: "冒充终端", scheme: "dark", tokens: validTokens() }],
    } as never;
    const out = autoExport.sanitizeRestoredSettings(hostile);
    expect(out.customThemes).toHaveLength(1);
    expect(out.customThemes?.[0].id).not.toBe("terminal");
    expect(out.customThemes?.[0].id.startsWith("custom-")).toBe(true);
    expect(out.customThemes?.[0].label).toBe("冒充终端");
  });

  it("leaves an already custom--prefixed id untouched", async () => {
    const autoExport = await import("../autoExport");
    const honest = {
      ...DEFAULT_SETTINGS,
      customThemes: [{ id: "custom-my-theme", label: "我的主题", scheme: "dark", tokens: validTokens() }],
    } as never;
    const out = autoExport.sanitizeRestoredSettings(honest);
    expect(out.customThemes?.[0].id).toBe("custom-my-theme");
  });

  it("drops a malformed customThemes entry (fails parseTheme) instead of partially trusting it", async () => {
    const autoExport = await import("../autoExport");
    const mixed = {
      ...DEFAULT_SETTINGS,
      customThemes: [
        { id: "custom-good", label: "好主题", scheme: "dark", tokens: validTokens() },
        { id: "custom-evil", label: "evil", scheme: "dark", tokens: { ...validTokens(), fg: "url(evil)" } },
        { id: "custom-missing-token", label: "缺token", scheme: "dark", tokens: {} },
      ],
    } as never;
    const out = autoExport.sanitizeRestoredSettings(mixed);
    expect(out.customThemes).toHaveLength(1);
    expect(out.customThemes?.[0].id).toBe("custom-good");
  });

  it("falls back to an empty array when customThemes is absent or not an array", async () => {
    const autoExport = await import("../autoExport");
    expect(autoExport.sanitizeRestoredSettings({ ...DEFAULT_SETTINGS } as never).customThemes).toEqual([]);
    expect(
      autoExport.sanitizeRestoredSettings({ ...DEFAULT_SETTINGS, customThemes: "not-an-array" } as never)
        .customThemes,
    ).toEqual([]);
  });

  it("re-mints two entries sharing the same non-prefixed label into DISTINCT ids (no in-batch collision)", async () => {
    const autoExport = await import("../autoExport");
    const raw = {
      ...DEFAULT_SETTINGS,
      customThemes: [
        { id: "not-prefixed-1", label: "重复标签", scheme: "dark", tokens: validTokens() },
        { id: "not-prefixed-2", label: "重复标签", scheme: "dark", tokens: validTokens() },
      ],
    } as never;
    const out = autoExport.sanitizeRestoredSettings(raw);
    expect(out.customThemes).toHaveLength(2);
    expect(out.customThemes?.[0].id).not.toBe(out.customThemes?.[1].id);
  });

  it("keeps the FIRST occurrence's id verbatim when two entries share the same already-prefixed id, re-minting only the later duplicate (F4)", async () => {
    const autoExport = await import("../autoExport");
    const raw = {
      ...DEFAULT_SETTINGS,
      customThemes: [
        { id: "custom-x", label: "第一个", scheme: "dark", tokens: validTokens() },
        { id: "custom-x", label: "第二个", scheme: "dark", tokens: validTokens() },
      ],
    } as never;
    const out = autoExport.sanitizeRestoredSettings(raw);
    expect(out.customThemes).toHaveLength(2);
    expect(out.customThemes?.[0].id).toBe("custom-x");
    expect(out.customThemes?.[0].label).toBe("第一个");
    expect(out.customThemes?.[1].id).not.toBe("custom-x");
    expect(out.customThemes?.[1].label).toBe("第二个");
    expect(new Set(out.customThemes?.map((t) => t.id)).size).toBe(2);
  });

  it("falls back to the default uiFont/monoFont when the restored value isn't a string", async () => {
    const autoExport = await import("../autoExport");
    const out = autoExport.sanitizeRestoredSettings({ ...DEFAULT_SETTINGS, uiFont: 42, monoFont: null } as never);
    expect(out.uiFont).toBe(DEFAULT_SETTINGS.uiFont);
    expect(out.monoFont).toBe(DEFAULT_SETTINGS.monoFont);
  });

  it("re-sanitizes a custom: font value's family half through sanitizeFontFamily", async () => {
    const autoExport = await import("../autoExport");
    const out = autoExport.sanitizeRestoredSettings({
      ...DEFAULT_SETTINGS,
      uiFont: 'custom:Evil";Font',
    } as never);
    expect(out.uiFont).toBe("custom:EvilFont");
  });

  it("falls back to default when a custom: font value sanitizes to nothing", async () => {
    const autoExport = await import("../autoExport");
    const out = autoExport.sanitizeRestoredSettings({ ...DEFAULT_SETTINGS, uiFont: "custom:;;;" } as never);
    expect(out.uiFont).toBe(DEFAULT_SETTINGS.uiFont);
  });

  it("passes through an ordinary (non-custom) preset id string as-is", async () => {
    const autoExport = await import("../autoExport");
    const out = autoExport.sanitizeRestoredSettings({ ...DEFAULT_SETTINGS, uiFont: "serif" } as never);
    expect(out.uiFont).toBe("serif");
  });

  // F11 (adversarial review): the previous `Boolean(picked.overlayGlass)`
  // coercion accepted ANY truthy value — including the string "false",
  // which is truthy in JS — so a hand-edited/foreign backup carrying
  // `overlayGlass: "false"` restored as TRUE. Only an actual boolean is
  // ever trusted now; anything else (including truthy non-booleans)
  // falls back to DEFAULT_SETTINGS.overlayGlass.
  it("accepts only an actual boolean for overlayGlass, falling back to the default for anything else (including the string \"false\")", async () => {
    const autoExport = await import("../autoExport");
    expect(autoExport.sanitizeRestoredSettings({ ...DEFAULT_SETTINGS, overlayGlass: true } as never).overlayGlass).toBe(true);
    expect(autoExport.sanitizeRestoredSettings({ ...DEFAULT_SETTINGS, overlayGlass: false } as never).overlayGlass).toBe(false);
    expect(autoExport.sanitizeRestoredSettings({ ...DEFAULT_SETTINGS, overlayGlass: undefined } as never).overlayGlass).toBe(
      DEFAULT_SETTINGS.overlayGlass,
    );
    expect(autoExport.sanitizeRestoredSettings({ ...DEFAULT_SETTINGS, overlayGlass: 1 } as never).overlayGlass).toBe(
      DEFAULT_SETTINGS.overlayGlass,
    );
    expect(autoExport.sanitizeRestoredSettings({ ...DEFAULT_SETTINGS, overlayGlass: "yes" } as never).overlayGlass).toBe(
      DEFAULT_SETTINGS.overlayGlass,
    );
    expect(autoExport.sanitizeRestoredSettings({ ...DEFAULT_SETTINGS, overlayGlass: "false" } as never).overlayGlass).toBe(
      DEFAULT_SETTINGS.overlayGlass,
    );
  });

  // F2 HIGH (v0.5.1 Bit sprint fix round): bitCostume's own allow-list
  // (`picked.bitCostume === "auto" || "none" || isBitCostumeId(...)`)
  // routes every non-legal shape through isBitCostumeId, so a hostile
  // string like "__proto__" — which used to read as "present" via
  // isBitCostumeId's now-fixed prototype-chain hole (see
  // lib/__tests__/bitCostumes.test.ts) — must fall back to the default
  // ("auto") exactly like any other unknown id, not survive the restore.
  it('falls back to "auto" for a hostile bitCostume value ("__proto__"), same as any other unknown id', async () => {
    const autoExport = await import("../autoExport");
    const hostile = { ...DEFAULT_SETTINGS, bitCostume: "__proto__" } as never;
    expect(autoExport.sanitizeRestoredSettings(hostile).bitCostume).toBe("auto");
  });
});

describe("postTaskWebhook — task.* envelope (#58 task center connector hook)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn(async () => ({ ok: true }));
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const task = {
    id: "t1",
    kind: "import-audio",
    label: "meeting.wav",
    stage: "转录中",
    progress: 0.5,
    status: "running",
    createdAt: 1000,
    updatedAt: 1500,
  };

  it("POSTs {schemaVersion, event, exportedAt, task} to the given url, mirroring postWebhook's own envelope shape", async () => {
    const autoExport = await import("../autoExport");
    await autoExport.postTaskWebhook(task, "task.started", "https://hooks.example.com/x");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/x");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ schemaVersion: 1, event: "task.started", task });
    expect(typeof body.exportedAt).toBe("number");
  });

  it("supports the done/error event names with their own task snapshot fields", async () => {
    const autoExport = await import("../autoExport");
    await autoExport.postTaskWebhook(
      { ...task, status: "done", sessionId: "s1" },
      "task.done",
      "https://hooks.example.com/x",
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.event).toBe("task.done");
    expect(body.task.sessionId).toBe("s1");

    mockFetch.mockClear();
    await autoExport.postTaskWebhook(
      { ...task, status: "error", error: "上传失败" },
      "task.error",
      "https://hooks.example.com/x",
    );
    const errBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(errBody.event).toBe("task.error");
    expect(errBody.task.error).toBe("上传失败");
  });

  it("never throws when the fetch itself fails (fire-and-forget, same contract as postWebhook)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"));
    const autoExport = await import("../autoExport");
    await expect(
      autoExport.postTaskWebhook(task, "task.started", "https://hooks.example.com/x"),
    ).resolves.toBeUndefined();
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
