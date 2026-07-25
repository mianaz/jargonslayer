// Exercises storage/remotePacks.ts: manifest validation rejecting the
// hostile cases the security contract must survive (dangerous/colliding
// ids, non-https/credentialed urls, oversized manifests, total-pack
// caps, minAppVersion gate, entry-level `pack` field never trusted),
// the install/remove round trip through an in-memory PacksStore (same
// injected-store idiom storage/history.test.ts's createMemoryStore()
// uses for its own IndexedDB-shaped KeyValueStore), and the shared core
// registry actually receiving what gets installed/removed.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getLoadedRemotePacks,
  setLoadedRemotePacks,
} from "@jargonslayer/core/detect/remotePacksRegistry";

import {
  addPackSource,
  classifyPackOrigin,
  isAllowedPackUrl,
  listPackSources,
  loadPacksIntoRegistry,
  MAX_PACK_BYTES,
  MAX_PACK_COUNT,
  removePackSource,
  type PacksStore,
} from "../remotePacks";

function createMemoryStore(): PacksStore {
  const map = new Map<string, unknown>();
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
  };
}

function fakeResponse(body: string, opts: { ok?: boolean; status?: number; url?: string } = {}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    url: opts.url ?? "",
    text: async () => body,
  } as Response;
}

const OFFICIAL_URL = "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/packs/x.json";

function makeManifest(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Pack ${id}`,
    version: "1.0.0",
    terms: [{ term: "Zynthraq", gloss_zh: "测试用生造词", pack: "SOMEONE-ELSES-PACK" }],
    ...overrides,
  };
}

function stubFetchOnce(body: string, opts: { ok?: boolean; status?: number; url?: string } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => fakeResponse(body, opts));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  setLoadedRemotePacks([]); // reset the shared core registry between tests
});

describe("manifest validation — hostile cases", () => {
  it("rejects a manifest id of __proto__", async () => {
    stubFetchOnce(JSON.stringify(makeManifest("__proto__")));
    await expect(addPackSource(OFFICIAL_URL, createMemoryStore())).rejects.toThrow(/__proto__/);
  });

  it("rejects a manifest id of constructor", async () => {
    stubFetchOnce(JSON.stringify(makeManifest("constructor")));
    await expect(addPackSource(OFFICIAL_URL, createMemoryStore())).rejects.toThrow();
  });

  it("rejects a manifest id colliding with a built-in pack id (core)", async () => {
    stubFetchOnce(JSON.stringify(makeManifest("core")));
    await expect(addPackSource(OFFICIAL_URL, createMemoryStore())).rejects.toThrow(/内置词典包冲突/);
  });

  it("rejects a non-https url WITHOUT ever calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(addPackSource("http://raw.githubusercontent.com/x.json", createMemoryStore())).rejects.toThrow(
      /https/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a credentialed https url WITHOUT ever calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      addPackSource("https://user:pass@raw.githubusercontent.com/x.json", createMemoryStore()),
    ).rejects.toThrow(/https/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a manifest body larger than the 2MB per-pack cap", async () => {
    const oversized = "x".repeat(MAX_PACK_BYTES + 1024);
    stubFetchOnce(oversized);
    await expect(addPackSource(OFFICIAL_URL, createMemoryStore())).rejects.toThrow(/2 MB/);
  });

  it("rejects a minAppVersion newer than this app's own version", async () => {
    stubFetchOnce(JSON.stringify(makeManifest("future-pack", { minAppVersion: "99.0.0" })));
    await expect(addPackSource(OFFICIAL_URL, createMemoryStore())).rejects.toThrow(/版本/);
  });

  it("rejects once the installed-pack count would exceed MAX_PACK_COUNT, leaving prior installs intact", async () => {
    const store = createMemoryStore();
    const fetchMock = vi.fn(async (url: string) => {
      const id = new URL(url).pathname.split("/").pop()!.replace(".json", "");
      return fakeResponse(JSON.stringify(makeManifest(id)));
    });
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < MAX_PACK_COUNT; i++) {
      await addPackSource(`https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/packs/pack-${i}.json`, store);
    }
    expect(await listPackSources(store)).toHaveLength(MAX_PACK_COUNT);

    await expect(
      addPackSource(
        `https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/packs/pack-overflow.json`,
        store,
      ),
    ).rejects.toThrow(/数量将超过上限/);

    // The prior 20 installs must still be there — a failed install must
    // never partially clobber existing state.
    expect(await listPackSources(store)).toHaveLength(MAX_PACK_COUNT);
  });

  it("ignores an entry's own `pack` field — always overwrites it with the manifest's own id", async () => {
    const store = createMemoryStore();
    stubFetchOnce(
      JSON.stringify(
        makeManifest("custom-pack", {
          terms: [{ term: "Zynthraq", gloss_zh: "测试用生造词", pack: "core" }],
          expressions: [
            {
              expression: "zorp the flanges",
              chinese_explanation: "测试用生造短语",
              pack: "core",
            },
          ],
        }),
      ),
    );

    const { pack } = await addPackSource(OFFICIAL_URL, store);
    expect(pack.terms[0].pack).toBe("custom-pack");
    expect(pack.expressions[0].pack).toBe("custom-pack");
  });
});

describe("install/remove round trip through the extension storage layer", () => {
  it("installs a pack and lists it back from a fresh read of the same store", async () => {
    const store = createMemoryStore();
    stubFetchOnce(JSON.stringify(makeManifest("law-plain-test")), {
      url: "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/packs/law-plain/law-plain.pack.json",
    });

    const result = await addPackSource(OFFICIAL_URL, store);
    expect(result.pack.id).toBe("law-plain-test");

    const sources = await listPackSources(store);
    expect(sources).toHaveLength(1);
    expect(sources[0].pack.id).toBe("law-plain-test");
    expect(sources[0].origin).toBe("official");
  });

  it("removes an installed source by url, leaving the rest intact", async () => {
    const store = createMemoryStore();
    const fetchMock = vi.fn(async (url: string) => {
      const id = new URL(url).pathname.split("/").pop()!.replace(".json", "");
      return fakeResponse(JSON.stringify(makeManifest(id)));
    });
    vi.stubGlobal("fetch", fetchMock);

    await addPackSource("https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/packs/a.json", store);
    await addPackSource("https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/packs/b.json", store);

    let sources = await listPackSources(store);
    expect(sources.map((s) => s.pack.id).sort()).toEqual(["a", "b"]);

    const removed = await removePackSource(sources.find((s) => s.pack.id === "a")!.url, "a", store);
    expect(removed).toBe(true);

    sources = await listPackSources(store);
    expect(sources.map((s) => s.pack.id)).toEqual(["b"]);
  });

  it("reinstalling the same url replaces the prior record rather than duplicating it", async () => {
    const store = createMemoryStore();
    stubFetchOnce(JSON.stringify(makeManifest("v1-pack", { version: "1.0.0" })), { url: OFFICIAL_URL });
    await addPackSource(OFFICIAL_URL, store);

    stubFetchOnce(JSON.stringify(makeManifest("v1-pack", { version: "2.0.0" })), { url: OFFICIAL_URL });
    await addPackSource(OFFICIAL_URL, store);

    const sources = await listPackSources(store);
    expect(sources).toHaveLength(1);
    expect(sources[0].pack.version).toBe("2.0.0");
  });
});

describe("the shared core registry receives loaded packs", () => {
  it("loadPacksIntoRegistry populates getLoadedRemotePacks from whatever is already persisted (startup path)", async () => {
    const store = createMemoryStore();
    stubFetchOnce(JSON.stringify(makeManifest("startup-pack")));
    await addPackSource(OFFICIAL_URL, store);

    // Simulate a fresh panel load: reset the registry, then reload it
    // from the SAME (persisted) store — no addPackSource call this time.
    setLoadedRemotePacks([]);
    expect(getLoadedRemotePacks()).toHaveLength(0);

    await loadPacksIntoRegistry(true, store);
    expect(getLoadedRemotePacks().map((p) => p.id)).toEqual(["startup-pack"]);
  });

  it("addPackSource immediately reflects into getLoadedRemotePacks (no separate reload call needed)", async () => {
    const store = createMemoryStore();
    stubFetchOnce(JSON.stringify(makeManifest("live-pack")));
    await addPackSource(OFFICIAL_URL, store);

    expect(getLoadedRemotePacks().map((p) => p.id)).toEqual(["live-pack"]);
  });

  it("removePackSource immediately clears the removed pack from getLoadedRemotePacks", async () => {
    const store = createMemoryStore();
    stubFetchOnce(JSON.stringify(makeManifest("to-remove")));
    const { url } = await addPackSource(OFFICIAL_URL, store);
    expect(getLoadedRemotePacks()).toHaveLength(1);

    await removePackSource(url, "to-remove", store);
    expect(getLoadedRemotePacks()).toHaveLength(0);
  });
});

describe("origin classification", () => {
  it("classifies the official raw.githubusercontent.com path with a 'main' ref as official", () => {
    expect(
      classifyPackOrigin("https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/index.json"),
    ).toBe("official");
  });

  it("classifies the official jsDelivr gh mirror with a 'main' ref as official", () => {
    expect(classifyPackOrigin("https://cdn.jsdelivr.net/gh/mianaz/jargonslayer-dicts@main/index.json")).toBe(
      "official",
    );
  });

  it("classifies a non-matching host as imported", () => {
    expect(classifyPackOrigin("https://evil.com/pack.json")).toBe("imported");
  });

  it("classifies a lookalike host (subdomain trick) as imported", () => {
    expect(
      classifyPackOrigin("https://raw.githubusercontent.com.evil.com/mianaz/jargonslayer-dicts/main/index.json"),
    ).toBe("imported");
  });

  it("classifies a 40-hex commit SHA ref on the official raw path as imported (Cross-Fork Object Reference)", () => {
    expect(
      classifyPackOrigin(
        "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/0123456789abcdef0123456789abcdef01234567/index.json",
      ),
    ).toBe("imported");
  });

  it("classifies a credentialed url on the official host as imported", () => {
    expect(
      classifyPackOrigin("https://user:pass@raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/index.json"),
    ).toBe("imported");
  });

  it("isAllowedPackUrl: true only for a plain https url with no embedded credentials", () => {
    expect(isAllowedPackUrl("https://raw.githubusercontent.com/x.json")).toBe(true);
    expect(isAllowedPackUrl("http://raw.githubusercontent.com/x.json")).toBe(false);
    expect(isAllowedPackUrl("https://user:pass@raw.githubusercontent.com/x.json")).toBe(false);
    expect(isAllowedPackUrl("not a url")).toBe(false);
  });
});
