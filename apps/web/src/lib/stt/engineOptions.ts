"use client";

// S10 field-fix (docs/design-explorations/s10-fieldfix-blueprint.md,
// "engine picker stops being header tabs — becomes a DROPDOWN in the
// bottom StatusLine", her words: 与其作为tab，engine不如改成dropdown，且
// 显示在下方状态栏) — engine option metadata + gating, extracted verbatim
// out of Header.tsx's pre-S10 ENGINE_OPTIONS/EnginePillGroup/
// MobileEngineSelect (D7 desktop tabaudio->appaudio swap, S9.4/D6
// macOS-floor gating, #61 preview-tier lock) so StatusLine's new
// bottom-bar dropdown and Header's own EnginePostureChip share ONE
// definition. SettingsDialog.tsx's ENGINE_CARDS keeps its own richer
// (per-card `hint` copy) array — a different shape that doesn't cleanly
// share this module's data — but consumes isAppAudioFloorLocked/
// appAudioLockReason from lib/desktop/audiocapCaps.ts underneath, same
// as this module does.
//
// D7 desktop tabaudio replacement (docs/design-explorations/
// s9-app-audio-tap-blueprint.md): tabaudio (getDisplayMedia) can only
// ever fail inside Tauri's WKWebView — there is no tab-share picker to
// launch there — so desktop shows appaudio (a CoreAudio process tap,
// S9) in its slot instead; the web build keeps tabaudio exactly as
// before (D7 pinned decision: browser behavior stays byte-identical).
//
// S10 field-fix #1: webspeech is DROPPED ENTIRELY on desktop (not just
// swapped, like tabaudio->appaudio above) — Tauri's WKWebView has no
// SpeechRecognition API, so it has never once worked there, and unlike
// tabaudio there is no desktop capture substitute for it in this same
// picker slot (the substitute is the local mic path, whisper — see
// store.ts's applyPlatformEngineDefaults, which already coerces a
// persisted desktop webspeech selection to whisper so nobody strands on
// a removed option). The web build keeps webspeech unconditionally,
// exactly as before.
//
// IS_DESKTOP is a build-time const, so every swap/filter below resolves
// once at module load, not per render.

import { useEffect, useState } from "react";
import type { Settings, STTEngineKind } from "@jargonslayer/core/types";
import { IS_DESKTOP } from "@/lib/platform/desktop";
import { IS_IOS } from "@/lib/platform/ios";
import { PREVIEW_TIER, SONIOX_PREVIEW_LANE } from "@/lib/deployTier";
import {
  appAudioLockReason,
  getAudiocapCapsSnapshot,
  isAppAudioFloorLocked,
  probeAudiocapCaps,
  subscribeAudiocapCaps,
  type AudiocapCapabilities,
} from "@/lib/desktop/audiocapCaps";
import {
  getOsSpeechCapsSnapshot,
  isOsSpeechFloorLocked,
  osSpeechLockReason,
  type OsSpeechCapabilities,
} from "@/lib/desktop/osspeechCaps";
import {
  derivePosture,
  ENGINE_CAPABILITIES,
  resolveWebspeechRetentionClass,
  type LiveEngineKind,
  type RetentionClass,
} from "./engineCapabilities";
import type { OnDeviceMode } from "./onDeviceSpeech";
// v0.5 Wave-1 Feature 5 (mode-first UI, §5 A3/A4): deriveEngineForMode's
// own "always run the result through applyPlatformEngineDefaults+
// applyTierDefaults semantics" sanitize pass reuses those two pure,
// already-tested store.ts coercions verbatim rather than re-deriving
// platform/tier legality here — store.ts does not import this module
// (grepped), so this is a one-directional, non-circular edge.
import { applyPlatformEngineDefaults, applyTierDefaults } from "@/lib/store";

// Real capture engines only — demo is a scripted preview, not a peer
// engine, so it has exactly one affordance: the ≡ menu's 演示 item.
// posture drives the 本地/云端 label: local engines process audio on
// this machine; cloud engines send audio to a third-party service.
// sidecarOnly (#61 preview tier): whisper/tabaudio/appaudio require the
// local sidecar process, which the hosted preview build never has —
// greyed out there rather than removed (showroom posture: show
// everything, no dead ends). byokOnly (v0.4 S4, blueprint decision E):
// soniox is an unproven BYOK cloud engine (no local sidecar involved,
// but not benchmark-cleared either) — same preview lock as sidecarOnly.
//
// v0.4.7 (stt-provider-wiring-2026-07.md, Lane A, D5/D6): this shape
// stays exactly as it was — ENGINE_OPTIONS/engineOptionGate's own
// consumers (Header/StatusLine) are untouched by that doc's lanes —
// but the arrays below are now PROJECTIONS of the new capability
// contract (engineCapabilities.ts) instead of separately hand-authored
// literals, so `label` has exactly one source across both.
export interface EngineOption {
  value: Exclude<STTEngineKind, "demo">;
  label: string;
  posture: "local" | "cloud";
  // v0.4.7 Lane C (tri-state privacy label, doc §4/§9 D5-D7): the richer
  // axis StatusLine/Header now read instead of the coarse posture above.
  // Always populated by toEngineOption below — posture stays alongside
  // it unchanged (TutorialOverlay.tsx/SettingsDialog.tsx's own separate
  // POSTURE_LABEL copies still read it; out of this lane's scope).
  retentionClass: RetentionClass;
  sidecarOnly?: boolean;
  byokOnly?: boolean;
}

function toEngineOption(kind: LiveEngineKind): EngineOption {
  const cap = ENGINE_CAPABILITIES[kind];
  return {
    value: cap.kind,
    label: cap.label,
    posture: derivePosture(cap.retentionClass),
    retentionClass: cap.retentionClass,
    sidecarOnly: cap.sidecarOnly,
    byokOnly: cap.byokOnly,
  };
}

const ALL_ENGINE_OPTIONS: EngineOption[] = [
  toEngineOption("webspeech"),
  toEngineOption("whisper"),
  IS_DESKTOP ? toEngineOption("appaudio") : toEngineOption("tabaudio"),
  // v0.5 Wave-1 Feature 4 (docs/design-explorations/v05-wave1-
  // blueprint.md §1 Feature 4 + §5 A4) — tab audio without the local
  // sidecar, BYOK cloud backend instead (Soniox/Deepgram, see
  // Settings.tabAudioCloudProvider). Web-only for v0.5: desktop already
  // has sidecar+appaudio in this same slot, and store.ts's
  // applyPlatformEngineDefaults coerces a persisted value away there —
  // same `!IS_DESKTOP` guard the appaudio/tabaudio swap above relies on
  // (the IS_IOS branch below never reads ALL_ENGINE_OPTIONS at all, so
  // no separate iOS guard is needed here either).
  ...(!IS_DESKTOP ? [toEngineOption("tabaudio-cloud")] : []),
  // S11 (v0.4.3, docs/design-explorations/s11-osspeech-blueprint.md) —
  // Zero-Install 系统识别: desktop-only (macOS 26+ gated via
  // engineOptionGate below, not here — mirrors appaudio's own
  // macOS-14.4 floor gate). NOT sidecarOnly (it needs no local Whisper
  // sidecar at all — the whole point is zero-install), so it is
  // structurally unaffected by the #61 preview-tier lock.
  ...(IS_DESKTOP ? [toEngineOption("osspeech")] : []),
  toEngineOption("soniox"),
  // v0.4.7 (docs/design-explorations/stt-provider-wiring-2026-07.md,
  // Lane D) — second BYOK cloud engine, web + desktop only (no iOS v1
  // capture path — see engineCapabilities.ts's own doc comment); same
  // byokOnly preview-tier lock as soniox above.
  toEngineOption("deepgram"),
];

// S13 (docs/design-explorations/s13-ios-blueprint.md, §6, Lane D): iOS
// v1 = mic-only, single native engine — osspeech ONLY (label byte-
// identical to the desktop entry above, Miana-veto #2: the two surfaces
// must never say this engine's name differently — now structurally
// guaranteed, not just conventionally matched, since both project off
// the SAME ENGINE_CAPABILITIES.osspeech.label). No webspeech/whisper/
// tabaudio/appaudio/soniox/mlx on iOS v1 (Soniox deferred, blueprint D7)
// — none has an iOS capture path in v1's scope.
const IOS_ENGINE_OPTIONS: EngineOption[] = [toEngineOption("osspeech")];

/** PINNED CONTRACT (S10 blueprint wave 2): StatusLine's engine dropdown
 *  and Header's EnginePostureChip both consume this exact list — see
 *  this module's own header comment for the desktop webspeech drop /
 *  D7 tabaudio->appaudio swap it already bakes in. IS_IOS branches FIRST
 *  (S13) — ALL_ENGINE_OPTIONS/the desktop-vs-web filter below it stay
 *  byte-identical to pre-S13. */
export const ENGINE_OPTIONS: EngineOption[] = IS_IOS
  ? IOS_ENGINE_OPTIONS
  : IS_DESKTOP
    ? ALL_ENGINE_OPTIONS.filter((o) => o.value !== "webspeech")
    : ALL_ENGINE_OPTIONS;

// v0.4 S4: renamed from PREVIEW_SIDECAR_TITLE — now covers TWO
// distinct preview-lock reasons (sidecarOnly: needs the local sidecar;
// byokOnly: needs a BYOK credential preview doesn't collect), so the
// copy stays reason-agnostic rather than claiming "sidecar" for both.
export const PREVIEW_LOCKED_TITLE = "本地版功能：体验版暂未开放";

// Soniox preview lane (hosted trial, SONIOX_PREVIEW_LANE): the honest
// replacement for PREVIEW_LOCKED_TITLE on soniox's own option/card once
// the trial is live — see engineOptionGate below. Exported so tests pin
// it instead of re-duplicating the zh string (same convention as
// PREVIEW_LOCKED_TITLE itself).
export const SONIOX_PREVIEW_TRIAL_TITLE = "预览体验：每日限量，单次最长 10 分钟";

export const POSTURE_LABEL: Record<"local" | "cloud", string> = {
  local: "本地",
  cloud: "云端",
};

// v0.4.7 Lane C — tri-state privacy label (docs/design-explorations/
// stt-provider-wiring-2026-07.md §4, D6: zh copy lives in apps/web,
// packages/core carries zero zh strings). Upgrades the binary
// 本地/云端 chip: Soniox (cloud-transient, no-retention default) and a
// future cloud-stored engine used to collapse into the same amber
// "云端" — a privacy-positioned tool should never say that. `label` is
// the compact chip form (Header's EnginePostureChip); `hint` is the
// doc §4 wording verbatim (WHERE audio goes + what the vendor
// retains) — StatusLine's wider privacy segment shows it directly,
// Header's badge carries it as its `title` tooltip. Colors keep the
// established green=local/amber=cloud idiom (lab-green/warn-soft,
// unchanged pixel-for-pixel from the pre-tri-state chips) and extend
// honestly for cloud-stored — the doc's own "red" column (Deepgram
// default currently resolves to cloud-transient per D7's
// mip_opt_out=true, so no live engine occupies this row yet; the UI
// must still be able to tell the truth the day one does). ITEM 6 fix
// (fix round, Sol, LOW): cloud-stored's TEXT stays warn-soft, same as
// cloud-transient — DESIGN.md rule 3 ("warn TEXT uses warn-soft; fills
// use lab-red, small elements only") reserves lab-red for the escalated
// BORDER, not the label color, so the stronger warning reads as a
// bolder/redder outline around the same amber text rather than a
// second, ungoverned red-text variant.
export const RETENTION_COPY: Record<
  RetentionClass,
  { label: string; hint: string; textClass: string; borderClass: string }
> = {
  local: {
    label: "本地",
    hint: "本地处理 · 音频不出设备",
    textClass: "text-lab-green",
    borderClass: "border-lab-green/30",
  },
  "cloud-transient": {
    label: "云端·不留存",
    hint: "云端 · 处理后不留存",
    textClass: "text-warn-soft",
    borderClass: "border-warn-soft/30",
  },
  "cloud-stored": {
    label: "云端·可能留存",
    hint: "云端 · 可能留存/需配置",
    textClass: "text-warn-soft",
    borderClass: "border-lab-red/30",
  },
};

/** D7 two-layer truth (doc §9 D7 + Lane C addendum, Opus C5): the ONE
 *  place StatusLine's privacy segment and Header's EnginePostureChip
 *  both resolve the ACTIVE retentionClass for the selected engine, so
 *  the two surfaces can never disagree (the addendum's own failure
 *  mode: "two coexisting privacy labels that can disagree"). Mirrors
 *  StatusLine's pre-tri-state posture derivation byte-for-byte: demo
 *  has no audio at all (S10 field-fix #2's lead adjudication — hard-
 *  pinned local), an engine absent from ENGINE_OPTIONS (import/
 *  browser-whisper, or any future value) never defaults to local, and
 *  webspeech alone narrows via the D7 runtime overlay
 *  (resolveWebspeechRetentionClass, engineCapabilities.ts) using the
 *  live onEngineMode signal (store.sttEngineMode). */
export function resolveEngineRetentionClass(
  engine: STTEngineKind,
  sttEngineMode: OnDeviceMode | null,
): RetentionClass {
  if (engine === "demo") return "local";
  const fallback = ENGINE_OPTIONS.find((o) => o.value === engine)?.retentionClass ?? "cloud-transient";
  return engine === "webspeech"
    ? resolveWebspeechRetentionClass(fallback, sttEngineMode ?? undefined)
    : fallback;
}

export interface EngineOptionGate {
  disabled: boolean;
  title: string | undefined;
}

/** Per-option preview-tier (#61) + macOS-floor (S9.4/D6, finding F9;
 *  S11 adds the osspeech macOS-26 floor identically) gate — the
 *  identical computation EnginePillGroup/MobileEngineSelect each used to
 *  hand-roll separately pre-S10. `osspeechCaps` is OPTIONAL and
 *  additive (S11) so every existing 2-arg call site keeps compiling
 *  untouched — a caller not yet updated to pass it simply never
 *  floor-locks the osspeech option (same fail-open posture a
 *  not-yet-resolved caps snapshot already has). Deliberately does NOT
 *  fold in `isEngineControlBusy` — a caller combines that itself at
 *  whichever granularity its own control needs (one <select disabled>
 *  for the whole picker vs a per-<option> gate), same split the pre-S10
 *  components already had.
 *
 *  BYOK preview (docs/design-explorations/byok-preview-blueprint.md D3):
 *  `byokOnly` no longer locks anything here — soniox/deepgram/
 *  tabaudio-cloud are all selectable exactly like full tier, a keyless
 *  pick just fails honestly at start (same unconditional-survival
 *  posture as applyTierDefaults, store.ts). ONLY `sidecarOnly` still
 *  locks (whisper/tabaudio/appaudio) — the hosted preview build
 *  genuinely never has that local process. Soniox preview lane (hosted
 *  trial, SONIOX_PREVIEW_LANE): the soniox option keeps its honest
 *  SONIOX_PREVIEW_TRIAL_TITLE hint while the lane is on, in place of
 *  `undefined` — this gate has no settings/key visibility (never did),
 *  so it can't tell a keyless trial rider from a BYOK sonioxKey holder;
 *  the title is informational, not a lock either way. tabaudio-cloud no
 *  longer gets this title: D3 makes its runtime provider an honest
 *  reflection of Settings.tabAudioCloudProvider (tabAudioCloud.ts's own
 *  effectiveProvider), which may resolve to Deepgram — no trial at all —
 *  so a blanket "预览体验" hint on the OPTION itself would be wrong half
 *  the time now. */
export function engineOptionGate(
  opt: EngineOption,
  audiocapCaps: AudiocapCapabilities | null,
  osspeechCaps?: OsSpeechCapabilities | null,
): EngineOptionGate {
  const sonioxPreviewTrial = SONIOX_PREVIEW_LANE && opt.value === "soniox";
  const previewLocked = PREVIEW_TIER && opt.sidecarOnly;
  const appAudioLocked = isAppAudioFloorLocked(opt.value, audiocapCaps);
  const osSpeechLocked = isOsSpeechFloorLocked(opt.value, osspeechCaps ?? null);
  return {
    disabled: !!previewLocked || appAudioLocked || osSpeechLocked,
    title: previewLocked
      ? PREVIEW_LOCKED_TITLE
      : appAudioLocked
        ? appAudioLockReason(audiocapCaps)
        : osSpeechLocked
          ? osSpeechLockReason(osspeechCaps ?? null)
          : sonioxPreviewTrial
            ? SONIOX_PREVIEW_TRIAL_TITLE
            : undefined,
  };
}

// S9.4/D6 macOS-floor gating (adversarial review finding F9): subscribes
// to the shared audiocapCaps probe (lib/desktop/audiocapCaps.ts) and
// kicks it off on mount — IS_DESKTOP-guarded INSIDE that module itself,
// so this is an inert no-op call on a web build (never reaches
// getInvoke()). Relocated verbatim out of Header.tsx (pre-S10 home of
// EnginePillGroup/MobileEngineSelect, its only two callers there).
export function useAudiocapCaps(): AudiocapCapabilities | null {
  const [caps, setCaps] = useState<AudiocapCapabilities | null>(() => getAudiocapCapsSnapshot());
  useEffect(() => {
    const unsubscribe = subscribeAudiocapCaps(() => setCaps(getAudiocapCapsSnapshot()));
    void probeAudiocapCaps().then(() => setCaps(getAudiocapCapsSnapshot()));
    return unsubscribe;
  }, []);
  return caps;
}

// ---------------------------------------------------------------
// v0.5 Wave-1 Feature 5 (mode-first UI, docs/design-explorations/
// v05-wave1-blueprint.md §1 Feature 5 + §5 A3/A4) — L8's own seam:
// ModeSelector.tsx (components/) calls deriveEngineForMode on a tile
// click to resolve WHICH engine a chosen mode should actually run, then
// writes both `mode` and the derived `engine` together via
// updateSettings (see Settings.mode's own doc comment, types.ts, for
// the mode/engine divergence contract this deliberately preserves —
// StatusLine's EngineDropdown keeps writing `engine` alone, unrelated
// to this function).
// ---------------------------------------------------------------

/** Platform flags this function needs — an EXPLICIT parameter (not the
 *  module-scope IS_DESKTOP/IS_IOS consts every other platform-filtered
 *  export in this file reads directly) so it's directly unit-testable
 *  across all three shells from one test file, no vi.mock+resetModules
 *  gymnastics required — mirrors modeForPersistedEngine's own `platform`
 *  parameter (store.ts). */
export interface DeriveEnginePlatform {
  isDesktop: boolean;
  isIos: boolean;
}

/** §1 F5's mode→engine table + §5 A4, as a pure(-ish) function: given
 *  the mode a ModeSelector tile just picked (or a mode already
 *  persisted from before), returns the engine that mode should run WITH
 *  on this platform/settings.
 *
 *  - "import"/"url" open ImportHub (page.tsx) rather than starting a
 *    live engine — `settings.engine` passes through UNCHANGED (§1 F5:
 *    "engine unchanged").
 *  - "system-audio" (desktop only in the real tile set, §3 Q2): osspeech
 *    when the shared macOS-26 floor probe (osspeechCaps.ts) says so,
 *    else appaudio (S9's CoreAudio tap) — reads the SAME single-flight
 *    cache engineOptionGate already consults (getOsSpeechCapsSnapshot)
 *    rather than re-probing; a not-yet-resolved (null) snapshot fails
 *    OPEN to osspeech, mirroring isOsSpeechFloorLocked's own D6 policy
 *    ("runtime commands re-check support — UI gating is not a
 *    boundary") — the conservative, precedent-consistent choice rather
 *    than a new one invented here. A caller reaching this branch off
 *    desktop (never happens from the real tile set — absent, not
 *    disabled) degrades to a working mic default rather than a
 *    platform-nonsensical one; the sanitize pass below still runs.
 *  - "tab" (web only in the real tile set): tabaudio-cloud on preview
 *    UNCONDITIONALLY (docs/design-explorations/byok-preview-blueprint.md
 *    D3 — a first-class, always-derivable preview engine now, keyless
 *    picks just fail honestly at start; the local-sidecar tabaudio is
 *    never reachable on preview anyway, still sidecarOnly-locked). On
 *    full tier: A4's key-gated rule — tabaudio-cloud when Settings.
 *    tabAudioCloudProvider's MATCHING BYOK key is present, else the
 *    local-sidecar tabaudio (never silently swaps to the OTHER
 *    provider's key). Whether the sidecar itself is actually reachable
 *    (`whisperUrl`) isn't knowable synchronously from a pure function —
 *    deliberately not attempted, same "let the surface explain" posture
 *    ImportHub's own url tab already takes for an analogous
 *    unknowable-synchronously case.
 *  - "mic": iOS is osspeech unconditionally (v1's only engine). Desktop
 *    is osspeech-if-floor else whisper (deliberately never appaudio —
 *    that is SYSTEM audio, not a mic substitute; mirrors store.ts's own
 *    desktop webspeech->whisper coercion precedent). Web defaults to
 *    webspeech (zero-config) UNLESS a BYOK cloud key already exists AND
 *    the CURRENT settings.engine is already whisper/soniox/deepgram —
 *    then that existing choice is respected rather than clobbered on
 *    every mic-tile click. An already-selected soniox is ALSO respected
 *    with no key at all on preview (D3: first-class there too, same as
 *    the "tab" bullet above).
 *
 *  Sanitize pass (L8 task spec: "always run the result through
 *  applyPlatformEngineDefaults+applyTierDefaults semantics"): every
 *  candidate above is run through those exact two store.ts coercions
 *  before returning — belt-and-suspenders against a derivation mistake
 *  above AND the one thing this function genuinely cannot decide for
 *  itself from its own inputs, preview-tier (byokOnly/sidecarOnly)
 *  legality, which those two pure, already-unit-tested functions already
 *  own. NOTE (verified by reading store.ts): `updateSettings` itself
 *  does NOT re-run migrateSettings/these coercions on every write — it
 *  is a plain merge+persist — so this function, not the later store
 *  write, is what actually guarantees the returned engine is legal. */
export function deriveEngineForMode(
  mode: Settings["mode"],
  platform: DeriveEnginePlatform,
  settings: Settings,
): STTEngineKind {
  if (mode === "import" || mode === "url") return settings.engine;

  const { isDesktop, isIos } = platform;
  const osspeechFloorMet = !isOsSpeechFloorLocked("osspeech", getOsSpeechCapsSnapshot());

  let candidate: STTEngineKind;
  if (mode === "system-audio") {
    candidate = isDesktop
      ? osspeechFloorMet
        ? "osspeech"
        : "appaudio"
      : isIos
        ? "osspeech" // unreachable via the real tile set (iOS has no system-audio mode)
        : "webspeech"; // unreachable via the real tile set (web has no system-audio capture)
  } else if (mode === "tab") {
    // BYOK preview (docs/design-explorations/byok-preview-blueprint.md
    // D3): tabaudio-cloud is reachable with NO key at all on preview —
    // it is now a first-class, always-selectable preview engine (a
    // keyless pick just fails honestly at start, tabAudioCloud.ts's own
    // start(); the local-sidecar tabaudio is never reachable on preview
    // anyway, still sidecarOnly-locked), so PREVIEW_TIER alone settles
    // it here — mirrors this same function's own mic-branch soniox
    // exception below, and applyTierDefaults' own unconditional BYOK
    // survival, store.ts.
    const providerKeyPresent =
      settings.tabAudioCloudProvider === "deepgram" ? !!settings.deepgramKey : !!settings.sonioxKey;
    candidate = PREVIEW_TIER || providerKeyPresent ? "tabaudio-cloud" : "tabaudio";
  } else {
    // mode === "mic"
    if (isIos) {
      candidate = "osspeech";
    } else if (isDesktop) {
      candidate = osspeechFloorMet ? "osspeech" : "whisper";
    } else {
      // whisper is respected UNCONDITIONALLY (local sidecar, needs no
      // key — a local-first user's deliberate choice must survive a
      // mic-tile click); soniox/deepgram are respected only when their
      // OWN matching key exists (L8 review fix — the first draft's flat
      // hasCloudKey && compatible gate reset keyless whisper users to
      // webspeech). BYOK preview (docs/design-explorations/byok-
      // preview-blueprint.md D3): an already-selected soniox is ALSO
      // respected with no key at all on preview — it's a first-class,
      // selectable-even-keyless engine there now (a keyless pick just
      // fails honestly at start, same as full tier), so "no sonioxKey"
      // is no longer proof the user can't keep using it (mirrors
      // applyTierDefaults' own unconditional BYOK survival, store.ts).
      // deepgram gets no such carve-out here: this branch is a "don't
      // clobber an existing pick on a mic-tile click" nicety, not a
      // legality gate (applyTierDefaults/engineOptionGate already make
      // deepgram equally selectable on preview regardless), and it
      // never had a keyless carve-out of its own even before D3.
      const cloudKeyFor =
        settings.engine === "soniox"
          ? !!settings.sonioxKey || PREVIEW_TIER
          : settings.engine === "deepgram"
            ? !!settings.deepgramKey
            : false;
      candidate =
        settings.engine === "whisper" || cloudKeyFor ? settings.engine : "webspeech";
    }
  }

  const candidateSettings: Settings = { ...settings, engine: candidate };
  const platformSanitized = applyPlatformEngineDefaults(candidateSettings, isDesktop, isIos);
  // `true`: applyTierDefaults' own 3rd param is unread post-S14.1 (see
  // its doc comment in store.ts) — kept `true` for signature-intent
  // clarity only ("yes, there is a real candidate engine to sanitize").
  return applyTierDefaults(platformSanitized, PREVIEW_TIER, true).engine;
}
