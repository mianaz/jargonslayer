// Theme resolution (v0.5.1 custom themes) — the ONE lookup used by
// store.ts's hydrate/updateSettings and the FOUC mirror writer (D2:
// "one resolver (builtin ?? custom)") so a theme id can never resolve
// differently depending on which call site asked. Builtins are tried
// first, deliberately: a custom theme can never be minted with a
// builtin's id (see mintCustomThemeId below), but an OLD persisted
// custom entry that predates a since-added builtin of the same name is
// not a real-world case this needs to defend against either way —
// builtin-first is just the natural "known-good wins" order.

import { getBuiltinTheme } from "./themes";
import type { ThemeDefinition } from "./schema";

/** Every custom (user-authored/imported) theme id is minted under this
 *  namespace — reserved so no imported/restored JSON can ever collide
 *  with (or be mistaken for) a builtin id: parseTheme only validates
 *  shape, not namespace, so this prefix is what actually keeps the two
 *  id spaces disjoint. Callers that need to tell "is this a custom
 *  theme" apart from "is this a builtin" (e.g. displayStorage.ts's FOUC
 *  guard) check `id.startsWith(CUSTOM_THEME_ID_PREFIX)` rather than
 *  re-deriving the split some other way. */
export const CUSTOM_THEME_ID_PREFIX = "custom-";

/** Soft cap on Settings.customThemes.length (D1's "soft cap 20"),
 *  enforced at every write site that can GROW the array (ThemeEditor's
 *  保存主题-when-creating + SettingsDialog's 导入) — same "enforced
 *  where it's written" posture as store.ts's own SPEAKER_ROSTER_CAP.
 *  A restore (autoExport.ts's sanitizeRestoredSettings) does NOT apply
 *  this cap — a backup file legitimately replaces the array wholesale,
 *  same as every other restored field, and re-enforcing a UI-level
 *  cap on that path would just make an honest old/foreign backup lose
 *  data on restore for no safety reason. */
export const CUSTOM_THEME_CAP = 20;

/** Resolve a theme id against the builtin registry first, then the
 *  caller's own custom themes (D2: one resolver for hydrate/
 *  updateSettings/the FOUC mirror writer, so they can never disagree
 *  about what an id means). `undefined` means "unknown id" — callers
 *  are expected to fall back to a terminal reset (D2) rather than
 *  silently keeping stale CSS, the bug this resolver replaces. */
export function resolveThemeById(
  id: string,
  customThemes: readonly ThemeDefinition[],
): ThemeDefinition | undefined {
  return getBuiltinTheme(id) ?? customThemes.find((t) => t.id === id);
}

// ASCII-only: a label is very often pure Chinese (this app's house
// voice), which strips to nothing here — that is fine, it's exactly
// the signal mintCustomThemeId below uses to fall back to a random
// suffix instead of an empty slug. Kept deliberately dumb (no pinyin
// transliteration, no dependency) — a random-suffixed id is just as
// collision-safe and this is an internal id, never shown to the user
// (the theme's `label` field is what she actually reads).
function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Mint a fresh `custom-`-prefixed id for a new/imported/re-saved
 *  custom theme: slugify the label when it yields anything usable
 *  (any latin/digit content survives; a pure-CJK label — the common
 *  case here — does not), otherwise a random suffix. Either way, retry
 *  with an additional random suffix until the result collides with
 *  neither a builtin id NOR anything in `existingIds` — the caller only
 *  ever needs to pass its OWN existing custom-theme ids; builtins are
 *  checked here unconditionally so no call site can forget the "never
 *  shadow a builtin" half of that guarantee (D1: "import/save re-mints
 *  id on collision or non-`custom-` prefix so no JSON can shadow a
 *  builtin id"). */
export function mintCustomThemeId(label: string, existingIds: readonly string[]): string {
  const taken = new Set<string>(existingIds);
  const slug = slugify(label);
  const base = `${CUSTOM_THEME_ID_PREFIX}${slug || randomSuffix()}`;
  let candidate = base;
  while (getBuiltinTheme(candidate) || taken.has(candidate)) {
    candidate = `${base}-${randomSuffix()}`;
  }
  return candidate;
}
