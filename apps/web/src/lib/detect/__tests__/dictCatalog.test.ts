import { afterEach, describe, expect, it, vi } from "vitest";
import { DICT_CATALOG_URLS, fetchDictCatalog } from "../dictCatalog";

function jsonResponse(payload: unknown, ok = true, status = 200) {
  // N4(c) fix round: fetchIndex now reads the raw body via res.text()
  // (so it can size-cap the wire bytes before JSON.parse) instead of
  // res.json() — mirrors remotePacks.test.ts's own mockFetchOnce for
  // the identical reason.
  return {
    ok,
    status,
    text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    json: async () => payload,
  } as Response;
}

describe("fetchDictCatalog — v0.6 T6 catalog index fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the primary URL and returns validated rows", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(DICT_CATALOG_URLS.primary);
      return jsonResponse({
        schemaVersion: 1,
        updatedAt: "2026-07-01",
        packs: [
          { id: "pharma", name: "医药与生物科技", version: "1.0", url: "https://example.com/pharma.json" },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await fetchDictCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(catalog.packs).toHaveLength(1);
    expect(catalog.packs[0].id).toBe("pharma");
  });

  it("falls back to the jsDelivr mirror when the primary fetch fails (mainland access is unreliable)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === DICT_CATALOG_URLS.primary) throw new Error("network error");
      expect(url).toBe(DICT_CATALOG_URLS.fallback);
      return jsonResponse({ packs: [{ id: "a", name: "A", version: 1, url: "https://example.com/a.json" }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await fetchDictCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(catalog.packs).toHaveLength(1);
  });

  it("falls back on a non-2xx primary response too, not just a network error", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === DICT_CATALOG_URLS.primary) return jsonResponse({}, false, 404);
      return jsonResponse({ packs: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await fetchDictCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(catalog.packs).toEqual([]);
  });

  it("throws once BOTH primary and fallback fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network error");
      }),
    );
    await expect(fetchDictCatalog()).rejects.toThrow();
  });

  it("drops malformed rows (missing required fields) instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          packs: [
            { id: "good", name: "Good Pack", version: 1, url: "https://example.com/good.json" },
            { id: "no-url", name: "Missing URL", version: 1 },
            { name: "Missing id", version: 1, url: "https://example.com/x.json" },
            "not even an object",
            null,
          ],
        }),
      ),
    );

    const catalog = await fetchDictCatalog();
    expect(catalog.packs).toHaveLength(1);
    expect(catalog.packs[0].id).toBe("good");
  });

  it("N7(a) fix: throws (does not silently succeed with 0 packs) when `packs` is missing/malformed on BOTH primary and fallback", async () => {
    // Before N7a, a syntactically-valid-but-semantically-broken 200
    // response (`packs` missing) was accepted as "0 packs, done" and
    // the fallback was never even tried — now semantic invalidity
    // counts as a failure just like a network error, so with BOTH
    // sources returning the same broken shape this rejects.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ schemaVersion: 1 })));
    await expect(fetchDictCatalog()).rejects.toThrow();
  });

  it("N7(a) fix: falls back to the mirror when the PRIMARY response is syntactically valid JSON but semantically broken (`packs` missing) — this used to be silently accepted as an empty catalog and the fallback was never reached", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === DICT_CATALOG_URLS.primary) return jsonResponse({ schemaVersion: 1 }); // no `packs` key
      return jsonResponse({ packs: [{ id: "real", name: "Real Pack", version: 1, url: "https://example.com/real.json" }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await fetchDictCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(catalog.packs).toHaveLength(1);
    expect(catalog.packs[0].id).toBe("real");
  });

  it("N7(a) fix: also falls back when `packs` is present but not an array (`{packs:\"bad\"}`)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === DICT_CATALOG_URLS.primary) return jsonResponse({ packs: "bad" });
      return jsonResponse({ packs: [{ id: "real", name: "Real Pack", version: 1, url: "https://example.com/real.json" }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await fetchDictCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(catalog.packs).toHaveLength(1);
  });

  it("N4(c) fix: rejects an oversized catalog response (falls back to the mirror rather than parsing it)", async () => {
    const hugeIndex = { packs: [{ id: "x", name: "x".repeat(600_000), version: 1, url: "https://example.com/x.json" }] };
    const fetchMock = vi.fn(async (url: string) => {
      if (url === DICT_CATALOG_URLS.primary) return jsonResponse(hugeIndex);
      return jsonResponse({ packs: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await fetchDictCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(catalog.packs).toEqual([]);
  });

  it("N4(c) fix: caps the number of rows at MAX_CATALOG_ROWS even when the source returns more", async () => {
    const manyPacks = Array.from({ length: 250 }, (_, i) => ({
      id: `pack-${i}`,
      name: `Pack ${i}`,
      version: 1,
      url: `https://example.com/pack-${i}.json`,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ packs: manyPacks })));

    const catalog = await fetchDictCatalog();
    expect(catalog.packs.length).toBeLessThanOrEqual(200);
    expect(catalog.packs.length).toBeLessThan(250);
  });
});
