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
