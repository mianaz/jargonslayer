// @vitest-environment jsdom
//
// checkAppUpdateWith reads/writes window.localStorage synchronously
// (ETag cache) — needs a real DOM global, same rationale as
// displayStorage.test.ts's own header comment.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getAppVersion mocked to THROW (mirrors tauriApi.ts's own real
// "throws synchronously outside a desktop build" contract) so the
// IS_DESKTOP-gated wrapper test below fails loudly if the gate is ever
// removed — reaching this mock at all outside a desktop build would be
// the bug.
const mockGetAppVersion = vi.fn(() => {
  throw new Error("tauriApi.getAppVersion: unavailable outside a desktop build");
});
vi.mock("../tauriApi", () => ({
  getAppVersion: () => mockGetAppVersion(),
}));

import { checkAppUpdate, checkAppUpdateWith, compareVersions, useUpdateCheck } from "../updateCheck";

function fakeFetchSequence(
  ...responses: Array<{ ok?: boolean; status?: number; etag?: string | null; body?: unknown }>
): typeof fetch {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("fakeFetchSequence: no more queued responses");
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      headers: { get: (name: string) => (name.toLowerCase() === "etag" ? (next.etag ?? null) : null) },
      json: async () => next.body,
    };
  }) as unknown as typeof fetch;
}

function resetStore(): void {
  useUpdateCheck.setState({
    status: "idle",
    currentVersion: "",
    latestVersion: undefined,
    url: undefined,
    checkedAt: undefined,
  });
}

describe("compareVersions — tolerant semver-ish compare", () => {
  it("a v-prefixed newer tag beats a bare current version", () => {
    expect(compareVersions("v0.4.2", "0.4.1")).toBeGreaterThan(0);
  });

  it("older is negative", () => {
    expect(compareVersions("v0.4.0", "0.4.1")).toBeLessThan(0);
  });

  it("equal regardless of v-prefix is 0", () => {
    expect(compareVersions("v0.4.1", "0.4.1")).toBe(0);
    expect(compareVersions("0.4.1", "0.4.1")).toBe(0);
  });

  it("missing components are tolerated as 0 — '0.4' == '0.4.0'", () => {
    expect(compareVersions("0.4", "0.4.0")).toBe(0);
  });

  it("a pre-release/build suffix is stripped before comparing", () => {
    expect(compareVersions("v0.4.2-beta.1", "0.4.1")).toBeGreaterThan(0);
    expect(compareVersions("v0.4.1+build5", "0.4.1")).toBe(0);
  });

  it("garbage input degrades to 0.0.0 rather than throwing/NaN-ing", () => {
    expect(() => compareVersions("garbage", "0.4.1")).not.toThrow();
    expect(compareVersions("garbage", "0.4.1")).toBeLessThan(0);
    expect(compareVersions("garbage", "garbage")).toBe(0);
  });

  it("compares minor/patch too, not just major", () => {
    expect(compareVersions("0.5.0", "0.4.9")).toBeGreaterThan(0);
    expect(compareVersions("0.4.2", "0.4.10")).toBeLessThan(0);
  });
});

describe("checkAppUpdateWith — pure core", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStore();
  });

  it("sets status:checking synchronously, before the fetch resolves", () => {
    let resolveFetch!: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    const fetchImpl = vi.fn(() => pending) as unknown as typeof fetch;

    void checkAppUpdateWith({ fetchImpl, getVersion: async () => "0.4.1" });
    expect(useUpdateCheck.getState().status).toBe("checking");

    resolveFetch({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) });
  });

  it("a fresh 200 with a newer tag_name sets status:available and caches the ETag", async () => {
    const fetchImpl = fakeFetchSequence({
      etag: 'W/"abc123"',
      body: { tag_name: "v0.4.2", html_url: "https://github.com/mianaz/jargonslayer/releases/tag/v0.4.2" },
    });

    await checkAppUpdateWith({ fetchImpl, getVersion: async () => "0.4.1" });

    const s = useUpdateCheck.getState();
    expect(s.status).toBe("available");
    expect(s.currentVersion).toBe("0.4.1");
    expect(s.latestVersion).toBe("v0.4.2");
    expect(s.url).toBe("https://github.com/mianaz/jargonslayer/releases/tag/v0.4.2");
    expect(typeof s.checkedAt).toBe("number");

    const cached = JSON.parse(window.localStorage.getItem("js-update-etag-cache") as string);
    expect(cached).toEqual({
      etag: 'W/"abc123"',
      version: "v0.4.2",
      url: "https://github.com/mianaz/jargonslayer/releases/tag/v0.4.2",
    });
  });

  it("a fresh 200 with the SAME version sets status:current", async () => {
    const fetchImpl = fakeFetchSequence({
      body: { tag_name: "v0.4.1", html_url: "https://example.com/v0.4.1" },
    });

    await checkAppUpdateWith({ fetchImpl, getVersion: async () => "0.4.1" });

    expect(useUpdateCheck.getState().status).toBe("current");
  });

  it("an older tag_name than current also collapses to status:current (never 'available' for a downgrade)", async () => {
    const fetchImpl = fakeFetchSequence({
      body: { tag_name: "v0.3.0", html_url: "https://example.com/v0.3.0" },
    });

    await checkAppUpdateWith({ fetchImpl, getVersion: async () => "0.4.1" });

    expect(useUpdateCheck.getState().status).toBe("current");
  });

  it("a second call sends If-None-Match with the previously-cached ETag", async () => {
    const first = fakeFetchSequence({
      etag: 'W/"abc123"',
      body: { tag_name: "v0.4.1", html_url: "https://example.com/v0.4.1" },
    });
    await checkAppUpdateWith({ fetchImpl: first, getVersion: async () => "0.4.1" });

    const second = vi.fn(async () => ({
      ok: true,
      status: 304,
      headers: { get: () => null },
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await checkAppUpdateWith({ fetchImpl: second, getVersion: async () => "0.4.1" });

    const [, init] = (second as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["If-None-Match"]).toBe('W/"abc123"');
  });

  it("a 304 reuses the cached version/url rather than re-parsing a body", async () => {
    const first = fakeFetchSequence({
      etag: 'W/"abc123"',
      body: { tag_name: "v0.4.2", html_url: "https://example.com/v0.4.2" },
    });
    await checkAppUpdateWith({ fetchImpl: first, getVersion: async () => "0.4.1" });

    const second = fakeFetchSequence({ status: 304 });
    await checkAppUpdateWith({ fetchImpl: second, getVersion: async () => "0.4.1" });

    const s = useUpdateCheck.getState();
    expect(s.status).toBe("available");
    expect(s.latestVersion).toBe("v0.4.2");
    expect(s.url).toBe("https://example.com/v0.4.2");
  });

  it("a non-ok, non-304 status lands on status:error and preserves the PRIOR successful check's fields", async () => {
    const first = fakeFetchSequence({
      body: { tag_name: "v0.4.2", html_url: "https://example.com/v0.4.2" },
    });
    await checkAppUpdateWith({ fetchImpl: first, getVersion: async () => "0.4.1" });

    const second = fakeFetchSequence({ ok: false, status: 500 });
    await checkAppUpdateWith({ fetchImpl: second, getVersion: async () => "0.4.1" });

    const s = useUpdateCheck.getState();
    expect(s.status).toBe("error");
    expect(s.latestVersion).toBe("v0.4.2"); // preserved, not blanked
    expect(s.currentVersion).toBe("0.4.1");
  });

  it("fetchImpl throwing (network failure) lands on status:error without crashing the caller", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(checkAppUpdateWith({ fetchImpl, getVersion: async () => "0.4.1" })).resolves.toBeUndefined();
    expect(useUpdateCheck.getState().status).toBe("error");
  });

  it("getVersion() itself rejecting lands on status:error too (never reaches fetch)", async () => {
    const fetchImpl = vi.fn();
    await checkAppUpdateWith({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getVersion: async () => {
        throw new Error("ipc failure");
      },
    });

    expect(useUpdateCheck.getState().status).toBe("error");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a malformed cached entry in localStorage is ignored, not thrown — falls back to an uncached fetch", async () => {
    window.localStorage.setItem("js-update-etag-cache", "{not valid json");
    const fetchImpl = fakeFetchSequence({
      body: { tag_name: "v0.4.1", html_url: "https://example.com/v0.4.1" },
    });

    await expect(checkAppUpdateWith({ fetchImpl, getVersion: async () => "0.4.1" })).resolves.toBeUndefined();
    expect(useUpdateCheck.getState().status).toBe("current");
  });
});

describe("checkAppUpdate — IS_DESKTOP-guarded real entry point", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStore();
    mockGetAppVersion.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("outside a desktop build (NEXT_PUBLIC_DESKTOP unset in the test env), is an inert no-op — never touches fetch or getAppVersion", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await checkAppUpdate();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockGetAppVersion).not.toHaveBeenCalled();
    expect(useUpdateCheck.getState().status).toBe("idle");
  });
});
