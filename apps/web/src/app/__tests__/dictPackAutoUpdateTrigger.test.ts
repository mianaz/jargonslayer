// Round-2 dict-pack auto-update — page.tsx has no component test
// harness in this repo (see wizardHelpTransition.ts's own header
// comment for why), so this pins triggerDictPackAutoUpdate's own
// never-produces-an-unhandled-rejection contract directly, with every
// dependency faked. Deliberately exercises the REAL runPackAutoUpdate
// (not mocked) — it's already independently covered by lib/detect/
// __tests__/packAutoUpdate.test.ts, so letting it run for real here is
// a genuine (still fully deterministic) integration of two already-
// tested, deps-injected pieces rather than a duplicated re-mock.

import { describe, expect, it, vi } from "vitest";
import { getDiagEntries } from "@/lib/diag/log";
import { triggerDictPackAutoUpdate, type DictPackAutoUpdateTriggerDeps } from "../dictPackAutoUpdateTrigger";

function baseDeps(overrides: Partial<DictPackAutoUpdateTriggerDeps> = {}): DictPackAutoUpdateTriggerDeps {
  return {
    getSettings: () => ({ packAutoUpdate: true, packAutoUpdateCheckedAt: undefined }),
    isOnline: () => true,
    isMeetingActive: () => false,
    listPackSources: vi.fn(async () => [{ url: "https://example.com/a.json" }]),
    checkUpdates: vi.fn(async () => ["a"]),
    recordCheckedAt: vi.fn(),
    ...overrides,
  };
}

describe("triggerDictPackAutoUpdate — MEDIUM-1 fix (v0.6 round-2 review): module-level in-flight guard", () => {
  // Fails against pre-fix code, where every call started its own fresh
  // run — checkUpdates would have been called twice here, one queued
  // behind the other by remotePacks.ts's own enqueueSourcesOp
  // serialization, exactly the "flaky wifi -> 8 queued rounds x 20
  // packs" hazard this fix closes.
  it("two OVERLAPPING calls (neither awaited before the next fires) share ONE in-flight run — checkUpdates is called only once", async () => {
    let resolveCheck!: () => void;
    const checkUpdates = vi.fn(
      () =>
        new Promise<string[]>((res) => {
          resolveCheck = () => res(["a"]);
        }),
    );
    const recordCheckedAt = vi.fn();

    const p1 = triggerDictPackAutoUpdate(baseDeps({ checkUpdates, recordCheckedAt }));
    const p2 = triggerDictPackAutoUpdate(baseDeps({ checkUpdates, recordCheckedAt }));

    // triggerDictPackAutoUpdate's own async body awaits listPackSources()
    // before runPackAutoUpdate ever reaches checkUpdates() — drain
    // microtasks until it's actually been invoked (so resolveCheck is
    // assigned) rather than assuming it happens within this same tick.
    for (let i = 0; i < 10 && checkUpdates.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(checkUpdates).toHaveBeenCalledTimes(1); // the second call never started a second round

    resolveCheck();
    await Promise.all([p1, p2]);

    expect(checkUpdates).toHaveBeenCalledTimes(1); // still just once after both settle
    expect(recordCheckedAt).toHaveBeenCalledTimes(1);
  });

  it("a call that arrives AFTER the previous one has already settled starts a genuinely NEW round", async () => {
    const checkUpdates = vi.fn(async () => ["a"]);

    await triggerDictPackAutoUpdate(baseDeps({ checkUpdates }));
    await triggerDictPackAutoUpdate(baseDeps({ checkUpdates }));

    expect(checkUpdates).toHaveBeenCalledTimes(2);
  });
});

describe("triggerDictPackAutoUpdate — page.tsx startup/online-event wiring", () => {
  it("gathers real deps into runPackAutoUpdate, records checkedAt, and diagLogs the outcome", async () => {
    const recordCheckedAt = vi.fn();
    const beforeCount = getDiagEntries().length;

    await triggerDictPackAutoUpdate(baseDeps({ recordCheckedAt }));

    expect(recordCheckedAt).toHaveBeenCalled();
    const entries = getDiagEntries();
    expect(entries.length).toBe(beforeCount + 1);
    expect(entries[entries.length - 1]).toMatchObject({ tag: "dict-update", level: "info" });
  });

  it("a due:false outcome (auto-update disabled) never calls checkUpdates/recordCheckedAt, and still logs", async () => {
    const checkUpdates = vi.fn(async () => ["a"]);
    const recordCheckedAt = vi.fn();
    const beforeCount = getDiagEntries().length;

    await triggerDictPackAutoUpdate(
      baseDeps({ getSettings: () => ({ packAutoUpdate: false }), checkUpdates, recordCheckedAt }),
    );

    expect(checkUpdates).not.toHaveBeenCalled();
    expect(recordCheckedAt).not.toHaveBeenCalled();
    expect(getDiagEntries().length).toBe(beforeCount + 1);
  });

  it("a rejecting checkUpdates() never rejects the returned promise (fire-and-forget safe)", async () => {
    const checkUpdates = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(triggerDictPackAutoUpdate(baseDeps({ checkUpdates }))).resolves.toBeUndefined();
  });

  it("a rejecting listPackSources() never rejects the returned promise either", async () => {
    const listPackSources = vi.fn(async () => {
      throw new Error("idb unavailable");
    });
    await expect(
      triggerDictPackAutoUpdate(baseDeps({ listPackSources })),
    ).resolves.toBeUndefined();
  });

  it("a synchronously-throwing getSettings() never rejects the returned promise", async () => {
    const getSettings = vi.fn((): { packAutoUpdate: boolean; packAutoUpdateCheckedAt?: number } => {
      throw new Error("store not ready");
    });
    await expect(triggerDictPackAutoUpdate(baseDeps({ getSettings }))).resolves.toBeUndefined();
  });

  it("a synchronously-throwing isOnline()/isMeetingActive() never rejects the returned promise", async () => {
    const isOnline = vi.fn((): boolean => {
      throw new Error("navigator unavailable");
    });
    await expect(triggerDictPackAutoUpdate(baseDeps({ isOnline }))).resolves.toBeUndefined();
  });
});
