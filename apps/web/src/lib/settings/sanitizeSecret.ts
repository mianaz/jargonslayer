// Field bug fix (iOS TestFlight: a user's valid OpenRouter key still
// "401'd") — iOS paste (share-sheet/clipboard round-trips through
// other apps) routinely carries leading/trailing whitespace and
// invisible zero-width characters a user has no way to see or edit
// out. normalizeBaseUrl (SettingsDialog.tsx) already does the
// equivalent cleanup for baseUrl; this is the same idea for the
// secret-shaped fields (secret.ts's SECRET_NAMES), applied at both the
// SAVE boundary (SettingsDialog's toSave) and the LOAD boundary
// (store.ts's migrateSettings + hydrateSecrets merge) so previously-
// persisted dirty values self-heal too.
//
// Deliberately narrow: only zero-width characters (invisible, never
// legitimately part of a real key) + leading/trailing whitespace are
// touched. No case folding, no full-width-punctuation mapping — a real
// API key is plain ASCII, and over-normalizing risks corrupting an
// exotic-but-valid token.

// Zero-width space, non-joiner, joiner (0x200B-0x200D) + zero-width
// no-break space / BOM (0xFEFF). Built from char codes rather than
// embedding the literal invisible characters (or a \u escape a source
// file can silently mangle) in the regex itself, so this stays
// reviewable as plain code.
const ZERO_WIDTH_CODE_POINTS = [0x200b, 0x200c, 0x200d, 0xfeff];
const ZERO_WIDTH_RE = new RegExp(
  `[${ZERO_WIDTH_CODE_POINTS.map((c) => String.fromCharCode(c)).join("")}]`,
  "g",
);

export function sanitizeSecretValue(value: string): string {
  return value.replace(ZERO_WIDTH_RE, "").trim();
}
