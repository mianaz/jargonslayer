// Cloud STT usage instrumentation (T2, local-only ledger — see
// lib/usage/ledger.ts's own header for why this never leaves the
// device). Shared by every CLOUD engine (soniox.ts, deepgram.ts, and
// whichever elevenlabs engine lands next — no such engine file exists
// yet as of this writing, only the STTEngineKind value and
// Settings.elevenLabsKey do; this helper is written generically off
// STTEngineKind rather than hand-listing engine names, so that future
// engine only needs to call recordSttSeconds at its own teardown,
// nothing here needs to change). Local engines (whisper/osspeech/
// appaudio) never call this at all — they run on-device or against a
// local sidecar and cost nothing, so there is nothing to record; see
// each of those engines' own files for the omission.
import type { STTEngineKind } from "@jargonslayer/core/types";
import { recordUsage } from "../usage/ledger";

/** Records streamed audio seconds for a cloud STT session, once, at
 *  teardown. Callers pass the WALL-CLOCK elapsed time between a
 *  successful stream attach and full transport teardown (see soniox.ts/
 *  deepgram.ts's own stop()) — a single measurement at session end, not
 *  a per-chunk accumulation (T2: cheaper, and just as accurate for a
 *  local approximate ledger). Fire-and-forget: recordUsage already
 *  never throws and no-ops when Settings.usageTracking is off (see
 *  ledger.ts) — the guard here only skips the call entirely for a
 *  zero/negative/non-finite duration (a session that never really
 *  streamed), so a clock-skew edge case never writes a bogus row. */
export function recordSttSeconds(kind: STTEngineKind, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  void recordUsage({ provider: kind, kind: "stt", metric: "seconds", value: seconds });
}
