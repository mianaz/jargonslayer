// Background-profile hint rendering (#48 step 3, design Q5). Turns
// Settings.profile into ONE short string, spliced into the USER
// message only (see prompts.ts's AUDIENCE splice) — never the
// server-built, prompt-cached SYSTEM prompt. Threaded through
// client.ts exactly like `settings.explainLanguage` is today.

import type { Settings } from "../types";

/** Free-text profile fields are truncated to this many characters
 *  client-side BEFORE composing the hint (design Q5: "free-text
 *  fields truncated ~40 chars"). */
export const PROFILE_FIELD_MAX_CHARS = 40;

/** Overall hint budget (design Q5: "hard-capped ~60 tokens"). No real
 *  tokenizer runs client-side, so this is a deliberately conservative
 *  chars-per-token estimate (undercounts tokens, i.e. truncates
 *  earlier rather than later) covering a hint that may mix Chinese
 *  and English text.
 *
 *  #48 s1 review item 9: also imported by the detect/define/summarize
 *  route zod schemas as the `profile` field's `.max()` bound, so the
 *  server-side contract can never silently drift wider than what a
 *  well-behaved client actually sends (previously each route
 *  hardcoded its own `.max(500)`, a generous defense-in-depth bound
 *  disconnected from this actual client-side cap). */
export const PROFILE_HINT_MAX_TOKENS = 60;
const CHARS_PER_TOKEN_ESTIMATE = 3;
export const PROFILE_HINT_MAX_CHARS = PROFILE_HINT_MAX_TOKENS * CHARS_PER_TOKEN_ESTIMATE;

const ENGLISH_LEVEL_LABEL: Record<NonNullable<Settings["profile"]>["englishLevel"] & string, string> = {
  basic: "初级",
  intermediate: "中级",
  advanced: "高级",
};

function truncateField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > PROFILE_FIELD_MAX_CHARS
    ? trimmed.slice(0, PROFILE_FIELD_MAX_CHARS)
    : trimmed;
}

/** Render Settings.profile into a short hint string, or `undefined`
 *  when disabled or every field is empty (nothing worth sending —
 *  callers must not send an empty AUDIENCE line). Pure — no I/O. */
export function renderProfileHint(profile: Settings["profile"]): string | undefined {
  if (!profile?.enabled) return undefined;

  const parts: string[] = [];
  const industry = truncateField(profile.industry);
  if (industry) parts.push(`行业：${industry}`);
  const role = truncateField(profile.role);
  if (role) parts.push(`角色：${role}`);
  if (profile.englishLevel) parts.push(`英语水平：${ENGLISH_LEVEL_LABEL[profile.englishLevel]}`);
  const familiarDomains = truncateField(profile.familiarDomains);
  if (familiarDomains) parts.push(`熟悉领域：${familiarDomains}`);
  const weakDomains = truncateField(profile.weakDomains);
  if (weakDomains) parts.push(`薄弱领域：${weakDomains}`);

  if (parts.length === 0) return undefined;

  const hint = parts.join("；");
  return hint.length > PROFILE_HINT_MAX_CHARS ? hint.slice(0, PROFILE_HINT_MAX_CHARS) : hint;
}
