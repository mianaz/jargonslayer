import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memStore = new Map<string, unknown>();

vi.mock("idb-keyval", () => ({
  get: vi.fn(async (key: string) => memStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    memStore.set(key, value);
  }),
}));

function mockFetchOnce(payload: unknown, ok = true, status = 200) {
  // v0.6 T5: fetchManifestRaw now reads the raw body via res.text() (so
  // it can size-cap the wire bytes before JSON.parse) instead of
  // res.json() — the mock Response needs both so any test can use
  // either payload shape (a pre-stringified JSON string, or a plain
  // object that gets JSON.stringify'd for the text() side).
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  global.fetch = vi.fn(async () => ({
    ok,
    status,
    text: async () => text,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

describe("remotePacks — pack field trust boundary", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("an entry claiming pack: 'core' is NOT smuggled in as core — it is overwritten with the manifest's own id, so isPackEnabled treats it as a normal (togglable) pack", async () => {
    mockFetchOnce({
      id: "sneaky-pack",
      name: "Sneaky Pack",
      version: 1,
      expressions: [
        {
          expression: "fake core term",
          chinese_explanation: "伪装成核心包的表达",
          pack: "core", // attempted smuggling — must be ignored
        },
      ],
      terms: [
        {
          term: "FAKECORE",
          gloss_zh: "伪装成核心包的术语",
          pack: "core", // attempted smuggling — must be ignored
        },
      ],
    });

    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/sneaky.json");

    expect(pack.id).toBe("sneaky-pack");
    expect(pack.expressions).toHaveLength(1);
    expect(pack.expressions[0].pack).toBe("sneaky-pack");
    expect(pack.terms).toHaveLength(1);
    expect(pack.terms[0].pack).toBe("sneaky-pack");

    // isPackEnabled must NOT treat this entry as always-on "core" —
    // it should be governed by the user's enabled-list like any other
    // installed pack.
    const { isPackEnabled } = await import("@jargonslayer/core/detect/packs");
    expect(isPackEnabled(pack.expressions[0].pack, [])).toBe(false);
    expect(isPackEnabled(pack.expressions[0].pack, ["sneaky-pack"])).toBe(true);
  });

  it("an entry claiming an arbitrary foreign pack id is also overwritten with the manifest's own id (not just 'core')", async () => {
    mockFetchOnce({
      id: "pack-a",
      name: "Pack A",
      version: 1,
      expressions: [
        {
          expression: "impersonation attempt",
          chinese_explanation: "冒充另一个已安装包的表达",
          pack: "pack-b", // impersonating a different installed pack
        },
      ],
    });

    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/pack-a.json");

    expect(pack.expressions[0].pack).toBe("pack-a");
  });

  it("an entry that omits pack still defaults to the manifest's own id (unchanged behavior for the well-behaved case)", async () => {
    mockFetchOnce({
      id: "well-behaved",
      name: "Well Behaved",
      version: 1,
      expressions: [
        { expression: "no pack field", chinese_explanation: "没有声明 pack 字段的表达" },
      ],
      terms: [{ term: "NOPACK", gloss_zh: "没有声明 pack 字段的术语" }],
    });

    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/well-behaved.json");

    expect(pack.expressions[0].pack).toBe("well-behaved");
    expect(pack.terms[0].pack).toBe("well-behaved");
  });
});

describe("remotePacks — manifest v2 attribution/provenance (v0.6 T1)", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("threads every optional v2 field through onto the stored pack", async () => {
    mockFetchOnce({
      id: "v2-pack",
      name: "V2 Pack",
      version: 1,
      license: "CC-BY-4.0",
      licenseUrl: "https://example.com/license",
      source: "Some Corpus",
      sourceUrl: "https://example.com/source",
      sourceVersion: "2024.1",
      citation: "Some Citation, 2024",
      notice: "Community-maintained",
      homepage: "https://example.com/home",
      updateUrl: "https://example.com/update",
      tags: ["biotech", "regulatory"],
      generator: { model: "gpt-x", promptHash: "abc123", builtAt: "2026-01-01" },
    });

    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/v2-pack.json");

    expect(pack.license).toBe("CC-BY-4.0");
    expect(pack.licenseUrl).toBe("https://example.com/license");
    expect(pack.source).toBe("Some Corpus");
    expect(pack.sourceUrl).toBe("https://example.com/source");
    expect(pack.sourceVersion).toBe("2024.1");
    expect(pack.citation).toBe("Some Citation, 2024");
    expect(pack.notice).toBe("Community-maintained");
    expect(pack.homepage).toBe("https://example.com/home");
    expect(pack.updateUrl).toBe("https://example.com/update");
    expect(pack.tags).toEqual(["biotech", "regulatory"]);
    expect(pack.generator).toEqual({ model: "gpt-x", promptHash: "abc123", builtAt: "2026-01-01" });
  });

  it("drops a non-https licenseUrl/homepage without failing the whole install", async () => {
    mockFetchOnce({
      id: "bad-urls-pack",
      name: "Bad URLs",
      version: 1,
      licenseUrl: "http://example.com/license", // http, not https
      homepage: "not a url at all",
    });

    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/bad-urls.json");

    expect(pack.licenseUrl).toBeUndefined();
    expect(pack.homepage).toBeUndefined();
  });

  it("entryCount on the wire is never trusted/threaded through — real counts always come from the arrays", async () => {
    mockFetchOnce({
      id: "lying-count-pack",
      name: "Lying Count",
      version: 1,
      entryCount: 999,
      expressions: [{ expression: "one entry only", chinese_explanation: "只有一条表达" }],
    });

    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/lying-count.json");

    expect((pack as unknown as Record<string, unknown>).entryCount).toBeUndefined();
    expect(pack.expressions).toHaveLength(1);
  });

  it("a v1 manifest with none of the v2 fields still installs successfully", async () => {
    mockFetchOnce({ id: "v1-pack", name: "V1 Pack", version: 1 });

    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/v1-pack.json");

    expect(pack.id).toBe("v1-pack");
    expect(pack.license).toBeUndefined();
    expect(pack.tags).toBeUndefined();
  });

  it("refuses the install with a zh error when minAppVersion is newer than this app", async () => {
    mockFetchOnce({ id: "future-pack", name: "Future Pack", version: 1, minAppVersion: "999.0.0" });

    const remotePacks = await import("../remotePacks");
    await expect(remotePacks.addPackSource("https://example.com/future.json")).rejects.toThrow(
      "此词典需要 JargonSlayer v999.0.0 或更高版本",
    );
  });

  it("installs fine when minAppVersion is at or below this app's own version", async () => {
    mockFetchOnce({ id: "old-enough-pack", name: "Old Enough", version: 1, minAppVersion: "0.0.1" });

    const remotePacks = await import("../remotePacks");
    await expect(remotePacks.addPackSource("https://example.com/old-enough.json")).resolves.toBeDefined();
  });
});

describe("classifyPackOrigin (v0.6 T4)", () => {
  it("classifies the official raw.githubusercontent.com form", async () => {
    const remotePacks = await import("../remotePacks");
    expect(
      remotePacks.classifyPackOrigin("https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/pack.json"),
    ).toBe("official");
  });

  it("classifies the official cdn.jsdelivr.net gh-mirror form", async () => {
    const remotePacks = await import("../remotePacks");
    expect(
      remotePacks.classifyPackOrigin("https://cdn.jsdelivr.net/gh/mianaz/jargonslayer-dicts@1.0.0/pack.json"),
    ).toBe("official");
  });

  it("an http:// downgrade of an otherwise-official url is imported", async () => {
    const remotePacks = await import("../remotePacks");
    expect(
      remotePacks.classifyPackOrigin("http://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/pack.json"),
    ).toBe("imported");
  });

  it("credentials embedded in the url downgrade to imported", async () => {
    const remotePacks = await import("../remotePacks");
    expect(
      remotePacks.classifyPackOrigin(
        "https://user:pass@raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/pack.json",
      ),
    ).toBe("imported");
  });

  it("a lookalike raw.githubusercontent.com host is imported", async () => {
    const remotePacks = await import("../remotePacks");
    expect(
      remotePacks.classifyPackOrigin(
        "https://raw.githubusercontent.com.evil.com/mianaz/jargonslayer-dicts/main/pack.json",
      ),
    ).toBe("imported");
  });

  it("a lookalike cdn.jsdelivr.net host is imported", async () => {
    const remotePacks = await import("../remotePacks");
    expect(
      remotePacks.classifyPackOrigin(
        "https://cdn.jsdelivr.net.attacker.io/gh/mianaz/jargonslayer-dicts@1.0.0/pack.json",
      ),
    ).toBe("imported");
  });

  it("a near-miss path prefix (different repo name) is imported", async () => {
    const remotePacks = await import("../remotePacks");
    expect(
      remotePacks.classifyPackOrigin("https://raw.githubusercontent.com/mianaz/jargonslayer-dicts-evil/main/pack.json"),
    ).toBe("imported");
  });

  it("a file-imported pack (no url — represented as an empty string) is imported", async () => {
    const remotePacks = await import("../remotePacks");
    expect(remotePacks.classifyPackOrigin("")).toBe("imported");
  });

  it("a malformed url string doesn't throw and classifies as imported", async () => {
    const remotePacks = await import("../remotePacks");
    expect(remotePacks.classifyPackOrigin("not a url")).toBe("imported");
  });
});

describe("remotePacks — size caps (v0.6 T5)", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("rejects a single manifest whose serialized JSON exceeds 2 MB", async () => {
    mockFetchOnce({ id: "huge-pack", name: "Huge", version: 1, junkPadding: "x".repeat(2_100_000) });

    const remotePacks = await import("../remotePacks");
    await expect(remotePacks.addPackSource("https://example.com/huge.json")).rejects.toThrow(
      "词典包过大：单个词典包不能超过 2 MB",
    );
  });

  it("refuses to install a 21st pack once 20 are already installed", async () => {
    const remotePacks = await import("../remotePacks");
    for (let i = 0; i < 20; i++) {
      mockFetchOnce({ id: `count-pack-${i}`, name: `Pack ${i}`, version: 1 });
      await remotePacks.addPackSource(`https://example.com/count-pack-${i}.json`);
    }
    mockFetchOnce({ id: "count-pack-20", name: "Pack 20", version: 1 });
    await expect(remotePacks.addPackSource("https://example.com/count-pack-20.json")).rejects.toThrow(/数量/);
  });

  it("refuses an install that would push the total installed size over 10 MB", async () => {
    const remotePacks = await import("../remotePacks");
    const bigDescription = "x".repeat(1_900_000); // ~1.9 MB, under the 2 MB single-pack cap
    for (let i = 0; i < 5; i++) {
      mockFetchOnce({ id: `big-pack-${i}`, name: `Big ${i}`, version: 1, description: bigDescription });
      await remotePacks.addPackSource(`https://example.com/big-pack-${i}.json`);
    }
    // 5 * ~1.9MB =~ 9.5MB already installed; one more tips it over 10MB.
    mockFetchOnce({ id: "big-pack-5", name: "Big 5", version: 1, description: bigDescription });
    await expect(remotePacks.addPackSource("https://example.com/big-pack-5.json")).rejects.toThrow(/总大小/);
  });

  it("surfaces a specific zh message when the underlying store throws QuotaExceededError", async () => {
    const idbKeyval = await import("idb-keyval");
    vi.mocked(idbKeyval.set).mockRejectedValueOnce(new DOMException("quota", "QuotaExceededError"));
    mockFetchOnce({ id: "quota-pack", name: "Quota Pack", version: 1 });

    const remotePacks = await import("../remotePacks");
    await expect(remotePacks.addPackSource("https://example.com/quota.json")).rejects.toThrow(
      "浏览器存储空间不足，无法保存词典",
    );
  });
});

describe("remotePacks — file-imported packs (v0.6 T6)", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("addPackFromManifest installs a valid manifest and returns {ok:true, pack}", async () => {
    const remotePacks = await import("../remotePacks");
    const result = await remotePacks.addPackFromManifest({
      id: "file-pack",
      name: "File Pack",
      version: 1,
      expressions: [{ expression: "file import test", chinese_explanation: "文件导入测试" }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pack.id).toBe("file-pack");
      expect(result.pack.expressions).toHaveLength(1);
    }
  });

  it("addPackFromManifest returns {ok:false, error} for junk JSON — never throws", async () => {
    const remotePacks = await import("../remotePacks");
    const result = await remotePacks.addPackFromManifest({ hello: "world" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("id");
    }
  });

  it("addPackFromManifest never throws/rejects even given a wildly malformed input", async () => {
    const remotePacks = await import("../remotePacks");
    await expect(remotePacks.addPackFromManifest(null)).resolves.toMatchObject({ ok: false });
    await expect(remotePacks.addPackFromManifest("just a string")).resolves.toMatchObject({ ok: false });
    await expect(remotePacks.addPackFromManifest(12345)).resolves.toMatchObject({ ok: false });
  });

  it('a file-imported pack survives listPackSources with url:"" and origin:"imported"', async () => {
    const remotePacks = await import("../remotePacks");
    await remotePacks.addPackFromManifest({ id: "file-pack", name: "File Pack", version: 1 });

    const sources = await remotePacks.listPackSources();
    const source = sources.find((s) => s.pack.id === "file-pack");
    expect(source).toBeDefined();
    expect(source!.url).toBe("");
    expect(source!.origin).toBe("imported");
  });

  it("checkUpdates skips a file-imported (url-less) pack without attempting a fetch", async () => {
    const remotePacks = await import("../remotePacks");
    await remotePacks.addPackFromManifest({ id: "file-pack", name: "File Pack", version: 1 });

    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const updated = await remotePacks.checkUpdates();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updated).toEqual([]);
    const sources = await remotePacks.listPackSources();
    expect(sources.find((s) => s.pack.id === "file-pack")).toBeDefined();
  });

  it("removePackSource removes a file-imported pack by its pack id (it has no url)", async () => {
    const remotePacks = await import("../remotePacks");
    await remotePacks.addPackFromManifest({ id: "file-pack", name: "File Pack", version: 1 });
    expect(await remotePacks.listPackSources()).toHaveLength(1);

    await remotePacks.removePackSource("file-pack");
    expect(await remotePacks.listPackSources()).toHaveLength(0);
  });

  it("a file-imported pack and a url-installed pack coexist — installing one never evicts the other (regression: url-less sources must not dedupe against EACH OTHER)", async () => {
    const remotePacks = await import("../remotePacks");
    await remotePacks.addPackFromManifest({ id: "file-pack-a", name: "File A", version: 1 });
    mockFetchOnce({ id: "url-pack", name: "URL Pack", version: 1 });
    await remotePacks.addPackSource("https://example.com/url-pack.json");
    await remotePacks.addPackFromManifest({ id: "file-pack-b", name: "File B", version: 1 });

    const ids = (await remotePacks.listPackSources()).map((s) => s.pack.id).sort();
    expect(ids).toEqual(["file-pack-a", "file-pack-b", "url-pack"]);
  });
});

describe("remotePacks — enabledPacks materialization wiring (v0.6 T3)", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("calls onEnabledPacksChange with the materialized list on a successful install", async () => {
    mockFetchOnce({ id: "new-pack", name: "New Pack", version: 1 });
    const onEnabledPacksChange = vi.fn();

    const remotePacks = await import("../remotePacks");
    await remotePacks.addPackSource("https://example.com/new-pack.json", {
      currentEnabledPacks: ["academic"],
      onEnabledPacksChange,
    });

    expect(onEnabledPacksChange).toHaveBeenCalledWith(["academic", "new-pack"]);
  });

  it("materializes the full built-in + installed list when currentEnabledPacks is null", async () => {
    mockFetchOnce({ id: "new-pack", name: "New Pack", version: 1 });
    const onEnabledPacksChange = vi.fn();

    const remotePacks = await import("../remotePacks");
    await remotePacks.addPackSource("https://example.com/new-pack.json", {
      currentEnabledPacks: null,
      onEnabledPacksChange,
    });

    const materialized = onEnabledPacksChange.mock.calls[0][0] as string[];
    expect(materialized).toContain("core");
    expect(materialized).toContain("new-pack");
  });

  it("defaults to a no-op when opts is omitted — existing callers keep working unchanged", async () => {
    mockFetchOnce({ id: "no-opts-pack", name: "No Opts", version: 1 });
    const remotePacks = await import("../remotePacks");
    await expect(remotePacks.addPackSource("https://example.com/no-opts-pack.json")).resolves.toBeDefined();
  });
});
