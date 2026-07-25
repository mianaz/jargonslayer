// Exercises fetchDictCatalog's primary->mirror fallback and its lenient
// row validation against a stubbed global fetch — same vi.stubGlobal
// idiom savedLookups.test.ts uses for chrome.storage.local, applied
// here to the Node 18+ global `fetch` this module calls directly.

import { afterEach, describe, expect, it, vi } from "vitest";

import { DICT_CATALOG_URLS, fetchDictCatalog } from "../dictCatalog";

function fakeResponse(body: string, opts: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: async () => body,
  } as Response;
}

const GOOD_CATALOG = JSON.stringify({
  schemaVersion: 1,
  updatedAt: "2026-07-24T00:00:00.000Z",
  packs: [
    {
      id: "law-plain",
      name: "日常法律术语",
      description: "美国联邦机构 + 欧盟 EUR-Lex 来源",
      version: "2026-07-24",
      entryCount: 320,
      license: "CC BY 4.0",
      url: "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/packs/law-plain/law-plain.pack.json",
    },
  ],
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchDictCatalog", () => {
  it("fetches the primary URL and returns its packs on success", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(DICT_CATALOG_URLS.primary);
      return fakeResponse(GOOD_CATALOG);
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await fetchDictCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(catalog.packs).toHaveLength(1);
    expect(catalog.packs[0].id).toBe("law-plain");
  });

  it("falls back to the jsDelivr mirror when the primary fails, and only the primary is tried first", async () => {
    const calledUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calledUrls.push(url);
      if (url === DICT_CATALOG_URLS.primary) {
        throw new Error("simulated network error");
      }
      return fakeResponse(GOOD_CATALOG);
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await fetchDictCatalog();
    expect(calledUrls).toEqual([DICT_CATALOG_URLS.primary, DICT_CATALOG_URLS.fallback]);
    expect(catalog.packs).toHaveLength(1);
  });

  it("falls back to the mirror when the primary returns a non-2xx status", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === DICT_CATALOG_URLS.primary) return fakeResponse("", { ok: false, status: 500 });
      return fakeResponse(GOOD_CATALOG);
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await fetchDictCatalog();
    expect(catalog.packs).toHaveLength(1);
  });

  it("falls back to the mirror when the primary's JSON has a semantically-broken shape (not just a parse error)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === DICT_CATALOG_URLS.primary) return fakeResponse(JSON.stringify({ packs: "bad" }));
      return fakeResponse(GOOD_CATALOG);
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await fetchDictCatalog();
    expect(catalog.packs).toHaveLength(1);
  });

  it("throws once BOTH the primary and the mirror fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("simulated network error");
      }),
    );

    await expect(fetchDictCatalog()).rejects.toThrow();
  });

  it("drops a malformed row (missing url) but keeps the well-formed ones", async () => {
    const catalogWithBadRow = JSON.stringify({
      packs: [
        { id: "good", name: "Good Pack", version: "1.0.0", url: "https://example.com/good.json" },
        { id: "bad-no-url", name: "Bad Pack", version: "1.0.0" },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(catalogWithBadRow)),
    );

    const catalog = await fetchDictCatalog();
    expect(catalog.packs.map((p) => p.id)).toEqual(["good"]);
  });

  it("rejects an oversized catalog response (falls back to the mirror instead of buffering it)", async () => {
    const oversized = "x".repeat(600 * 1024); // > 512 KB cap
    const fetchMock = vi.fn(async (url: string) => {
      if (url === DICT_CATALOG_URLS.primary) return fakeResponse(oversized);
      return fakeResponse(GOOD_CATALOG);
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await fetchDictCatalog();
    expect(catalog.packs).toHaveLength(1);
  });
});
