// Field-test fix (v0.4.4, real user report): a user who connected
// OpenRouter via the OAuth button (SettingsDialog.tsx's "一键连接
// OpenRouter 账号" / the desktop loopback flow / the web /oauth/
// openrouter callback page) kept whatever bare Anthropic-flavored
// detectModel/summaryModel Settings already had (e.g. the pre-fix
// DEFAULT_SETTINGS "claude-haiku-4-5") — OpenRouter's chat-completions
// endpoint 400s on a bare model id ("claude-haiku-4-5 is not a valid
// model ID"); it needs an "vendor/model" slug
// (anthropic/claude-haiku-4.5, deepseek/deepseek-v4-flash, …). Both
// OAuth-completion sites (openrouterDesktop.ts's connectOpenRouterDesktopWith,
// app/oauth/openrouter/page.tsx's handleConnect effect) and store.ts's
// migrateSettings (an EXISTING persisted user, already on OpenRouter,
// upgrading past this fix) all need the exact same remap decision —
// single-sourced here rather than three near-copies drifting apart.
//
// Product decision (not this fix's own call): the DeepSeek OpenRouter
// slugs are the new default/cheap models, NOT Claude — deployTier.ts's
// own PREVIEW_LIVE_MODELS/PREVIEW_SUMMARY_MODELS already prove these
// exact ids live, and tasks/detect.ts + tasks/summarize.ts single-
// source them (DEFAULT_DETECT_MODEL/DEFAULT_SUMMARIZE_MODEL) so this
// module never hardcodes a second copy of either string.

import type { Settings } from "@jargonslayer/core/types";
import { DEFAULT_DETECT_MODEL } from "../llm/tasks/detect";
import { DEFAULT_SUMMARIZE_MODEL } from "../llm/tasks/summarize";

/** True for a bare model id (no "/") — every real OpenRouter slug is
 *  "vendor/model" shaped (see this module's header comment), so a
 *  model with no slash is either one of our own pre-fix Anthropic-
 *  flavored defaults (claude-haiku-4-5/claude-sonnet-5) or some other
 *  bare id that was never going to resolve against OpenRouter's own
 *  catalog either way — "equals a known old default" is already a
 *  subset of "has no slash", so this one check covers both. A
 *  deliberately-typed custom OpenRouter slug (anything with a "/")
 *  always passes through untouched — this function must never clobber
 *  a user's own choice. */
function isBareModelId(model: string): boolean {
  return !model.includes("/");
}

/** The patch to merge alongside an OpenRouter provider/baseUrl/apiKey
 *  write: only the fields whose CURRENT value is a bare id get
 *  remapped to the DeepSeek OpenRouter defaults; an already-slash-
 *  shaped value (a prior remap, or the user's own custom OpenRouter
 *  model) is left out of the returned patch entirely — callers should
 *  spread this alongside their own patch, never unconditionally
 *  overwrite with it. */
export function remapOpenRouterModelDefaults(
  current: Pick<Settings, "detectModel" | "summaryModel">,
): Partial<Pick<Settings, "detectModel" | "summaryModel">> {
  const patch: Partial<Pick<Settings, "detectModel" | "summaryModel">> = {};
  if (isBareModelId(current.detectModel)) {
    patch.detectModel = DEFAULT_DETECT_MODEL;
  }
  if (isBareModelId(current.summaryModel)) {
    patch.summaryModel = DEFAULT_SUMMARIZE_MODEL;
  }
  return patch;
}
