// Field-test fix (v0.4.4, real user report) — see openrouterModelDefaults.ts's
// own header comment for the bug this closes (OpenRouter 400ing on a
// bare Anthropic model id) and why this is single-sourced for all
// three callers (openrouterDesktop.ts, app/oauth/openrouter/page.tsx,
// store.ts's migrateSettings).

import { describe, expect, it } from "vitest";
import { remapOpenRouterModelDefaults } from "../openrouterModelDefaults";
import { DEFAULT_DETECT_MODEL } from "../../llm/tasks/detect";
import { DEFAULT_SUMMARIZE_MODEL } from "../../llm/tasks/summarize";

describe("remapOpenRouterModelDefaults", () => {
  it("remaps both fields when both are the pre-fix bare Anthropic defaults", () => {
    const patch = remapOpenRouterModelDefaults({
      detectModel: "claude-haiku-4-5",
      summaryModel: "claude-sonnet-5",
    });
    expect(patch).toEqual({
      detectModel: DEFAULT_DETECT_MODEL,
      summaryModel: DEFAULT_SUMMARIZE_MODEL,
    });
    // Sanity: the product decision's ids are actually slash-shaped
    // OpenRouter slugs, not another bare id in disguise.
    expect(DEFAULT_DETECT_MODEL).toContain("/");
    expect(DEFAULT_SUMMARIZE_MODEL).toContain("/");
  });

  it("remaps any other bare (no slash) model id, not just the two known old defaults", () => {
    const patch = remapOpenRouterModelDefaults({
      detectModel: "some-other-bare-id",
      summaryModel: "another-bare-one",
    });
    expect(patch).toEqual({
      detectModel: DEFAULT_DETECT_MODEL,
      summaryModel: DEFAULT_SUMMARIZE_MODEL,
    });
  });

  it("never touches an already-slash-shaped model — a deliberate custom OpenRouter slug survives untouched", () => {
    const patch = remapOpenRouterModelDefaults({
      detectModel: "openai/gpt-5.4",
      summaryModel: "anthropic/claude-opus-4.8",
    });
    expect(patch).toEqual({});
  });

  it("never touches an already-slash-shaped model even when it happens to equal a PRIOR remap's own output (idempotent)", () => {
    const patch = remapOpenRouterModelDefaults({
      detectModel: DEFAULT_DETECT_MODEL,
      summaryModel: DEFAULT_SUMMARIZE_MODEL,
    });
    expect(patch).toEqual({});
  });

  it("remaps only the bare field when the two are mixed (one already a custom slug, one still bare)", () => {
    const patchA = remapOpenRouterModelDefaults({
      detectModel: "claude-haiku-4-5",
      summaryModel: "anthropic/claude-opus-4.8",
    });
    expect(patchA).toEqual({ detectModel: DEFAULT_DETECT_MODEL });

    const patchB = remapOpenRouterModelDefaults({
      detectModel: "openai/gpt-5.4",
      summaryModel: "claude-sonnet-5",
    });
    expect(patchB).toEqual({ summaryModel: DEFAULT_SUMMARIZE_MODEL });
  });
});
