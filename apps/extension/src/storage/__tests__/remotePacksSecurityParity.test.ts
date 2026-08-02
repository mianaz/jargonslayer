// Remote-pack SECURITY-CONSTANT parity, web <-> extension.
//
// apps/extension/src/storage/remotePacks.ts is a partial port of
// apps/web/src/lib/detect/remotePacks.ts — the two sit on different
// storage backends (chrome.storage vs idb-keyval) and have ~1000 lines
// of legitimate divergence, so the byte-diff approach that guards the
// capture/ vendored files (see capture/__tests__/webSttParity.test.ts)
// is the wrong shape here.
//
// What must NOT diverge is the install-time security boundary. These
// constants decide which origins a pack may be fetched from, how big it
// may be, how many surfaces it may claim, which manifest ids are
// refused outright, and which git refs are accepted. They agree today;
// nothing was stopping them from drifting, and a limit that is tighter
// on one surface than the other is a hole on the looser one.
//
// Values are compared as SOURCE TEXT rather than by importing the
// modules, because most of these are module-private on both sides and
// exporting them just for a test would widen the API to satisfy the
// harness.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SECURITY_CONSTANTS = [
  "MAX_PACK_BYTES",
  "MAX_TOTAL_BYTES",
  "MAX_PACK_COUNT",
  "MAX_PACK_SURFACES",
  "MAX_NAME_LEN",
  "MAX_DESCRIPTION_LEN",
  "MAX_ZH_LEN",
  "DANGEROUS_MANIFEST_IDS",
  "OFFICIAL_RAW_ORIGIN",
  "OFFICIAL_RAW_PATH_PREFIX",
  "OFFICIAL_JSDELIVR_ORIGIN",
  "OFFICIAL_JSDELIVR_PATH_PREFIX",
  "BIDI_CONTROL_RE",
  "SEMVER_TAG_RE",
] as const;

const extSource = readFileSync(new URL("../remotePacks.ts", import.meta.url), "utf8");
const webSource = readFileSync(
  new URL("../../../../web/src/lib/detect/remotePacks.ts", import.meta.url),
  "utf8",
);

/** The declared value, with any trailing line comment and trailing
 *  semicolon stripped — the two copies annotate the same number
 *  differently and that is not divergence worth failing on. */
function declaredValue(source: string, name: string): string | null {
  const m = source.match(new RegExp(`^(?:export )?const ${name}\\s*=\\s*(.+)$`, "m"));
  if (!m) return null;
  return m[1]
    .replace(/\s*\/\/.*$/, "")
    .replace(/;\s*$/, "")
    .trim();
}

describe("remote-pack security constants stay identical across the web and extension copies", () => {
  it.each(SECURITY_CONSTANTS)("%s is declared in both copies", (name) => {
    // A rename on one side must fail here rather than silently drop the
    // constant out of the comparison below.
    expect(declaredValue(webSource, name), `${name} missing from the web copy`).not.toBeNull();
    expect(
      declaredValue(extSource, name),
      `${name} missing from the extension copy`,
    ).not.toBeNull();
  });

  it.each(SECURITY_CONSTANTS)("%s has the same value in both copies", (name) => {
    expect(declaredValue(extSource, name)).toBe(declaredValue(webSource, name));
  });
});
