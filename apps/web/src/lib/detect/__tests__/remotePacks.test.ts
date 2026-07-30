import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memStore = new Map<string, unknown>();

vi.mock("idb-keyval", () => ({
  get: vi.fn(async (key: string) => memStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    memStore.set(key, value);
  }),
}));

function mockFetchOnce(
  payload: unknown,
  ok = true,
  status = 200,
  // N2 fix round: `finalUrl`/`redirected` let a test simulate fetch()
  // following a redirect — default (undefined finalUrl) mirrors real
  // fetch's own res.url for an UNredirected request (equal to whatever
  // was actually requested).
  opts: { finalUrl?: string; redirected?: boolean } = {},
) {
  // v0.6 T5: fetchManifestRaw now reads the raw body via res.text() (so
  // it can size-cap the wire bytes before JSON.parse) instead of
  // res.json() — the mock Response needs both so any test can use
  // either payload shape (a pre-stringified JSON string, or a plain
  // object that gets JSON.stringify'd for the text() side).
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  global.fetch = vi.fn(async (input: string | URL) => ({
    ok,
    status,
    url: opts.finalUrl ?? String(input),
    redirected: opts.redirected ?? false,
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
    // B1 fix round: jsDelivr's accepted ref shape narrowed to @main/
    // @v<semver> (see the dedicated "ref allowlisting" describe block
    // below) — a bare version with no "v" prefix no longer qualifies.
    expect(
      remotePacks.classifyPackOrigin("https://cdn.jsdelivr.net/gh/mianaz/jargonslayer-dicts@v1.0.0/pack.json"),
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
    // N5/L4 fix round: `description` is now clamped to 200 chars, so it
    // can no longer inflate a fixture's serialized size — `meaning` is
    // still unbounded (out of this fix round's scope), so it's used
    // here instead to keep exercising the SAME total-bytes cap.
    const bigMeaning = "x".repeat(1_900_000); // ~1.9 MB, under the 2 MB single-pack cap
    for (let i = 0; i < 5; i++) {
      mockFetchOnce({
        id: `big-pack-${i}`,
        name: `Big ${i}`,
        version: 1,
        expressions: [{ expression: "big pack filler", chinese_explanation: "占位", meaning: bigMeaning }],
      });
      await remotePacks.addPackSource(`https://example.com/big-pack-${i}.json`);
    }
    // 5 * ~1.9MB =~ 9.5MB already installed; one more tips it over 10MB.
    mockFetchOnce({
      id: "big-pack-5",
      name: "Big 5",
      version: 1,
      expressions: [{ expression: "big pack filler", chinese_explanation: "占位", meaning: bigMeaning }],
    });
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

    await remotePacks.removePackSource("", "file-pack");
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

describe("remotePacks — manifest id safety (H3/H4 fix round)", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("H3: rejects a manifest id of __proto__/constructor/prototype", async () => {
    const remotePacks = await import("../remotePacks");
    for (const dangerousId of ["__proto__", "constructor", "prototype"]) {
      mockFetchOnce({ id: dangerousId, name: "Dangerous", version: 1 });
      await expect(remotePacks.addPackSource(`https://example.com/${dangerousId}.json`)).rejects.toThrow(
        /id/,
      );
    }
    expect(await remotePacks.listPackSources()).toHaveLength(0);
  });

  it("H4: rejects a manifest id colliding with a built-in pack id ('core' and one other)", async () => {
    const remotePacks = await import("../remotePacks");
    mockFetchOnce({ id: "core", name: "Sneaky Core", version: 1 });
    await expect(remotePacks.addPackSource("https://example.com/core.json")).rejects.toThrow(/core/);

    mockFetchOnce({ id: "academic", name: "Sneaky Academic", version: 1 });
    await expect(remotePacks.addPackSource("https://example.com/academic.json")).rejects.toThrow(
      /academic/,
    );
    expect(await remotePacks.listPackSources()).toHaveLength(0);
  });

  it("a normal, non-colliding id still installs fine (regression safety)", async () => {
    mockFetchOnce({ id: "biotech-terms", name: "Biotech", version: 1 });
    const remotePacks = await import("../remotePacks");
    await expect(
      remotePacks.addPackSource("https://example.com/biotech.json"),
    ).resolves.toBeDefined();
  });
});

describe("classifyPackOrigin — ref allowlisting (B1 BLOCK fix round)", () => {
  it("accepts the raw.githubusercontent.com main-branch form", async () => {
    const remotePacks = await import("../remotePacks");
    expect(
      remotePacks.classifyPackOrigin(
        "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/pack.json",
      ),
    ).toBe("official");
  });

  it("accepts the raw.githubusercontent.com fully-qualified refs/heads/main form", async () => {
    const remotePacks = await import("../remotePacks");
    expect(
      remotePacks.classifyPackOrigin(
        "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/refs/heads/main/pack.json",
      ),
    ).toBe("official");
  });

  it("accepts v1/v1.2/v1.2.3 release-tag forms on raw.githubusercontent.com", async () => {
    const remotePacks = await import("../remotePacks");
    for (const tag of ["v1", "v1.2", "v1.2.3"]) {
      expect(
        remotePacks.classifyPackOrigin(
          `https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/${tag}/pack.json`,
        ),
      ).toBe("official");
    }
  });

  it("rejects a 40-hex commit SHA — reachable through the upstream path from ANY fork (Cross-Fork Object Reference)", async () => {
    const remotePacks = await import("../remotePacks");
    const sha = "a".repeat(40);
    expect(
      remotePacks.classifyPackOrigin(
        `https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/${sha}/pack.json`,
      ),
    ).toBe("imported");
  });

  it("rejects a refs/pull/… ref", async () => {
    const remotePacks = await import("../remotePacks");
    expect(
      remotePacks.classifyPackOrigin(
        "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/refs/pull/123/head/pack.json",
      ),
    ).toBe("imported");
  });

  it("rejects a ref named main-evil (near-miss of the allowlisted 'main')", async () => {
    const remotePacks = await import("../remotePacks");
    expect(
      remotePacks.classifyPackOrigin(
        "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main-evil/pack.json",
      ),
    ).toBe("imported");
  });

  it("rejects a ref named mainX (near-miss of the allowlisted 'main')", async () => {
    const remotePacks = await import("../remotePacks");
    expect(
      remotePacks.classifyPackOrigin(
        "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/mainX/pack.json",
      ),
    ).toBe("imported");
  });

  it("accepts the jsDelivr @main and @v<semver> forms", async () => {
    const remotePacks = await import("../remotePacks");
    expect(
      remotePacks.classifyPackOrigin("https://cdn.jsdelivr.net/gh/mianaz/jargonslayer-dicts@main/pack.json"),
    ).toBe("official");
    expect(
      remotePacks.classifyPackOrigin(
        "https://cdn.jsdelivr.net/gh/mianaz/jargonslayer-dicts@v1.0.0/pack.json",
      ),
    ).toBe("official");
  });

  it("rejects a bare jsDelivr @<sha> (no leading 'v', not 'main')", async () => {
    const remotePacks = await import("../remotePacks");
    const sha = "b".repeat(40);
    expect(
      remotePacks.classifyPackOrigin(`https://cdn.jsdelivr.net/gh/mianaz/jargonslayer-dicts@${sha}/pack.json`),
    ).toBe("imported");
  });

  it("rejects the OLD accept form (bare version, no 'v' prefix) now that jsDelivr requires @v<semver>", async () => {
    const remotePacks = await import("../remotePacks");
    expect(
      remotePacks.classifyPackOrigin("https://cdn.jsdelivr.net/gh/mianaz/jargonslayer-dicts@1.0.0/pack.json"),
    ).toBe("imported");
  });

  // Existing bypass tests (pre-B1-fix, must still pass unchanged).
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

describe("remotePacks — N1: addPackSource itself enforces https-only/no-credentials", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("rejects a data: url without ever calling fetch", async () => {
    const remotePacks = await import("../remotePacks");
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    await expect(remotePacks.addPackSource("data:application/json,{}")).rejects.toThrow(/https/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a plain http:// url without ever calling fetch", async () => {
    const remotePacks = await import("../remotePacks");
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    await expect(remotePacks.addPackSource("http://127.0.0.1:8766/pack.json")).rejects.toThrow(/https/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a credentialed https url without ever calling fetch", async () => {
    const remotePacks = await import("../remotePacks");
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    await expect(remotePacks.addPackSource("https://user:pass@example.com/pack.json")).rejects.toThrow(
      /https/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("remotePacks — N2: redirect-safe provenance classification", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("a redirect OFF the official host downgrades to imported, even though the requested url was official", async () => {
    mockFetchOnce(
      { id: "redirected-pack", name: "Redirected", version: 1 },
      true,
      200,
      { finalUrl: "https://evil.example.com/pack.json", redirected: true },
    );
    const remotePacks = await import("../remotePacks");
    await remotePacks.addPackSource(
      "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/pack.json",
    );
    const sources = await remotePacks.listPackSources();
    expect(sources[0].origin).toBe("imported");
  });

  it("persists the FINAL (post-redirect) url, not the originally requested one", async () => {
    mockFetchOnce(
      { id: "redirected-pack", name: "Redirected", version: 1 },
      true,
      200,
      { finalUrl: "https://example.com/moved/pack.json", redirected: true },
    );
    const remotePacks = await import("../remotePacks");
    await remotePacks.addPackSource("https://example.com/pack.json");
    const sources = await remotePacks.listPackSources();
    expect(sources[0].url).toBe("https://example.com/moved/pack.json");
  });

  it("a redirect ONTO the official host does NOT earn the official badge (requested url must ALSO classify official)", async () => {
    mockFetchOnce(
      { id: "sneaky-redirect-pack", name: "Sneaky", version: 1 },
      true,
      200,
      {
        finalUrl: "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/pack.json",
        redirected: true,
      },
    );
    const remotePacks = await import("../remotePacks");
    await remotePacks.addPackSource("https://example.com/pack.json");
    const sources = await remotePacks.listPackSources();
    expect(sources[0].origin).toBe("imported");
  });

  it("an unredirected official fetch still classifies official (no regression)", async () => {
    mockFetchOnce({ id: "plain-official", name: "Plain", version: 1 });
    const remotePacks = await import("../remotePacks");
    await remotePacks.addPackSource(
      "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/pack.json",
    );
    const sources = await remotePacks.listPackSources();
    expect(sources[0].origin).toBe("official");
  });
});

describe("remotePacks — N3: expression variants capped + total surface budget", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("caps expression variants at 8, deduped case-insensitively", async () => {
    mockFetchOnce({
      id: "many-variants-pack",
      name: "Many Variants",
      version: 1,
      expressions: [
        {
          expression: "ship it",
          chinese_explanation: "发布上线",
          variants: ["Ship It", "SHIP IT", "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9"],
        },
      ],
    });
    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/many-variants.json");
    expect(pack.expressions[0].variants).toHaveLength(8);
    // "Ship It"/"SHIP IT" collapse into the first-seen "Ship It" —
    // case-insensitive dedup — so v1..v7 (7 more) fill the remaining
    // slots up to 8 total.
    expect(pack.expressions[0].variants).toEqual([
      "Ship It",
      "v1",
      "v2",
      "v3",
      "v4",
      "v5",
      "v6",
      "v7",
    ]);
  });

  it("rejects a manifest whose total candidate-surface count (headwords + variants) exceeds the budget", async () => {
    const expressions = Array.from({ length: 6000 }, (_, i) => ({
      expression: `zzzexpr${i}`,
      chinese_explanation: "测试表达",
    }));
    mockFetchOnce({ id: "huge-surface-pack", name: "Huge Surface", version: 1, expressions });
    const remotePacks = await import("../remotePacks");
    await expect(
      remotePacks.addPackSource("https://example.com/huge-surface.json"),
    ).rejects.toThrow(/匹配项/);
  });

  it("a manifest within the surface budget still installs fine", async () => {
    const expressions = Array.from({ length: 10 }, (_, i) => ({
      expression: `zzzexpr${i}`,
      chinese_explanation: "测试表达",
    }));
    mockFetchOnce({ id: "small-surface-pack", name: "Small Surface", version: 1, expressions });
    const remotePacks = await import("../remotePacks");
    await expect(
      remotePacks.addPackSource("https://example.com/small-surface.json"),
    ).resolves.toBeDefined();
  });
});

describe("remotePacks — expression literal-context guards", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("preserves a non-empty string list and drops malformed notFollowedBy input", async () => {
    mockFetchOnce({
      id: "literal-context-pack",
      name: "Literal Context Pack",
      version: 1,
      expressions: [
        { expression: "in the red", chinese_explanation: "亏损", notFollowedBy: ["graph", "curve"] },
        { expression: "underwater", chinese_explanation: "资不抵债", notFollowedBy: ["camera", ""] },
        { expression: "in the black", chinese_explanation: "盈利", notFollowedBy: "chart" },
      ],
    });

    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/literal-context.json");

    expect(pack.expressions[0].notFollowedBy).toEqual(["graph", "curve"]);
    expect(pack.expressions[1].notFollowedBy).toBeUndefined();
    expect(pack.expressions[2].notFollowedBy).toBeUndefined();
  });

  it("preserves notPrecededBy on expressions and drops malformed input", async () => {
    mockFetchOnce({
      id: "literal-precede-pack",
      name: "Literal Precede Pack",
      version: 1,
      expressions: [
        { expression: "bandwidth", chinese_explanation: "精力", notPrecededBy: ["network", "channel"] },
        { expression: "granular", chinese_explanation: "细化", notPrecededBy: ["sand", ""] },
        { expression: "unpack", chinese_explanation: "拆开讲", notPrecededBy: "box" },
      ],
    });

    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/literal-precede.json");

    expect(pack.expressions[0].notPrecededBy).toEqual(["network", "channel"]);
    expect(pack.expressions[1].notPrecededBy).toBeUndefined();
    expect(pack.expressions[2].notPrecededBy).toBeUndefined();
  });

  it("preserves notFollowedBy/notPrecededBy on terms and drops malformed input", async () => {
    mockFetchOnce({
      id: "term-literal-context-pack",
      name: "Term Literal Context Pack",
      version: 1,
      terms: [
        {
          term: "prior",
          gloss_zh: "先验",
          notFollowedBy: ["to"],
          notPrecededBy: ["weak"],
        },
        {
          term: "mean",
          gloss_zh: "均值",
          notPrecededBy: ["i", ""],
        },
        {
          term: "recall",
          gloss_zh: "召回",
          notFollowedBy: "that",
        },
      ],
    });

    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource(
      "https://example.com/term-literal-context.json",
    );

    expect(pack.terms[0].notFollowedBy).toEqual(["to"]);
    expect(pack.terms[0].notPrecededBy).toEqual(["weak"]);
    expect(pack.terms[1].notPrecededBy).toBeUndefined();
    expect(pack.terms[1].notFollowedBy).toBeUndefined();
    expect(pack.terms[2].notFollowedBy).toBeUndefined();
  });
});

describe("remotePacks — N5: bidi/zero-width control chars stripped from name/description", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("strips an embedded RLO override character from name/description", async () => {
    const rlo = "\u202E"; // RIGHT-TO-LEFT OVERRIDE
    const pdf = "\u202C"; // POP DIRECTIONAL FORMATTING
    mockFetchOnce({
      id: "bidi-pack",
      name: `evil${rlo}name${pdf}`,
      description: `evil${rlo}description${pdf}`,
      version: 1,
    });
    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/bidi.json");
    expect(pack.name).not.toMatch(/[\u202A-\u202E]/);
    expect(pack.description).not.toMatch(/[\u202A-\u202E]/);
    expect(pack.name).toBe("evilname");
  });

  it("clamps an overlong name/description (L4)", async () => {
    mockFetchOnce({
      id: "long-name-pack",
      name: "x".repeat(200),
      description: "y".repeat(400),
      version: 1,
    });
    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/long-name.json");
    expect(pack.name.length).toBeLessThanOrEqual(80);
    expect(pack.description!.length).toBeLessThanOrEqual(200);
  });
});

describe("remotePacks — N7(c): AbortSignal.timeout() surfaces the friendly timeout message", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("recognizes a TimeoutError DOMException (not just AbortError)", async () => {
    global.fetch = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    const remotePacks = await import("../remotePacks");
    await expect(remotePacks.addPackSource("https://example.com/slow.json")).rejects.toThrow(
      "获取词典包超时",
    );
  });
});

describe("remotePacks — N7(d): removePackSource discriminated match (field-collision safety)", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("removing a file-backed pack by id does not also remove a DIFFERENT url-backed pack whose url happens to equal that same string", async () => {
    const remotePacks = await import("../remotePacks");
    const collidingString = "https://example.com/colliding.json";
    mockFetchOnce({ id: "colliding-string-pack", name: "URL Pack", version: 1 });
    await remotePacks.addPackSource(collidingString);
    await remotePacks.addPackFromManifest({ id: collidingString, name: "File Pack", version: 1 });
    expect(await remotePacks.listPackSources()).toHaveLength(2);

    // Remove the FILE-backed one by packId (its own id is the colliding string).
    await remotePacks.removePackSource("", collidingString);

    const remaining = await remotePacks.listPackSources();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].pack.id).toBe("colliding-string-pack");
  });

  it("removePackSource resolves false when the underlying write fails, true on success", async () => {
    const idbKeyval = await import("idb-keyval");
    const remotePacks = await import("../remotePacks");
    await remotePacks.addPackFromManifest({ id: "removable-pack", name: "Removable", version: 1 });

    vi.mocked(idbKeyval.set).mockRejectedValueOnce(new Error("write failed"));
    await expect(remotePacks.removePackSource("", "removable-pack")).resolves.toBe(false);

    await expect(remotePacks.removePackSource("", "removable-pack")).resolves.toBe(true);
  });
});

describe("remotePacks — M1: concurrent installs are serialized, not lost", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("two concurrent addPackFromManifest calls both survive (neither clobbers the other)", async () => {
    const remotePacks = await import("../remotePacks");
    const [a, b] = await Promise.all([
      remotePacks.addPackFromManifest({ id: "concurrent-a", name: "Concurrent A", version: 1 }),
      remotePacks.addPackFromManifest({ id: "concurrent-b", name: "Concurrent B", version: 1 }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const ids = (await remotePacks.listPackSources()).map((s) => s.pack.id).sort();
    expect(ids).toEqual(["concurrent-a", "concurrent-b"]);
  });

  it("a concurrent addPackSource (url) and addPackFromManifest (file) both survive", async () => {
    mockFetchOnce({ id: "concurrent-url", name: "Concurrent URL", version: 1 });
    const remotePacks = await import("../remotePacks");
    const [urlResult, fileResult] = await Promise.all([
      remotePacks.addPackSource("https://example.com/concurrent-url.json"),
      remotePacks.addPackFromManifest({ id: "concurrent-file", name: "Concurrent File", version: 1 }),
    ]);
    expect(urlResult.pack.id).toBe("concurrent-url");
    expect(fileResult.ok).toBe(true);

    const ids = (await remotePacks.listPackSources()).map((s) => s.pack.id).sort();
    expect(ids).toEqual(["concurrent-file", "concurrent-url"]);
  });
});

describe("remotePacks — M2: checkUpdates re-checks the total caps before writing", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("refuses to write a refetch that would push the total size over 10MB, and keeps the previous versions installed", async () => {
    const remotePacks = await import("../remotePacks");
    // N5/L4 fix round: `description` is now clamped to 200 chars, so a
    // padded `meaning` (still unbounded, out of this fix round's scope)
    // is used instead to inflate the fixture. 6 packs at ~1.5MB each
    // installs fine (~9MB total, under 10MB).
    const filler = (bytes: number) => [{ expression: "filler", chinese_explanation: "占位", meaning: "x".repeat(bytes) }];
    for (let i = 0; i < 6; i++) {
      mockFetchOnce({ id: `grow-pack-${i}`, name: `Pack ${i}`, version: 1, expressions: filler(1_400_000) });
      await remotePacks.addPackSource(`https://example.com/grow-pack-${i}.json`);
    }
    const beforeVersions = (await remotePacks.listPackSources()).map((s) => s.pack.version);

    // Now every source's checkUpdates refetch reports a NEW version at
    // the SAME ~1.4MB size each — total stays ~9MB, so bump the size
    // further per-pack on the refetch to legally tip it over 10MB.
    global.fetch = vi.fn(async (input: string | URL) => {
      const text = JSON.stringify({
        id: String(input).match(/grow-pack-\d+/)?.[0] ?? "grow-pack-x",
        name: "Grown",
        version: 2,
        expressions: filler(1_900_000),
      });
      return { ok: true, status: 200, url: String(input), redirected: false, text: async () => text };
    }) as unknown as typeof fetch;

    await expect(remotePacks.checkUpdates()).rejects.toThrow(/总大小/);

    // The previous (pre-refetch) versions must still be what's installed.
    const afterVersions = (await remotePacks.listPackSources()).map((s) => s.pack.version);
    expect(afterVersions).toEqual(beforeVersions);
  });
});

describe("remotePacks — MEDIUM-2: checkUpdates' shouldContinue param + only reloading the registry on a real change (v0.6 round-2 review)", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  // Fails against pre-fix checkUpdates(), which took no shouldContinue
  // param at all and always wrote a genuine update through.
  it("shouldContinue() returning false bails WITHOUT writing — even when a real update was found", async () => {
    mockFetchOnce({ id: "pack-a", name: "Pack A", version: 1 });
    const remotePacks = await import("../remotePacks");
    await remotePacks.addPackSource("https://example.com/pack-a.json");

    mockFetchOnce({ id: "pack-a", name: "Pack A", version: 2 });
    const updated = await remotePacks.checkUpdates(() => false);

    expect(updated).toEqual([]);
    const sources = await remotePacks.listPackSources();
    expect(sources.find((s) => s.pack.id === "pack-a")!.pack.version).toBe(1); // unchanged — never written
  });

  it("shouldContinue() returning true proceeds exactly like passing nothing at all", async () => {
    mockFetchOnce({ id: "pack-a", name: "Pack A", version: 1 });
    const remotePacks = await import("../remotePacks");
    await remotePacks.addPackSource("https://example.com/pack-a.json");

    mockFetchOnce({ id: "pack-a", name: "Pack A", version: 2 });
    const updated = await remotePacks.checkUpdates(() => true);

    expect(updated).toEqual(["pack-a"]);
    const sources = await remotePacks.listPackSources();
    expect(sources.find((s) => s.pack.id === "pack-a")!.pack.version).toBe(2);
  });

  // Fails against pre-fix checkUpdates(), which called
  // loadRemotePacksIntoRegistry(true) unconditionally — the generation
  // would bump here even though nothing changed.
  it("a no-op check (every source already current) never bumps the remote-packs registry generation", async () => {
    const { getRemotePacksGeneration } = await import("@jargonslayer/core/detect/remotePacksRegistry");
    mockFetchOnce({ id: "pack-a", name: "Pack A", version: 1 });
    const remotePacks = await import("../remotePacks");
    await remotePacks.addPackSource("https://example.com/pack-a.json");
    await remotePacks.loadRemotePacksIntoRegistry(true);
    const before = getRemotePacksGeneration();

    mockFetchOnce({ id: "pack-a", name: "Pack A", version: 1 }); // SAME version — no-op
    const updated = await remotePacks.checkUpdates();

    expect(updated).toEqual([]);
    expect(getRemotePacksGeneration()).toBe(before);
  });

  it("a REAL update still bumps the registry generation, same as before this fix", async () => {
    const { getRemotePacksGeneration } = await import("@jargonslayer/core/detect/remotePacksRegistry");
    mockFetchOnce({ id: "pack-a", name: "Pack A", version: 1 });
    const remotePacks = await import("../remotePacks");
    await remotePacks.addPackSource("https://example.com/pack-a.json");
    await remotePacks.loadRemotePacksIntoRegistry(true);
    const before = getRemotePacksGeneration();

    mockFetchOnce({ id: "pack-a", name: "Pack A", version: 2 });
    const updated = await remotePacks.checkUpdates();

    expect(updated).toEqual(["pack-a"]);
    expect(getRemotePacksGeneration()).toBeGreaterThan(before);
  });
});

describe("remotePacks — LOW fix: loadRemotePacksIntoRegistry never poisons its own promise on failure (v0.6 round-2 review)", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  // Fails against pre-fix loadRemotePacksIntoRegistry, where the
  // `loadingPromise = null` line sat AFTER the await with no
  // try/finally — a rejection left it set forever, so this SECOND call
  // would return the SAME dead rejected promise instead of a genuine
  // retry, even after the injected failure stopped happening.
  it("a failed load does not poison later calls — a later call (after the failure clears) succeeds instead of reusing the same rejected promise", async () => {
    const remotePacks = await import("../remotePacks");
    const registry = await import("@jargonslayer/core/detect/remotePacksRegistry");
    const spy = vi.spyOn(registry, "setLoadedRemotePacks").mockImplementationOnce(() => {
      throw new Error("boom");
    });

    await expect(remotePacks.loadRemotePacksIntoRegistry()).rejects.toThrow("boom");

    spy.mockRestore(); // the injected failure is now gone — a real retry should succeed
    await expect(remotePacks.loadRemotePacksIntoRegistry()).resolves.toBeUndefined();
  });
});

// v0.6 multi-sense-terms sprint (T1) — NOT the "v0.6 T1-T6" labels used
// elsewhere in this file, which name the earlier/unrelated remote-packs
// sprint (variants, commonWord, manifest v2, size caps, catalog browse).
// clampSenses' own wire-validation coverage: a term MAY declare
// `senses`, validated like a term itself, lenient-drop per malformed
// sense (never fatal to the whole term/pack).
describe("remotePacks — term senses (v0.6 multi-sense-terms sprint)", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("installs a well-formed senses array, filling in defaults (prior 0.5, generated senseId) where absent", async () => {
    mockFetchOnce({
      id: "senses-pack",
      name: "Senses Pack",
      version: 1,
      terms: [
        {
          term: "EMT",
          gloss_zh: "顶层默认释义",
          senses: [
            { gloss_en: "epithelial-mesenchymal transition", gloss_zh: "上皮间质转化", domain: "biomed", prior: 0.7 },
            { gloss_en: "ITK gene", gloss_zh: "ITK 基因", domain: "genomics" }, // no senseId, no prior
          ],
        },
      ],
    });
    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/senses.json");

    const term = pack.terms.find((t) => t.term === "EMT");
    expect(term?.senses).toHaveLength(2);
    expect(term?.senses?.[0]).toEqual({
      gloss_en: "epithelial-mesenchymal transition",
      gloss_zh: "上皮间质转化",
      type: undefined,
      domain: "biomed",
      prior: 0.7,
      senseId: "sense-0",
    });
    // Absent prior -> defaults to 0.5; absent senseId -> generated from index.
    expect(term?.senses?.[1].prior).toBe(0.5);
    expect(term?.senses?.[1].senseId).toBe("sense-1");
  });

  it("caps at 6 senses even when the manifest declares more", async () => {
    const senses = Array.from({ length: 9 }, (_, i) => ({
      gloss_en: `sense ${i}`,
      gloss_zh: `释义 ${i}`,
      domain: "general",
    }));
    mockFetchOnce({
      id: "many-senses-pack",
      name: "Many Senses",
      version: 1,
      terms: [{ term: "OVERLOADED", gloss_zh: "顶层释义", senses }],
    });
    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/many-senses.json");
    expect(pack.terms[0].senses).toHaveLength(6);
  });

  it("drops a sense missing gloss_en/gloss_zh but keeps the other senses and the term itself", async () => {
    mockFetchOnce({
      id: "malformed-sense-pack",
      name: "Malformed Sense",
      version: 1,
      terms: [
        {
          term: "PARTIAL",
          gloss_zh: "顶层释义",
          senses: [
            { gloss_en: "good sense", gloss_zh: "正常释义", domain: "software" },
            { gloss_en: "", gloss_zh: "缺少英文释义", domain: "software" }, // dropped
            { gloss_zh: "缺少英文字段", domain: "software" }, // dropped (no gloss_en key at all)
          ],
        },
      ],
    });
    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/malformed-sense.json");
    expect(pack.terms).toHaveLength(1); // the TERM survives
    expect(pack.terms[0].senses).toHaveLength(1);
    expect(pack.terms[0].senses?.[0].gloss_en).toBe("good sense");
  });

  it("drops a sense whose domain is not a recognized DomainTag", async () => {
    mockFetchOnce({
      id: "bad-domain-pack",
      name: "Bad Domain",
      version: 1,
      terms: [
        {
          term: "BADDOMAIN",
          gloss_zh: "顶层释义",
          senses: [
            { gloss_en: "ok", gloss_zh: "正常", domain: "biomed" },
            { gloss_en: "bad", gloss_zh: "不合法域", domain: "not-a-real-domain" },
          ],
        },
      ],
    });
    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/bad-domain.json");
    expect(pack.terms[0].senses).toHaveLength(1);
    expect(pack.terms[0].senses?.[0].domain).toBe("biomed");
  });

  it("clamps prior to the 0..1 range", async () => {
    mockFetchOnce({
      id: "prior-range-pack",
      name: "Prior Range",
      version: 1,
      terms: [
        {
          term: "PRIORRANGE",
          gloss_zh: "顶层释义",
          senses: [
            { gloss_en: "too high", gloss_zh: "过高", domain: "finance", prior: 5 },
            { gloss_en: "too low", gloss_zh: "过低", domain: "sales", prior: -3 },
          ],
        },
      ],
    });
    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/prior-range.json");
    expect(pack.terms[0].senses?.[0].prior).toBe(1);
    expect(pack.terms[0].senses?.[1].prior).toBe(0);
  });

  it("clamps an over-long senseId to 40 chars", async () => {
    mockFetchOnce({
      id: "long-senseid-pack",
      name: "Long SenseId",
      version: 1,
      terms: [
        {
          term: "LONGID",
          gloss_zh: "顶层释义",
          senses: [{ gloss_en: "x", gloss_zh: "x", domain: "hr", senseId: "s".repeat(80) }],
        },
      ],
    });
    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/long-senseid.json");
    expect(pack.terms[0].senses?.[0].senseId).toHaveLength(40);
  });

  it("a term with senses entirely malformed (all dropped) installs with `senses: undefined`, not an empty array", async () => {
    mockFetchOnce({
      id: "all-malformed-pack",
      name: "All Malformed",
      version: 1,
      terms: [{ term: "ALLBAD", gloss_zh: "顶层释义", senses: [{ domain: "not-real" }, { gloss_en: "x" }] }],
    });
    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/all-malformed.json");
    expect(pack.terms[0].senses).toBeUndefined();
  });

  it("a term with no `senses` field at all installs with `senses: undefined` — unaffected by this feature", async () => {
    mockFetchOnce({
      id: "no-senses-pack",
      name: "No Senses",
      version: 1,
      terms: [{ term: "NOSENSES", gloss_zh: "顶层释义" }],
    });
    const remotePacks = await import("../remotePacks");
    const { pack } = await remotePacks.addPackSource("https://example.com/no-senses.json");
    expect(pack.terms[0].senses).toBeUndefined();
  });
});
