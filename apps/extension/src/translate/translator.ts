// Thin, impure adapter around Chrome's built-in Translator API
// (self.Translator, Chrome 138+ — types from @types/dom-chromium-ai).
// Deliberately thin and NOT unit tested directly (no real Translator
// global exists under vitest/node, and this repo has no way to drive
// an actual Chrome 138+ instance) — the real logic lives in
// availability.ts's pure reducer, which IS unit tested. Best-effort
// against Chrome's currently-documented API shape (verified against
// developer.chrome.com/docs/ai/translator-api + the DefinitelyTyped
// `dom-chromium-ai` package while writing this); re-verify against a
// real Chrome 138+ instance during load-unpacked testing — see the
// PLAN-v0.4 S6 report's "Translator availability handling" section.

import {
  canUseCapabilityNow,
  type CapabilityState,
  INITIAL_CAPABILITY_STATE,
  normalizeDownloadProgress,
  reduceCapabilityState,
} from "./availability";

// Source is always English (the panel's whole premise — paste English
// text); target is Simplified Chinese, matching every zh string in
// core's dictionary (packages/core/src/detect/dictionary-data.ts).
const SOURCE_LANGUAGE = "en";
const TARGET_LANGUAGE = "zh";

let cachedTranslator: Translator | null = null;
let cachedState: CapabilityState = INITIAL_CAPABILITY_STATE;

function isSupported(): boolean {
  return typeof Translator !== "undefined";
}

/** Checks (without downloading anything) whether on-device en->zh
 *  translation is available in this browser right now. Cheap, safe to
 *  call repeatedly (e.g. every time the panel wants to decide whether
 *  to show the translate affordance at all). */
export async function checkTranslatorAvailability(): Promise<CapabilityState> {
  if (!isSupported()) {
    cachedState = reduceCapabilityState(cachedState, { type: "unsupported" });
    return cachedState;
  }
  try {
    const availability = await Translator.availability({
      sourceLanguage: SOURCE_LANGUAGE,
      targetLanguage: TARGET_LANGUAGE,
    });
    cachedState = reduceCapabilityState(cachedState, { type: "checked", status: availability });
    return cachedState;
  } catch (err) {
    cachedState = reduceCapabilityState(cachedState, {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    return cachedState;
  }
}

export function getTranslatorState(): CapabilityState {
  return cachedState;
}

/** Ensures a Translator instance exists, triggering the first-use
 *  model download (with progress reported via onProgress) if needed.
 *  Instance is cached module-wide — translate() calls should reuse it
 *  rather than re-download/re-create per call. */
async function ensureTranslatorReady(
  onProgress?: (state: CapabilityState) => void,
): Promise<Translator> {
  if (cachedTranslator && canUseCapabilityNow(cachedState)) return cachedTranslator;
  if (!isSupported()) throw new Error("Translator API not supported in this browser");

  cachedTranslator = await Translator.create({
    sourceLanguage: SOURCE_LANGUAGE,
    targetLanguage: TARGET_LANGUAGE,
    monitor(m) {
      m.addEventListener("downloadprogress", (e) => {
        cachedState = reduceCapabilityState(cachedState, {
          type: "download-progress",
          progress: normalizeDownloadProgress(e.loaded, e.total),
        });
        onProgress?.(cachedState);
      });
    },
  });
  cachedState = reduceCapabilityState(cachedState, { type: "ready" });
  onProgress?.(cachedState);
  return cachedTranslator;
}

/** Translates `text` (English) into Simplified Chinese, downloading
 *  the on-device model first if this is the first use in this
 *  browser. Returns null (rather than throwing) on any failure — the
 *  caller degrades to "dictionary glosses only", per risk #5's
 *  documented mitigation; dictionary zh glosses need no translation. */
export async function translateText(
  text: string,
  onProgress?: (state: CapabilityState) => void,
): Promise<string | null> {
  try {
    const translator = await ensureTranslatorReady(onProgress);
    return await translator.translate(text);
  } catch (err) {
    cachedState = reduceCapabilityState(cachedState, {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    onProgress?.(cachedState);
    return null;
  }
}
