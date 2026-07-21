// Font presets (v0.5.1 appearance sprint, D5). Deliberately a SEPARATE
// setting from the theme engine (schema.ts's own module comment: "fonts
// are a SEPARATE setting, never part of importable theme files" — a
// theme JSON stays a pure color contract, so no external theme source
// can ever smuggle a font-family value in). Presets here are all
// zero-download system stacks (macOS-first, with Windows/Linux
// fallbacks) — no webfont loading, no new next/font entry, so picking
// one never costs a network request. A user's own free-text choice is
// stored as `custom:<family>` and run through sanitizeFontFamily below
// before it ever reaches a CSS custom property.

/** Prefix marking a free-text (non-preset) font choice, e.g.
 *  `"custom:Fira Code"`. Mirrors resolve.ts's CUSTOM_THEME_ID_PREFIX
 *  naming — both exist so a stored string's "is this a preset id or a
 *  user value" question is answered the same way everywhere. */
export const CUSTOM_FONT_PREFIX = "custom:";

export interface FontPreset {
  id: string;
  label: string; // zh display name for the settings picker
  /** CSS `font-family` value, already comma/quote-formatted — used
   *  verbatim as the resolved stack (see resolveFontStack). */
  stack: string;
}

// "default" is both a real preset (id "default", picked from the UI
// like any other) AND the sentinel resolveFontStack treats as "no
// override" — the two meanings coincide on purpose: this preset's own
// stack IS the CSS-authored fallback already active with no inline
// override at all, so removing the override (rather than setting it to
// an identical value) is a pure optimization, never a behavior change.
export const UI_FONT_PRESETS: readonly FontPreset[] = [
  {
    id: "default",
    label: "默认",
    // Verbatim copy of tailwind.config.ts's `sans` stack (pre-v0.5.1,
    // before it became a single --font-ui var reference) — this preset
    // exists so picking it back after trying serif/rounded is a real,
    // explicit choice in the list, not just "clear the field".
    stack:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif',
  },
  {
    id: "serif",
    label: "衬线",
    stack: '"Songti SC", "STSong", "SimSun", Georgia, serif',
  },
  {
    id: "rounded",
    label: "圆体",
    stack: '"Yuanti SC", "YouYuan", -apple-system, BlinkMacSystemFont, sans-serif',
  },
];

export const MONO_FONT_PRESETS: readonly FontPreset[] = [
  {
    id: "default",
    label: "默认（JetBrains Mono）",
    // Verbatim copy of tailwind.config.ts's pre-v0.5.1 `mono` stack —
    // same "default preset == no override" coincidence as above.
    stack: 'var(--font-mono-brand), "SF Mono", Menlo, monospace',
  },
  {
    id: "system",
    label: "系统等宽",
    stack: '"SF Mono", Menlo, Monaco, Consolas, "Cascadia Mono", monospace',
  },
];

// Every character a CSS font-family value has no legitimate use for,
// but that a naive `font-family: ${value}` interpolation would let
// escape into a new declaration/selector: quotes (so a wrapped
// `"${value}"` can never close early), semicolons/braces (declaration/
// rule boundaries), parens/angle-brackets (url()/HTML-ish payloads),
// and backslashes (CSS escape sequences). Stripped rather than
// rejected outright — a stray character in an otherwise-fine family
// name (copy-pasted with smart quotes, say) shouldn't nuke the whole
// value when simply dropping it is harmless.
const UNSAFE_FONT_CHARS_RE = /["'\\;{}()<>]/g;
const MAX_FONT_FAMILY_LEN = 60;

/** Sanitize a free-text font-family name before it's ever stored in
 *  Settings.uiFont/monoFont or interpolated into a CSS value: trim,
 *  strip every character in UNSAFE_FONT_CHARS_RE, cap length, then
 *  reject (return null) if nothing usable survives. Idempotent —
 *  re-sanitizing an already-clean value is a no-op — so callers that
 *  aren't sure whether a string has been through this yet (e.g.
 *  resolveFontStack below, reading a value that MIGHT be a raw restore)
 *  can always call it again for free. */
export function sanitizeFontFamily(input: string): string | null {
  const cleaned = input
    .trim()
    .replace(UNSAFE_FONT_CHARS_RE, "")
    .slice(0, MAX_FONT_FAMILY_LEN)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Resolve a stored uiFont/monoFont value into the CSS `font-family`
 *  list to apply, or `null` meaning "remove any override, fall back to
 *  the CSS-authored default" (the "default" sentinel, and also the
 *  catch-all for anything this function doesn't recognize — an
 *  unresolvable value, e.g. a preset removed in a later release or a
 *  corrupt restore, must never crash or leave a half-applied var; it
 *  just silently behaves like "default"). `slotDefaultStack` is the
 *  fallback chain appended after a CUSTOM family (so an uninstalled
 *  custom font degrades to the slot's normal stack instead of the
 *  browser's own generic default) — callers pass the matching preset's
 *  own `stack` (UI_FONT_PRESETS[0] / MONO_FONT_PRESETS[0]) for their
 *  slot. Re-sanitizes a custom value on every call (see
 *  sanitizeFontFamily's own doc on why that's safe/cheap) rather than
 *  trusting the caller already did — defense in depth, since this is
 *  the function that actually feeds a CSSOM setProperty call. */
export function resolveFontStack(slotDefaultStack: string, value: string): string | null {
  if (value === "default") return null;
  if (value.startsWith(CUSTOM_FONT_PREFIX)) {
    const family = sanitizeFontFamily(value.slice(CUSTOM_FONT_PREFIX.length));
    return family ? `"${family}", ${slotDefaultStack}` : null;
  }
  const preset = [...UI_FONT_PRESETS, ...MONO_FONT_PRESETS].find((p) => p.id === value);
  return preset ? preset.stack : null;
}
