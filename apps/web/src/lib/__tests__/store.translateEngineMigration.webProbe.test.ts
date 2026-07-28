// Translation-rework wave 1 — the REAL (unmocked) lib/translate/
// providers.ts probe, exercised through runTranslateEngineMigration.
// This vitest process runs as plain web (no NEXT_PUBLIC_DESKTOP/
// NEXT_PUBLIC_IOS, no Tauri globals — see providers.test.ts's own
// "IS_TAURI is false in this process" precedent), so
// probeSystemTranslateSupport's own getInvoke() call throws
// synchronously and its try/catch resolves the fail-closed
// {osSupported:false, status:"unsupported"} shape — this pins that the
// migration takes the marker-only path end to end without ever
// erroring, i.e. genuinely never touches Tauri's invoke bridge. Kept in
// its own file (not store.translateEngineMigration.test.ts) because
// vi.mock is file-scoped — that file mocks this exact module.

import { describe, expect, it } from "vitest";
import { runTranslateEngineMigration } from "../store";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";

describe("runTranslateEngineMigration — real providers.ts, web build (no native probe)", () => {
  it('resolves the marker-only patch without throwing when translateEngine is "llm"', async () => {
    await expect(
      runTranslateEngineMigration({ ...DEFAULT_SETTINGS, translateEngine: "llm" }),
    ).resolves.toEqual({ patch: { translateEngineMigrated: true } });
  });
});
