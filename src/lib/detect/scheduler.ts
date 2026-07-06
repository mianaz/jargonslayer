// Real-time detection scheduler: batches finalized transcript
// segments and drives /api/detect (LLM) with dictionary fallback.
// OWNER: worker B. Public signature is contract — do not change it.

import type {
  DetectResponse,
  DetectionSource,
  Settings,
  TranscriptSegment,
} from "../types";

export type DetectMode = "llm" | "dictionary" | "off";

export interface SchedulerOptions {
  getSettings: () => Settings;
  onDetection: (res: DetectResponse, source: DetectionSource) => void;
  onBusyChange: (busy: boolean) => void;
  onModeChange: (mode: DetectMode) => void;
  onError: (msg: string) => void;
}

export class DetectionScheduler {
  constructor(private opts: SchedulerOptions) {}

  /** Feed every finalized segment here, in order. */
  pushSegment(seg: TranscriptSegment): void {
    // STUB — worker B implements batching/flush/fallback here.
    void seg;
    void this.opts;
  }

  /** Force-flush pending text (called on meeting stop). */
  flushNow(): void {}

  /** Cancel timers and in-flight requests. */
  stop(): void {}
}
