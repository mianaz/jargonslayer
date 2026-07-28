// v0.7.1 translation train-2, Chamber B (docs/design-explorations/
// v071-translation-train2-blueprint.md §Shared contract + §Chamber B).
// TranslateQueue (queue.ts) only exists for a LIVE meeting — a stopped
// session (including one re-opened from history via loadSession, which
// lands status:"stopped") has translation gaps with nothing left to
// fill them. This module is that standalone runner: it walks
// untranslatedSegments() in batches through the CONFIGURED provider
// (resolveTranslationProvider — same engine choice as the live queue,
// never CorrectionReview's LLM-only retranslate) and applies results
// straight into the store.
//
// Public API is PINNED (worker C's export-gate flow calls runGapFill()
// directly) — see the blueprint's "Shared contract" section.

import { useApp } from "@/lib/store";
import { NoKeyError, RateLimitApiError } from "@/lib/llm/client";
import {
  langPairFromSettings,
  resolveTranslationProvider,
  stopSystemTranslator,
  SystemTranslatorUnavailableError,
} from "./providers";
import { untranslatedSegments } from "./gaps";

const BATCH_SIZE = 6;
const RATE_LIMIT_WAIT_MS = 30_000;
// "third rate-limit failure aborts" — i.e. at most 2 waits are spent
// retrying before giving up.
const MAX_RATE_LIMIT_WAITS = 2;

type Result = { filled: number; failed: number; aborted: boolean };

// Module-level re-entry guard (F3 fix, v0.7.1 train-2 adversarial
// review): a second call while one is already in flight JOINS the same
// run — callers (SummaryPanel's 补全后导出) must genuinely wait for the
// real result instead of racing past a no-op stub while the real run is
// still filling gaps underneath them.
let currentRun: Promise<Result> | null = null;

export function isGapFillRunning(): boolean {
  return currentRun !== null;
}

function terminalStatus(filled: number): { state: "done" | "off"; pending: 0 } {
  return filled > 0 ? { state: "done", pending: 0 } : { state: "off", pending: 0 };
}

export function runGapFill(): Promise<Result> {
  if (currentRun) return currentRun;
  const run = doRunGapFill();
  currentRun = run;
  void run.finally(() => {
    currentRun = null;
  });
  return run;
}

async function doRunGapFill(): Promise<Result> {
  // F4 fix (adversarial review): a live meeting (connecting/listening/
  // paused) already has its OWN TranslateQueue filling gaps as segments
  // finalize — running this standalone batch runner concurrently would
  // double-translate (and double-bill) the exact same segments. Only a
  // stopped session (including one reloaded from history) is fair game.
  // Checked before prepare(), before anything else.
  if (useApp.getState().status !== "stopped") {
    return { filled: 0, failed: 0, aborted: true };
  }

  const { settings, meetingGen: gen } = useApp.getState();
  const pair = langPairFromSettings(settings);
  if (pair.source === pair.target) return { filled: 0, failed: 0, aborted: false };

  // Gen check helper: loadSession/newMeeting bump meetingGen, which
  // must auto-cancel this run — checked before every batch and before
  // every store write.
  const genCurrent = () => useApp.getState().meetingGen === gen;

  // F8 fix: the gap query is sync, so checking it BEFORE creating/
  // priming a provider costs nothing against the user-gesture
  // requirement below — and a no-gap call never spins up (and so never
  // needs to tear down) a provider at all.
  const initialGaps = untranslatedSegments(useApp.getState().segments, useApp.getState().translations);
  if (initialGaps.length === 0) return { filled: 0, failed: 0, aborted: false };

  // MUST be synchronous, before any await in this function: Chrome's
  // on-device Translator API needs a live user-gesture call stack the
  // first time a language pair's model downloads (see providers.ts's
  // own header comment) — the toolbar button calls `void runGapFill()`
  // directly from its onClick, so everything up to here runs on that
  // same gesture's synchronous stack.
  const provider = resolveTranslationProvider(() => useApp.getState().settings);
  provider.prepare(pair);

  try {
    let filled = 0;
    let failed = 0;
    let rateLimitWaits = 0;
    // A batch that exhausts its one generic-error retry, or an id whose
    // translation never lands as a non-empty string (F1 fix — see
    // below), is given up on (counted failed) and never revisited —
    // untranslatedSegments() alone can't tell "gave up on this one" from
    // "haven't reached it yet" (a failed segment has no translations[]
    // entry either way), so without this set the very next loop
    // iteration would re-read the SAME gaps and pick the SAME dead
    // batch/id forever.
    const giveUpIds = new Set<string>();

    for (;;) {
      if (!genCurrent()) return { filled, failed, aborted: true };

      // Re-read fresh every batch — segments can be edited mid-run.
      const gaps = untranslatedSegments(useApp.getState().segments, useApp.getState().translations).filter(
        (s) => !giveUpIds.has(s.id),
      );
      if (gaps.length === 0) break;

      if (!genCurrent()) return { filled, failed, aborted: true };
      useApp.getState().setTranslateStatus({ state: "busy", pending: gaps.length });

      const batch = gaps.slice(0, BATCH_SIZE);
      // F5 fix: the exact text sent per id, re-checked against the
      // store's CURRENT text before applying below — a segment edited
      // mid-flight (between dispatch and this batch's response landing)
      // must never get a translation of its now-stale wording silently
      // written back.
      const sentText = new Map(batch.map((s) => [s.id, s.text]));
      let retriedGeneric = false;

      for (;;) {
        try {
          const items = batch.map((s) => ({ id: s.id, text: s.text }));
          const translations = await provider.translate(items, pair.target);
          if (!genCurrent()) return { filled, failed, aborted: true };

          const currentTextById = new Map(useApp.getState().segments.map((s) => [s.id, s.text]));
          const translatedById = new Map(translations.map((t) => [t.id, t.text]));
          const map: Record<string, string> = {};
          for (const s of batch) {
            if (currentTextById.get(s.id) !== sentText.get(s.id)) continue; // F5: stale edit — skip, leave as a gap
            const text = translatedById.get(s.id);
            if (text && text.trim().length > 0) map[s.id] = text;
          }
          useApp.getState().applyTranslations(map, gen);
          filled += Object.keys(map).length;

          // F1 fix: any id that did NOT land a non-empty translation —
          // missing from the response entirely, or resolved to an empty/
          // whitespace string — is given up on right here, not left for
          // the next loop iteration to re-select (which would just pick
          // the SAME dead id forever, since a failed id has no
          // translations[] entry to distinguish it from "not reached
          // yet"). A stale-edited id (skipped above) is the one
          // exception: left as an ordinary gap for a future pass instead
          // of given up on, since the edit — not the provider — is why
          // it didn't land.
          for (const s of batch) {
            if (map[s.id] !== undefined) continue;
            if (currentTextById.get(s.id) !== sentText.get(s.id)) continue;
            giveUpIds.add(s.id);
            failed += 1;
          }
          break;
        } catch (err) {
          if (!genCurrent()) return { filled, failed, aborted: true };

          if (err instanceof NoKeyError) {
            useApp.getState().showToast("翻译引擎未配置 Key，请在设置中填写");
            useApp.getState().setTranslateStatus(terminalStatus(filled));
            return { filled, failed, aborted: true };
          }

          if (err instanceof SystemTranslatorUnavailableError) {
            useApp.getState().showToast(
              err.reason === "downloading"
                ? "系统翻译语言包下载中，请稍后再试"
                : "系统翻译在此设备不可用，请在设置中更换翻译引擎",
            );
            useApp.getState().setTranslateStatus(terminalStatus(filled));
            return { filled, failed, aborted: true };
          }

          if (err instanceof RateLimitApiError) {
            if (rateLimitWaits >= MAX_RATE_LIMIT_WAITS) {
              useApp.getState().setTranslateStatus(terminalStatus(filled));
              return { filled, failed, aborted: true };
            }
            rateLimitWaits++;
            await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
            if (!genCurrent()) return { filled, failed, aborted: true };
            continue; // retry the same batch, independent of the generic-error retry below
          }

          // Generic error: retry this exact batch once; a second failure
          // gives up on it (counts failed) and moves on to the next one.
          if (!retriedGeneric) {
            retriedGeneric = true;
            continue;
          }
          for (const s of batch) giveUpIds.add(s.id);
          failed += batch.length;
          break;
        }
      }
    }

    if (genCurrent()) useApp.getState().setTranslateStatus(terminalStatus(filled));
    return { filled, failed, aborted: false };
  } finally {
    // F8 fix: a native system-translation child spawned by prepare()
    // above for this standalone gap-fill run must not outlive it — see
    // stopSystemTranslator's own doc comment (providers.ts) for why a
    // stop is scoped to the exact generation prepare() warmed. Only
    // reached when a provider was actually created (the no-gap early
    // return above skips this whole try block entirely).
    if (provider.kind === "system") void stopSystemTranslator();
  }
}
