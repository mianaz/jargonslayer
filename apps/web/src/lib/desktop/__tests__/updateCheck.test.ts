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

import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  checkAppUpdate,
  checkAppUpdateWith,
  compareVersions,
  runAppUpdateAutoCheck,
  shouldCheckForAppUpdate,
  shouldShowUpdateBanner,
  useUpdateCheck,
  type RunAppUpdateAutoCheckDeps,
} from "../updateCheck";

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

    await expect(checkAppUpdateWith({ fetchImpl, getVersion: async () => "0.4.1" })).resolves.toEqual({
      rateLimited: false,
    });
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

    await expect(checkAppUpdateWith({ fetchImpl, getVersion: async () => "0.4.1" })).resolves.toEqual({
      rateLimited: false,
    });
    expect(useUpdateCheck.getState().status).toBe("current");
  });
});

// ---------------------------------------------------------------
// Fix round v0.7.7: F4a (rate-limit classification) + F4b (quiet path
// never surfaces status:"error").
// ---------------------------------------------------------------

describe("checkAppUpdateWith — F4a: GitHub rate-limit classification", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStore();
  });

  it("a 403 response is classified as rateLimited:true", async () => {
    const fetchImpl = fakeFetchSequence({ ok: false, status: 403 });
    await expect(checkAppUpdateWith({ fetchImpl, getVersion: async () => "0.4.1" })).resolves.toEqual({
      rateLimited: true,
    });
  });

  it("a 429 response is classified as rateLimited:true too", async () => {
    const fetchImpl = fakeFetchSequence({ ok: false, status: 429 });
    await expect(
      checkAppUpdateWith({ fetchImpl, getVersion: async () => "0.4.1" }, true),
    ).resolves.toEqual({ rateLimited: true });
  });

  it("an ordinary 500 is NOT classified as rateLimited", async () => {
    const fetchImpl = fakeFetchSequence({ ok: false, status: 500 });
    await expect(checkAppUpdateWith({ fetchImpl, getVersion: async () => "0.4.1" })).resolves.toEqual({
      rateLimited: false,
    });
  });
});

describe("checkAppUpdateWith — F4b: the quiet path never surfaces status:error", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStore();
  });

  it("quiet:true — a failure leaves whatever status was showing before untouched, never 'error'", async () => {
    // Seed a real prior successful check so there's a genuine "current"
    // status (and fields) to preserve.
    const first = fakeFetchSequence({
      body: { tag_name: "v0.4.1", html_url: "https://example.com/v0.4.1" },
    });
    await checkAppUpdateWith({ fetchImpl: first, getVersion: async () => "0.4.1" });
    expect(useUpdateCheck.getState().status).toBe("current");

    const second = fakeFetchSequence({ ok: false, status: 500 });
    await checkAppUpdateWith({ fetchImpl: second, getVersion: async () => "0.4.1" }, true);

    const s = useUpdateCheck.getState();
    expect(s.status).toBe("current"); // untouched — never "error"
    expect(s.latestVersion).toBe("v0.4.1");
  });

  it("quiet:true — a failure from the very first check ever (idle, nothing prior) reverts to idle, not error", async () => {
    const fetchImpl = fakeFetchSequence({ ok: false, status: 500 });
    await checkAppUpdateWith({ fetchImpl, getVersion: async () => "0.4.1" }, true);

    expect(useUpdateCheck.getState().status).toBe("idle");
  });

  it("quiet:false (the default, manual checks) — a failure still writes status:error", async () => {
    const first = fakeFetchSequence({
      body: { tag_name: "v0.4.1", html_url: "https://example.com/v0.4.1" },
    });
    await checkAppUpdateWith({ fetchImpl: first, getVersion: async () => "0.4.1" });

    const second = fakeFetchSequence({ ok: false, status: 500 });
    await checkAppUpdateWith({ fetchImpl: second, getVersion: async () => "0.4.1" }); // quiet defaults false

    expect(useUpdateCheck.getState().status).toBe("error");
  });
});

// ---------------------------------------------------------------
// F9 (LOW, adversarial review): the GitHub releases API is documented
// to return only the latest non-draft/non-prerelease release from
// /releases/latest, but this check must not blindly TRUST that
// endpoint semantics never change/differ (a private mirror, a future
// API version, …) — draft/prerelease responses are explicitly ignored,
// and tag_name is validated against a strict vX.Y.Z shape before ever
// being trusted as latestVersion. Neither case may ever reach
// status:"available" — status:"error" (this file's own existing
// non-ok-status/network-failure cases already land there too, and
// preserve whatever a PRIOR successful check found).
// ---------------------------------------------------------------

describe("checkAppUpdateWith — F9: never trusts a draft/prerelease/malformed-tag response", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStore();
  });

  it("a draft:true release is ignored — lands on status:error, never available", async () => {
    const fetchImpl = fakeFetchSequence({
      body: { tag_name: "v0.4.2", html_url: "https://example.com/v0.4.2", draft: true },
    });

    await checkAppUpdateWith({ fetchImpl, getVersion: async () => "0.4.1" });

    expect(useUpdateCheck.getState().status).toBe("error");
  });

  it("a prerelease:true release is ignored — lands on status:error, never available", async () => {
    const fetchImpl = fakeFetchSequence({
      body: { tag_name: "v0.4.2", html_url: "https://example.com/v0.4.2", prerelease: true },
    });

    await checkAppUpdateWith({ fetchImpl, getVersion: async () => "0.4.1" });

    expect(useUpdateCheck.getState().status).toBe("error");
  });

  it("a draft/prerelease response never overwrites (or caches) a PRIOR successful check's fields", async () => {
    const first = fakeFetchSequence({
      etag: 'W/"abc123"',
      body: { tag_name: "v0.4.2", html_url: "https://example.com/v0.4.2" },
    });
    await checkAppUpdateWith({ fetchImpl: first, getVersion: async () => "0.4.1" });
    expect(useUpdateCheck.getState().status).toBe("available");

    const second = fakeFetchSequence({
      body: { tag_name: "v0.4.3", html_url: "https://example.com/v0.4.3", prerelease: true },
    });
    await checkAppUpdateWith({ fetchImpl: second, getVersion: async () => "0.4.1" });

    const s = useUpdateCheck.getState();
    expect(s.status).toBe("error");
    expect(s.latestVersion).toBe("v0.4.2"); // preserved, not overwritten by the ignored prerelease
    const cached = JSON.parse(window.localStorage.getItem("js-update-etag-cache") as string);
    expect(cached.version).toBe("v0.4.2"); // never cached either
  });

  it.each(["v0.4.2-rc1", "4x.1.0"])(
    "a malformed release tag (%s) is rejected — lands on status:error, never available",
    async (tag_name) => {
      const fetchImpl = fakeFetchSequence({
        body: { tag_name, html_url: "https://example.com/release" },
      });

      await checkAppUpdateWith({ fetchImpl, getVersion: async () => "0.4.1" });

      expect(useUpdateCheck.getState().status).toBe("error");
    },
  );

  it("a well-formed bare (no v-prefix) tag still passes — the strict check isn't v-prefix-only", async () => {
    const fetchImpl = fakeFetchSequence({
      body: { tag_name: "0.4.2", html_url: "https://example.com/v0.4.2" },
    });

    await checkAppUpdateWith({ fetchImpl, getVersion: async () => "0.4.1" });

    expect(useUpdateCheck.getState().status).toBe("available");
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

// ---------------------------------------------------------------
// Field-fix #8 v2: shouldCheckForAppUpdate (pure gate) + runAppUpdate
// AutoCheck (deps-injected orchestrator) — mirrors lib/detect/
// packAutoUpdate.ts's own shouldCheckForPackUpdates/runPackAutoUpdate
// tests almost line for line (see that file's own header comment for
// why this is the precedent), minus the enabled/online/hasInstalledPacks
// preconditions this simpler gate doesn't have.
// ---------------------------------------------------------------

describe("shouldCheckForAppUpdate", () => {
  const now = 1_700_000_000_000;

  it("a missing lastCheckedAt (never auto-checked before) counts as due", () => {
    expect(shouldCheckForAppUpdate({ now })).toBe(true);
  });

  it("false while still within the 24h interval", () => {
    expect(
      shouldCheckForAppUpdate({ now, lastCheckedAt: now - APP_UPDATE_CHECK_INTERVAL_MS + 1000 }),
    ).toBe(false);
  });

  it("true once the interval has fully elapsed (boundary: exactly at the interval)", () => {
    expect(
      shouldCheckForAppUpdate({ now, lastCheckedAt: now - APP_UPDATE_CHECK_INTERVAL_MS }),
    ).toBe(true);
  });

  it("true well past the interval", () => {
    expect(
      shouldCheckForAppUpdate({ now, lastCheckedAt: now - APP_UPDATE_CHECK_INTERVAL_MS * 3 }),
    ).toBe(true);
  });

  it("a lastCheckedAt in the future (clock skew) counts as due, never permanently not-due", () => {
    expect(shouldCheckForAppUpdate({ now, lastCheckedAt: now + 60_000 })).toBe(true);
    // Even a tiny skew (1ms ahead) — the naive `now - lastCheckedAt >=
    // INTERVAL` would compute a negative number here (always < INTERVAL,
    // i.e. never due) without the explicit future-timestamp check.
    expect(shouldCheckForAppUpdate({ now, lastCheckedAt: now + 1 })).toBe(true);
  });
});

describe("runAppUpdateAutoCheck", () => {
  function baseDeps(overrides: Partial<RunAppUpdateAutoCheckDeps> = {}): RunAppUpdateAutoCheckDeps {
    return {
      now: 1_700_000_000_000,
      isMeetingActive: () => false,
      check: vi.fn(async () => {}),
      recordCheckedAt: vi.fn(),
      ...overrides,
    };
  }

  it("calls the injected check() and records checkedAt on a due, non-meeting run", async () => {
    const check = vi.fn(async () => {});
    const recordCheckedAt = vi.fn();

    const result = await runAppUpdateAutoCheck(baseDeps({ check, recordCheckedAt }));

    expect(check).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ checked: true });
    expect(recordCheckedAt).toHaveBeenCalledWith(1_700_000_000_000);
  });

  it("never throws when check() rejects — still resolves checked:true", async () => {
    const check = vi.fn(async () => {
      throw new Error("network down");
    });
    const recordCheckedAt = vi.fn();

    await expect(
      runAppUpdateAutoCheck(baseDeps({ check, recordCheckedAt })),
    ).resolves.toEqual({ checked: true });
  });

  it("records the timestamp even when check() rejects — a persistently-dead endpoint must not re-check on every launch", async () => {
    const check = vi.fn(async () => {
      throw new Error("boom");
    });
    const recordCheckedAt = vi.fn();

    await runAppUpdateAutoCheck(baseDeps({ check, recordCheckedAt, now: 42 }));

    expect(recordCheckedAt).toHaveBeenCalledWith(42);
  });

  it("skips entirely — never calls check, never records — while a meeting is live", async () => {
    const check = vi.fn(async () => {});
    const recordCheckedAt = vi.fn();

    const result = await runAppUpdateAutoCheck(
      baseDeps({ isMeetingActive: () => true, check, recordCheckedAt }),
    );

    expect(result).toEqual({ checked: false });
    expect(check).not.toHaveBeenCalled();
    expect(recordCheckedAt).not.toHaveBeenCalled();
  });

  it("skips — never calls check, never records — when not due yet", async () => {
    const check = vi.fn(async () => {});
    const recordCheckedAt = vi.fn();

    const result = await runAppUpdateAutoCheck(
      baseDeps({ lastCheckedAt: 1_700_000_000_000 - 1000, check, recordCheckedAt }),
    );

    expect(result).toEqual({ checked: false });
    expect(check).not.toHaveBeenCalled();
    expect(recordCheckedAt).not.toHaveBeenCalled();
  });

  it("never throws when isMeetingActive() itself throws synchronously", async () => {
    const isMeetingActive = vi.fn(() => {
      throw new Error("store not ready");
    });

    await expect(runAppUpdateAutoCheck(baseDeps({ isMeetingActive }))).resolves.toEqual({
      checked: false,
    });
  });

  // F4a fix (fix round v0.7.7, adversarial review): a GitHub 403/429 is
  // treated as NOT a completed check — recordCheckedAt is skipped so the
  // NEXT launch retries instead of the transient throttle silently
  // going quiet for the full 24h cadence interval.
  it("F4a: skips recordCheckedAt and returns checked:false when check() reports rateLimited:true", async () => {
    const check = vi.fn(async () => ({ rateLimited: true }));
    const recordCheckedAt = vi.fn();

    const result = await runAppUpdateAutoCheck(baseDeps({ check, recordCheckedAt }));

    expect(check).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ checked: false });
    expect(recordCheckedAt).not.toHaveBeenCalled();
  });

  it("F4a: still records checkedAt when check() reports rateLimited:false — only an actual 403/429 skips it", async () => {
    const check = vi.fn(async () => ({ rateLimited: false }));
    const recordCheckedAt = vi.fn();

    await runAppUpdateAutoCheck(baseDeps({ check, recordCheckedAt, now: 99 }));

    expect(recordCheckedAt).toHaveBeenCalledWith(99);
  });
});

describe("shouldShowUpdateBanner", () => {
  it("false when status isn't 'available', even with a latestVersion set", () => {
    expect(shouldShowUpdateBanner({ status: "current", latestVersion: "v0.5.0" })).toBe(false);
    expect(shouldShowUpdateBanner({ status: "checking", latestVersion: "v0.5.0" })).toBe(false);
    expect(shouldShowUpdateBanner({ status: "error", latestVersion: "v0.5.0" })).toBe(false);
    expect(shouldShowUpdateBanner({ status: "idle" })).toBe(false);
  });

  it("true when available with no prior dismissal", () => {
    expect(shouldShowUpdateBanner({ status: "available", latestVersion: "v0.5.0" })).toBe(true);
  });

  it("false once the user dismissed exactly this version", () => {
    expect(
      shouldShowUpdateBanner({ status: "available", latestVersion: "v0.5.0", dismissedVersion: "v0.5.0" }),
    ).toBe(false);
  });

  it("true again for a NEWER version even though an older one was dismissed — non-nag, not silence-forever", () => {
    expect(
      shouldShowUpdateBanner({ status: "available", latestVersion: "v0.6.0", dismissedVersion: "v0.5.0" }),
    ).toBe(true);
  });

  it("false when latestVersion is itself absent (shouldn't happen alongside status:available, but must not crash/show)", () => {
    expect(shouldShowUpdateBanner({ status: "available" })).toBe(false);
  });
});
