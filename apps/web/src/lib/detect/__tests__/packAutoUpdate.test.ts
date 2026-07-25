// Round-2 dict-pack auto-update — shouldCheckForPackUpdates (pure gate)
// and runPackAutoUpdate (deps-injected orchestrator, mirrors lib/
// desktop/updateCheck.ts's own checkAppUpdateWith(deps) testing style:
// every fake is a plain vi.fn(), no real fetch/IndexedDB/store).

import { describe, expect, it, vi } from "vitest";
import {
  PACK_UPDATE_INTERVAL_MS,
  runPackAutoUpdate,
  shouldCheckForPackUpdates,
  type RunPackAutoUpdateDeps,
} from "../packAutoUpdate";

describe("shouldCheckForPackUpdates", () => {
  const now = 1_700_000_000_000;

  it("false when disabled, even though every other input says due", () => {
    expect(
      shouldCheckForPackUpdates({ enabled: false, online: true, hasInstalledPacks: true, now }),
    ).toBe(false);
  });

  it("false when the browser reports offline", () => {
    expect(
      shouldCheckForPackUpdates({ enabled: true, online: false, hasInstalledPacks: true, now }),
    ).toBe(false);
  });

  it("false when nothing is installed to refresh", () => {
    expect(
      shouldCheckForPackUpdates({ enabled: true, online: true, hasInstalledPacks: false, now }),
    ).toBe(false);
  });

  it("false while still within the interval", () => {
    expect(
      shouldCheckForPackUpdates({
        enabled: true,
        online: true,
        hasInstalledPacks: true,
        now,
        lastCheckedAt: now - PACK_UPDATE_INTERVAL_MS + 1000,
      }),
    ).toBe(false);
  });

  it("true once the interval has fully elapsed (boundary: exactly at the interval)", () => {
    expect(
      shouldCheckForPackUpdates({
        enabled: true,
        online: true,
        hasInstalledPacks: true,
        now,
        lastCheckedAt: now - PACK_UPDATE_INTERVAL_MS,
      }),
    ).toBe(true);
  });

  it("true well past the interval", () => {
    expect(
      shouldCheckForPackUpdates({
        enabled: true,
        online: true,
        hasInstalledPacks: true,
        now,
        lastCheckedAt: now - PACK_UPDATE_INTERVAL_MS * 3,
      }),
    ).toBe(true);
  });

  it("a missing lastCheckedAt (never auto-checked before) counts as due", () => {
    expect(
      shouldCheckForPackUpdates({ enabled: true, online: true, hasInstalledPacks: true, now }),
    ).toBe(true);
  });

  it("a lastCheckedAt in the future (clock skew) counts as due, never permanently not-due", () => {
    expect(
      shouldCheckForPackUpdates({
        enabled: true,
        online: true,
        hasInstalledPacks: true,
        now,
        lastCheckedAt: now + 60_000,
      }),
    ).toBe(true);
    // Even a tiny skew (1ms ahead) — the naive `now - lastCheckedAt >=
    // INTERVAL` would compute a negative number here (always < INTERVAL,
    // i.e. never due) without the explicit future-timestamp check.
    expect(
      shouldCheckForPackUpdates({
        enabled: true,
        online: true,
        hasInstalledPacks: true,
        now,
        lastCheckedAt: now + 1,
      }),
    ).toBe(true);
  });
});

describe("runPackAutoUpdate", () => {
  function baseDeps(overrides: Partial<RunPackAutoUpdateDeps> = {}): RunPackAutoUpdateDeps {
    return {
      enabled: true,
      online: true,
      hasInstalledPacks: true,
      now: 1_700_000_000_000,
      isMeetingActive: () => false,
      checkUpdates: vi.fn(async () => []),
      recordCheckedAt: vi.fn(),
      ...overrides,
    };
  }

  it("reuses the injected checkUpdates() (no second update path) and records checkedAt on success", async () => {
    const checkUpdates = vi.fn(async () => ["pack-a", "pack-b"]);
    const recordCheckedAt = vi.fn();

    const result = await runPackAutoUpdate(baseDeps({ checkUpdates, recordCheckedAt }));

    expect(checkUpdates).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ checked: true, updated: ["pack-a", "pack-b"], failed: 0 });
    expect(recordCheckedAt).toHaveBeenCalledWith(1_700_000_000_000);
  });

  it("never throws when checkUpdates() rejects — reports failed:1 instead of propagating", async () => {
    const checkUpdates = vi.fn(async () => {
      throw new Error("网络错误");
    });
    const recordCheckedAt = vi.fn();

    await expect(
      runPackAutoUpdate(baseDeps({ checkUpdates, recordCheckedAt })),
    ).resolves.toEqual({ checked: true, updated: [], failed: 1 });
  });

  it("records the timestamp even on a checkUpdates() failure — a persistently-dead source must not re-run on every launch", async () => {
    const checkUpdates = vi.fn(async () => {
      throw new Error("boom");
    });
    const recordCheckedAt = vi.fn();

    await runPackAutoUpdate(baseDeps({ checkUpdates, recordCheckedAt, now: 42 }));

    expect(recordCheckedAt).toHaveBeenCalledWith(42);
  });

  it("skips entirely — never calls checkUpdates, never records — while a meeting is live", async () => {
    const checkUpdates = vi.fn(async () => ["pack-a"]);
    const recordCheckedAt = vi.fn();

    const result = await runPackAutoUpdate(
      baseDeps({ isMeetingActive: () => true, checkUpdates, recordCheckedAt }),
    );

    expect(result).toEqual({ checked: false, updated: [], failed: 0 });
    expect(checkUpdates).not.toHaveBeenCalled();
    expect(recordCheckedAt).not.toHaveBeenCalled();
  });

  it("skips — never calls checkUpdates, never records — when not due yet", async () => {
    const checkUpdates = vi.fn(async () => ["pack-a"]);
    const recordCheckedAt = vi.fn();

    const result = await runPackAutoUpdate(
      baseDeps({ lastCheckedAt: 1_700_000_000_000 - 1000, checkUpdates, recordCheckedAt }),
    );

    expect(result).toEqual({ checked: false, updated: [], failed: 0 });
    expect(checkUpdates).not.toHaveBeenCalled();
    expect(recordCheckedAt).not.toHaveBeenCalled();
  });

  // MEDIUM-2 fix (v0.6 round-2 review): re-checks isMeetingActive()
  // AGAIN right before recordCheckedAt — deps.checkUpdates() itself can
  // run for several seconds; a meeting that started WHILE it was
  // running must bail without stamping, or the NEXT due-check (once
  // the meeting ends) would be robbed of its due-ness for a full
  // PACK_UPDATE_INTERVAL_MS. Fails against pre-fix code, which only
  // ever checked isMeetingActive() once, at entry.
  it("re-checks isMeetingActive() right before stamping — a meeting that started mid-checkUpdates() bails without recording", async () => {
    let calls = 0;
    const isMeetingActive = vi.fn(() => {
      calls += 1;
      return calls > 1; // false on the entry check, true on the pre-stamp re-check
    });
    const checkUpdates = vi.fn(async () => ["pack-a"]);
    const recordCheckedAt = vi.fn();

    const result = await runPackAutoUpdate(baseDeps({ isMeetingActive, checkUpdates, recordCheckedAt }));

    expect(checkUpdates).toHaveBeenCalledTimes(1); // the check itself still ran to completion
    expect(recordCheckedAt).not.toHaveBeenCalled(); // but never stamped
    expect(result).toEqual({ checked: false, updated: [], failed: 0 });
  });

  it("never throws when isMeetingActive() itself throws synchronously", async () => {
    const isMeetingActive = vi.fn(() => {
      throw new Error("store not ready");
    });

    await expect(runPackAutoUpdate(baseDeps({ isMeetingActive }))).resolves.toEqual({
      checked: false,
      updated: [],
      failed: 0,
    });
  });
});
