// Extension capture duplication parity test (tech-debt ledger #3,
// docs/TECH-DEBT-LEDGER-2026-07.md item 3): apps/extension/src/capture/
// vendors these 6 files verbatim from apps/web/src/lib/stt/ — 4
// byte-identical, 2 (webSpeech.ts/webSpeechSession.ts) differing ONLY in
// their own diagLog import path (extension's lib/diag.ts vs web's
// diag/log.ts — the two apps' diag modules live in different places).
// Nothing previously caught drift between the two copies — this reads
// both files straight off disk and diffs them (modulo that one known
// import-header difference), so ANY other divergence (a bug fixed on
// one side and not the other, a stray edit, a rename, ...) fails loudly
// here instead of silently forking behavior between web and extension.
// Package hoist (dedupe for real) is tracked as a later paydown, not
// this ride-along.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const IDENTICAL_PAIRS = ["onDeviceSpeech.ts", "sttSupervisor.ts", "vad.ts", "vadCore.ts"] as const;

// The one accepted difference for each of these two — normalized to the
// SAME literal before comparing everything else byte-for-byte.
const IMPORT_HEADER_DIFF_PAIRS = ["webSpeech.ts", "webSpeechSession.ts"] as const;
const WEB_DIAG_IMPORT = 'import { diagLog } from "../diag/log";';
const EXT_DIAG_IMPORT = 'import { diagLog } from "../lib/diag";';

function readExtCapture(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
}

function readWebStt(name: string): string {
  return readFileSync(new URL(`../../../../web/src/lib/stt/${name}`, import.meta.url), "utf8");
}

describe("apps/extension/src/capture files stay in sync with their apps/web/src/lib/stt vendored source", () => {
  it.each(IDENTICAL_PAIRS)("%s is byte-identical to the web copy", (name) => {
    expect(readExtCapture(name)).toBe(readWebStt(name));
  });

  it.each(IMPORT_HEADER_DIFF_PAIRS)(
    "%s is identical to the web copy modulo its own diagLog import path",
    (name) => {
      const ext = readExtCapture(name);
      const web = readWebStt(name);
      // Fails loudly (rather than silently no-op-ing the .replace below)
      // if either side ever stops carrying the known import line at all.
      expect(ext).toContain(EXT_DIAG_IMPORT);
      expect(web).toContain(WEB_DIAG_IMPORT);
      expect(ext.replace(EXT_DIAG_IMPORT, WEB_DIAG_IMPORT)).toBe(web);
    },
  );
});
