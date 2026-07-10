// Video-import routing decision (#58 design decision 6): when the
// local Whisper sidecar is healthy, a picked video file can go through
// EITHER the sidecar (faster-whisper quality + diarization) or the
// existing browser path (ffmpeg.wasm extract -> in-browser Whisper) —
// sidecar is offered as the default when reachable, browser stays the
// fallback choice. Local tier only: preview tier never offers the
// sidecar option at all (rendered greyed with the 「本地版功能」 badge,
// same showroom posture as every other sidecar-only affordance).
//
// `sidecarHealth` takes the EXACT shape HistoryDrawer/ImportHub's own
// fetchSidecarHealth probe already produces (undefined = not yet
// checked this popover-open, null = sidecar unreachable, object =
// reachable) so this reuses the existing gate rather than inventing a
// second "is the sidecar up" signal that could drift from it —
// `undefined` reads as optimistically available (matches the
// pre-existing sidecarReachable logic: don't flash the option disabled
// before the health probe resolves).
//
// Pure — no network, no store — so ImportHub and this module's own
// decision-table test can both exercise every (health × tier) cell
// without mounting anything.

export type ImportPath = "sidecar" | "browser";

export interface VideoRoutingDecision {
  /** The path a freshly-picked video file should default to. */
  defaultPath: ImportPath;
  /** Whether the sidecar option is selectable at all (false for
   *  preview tier or a confirmed-unreachable sidecar). */
  sidecarAvailable: boolean;
  /** Preview tier specifically — sidecar renders greyed with the
   *  「本地版功能」 badge rather than being hidden (showroom rule),
   *  distinct from "just currently unreachable". */
  sidecarLocked: boolean;
}

export function decideVideoRouting(opts: {
  sidecarHealth: { diarization_ready: boolean } | null | undefined;
  isPreviewTier: boolean;
}): VideoRoutingDecision {
  if (opts.isPreviewTier) {
    return { defaultPath: "browser", sidecarAvailable: false, sidecarLocked: true };
  }
  const sidecarAvailable = opts.sidecarHealth !== null;
  return {
    defaultPath: sidecarAvailable ? "sidecar" : "browser",
    sidecarAvailable,
    sidecarLocked: false,
  };
}
