// Pure, unit-testable state machine around Chrome's built-in-AI
// "Availability" states (Translator + LanguageDetector share the same
// four-state shape — see @types/dom-chromium-ai's `Availability`).
// Kept pure/DOM-free on purpose, mirroring packages/core's own
// pure/impure split (e.g. detect/remotePacksRegistry.ts's in-memory
// registry vs apps/web's impure fetch/idb-keyval loader) so this piece
// is testable under plain vitest — no real Chrome 138+ browser needed
// — while the actual `Translator`/`LanguageDetector` calls live in the
// thin adapters next to this file (translator.ts / languageDetector.ts),
// which are NOT unit tested (nothing to assert against outside a real
// browser) and stay deliberately thin so this reducer carries the
// actual logic (PLAN-v0.4 S6 requirement 4).

export type CapabilityAvailability =
  | "unsupported" // the API global doesn't exist in this browser at all (pre-Chrome 138, or non-Chrome)
  | "unavailable" // API exists, but this language pair/config isn't supported
  | "downloadable" // model exists but hasn't been downloaded yet
  | "downloading" // download in progress — see `progress`
  | "available" // ready to use immediately
  | "error"; // a create()/availability() call rejected — see `message`

export interface CapabilityState {
  status: CapabilityAvailability;
  progress: number; // 0..1, meaningful only while status === "downloading"
  message: string | null; // detail for "error", null otherwise
}

export const INITIAL_CAPABILITY_STATE: CapabilityState = {
  status: "unsupported",
  progress: 0,
  message: null,
};

export type CapabilityEvent =
  | { type: "unsupported" }
  | { type: "checked"; status: "unavailable" | "downloadable" | "downloading" | "available" }
  | { type: "download-progress"; progress: number }
  | { type: "ready" }
  | { type: "error"; message: string };

/** Pure reducer — identical shape drives both Translator and
 *  LanguageDetector's adapters. */
export function reduceCapabilityState(
  state: CapabilityState,
  event: CapabilityEvent,
): CapabilityState {
  switch (event.type) {
    case "unsupported":
      return { ...INITIAL_CAPABILITY_STATE, status: "unsupported" };
    case "checked":
      return {
        status: event.status,
        progress: event.status === "available" ? 1 : 0,
        message: null,
      };
    case "download-progress":
      return { status: "downloading", progress: clamp01(event.progress), message: null };
    case "ready":
      return { status: "available", progress: 1, message: null };
    case "error":
      return { ...state, status: "error", message: event.message };
    default:
      return state;
  }
}

export function canUseCapabilityNow(state: CapabilityState): boolean {
  return state.status === "available";
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Chrome's built-in-AI `downloadprogress` event puts a 0..1 FRACTION
 *  directly in `.loaded` in practice — Chrome's own docs compute
 *  `e.loaded * 100` for a percentage — rather than the bytes-loaded/
 *  -total pair the generic DOM ProgressEvent shape implies. Handle
 *  both defensively: treat loaded<=1 as already-a-fraction (today's
 *  real Chrome behavior), otherwise derive loaded/total (in case a
 *  future Chrome version matches the spec's generic ProgressEvent
 *  semantics instead). Takes plain numbers (not a DOM ProgressEvent)
 *  so this stays platform-agnostic and testable here. */
export function normalizeDownloadProgress(loaded: number, total: number): number {
  if (!Number.isFinite(loaded)) return 0;
  if (loaded <= 1) return clamp01(loaded);
  return total > 0 ? clamp01(loaded / total) : 0;
}
