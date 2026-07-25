// End-to-end proof of the "Matcher" requirement: once storage/
// remotePacks.ts loads an installed pack into @jargonslayer/core's
// shared remotePacksRegistry, scanDictionary (main.ts:142's own call)
// picks it up with NO extension-side change — this test never mocks
// scanDictionary or the registry, unlike dictionarySmoke.test.ts's own
// header, which explicitly defers this exact proof to whichever worker
// wires up remote-pack loading in this app.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { scanDictionary } from "@jargonslayer/core/detect/dictionary";
import { setLoadedRemotePacks } from "@jargonslayer/core/detect/remotePacksRegistry";

import { addPackSource, loadPacksIntoRegistry, type PacksStore } from "../storage/remotePacks";

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

function fakeResponse(body: string): Response {
  return { ok: true, status: 200, url: "", text: async () => body } as Response;
}

const UNIQUE_TERM = "Zynthraq"; // not a real word — guaranteed absent from every built-in pack
const UNIQUE_URL = "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/packs/e2e-test.json";

beforeEach(() => {
  vi.unstubAllGlobals();
  setLoadedRemotePacks([]);
});

describe("installed pack -> registry -> scanDictionary, end to end", () => {
  it("a term absent from every built-in pack is NOT matched before install", () => {
    const { terms } = scanDictionary(`Let's discuss ${UNIQUE_TERM} in the next sprint.`);
    expect(terms.some((t) => t.term === UNIQUE_TERM)).toBe(false);
  });

  it("scanDictionary matches a term that exists ONLY in a freshly-installed pack", async () => {
    const store = createMemoryStore();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse(
          JSON.stringify({
            id: "e2e-test-pack",
            name: "E2E Test Pack",
            version: "1.0.0",
            terms: [
              {
                term: UNIQUE_TERM,
                type: "tech",
                gloss_en: "a made-up term for this test",
                gloss_zh: "测试用生造词",
              },
            ],
          }),
        ),
      ),
    );

    await addPackSource(UNIQUE_URL, store);

    const { terms } = scanDictionary(`Let's discuss ${UNIQUE_TERM} in the next sprint.`);
    const match = terms.find((t) => t.term === UNIQUE_TERM);
    expect(match).toBeDefined();
    expect(match?.gloss_zh).toBe("测试用生造词");
  });

  it("also matches after a fresh loadPacksIntoRegistry() from persisted storage (the real panel-load path)", async () => {
    const store = createMemoryStore();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse(
          JSON.stringify({
            id: "e2e-startup-pack",
            name: "E2E Startup Pack",
            version: "1.0.0",
            terms: [
              {
                term: "Flurbnix",
                type: "tech",
                gloss_en: "another made-up term",
                gloss_zh: "另一个测试用生造词",
              },
            ],
          }),
        ),
      ),
    );
    await addPackSource(UNIQUE_URL, store);

    // Simulate a fresh panel open: registry reset, then reloaded from
    // storage only — exactly what main.ts's own
    // `void loadPacksIntoRegistry().then(...)` init call does.
    setLoadedRemotePacks([]);
    await loadPacksIntoRegistry(true, store);

    const { terms } = scanDictionary("Flurbnix needs a fix before the release.");
    expect(terms.some((t) => t.term === "Flurbnix")).toBe(true);
  });
});
