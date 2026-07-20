"use client";

// v0.4.7 STT provider wiring — Lane A, the BLOCKING foundation lane
// (docs/design-explorations/stt-provider-wiring-2026-07.md, §2 + §9
// decision record D5/D6/D7). One descriptor per LIVE capture engine —
// the per-engine capability CONTRACT other lanes bind to: Lane B
// (glossary -> recognizer bias) reads `biasSupport`, Lane C (tri-state
// privacy label) reads `retentionClass`, Lane D (Deepgram adapter)
// adds a new row. `label` is the single source that kills the S13
// blueprint's veto-#2 drift risk (three surfaces used to hand-author
// the SAME zh engine name separately — see engineOptions.ts's own
// ALL_ENGINE_OPTIONS/IOS_ENGINE_OPTIONS, now projected off this table).
//
// D6 (placement): apps/web, NOT packages/core — core carries zero zh
// strings, and desktop/iOS both wrap the SAME apps/web bundle, so this
// placement already reaches every surface. Sibling to engineOptions.ts
// per the doc's own "(or a sibling)" latitude, rather than growing
// that already-central module further.
//
// D5 (shape): exactly 7 fields — CUT from the original §2 sketch
// (processingRegion, translationPairs, approxCostPerHour, streaming,
// partialRevisions, timestamps, languages, diarization: no lane-B/C/D
// consumer for any of them). Also REJECTED: a `requires` array
// subsuming sidecarOnly/byokOnly/floor-locks into one list — mixing a
// build-time const with a runtime probe result in one list invites
// dropping the snapshot (Opus C2/Sol F6). `osFloor` is a purely
// DECLARATIVE tag here — engineOptionGate (engineOptions.ts) keeps
// resolving the actual floor against the live audiocapCaps/
// osspeechCaps probes exactly as it did before this table existed;
// this table never drives that gate's control flow.
//
// D7 (two-layer truth): this table holds STATIC DEFAULTS, not final
// truth for a given session — three axes need a runtime overlay the
// table alone can't capture (Sol F7): webspeech's retentionClass
// (resolveWebspeechRetentionClass below — STTEvents.onEngineMode,
// types.ts:118, reports which mode a session actually ran in; doc §1
// footnote 1's "assume cloud unless enforced" is this table's static
// default), whisper's biasSupport (spans faster-whisper AND Parakeet —
// resolves per ACTIVE MODEL, i.e. Settings.whisperModel, not per kind;
// Lane B's job), and a future opt-out-gated cloud engine's
// retentionClass (Deepgram: D7 resolves this in advance — we send
// `mip_opt_out=true` unconditionally, so it is honestly
// cloud-transient in OUR integration once Lane D adds it).

import type { STTEngineKind } from "@jargonslayer/core/types";

// Live capture engines only — excludes "demo" (scripted preview, not a
// peer engine) and the two file-ingest paths "import"/"browser-whisper"
// (never selectable in a picker — see types.ts's own STTEngineKind doc
// comment). Adding a new STTEngineKind member that IS a live engine
// (e.g. Lane D's "deepgram") widens this union automatically, which
// then makes ENGINE_CAPABILITIES below a type error until that lane
// adds the matching row — the same "type-checker enumerates every
// exhaustive Record" discipline the S9 appaudio / S11 osspeech adds
// already held STTEngineKind itself to.
export type LiveEngineKind = Exclude<STTEngineKind, "demo" | "import" | "browser-whisper">;

export type RetentionClass = "local" | "cloud-transient" | "cloud-stored";

export type BiasSupport = "none" | "initial_prompt" | "keyterms" | "context";

export interface EngineCapability {
  kind: LiveEngineKind;
  label: string; // zh — single source (S13 veto-#2 drift killer)
  retentionClass: RetentionClass; // static DEFAULT — see D7 above
  biasSupport: BiasSupport; // static DEFAULT — see D7 above
  sidecarOnly?: boolean; // keep the two tested static booleans as-is (D5)
  byokOnly?: boolean;
  osFloor?: "macos26" | "macos144"; // declarative tag only (D5) — NOT consumed by engineOptionGate
}

/** `posture` is DERIVED (D5), never stored — the coarse two-way split
 *  the existing 本地/云端 chip needs; `retentionClass` is the richer
 *  axis Lane C's tri-state label reads instead. */
export function derivePosture(retentionClass: RetentionClass): "local" | "cloud" {
  return retentionClass === "local" ? "local" : "cloud";
}

/** D7 runtime overlay, webspeech only: STTEvents.onEngineMode fires
 *  once per engine session with the mode it actually ran in (Chrome
 *  139+ `processLocally` on-device recognition vs the cloud fallback).
 *  Resolves the table's cloud-transient DEFAULT ("assume cloud unless
 *  enforced", doc §1 footnote 1) down to `local` for that one session;
 *  a structural no-op otherwise (StatusLine already renders this same
 *  override today via its own posture computation — this is the same
 *  resolution rule, named and testable, for anything Lane C wires to
 *  ENGINE_CAPABILITIES instead). */
export function resolveWebspeechRetentionClass(
  fallback: RetentionClass,
  engineMode?: "on-device" | "cloud",
): RetentionClass {
  return engineMode === "on-device" ? "local" : fallback;
}

// One row per live engine kind. Record<LiveEngineKind, …> rather than
// an array: TypeScript enforces completeness, so Lane D adding
// "deepgram" to STTEngineKind without adding its row here fails
// `npm run typecheck`, not silently — closes the exact "persisted
// engine survives with no capability entry" failure mode D5's own
// cross-invariant test targets (see engineCapabilities.test.ts).
export const ENGINE_CAPABILITIES: Record<LiveEngineKind, EngineCapability> = {
  webspeech: {
    kind: "webspeech",
    label: "浏览器识别",
    retentionClass: "cloud-transient",
    biasSupport: "none", // honest no-op (doc §3: "webspeech lands in the none bucket honestly")
  },
  whisper: {
    kind: "whisper",
    label: "本地 Whisper",
    retentionClass: "local",
    // faster-whisper default; Parakeet models (same kind, different
    // sidecar backend) resolve this to "none" per ACTIVE MODEL — Lane B.
    biasSupport: "initial_prompt",
    sidecarOnly: true,
  },
  tabaudio: {
    kind: "tabaudio",
    label: "标签页音频",
    retentionClass: "local",
    biasSupport: "initial_prompt", // rides the same faster-whisper sidecar as whisper
    sidecarOnly: true,
  },
  appaudio: {
    kind: "appaudio",
    label: "系统/App 音频",
    retentionClass: "local",
    biasSupport: "initial_prompt", // rides the same faster-whisper sidecar as whisper
    sidecarOnly: true,
    osFloor: "macos144",
  },
  osspeech: {
    kind: "osspeech",
    label: "系统识别 · 开箱即用",
    retentionClass: "local",
    // SpeechAnalyzer's AnalysisContext.contextualStrings — S11's Q11
    // already ships this (doc §3, Sol F16); Lane B migrates the
    // existing osSpeech.ts:287 direct store read onto the shared
    // lexicon builder, which doesn't change this static capability.
    biasSupport: "context",
    osFloor: "macos26", // iOS osspeech maps this SAME tag onto its own iOS-26 probe (Sol F6)
  },
  soniox: {
    kind: "soniox",
    label: "Soniox 云端识别",
    retentionClass: "cloud-transient", // no-retention default, per Soniox's own docs (doc §4)
    biasSupport: "context",
    byokOnly: true,
  },
};
