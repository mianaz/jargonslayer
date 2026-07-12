// Thin, impure adapter around Chrome's built-in LanguageDetector API
// (self.LanguageDetector, Chrome 138+). Same pure/impure split as
// translator.ts — see availability.ts for the tested reducer, and
// that file's header comment for why this isn't unit tested directly.
//
// Used only as a soft, non-blocking hint: dictionary scanning itself
// doesn't care what language the pasted text is (plain regex
// matching over whatever string it's given), so a wrong or uncertain
// language guess must never block the core detect loop — see
// sidepanel/main.ts's offerLanguageHint, which only ever appends an
// advisory status-line note.

import {
  type CapabilityState,
  INITIAL_CAPABILITY_STATE,
  normalizeDownloadProgress,
  reduceCapabilityState,
} from "./availability";

let cachedDetector: LanguageDetector | null = null;
let cachedState: CapabilityState = INITIAL_CAPABILITY_STATE;

function isSupported(): boolean {
  return typeof LanguageDetector !== "undefined";
}

export async function checkLanguageDetectorAvailability(): Promise<CapabilityState> {
  if (!isSupported()) {
    cachedState = reduceCapabilityState(cachedState, { type: "unsupported" });
    return cachedState;
  }
  try {
    const availability = await LanguageDetector.availability();
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

export function getLanguageDetectorState(): CapabilityState {
  return cachedState;
}

async function ensureDetectorReady(
  onProgress?: (state: CapabilityState) => void,
): Promise<LanguageDetector> {
  if (cachedDetector) return cachedDetector;
  if (!isSupported()) throw new Error("LanguageDetector API not supported in this browser");

  cachedDetector = await LanguageDetector.create({
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
  return cachedDetector;
}

/** Best-guess top language for `text`, or null if detection is
 *  unavailable, fails, or comes back empty. Non-blocking soft signal
 *  only — see the module comment above. */
export async function detectTopLanguage(
  text: string,
): Promise<{ language: string; confidence: number } | null> {
  try {
    const detector = await ensureDetectorReady();
    const results = await detector.detect(text);
    const top = results[0];
    if (!top?.detectedLanguage) return null;
    return { language: top.detectedLanguage, confidence: top.confidence ?? 0 };
  } catch {
    return null;
  }
}
