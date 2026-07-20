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
import type { STTEngineKind } from "@jargonslayer/core/types";
import { IS_DESKTOP } from "@/lib/platform/desktop";
import { IS_IOS } from "@/lib/platform/ios";
import { PREVIEW_TIER } from "@/lib/deployTier";
import {
  appAudioLockReason,
  getAudiocapCapsSnapshot,
  isAppAudioFloorLocked,
  probeAudiocapCaps,
  subscribeAudiocapCaps,
  type AudiocapCapabilities,
} from "@/lib/desktop/audiocapCaps";
import {
  isOsSpeechFloorLocked,
  osSpeechLockReason,
  type OsSpeechCapabilities,
} from "@/lib/desktop/osspeechCaps";

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
export interface EngineOption {
  value: Exclude<STTEngineKind, "demo">;
  label: string;
  posture: "local" | "cloud";
  sidecarOnly?: boolean;
  byokOnly?: boolean;
}

const ALL_ENGINE_OPTIONS: EngineOption[] = [
  { value: "webspeech", label: "浏览器识别", posture: "cloud" },
  { value: "whisper", label: "本地 Whisper", posture: "local", sidecarOnly: true },
  IS_DESKTOP
    ? { value: "appaudio", label: "系统/App 音频", posture: "local", sidecarOnly: true }
    : { value: "tabaudio", label: "标签页音频", posture: "local", sidecarOnly: true },
  // S11 (v0.4.3, docs/design-explorations/s11-osspeech-blueprint.md) —
  // Zero-Install 系统识别: desktop-only (macOS 26+ gated via
  // engineOptionGate below, not here — mirrors appaudio's own
  // macOS-14.4 floor gate). NOT sidecarOnly (it needs no local Whisper
  // sidecar at all — the whole point is zero-install), so it is
  // structurally unaffected by the #61 preview-tier lock.
  ...(IS_DESKTOP
    ? [{ value: "osspeech" as const, label: "系统识别 · 开箱即用", posture: "local" as const }]
    : []),
  { value: "soniox", label: "Soniox 云端识别", posture: "cloud", byokOnly: true },
];

// S13 (docs/design-explorations/s13-ios-blueprint.md, §6, Lane D): iOS
// v1 = mic-only, single native engine — osspeech ONLY (label byte-
// identical to the desktop entry above, Miana-veto #2: the two surfaces
// must never say this engine's name differently). No webspeech/whisper/
// tabaudio/appaudio/soniox/mlx on iOS v1 (Soniox deferred, blueprint D7)
// — none has an iOS capture path in v1's scope.
const IOS_ENGINE_OPTIONS: EngineOption[] = [
  { value: "osspeech", label: "系统识别 · 开箱即用", posture: "local" },
];

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

export const POSTURE_LABEL: Record<"local" | "cloud", string> = {
  local: "本地",
  cloud: "云端",
};

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
 *  components already had. */
export function engineOptionGate(
  opt: EngineOption,
  audiocapCaps: AudiocapCapabilities | null,
  osspeechCaps?: OsSpeechCapabilities | null,
): EngineOptionGate {
  const previewLocked = PREVIEW_TIER && (opt.sidecarOnly || opt.byokOnly);
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
