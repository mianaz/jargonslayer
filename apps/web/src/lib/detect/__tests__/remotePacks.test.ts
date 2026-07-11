import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memStore = new Map<string, unknown>();

vi.mock("idb-keyval", () => ({
  get: vi.fn(async (key: string) => memStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    memStore.set(key, value);
  }),
}));

function mockFetchOnce(payload: unknown, ok = true, status = 200) {
  global.fetch = vi.fn(async () => ({
    ok,
    status,
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
