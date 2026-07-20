// S13.1 (docs/design-explorations/s13-ios-blueprint.md) — the iOS
// simulator spike harness's JS half. `simctl` has no tap-automation
// surface, so this module drives the REAL osspeech engine the exact
// same way the UI does and tees every step to a file
// (devspike_ios.rs's spike_report) that `simctl get_app_container …
// data` can read back afterward.
//
// Dynamically imported by bootstrap.ts's `bootstrapIos()` ONLY once
// `spike_flags()` has already confirmed `--spike-osspeech` reached this
// launch — that caller owns the gate; this module assumes it's already
// armed and never re-checks. Kept as its own module (rather than inline
// in bootstrap.ts) specifically so its own `createEngine`/osSpeech
// import graph never reaches the ordinary iOS bundle — see bootstrap.ts's
// own call site for the `import()` that makes that true.
//
// Every step reports ONE NDJSON line via spike_report:
// `{step, ok, detail, tMs}`, tMs = elapsed ms since this module started.
// A step's own internal try/catch decides `ok`; `runStep` below is a
// last-resort net so a step that somehow throws PAST its own try/catch
// still gets reported instead of silently killing every step after it.

import type { STTEvents } from "@jargonslayer/core/types";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import { createEngine } from "../stt";
import { getInvoke, type InvokeFn } from "./tauriApi";
import type { OsSpeechCapabilities } from "./osspeechCaps";

// Blueprint step 3: "wait 15s" before stop() — long enough to observe
// asset-checking/capturing settle without turning the spike into a
// multi-minute run.
const SESSION_DURATION_MS = 15000;

type ReportFn = (step: string, ok: boolean, detail: unknown) => Promise<void>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extracts `name`/`message` off whatever got thrown without relying on
 *  `instanceof Error` — getUserMedia rejects with a DOMException, which
 *  isn't reliably `instanceof Error` across engines but always carries
 *  real `name`/`message` string properties; this reads those directly
 *  so the getUserMedia verdict (NotAllowedError vs NotFoundError vs a
 *  bare TypeError from a missing `navigator.mediaDevices`) survives
 *  into the report either way. */
function describeError(err: unknown): { name?: string; message: string } {
  if (typeof err === "object" && err !== null) {
    const e = err as { name?: unknown; message?: unknown };
    return {
      name: typeof e.name === "string" ? e.name : undefined,
      message: typeof e.message === "string" ? e.message : String(err),
    };
  }
  return { message: String(err) };
}

/** Runs one step, swallowing anything that escapes its OWN try/catch so
 *  a single unexpected throw can't blind every step queued after it. */
async function runStep(name: string, report: ReportFn, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    await report(name, false, { unexpected: describeError(err) });
  }
}

/** THE Soniox-on-iOS question (blueprint D7): does WKWebView's
 *  `getUserMedia` even exist/work inside a Tauri `tauri://localhost`
 *  iOS webview? Reports existence first, then the actual call outcome —
 *  a successful stream is stopped immediately (this probe has no use
 *  for the audio itself). */
async function stepGetUserMediaProbe(report: ReportFn): Promise<void> {
  const typeofMediaDevices = typeof navigator.mediaDevices;
  const hasGetUserMedia = typeof navigator.mediaDevices?.getUserMedia === "function";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    await report("getUserMedia-probe", true, { typeofMediaDevices, hasGetUserMedia, result: "success" });
  } catch (err) {
    await report("getUserMedia-probe", false, {
      typeofMediaDevices,
      hasGetUserMedia,
      result: describeError(err),
    });
  }
}

/** Raw `os_speech_capabilities` round trip — deliberately NOT
 *  `probeOsSpeechCaps()`'s cached wrapper, since the spike wants the
 *  actual wire payload, not that module's own fail-open/caching
 *  behavior layered on top. */
async function stepCaps(report: ReportFn, invoke: InvokeFn): Promise<OsSpeechCapabilities | null> {
  try {
    const caps = await invoke<OsSpeechCapabilities>("os_speech_capabilities");
    await report("caps", true, caps);
    return caps;
  } catch (err) {
    await report("caps", false, describeError(err));
    return null;
  }
}

/** Drives the real `OsSpeechEngine` exactly as the UI does
 *  (`createEngine("osspeech")` — see stt/index.ts): start(locale
 *  "en-US") -> wait `SESSION_DURATION_MS` -> stop(), capturing every
 *  status event (full payload) + a count of transcript events (interim
 *  + final both ride the SAME wire "transcript" event, blueprint §2) +
 *  the stop() call-to-resolved latency. Transcript TEXT is never
 *  captured (this codebase's own diagLog privacy rule: labels/counts,
 *  never transcript content). */
async function stepSession(report: ReportFn): Promise<void> {
  const engine = createEngine("osspeech");
  const sessionT0 = performance.now();
  const statusEvents: { tMs: number; status: string; detail?: string }[] = [];
  let transcriptEventCount = 0;

  const events: STTEvents = {
    onInterim: () => {
      transcriptEventCount++;
    },
    onFinal: () => {
      transcriptEventCount++;
    },
    onStatus: (status, detail) => {
      statusEvents.push({ tMs: Math.round(performance.now() - sessionT0), status, detail });
    },
  };

  await engine.start(events, { ...DEFAULT_SETTINGS, language: "en-US" });
  await sleep(SESSION_DURATION_MS);

  const stopT0 = performance.now();
  await engine.stop();
  const stopLatencyMs = Math.round(performance.now() - stopT0);

  await report("session", true, { statusEvents, transcriptEventCount, stopLatencyMs });
}

/** !caps.supported path: proves the floor/unsupported rejection reaches
 *  end-to-end through the real `start_os_speech` command (not just the
 *  caps probe). */
async function stepStartRejection(report: ReportFn, invoke: InvokeFn): Promise<void> {
  try {
    await invoke("start_os_speech", { locale: "en-US", contextualJson: null });
    await report("start-rejection", false, { note: "start_os_speech resolved instead of rejecting" });
  } catch (err) {
    await report("start-rejection", true, describeError(err));
  }
}

export async function runIosSpike(): Promise<void> {
  const t0 = performance.now();
  const invoke = await getInvoke();

  const report: ReportFn = async (step, ok, detail) => {
    const line = JSON.stringify({ step, ok, detail, tMs: Math.round(performance.now() - t0) });
    try {
      await invoke("spike_report", { line });
    } catch {
      // best-effort — a report call failing must not abort the run.
    }
  };

  await runStep("getUserMedia-probe", report, () => stepGetUserMediaProbe(report));
  const caps = await stepCaps(report, invoke);

  if (caps?.supported) {
    await runStep("session", report, () => stepSession(report));
  } else {
    await runStep("start-rejection", report, () => stepStartRejection(report, invoke));
  }

  await report("done", true, { totalMs: Math.round(performance.now() - t0) });
}
