import { afterEach, describe, expect, it, vi } from "vitest";
import { DICT_CATALOG_URLS, fetchDictCatalog } from "../dictCatalog";

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
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

  it("returns an empty pack list (never throws) when `packs` itself is missing/malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ schemaVersion: 1 })));
    const catalog = await fetchDictCatalog();
    expect(catalog.packs).toEqual([]);
  });
});
