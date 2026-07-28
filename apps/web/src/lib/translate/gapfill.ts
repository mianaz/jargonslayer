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
  SystemTranslatorUnavailableError,
} from "./providers";
import { untranslatedSegments } from "./gaps";

const BATCH_SIZE = 6;
const RATE_LIMIT_WAIT_MS = 30_000;
// "third rate-limit failure aborts" — i.e. at most 2 waits are spent
// retrying before giving up.
const MAX_RATE_LIMIT_WAITS = 2;

// Module-level re-entry guard — one run at a time; a second call while
// one is in flight is a no-op, not a queued-up second pass.
let running = false;

export function isGapFillRunning(): boolean {
  return running;
}

type Result = { filled: number; failed: number; aborted: boolean };

function terminalStatus(filled: number): { state: "done" | "off"; pending: 0 } {
  return filled > 0 ? { state: "done", pending: 0 } : { state: "off", pending: 0 };
}

export async function runGapFill(): Promise<Result> {
  if (running) return { filled: 0, failed: 0, aborted: false };
  running = true;

  try {
    const { settings, meetingGen: gen } = useApp.getState();
    const pair = langPairFromSettings(settings);
    if (pair.source === pair.target) return { filled: 0, failed: 0, aborted: false };

    // MUST be synchronous, before any await in this function: Chrome's
    // on-device Translator API needs a live user-gesture call stack the
    // first time a language pair's model downloads (see providers.ts's
    // own header comment) — the toolbar button calls `void runGapFill()`
    // directly from its onClick, so everything up to here runs on that
    // same gesture's synchronous stack.
    const provider = resolveTranslationProvider(() => useApp.getState().settings);
    provider.prepare(pair);

    // Gen check helper: loadSession/newMeeting bump meetingGen, which
    // must auto-cancel this run — checked before every batch and before
    // every store write.
    const genCurrent = () => useApp.getState().meetingGen === gen;

    let filled = 0;
    let failed = 0;
    let rateLimitWaits = 0;
    // A batch that exhausts its one generic-error retry is given up on
    // (counted failed) and never revisited — untranslatedSegments()
    // alone can't tell "gave up on this one" from "haven't reached it
    // yet" (a failed segment has no translations[] entry either way),
    // so without this set the very next loop iteration would re-read
    // the SAME gaps and pick the SAME dead batch forever.
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
      let retriedGeneric = false;

      for (;;) {
        try {
          const items = batch.map((s) => ({ id: s.id, text: s.text }));
          const translations = await provider.translate(items, pair.target);
          if (!genCurrent()) return { filled, failed, aborted: true };

          const map: Record<string, string> = {};
          for (const t of translations) map[t.id] = t.text;
          useApp.getState().applyTranslations(map, gen);
          filled += Object.keys(map).length;
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
    running = false;
  }
}
