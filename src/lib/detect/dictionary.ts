// Built-in offline dictionary of business idioms + terms.
// OWNER: worker B (fills DICTIONARY/TERM_DICTIONARY + scan logic).
// Used when: no API key (server returns code "no_key"), the user
// forces dictionaryOnly, or /api/detect fails.

import type { DetectResponse } from "../types";

/** Scan text against the built-in dictionaries. Word-boundary,
 *  case-insensitive, light inflection tolerance (e.g. "circling back"). */
export function scanDictionary(text: string): DetectResponse {
  // STUB — worker B implements.
  void text;
  return { expressions: [], terms: [] };
}
