// Local Whisper sidecar status probe for the GUI (owner ask 2026-07-11:
// "I cannot see in the GUI if the local side got set up at all"). GET
// /health runs on the sidecar's job-API HTTP server (sidecar/
// whisper_server.py's do_GET "health" branch — the same :8766 server
// uploadRecording/ingestUrl/fetchSidecarHealth below already talk to),
// with CORS "*", and always replies:
//   { ok: true, model: <loaded faster-whisper model name>,
//     diarization_installed: bool, diarization_ready: bool,
//     diarization_error: string | null }
// — a lightweight readiness check (pyannote import + token presence),
// never loads the diarization model itself. `diarization_installed`
// (S5 chunk 1, decision C) is the token-INDEPENDENT "is pyannote even
// importable" fact; a legacy/external sidecar that predates it simply
// omits the key, so this file's own SidecarProbeResult.installed below
// is `boolean | undefined` — undefined must always render as 未知,
// never coerced to 未安装 (risk 5).
//
// Reuses upload.ts's httpBaseFromWs for the ws://…:8765 ->
// http://…:8766 derivation (already public/exported there — no
// extraction needed) rather than re-deriving it, so this can never
// drift from videoRouting/ImportHub's own sidecar-reachability
// posture. Deliberately a NEW probe (not a wrapper around upload.ts's
// existing fetchSidecarHealth) because it wants the `model` field
// fetchSidecarHealth's return type omits — fetchSidecarHealth stays
// exactly as-is for its own callers (说话人分离's "检测状态" button,
// ImportHub's routing probe).

import type { Settings } from "@jargonslayer/core/types";
import { httpBaseFromWs } from "./upload";

// Matches fetchSidecarHealth/agentHealth's existing 3s probe budget —
// this is a "is anything even listening on localhost" check, not a
// request that should ever legitimately take longer.
const PROBE_TIMEOUT_MS = 3000;

export interface SidecarProbeResult {
  up: boolean;
  /** Loaded faster-whisper model name (health's `model` field) — only
   *  present when reachable. */
  model?: string;
  /** Speaker diarization readiness (health's `diarization_ready`) —
   *  only present when reachable. */
  diarize?: boolean;
  /** Speaker diarization INSTALL state (health's new
   *  `diarization_installed`, S5 chunk 1/decision C) — token-
   *  independent, unlike `diarize` above. `undefined` whenever
   *  unreachable OR the sidecar simply doesn't send the field (a
   *  legacy/external sidecar predating S5) — callers must render that
   *  as "未知," never "未安装" (risk 5). Managed sidecars always send
   *  it, true or false. */
  installed?: boolean;
}

/** GET {httpBase}/health. Never throws — `{ up: false }` on ANY
 *  failure (unreachable, timeout, non-2xx, malformed JSON), mirroring
 *  fetchSidecarHealth/agentHealth's "never throws" probe contract so
 *  callers (SettingsDialog's 转录引擎 status line, StatusLine's derived
 *  tooltip) never need try/catch plumbing. */
export async function probeSidecar(settings: Settings): Promise<SidecarProbeResult> {
  const base = httpBaseFromWs(settings.whisperUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/health`, { signal: controller.signal });
    if (!res.ok) return { up: false };
    const body = (await res.json()) as {
      model?: string;
      diarization_installed?: boolean;
      diarization_ready?: boolean;
    };
    return {
      up: true,
      model: body.model,
      diarize: body.diarization_ready,
      installed: body.diarization_installed,
    };
  } catch {
    return { up: false };
  } finally {
    clearTimeout(timeout);
  }
}
