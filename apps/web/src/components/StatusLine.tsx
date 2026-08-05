"use client";

// v3 主题基座 vim 状态线 (docs/DESIGN.md v3.3): bottom bar mounted below
// <main> in page.tsx. Left = inverted status block reading store
// status; middle = detect mode + audio-privacy sentence; right =
// {cards+terms} counter, then the task tray.
//
// Bit mascot behavior train (chamber B): the always-on perch that used
// to live at the right end of this bar is GONE — Bit now only appears
// as a ModeSelector greeting (pre-meeting) and a brief post-meeting
// celebration overlay (page.tsx), never during connecting/listening/
// paused, and never as a persistent fixture here. See ModeSelector.tsx
// and BitCelebrationOverlay.tsx.

import { useEffect, useRef, useState } from "react";
import { modeForPersistedEngine, useApp, type ModePlatform } from "@/lib/store";
import { IS_DESKTOP } from "@/lib/platform/desktop";
import { IS_IOS } from "@/lib/platform/ios";
import { useLatencyStats } from "@/lib/stt/latencyStats";
import {
  RENOTICE_INTERVAL_MS,
  WATCHDOG_WALL_FLOOR_MS,
  useAudioLiveness,
  type AudioChannel,
} from "@/lib/stt/audioLiveness";
import { diagLog } from "@/lib/diag/log";
import {
  ENGINE_OPTIONS,
  RETENTION_COPY,
  deriveEngineForMode,
  engineOptionGate,
  isSidecarFamily,
  resolveEngineRetentionClass,
  sidecarEngineForMode,
  useAudiocapCaps,
} from "@/lib/stt/engineOptions";
import {
  ENGINE_CAPABILITIES,
  ENGINE_FAMILY_LABEL,
  ENGINE_FAMILY_ORDER,
  resolveTabAudioCloudProvider,
  type RetentionClass,
} from "@/lib/stt/engineCapabilities";
import { KEY_STATUS_LABEL, deriveKeyStatus } from "@/lib/settings/keyStatus";
import { sttProviderKeyValue } from "@/lib/settings/keysCatalog";
import { useOsSpeechCaps } from "@/lib/desktop/osspeechCaps";
import { langPairFromSettings } from "@/lib/translate/providers";
import { isEngineControlBusy } from "@/components/Header";
import TaskTray from "@/components/TaskTray";
import AiStatusPanel, { deriveHealthStatus, type AiHealthStatus } from "@/components/AiStatusPanel";
import { useLlmTelemetry } from "@/lib/llm/telemetry";
import { resolveTaskCreds } from "@/lib/llm/taskConfig";
import { useDirectTransport } from "@/lib/llm/client";
import { useOverlayA11y } from "@/lib/a11y";
import type { Settings, STTEngineKind } from "@jargonslayer/core/types";

// Exported (tech-debt ledger #4, 2026-07-17): StatusLine.test.tsx
// imports this instead of re-pinning its own copy of the zh labels, so
// a reword here can't silently desync from a test asserting the old
// string.
// TestFlight batch fix (detect-mode rename round): 词典模式/AI 模式
// replace the old 词典检测/词典+AI 检测 wording fleet-wide — SettingsDialog's
// own 检测模式 segmented control appends its own "（Beta）" qualifier onto
// the `llm` label locally (see DETECT_MODE_OPTIONS there) rather than
// baking it in here, since this bare string also has to fit this file's
// own space-constrained bottom-bar chip/button.
export const DETECT_MODE_LABEL: Record<string, string> = {
  llm: "AI 模式",
  dictionary: "词典模式",
  off: "关闭",
};

// Same reasoning — the engine <select>'s own placeholder + sidecar-down
// hint below, both pinned by exact-equality assertions in
// StatusLine.test.tsx.
export const ENGINE_SELECT_PLACEHOLDER = "引擎";
export const SIDECAR_DOWN_HINT_WEB = "本地转录服务未连接——见 设置 → 转录引擎";

// S10 field-fix #5: engines whose transcription actually flows through
// wsTransport.ts (the ONE lag_ms producer, via the local Whisper
// sidecar) — mirrors sidecarDownHint's own identical three-way gate
// just below, which already established "these are the sidecar-backed
// engines" for this exact file.
const LOCAL_WHISPER_ENGINES = new Set(["whisper", "tabaudio", "appaudio"]);

// This is intentionally two adjacent controls: recognizer family and audio
// source are independent persisted settings, and BOTH dropdowns write the
// pair together — the source dropdown derives a matching engine (FINDING 1
// fix, see AudioSourceDropdown's doc comment) and the engine dropdown
// back-derives the matching source via modeForPersistedEngine (v0.7.4
// osspeech-silence round: picking 系统 used to leave a persisted
// mode:"mic" claiming 麦克风 over the live output tap). Same pairing
// TutorialOverlay's engine grid already uses.
const ENGINE_OVERRIDE_HINT = "选择转录服务；音源随之切换";
// Platform shape for modeForPersistedEngine — same construction
// TutorialOverlay's ITEM 4 fix uses.
const MODE_PLATFORM: ModePlatform = IS_IOS ? "ios" : IS_DESKTOP ? "desktop" : "web";
const AUDIO_SOURCE_PLACEHOLDER = "音源";
const SYSTEM_AUDIO_CAVEAT = "只捕获对方的系统/App 声音，不包含你的麦克风";

interface AudioSourceOption {
  value: "mic" | "system-audio" | "dual" | "tab";
  label: string;
  caveat?: string;
}

// Dual capture v1 (docs/design-explorations/dual-capture-2026-08.md):
// "dual" (麦克风+系统) joins the desktop-only "system-audio" entry —
// picking it always resolves to osspeech (deriveEngineForMode's own
// "dual" branch, engineOptions.ts; isModeLegalForPlatform pins the
// legality identically), same as how picking "system-audio"/"mic" here
// can already switch the engine underneath a different current pick.
const AUDIO_SOURCE_OPTIONS: readonly AudioSourceOption[] = [
  { value: "mic", label: "麦克风" },
  ...(IS_DESKTOP
    ? ([
        { value: "system-audio", label: "系统/App 音频（仅对方，不含麦克风）", caveat: SYSTEM_AUDIO_CAVEAT },
        { value: "dual", label: "麦克风+系统" },
      ] as const)
    : []),
  ...(!IS_DESKTOP && !IS_IOS ? ([{ value: "tab", label: "浏览器标签页" }] as const) : []),
] as const;

// FINDING 1 fix (BLOCKER): this used to write `mode` alone, relabeling the
// capture source in the UI without touching `engine` — the field that
// actually decides what gets recorded (nothing in lib/stt/useMeeting/any
// transport ever reads settings.mode at capture time). Picking 麦克风
// while the engine stayed appaudio left the process tap running under a
// UI claiming mic-only, and the inverse left the mic hot under a "仅对方"
// claim — the worst class of bug for a tool whose pitch is transparency.
// Mirrors ModeSelector.pickCapture exactly: same deriveEngineForMode call,
// same platform shape, both settings written together in one
// updateSettings call so mode/engine can never observably diverge.
function AudioSourceDropdown() {
  const mode = useApp((s) => s.settings.mode);
  const settings = useApp((s) => s.settings);
  const status = useApp((s) => s.status);
  const updateSettings = useApp((s) => s.updateSettings);
  const selected = AUDIO_SOURCE_OPTIONS.find((option) => option.value === mode);
  // Same gate EngineDropdown already uses — the engine can't follow a
  // source swap mid-capture (connecting/listening), so neither can this.
  const disabled = isEngineControlBusy(status);

  return (
    <select
      aria-label="音频来源"
      aria-description={selected?.caveat}
      data-testid="statusline-audio-source-select"
      title={selected?.caveat ?? "选择要捕获的音频来源"}
      value={selected ? mode : ""}
      disabled={disabled}
      onChange={(e) => {
        const nextMode = e.target.value as Settings["mode"];
        updateSettings({
          mode: nextMode,
          engine: deriveEngineForMode(nextMode, { isDesktop: IS_DESKTOP, isIos: IS_IOS }, settings),
        });
      }}
      // F5 fix round (HIGH): below sm this is the NARROWER of the two
      // selects (7rem vs 引擎's 8.5rem, EngineDropdown below) — its own
      // option labels (麦克风/系统/麦克风+系统/浏览器标签页) are shorter
      // than the engine picker's third-party names, so it needs less of
      // the row's tight budget. Native <select> clips its own displayed
      // (selected) text once boxed this narrow — no extra truncate class
      // needed. ≥sm unchanged.
      className="h-full max-w-[7rem] shrink-0 border-l border-edge bg-panel2 px-2 font-mono text-fg disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-[12rem]"
    >
      {!selected && (
        <option value="" disabled>
          {AUDIO_SOURCE_PLACEHOLDER}
        </option>
      )}
      {AUDIO_SOURCE_OPTIONS.map((option) => (
        <option key={option.value} value={option.value} title={option.caveat}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

// FINDING 12 fix (LOW): short NAME half for the cramped bottom bar (the
// select is max-w-[8.5rem] below sm — "Soniox 云端识别 · 未配置" truncates
// on iOS) — a display-only override local to this component, never a
// change to the shared ENGINE_OPTIONS array (SettingsDialog's own
// ENGINE_CARDS, the actual source of `label`, keeps the full name).
const ENGINE_SELECT_LABEL_OVERRIDE: Record<string, string> = {
  osspeech: "系统",
  soniox: "Soniox",
  deepgram: "Deepgram",
  elevenlabs: "ElevenLabs",
};

// Miana 2026-08-01: the 本地 STT 模型 family (whisper/appaudio/tabaudio)
// is ONE recognizer — the local sidecar running Whisper or Parakeet —
// fed by whichever source the 音源 dropdown picks. Listing its
// source-variants as separate "engines" next to a source dropdown was
// pure duplication, and "本地 Whisper" misnamed the Parakeet models
// too. The picker shows one sentinel entry; picking it resolves to the
// sidecar kind that serves the CURRENT source (sidecarEngineForMode).
const LOCAL_SIDECAR_VALUE = "local-sidecar";
export const LOCAL_SIDECAR_LABEL = "本地模型";

function engineOptionLabel(opt: (typeof ENGINE_OPTIONS)[number], settings: Settings): string {
  const label = ENGINE_SELECT_LABEL_OVERRIDE[opt.value] ?? opt.label;
  // FINDING 10 fix (MEDIUM): tabaudio-cloud has no static keyField of its
  // own — its credential resolves via Settings.tabAudioCloudProvider
  // (resolveTabAudioCloudProvider, engineCapabilities.ts), unlike
  // Soniox/Deepgram/ElevenLabs' own fixed opt.keyField — so it rendered
  // bare and selectable with zero keys and no hint, unlike every other
  // third-party option in this same optgroup. Derive the SAME 已配置/
  // 未配置 status off whichever provider it would actually run.
  const keyField =
    opt.keyField ??
    (opt.value === "tabaudio-cloud"
      ? resolveTabAudioCloudProvider(settings) === "deepgram"
        ? "deepgramKey"
        : "sonioxKey"
      : undefined);
  if (!keyField) return label;
  const status = deriveKeyStatus(sttProviderKeyValue(settings, keyField));
  return `${label} · ${KEY_STATUS_LABEL[status]}`;
}

function EngineDropdown() {
  const settings = useApp((s) => s.settings);
  const engine = settings.engine;
  const status = useApp((s) => s.status);
  const sttEngineMode = useApp((s) => s.sttEngineMode);
  const updateSettings = useApp((s) => s.updateSettings);
  const disabled = isEngineControlBusy(status);
  const audiocapCaps = useAudiocapCaps();
  const osspeechCaps = useOsSpeechCaps();
  const selectedOpt = ENGINE_OPTIONS.find((o) => o.value === engine);
  const selectedGate = selectedOpt ? engineOptionGate(selectedOpt, audiocapCaps, osspeechCaps) : undefined;

  // Which sidecar kind the sentinel resolves to under the CURRENT
  // source (desktop: whisper/appaudio; web: whisper/tabaudio) — also
  // supplies the sentinel's gate (preview lock / macOS floor).
  const localTargetOpt =
    ENGINE_OPTIONS.find((o) => o.value === sidecarEngineForMode(settings.mode)) ??
    ENGINE_OPTIONS.find((o) => o.value === "whisper");

  // The group structure is projected from ENGINE_CAPABILITIES via
  // ENGINE_OPTIONS.family. An engine cannot be added to the exhaustive
  // capabilities record without selecting one of these families.
  const groupedOptions = ENGINE_FAMILY_ORDER.map((family) => ({
    family,
    options: ENGINE_OPTIONS.filter((option) => option.family === family),
  })).filter((group) => group.options.length > 0);

  // TASK 5 root cause (value/option mismatch): `engine` can be a value
  // this BUILD's platform-filtered ENGINE_OPTIONS carries no <option>
  // for at all — "demo"/"import" by design (never live engines), but
  // also any cross-platform/stale persisted kind (e.g. a desktop-only
  // "osspeech"/"appaudio" surviving into a web session). Before this
  // fix `selectValue` fell through to that raw string for every
  // non-demo/import case, which matches no rendered <option> — a
  // native <select> then silently auto-selects its FIRST enabled
  // option (verified against jsdom's own HTMLSelectElement algorithm:
  // it lands on 本地模型, the first-rendered option) instead of showing
  // nothing, quietly misrepresenting an unrelated engine as 本地模型.
  // `unmapped` generalizes the existing demo/import placeholder path
  // to catch this too, so the select falls back to an honest
  // placeholder instead of a WRONG live option.
  const unmapped = !selectedOpt;
  // The unmapped engine's OWN name when ENGINE_CAPABILITIES still knows
  // it (a real engine, just unavailable on this platform/build) — the
  // generic ENGINE_SELECT_PLACEHOLDER stays reserved for demo/import,
  // which were never real capture engines to begin with.
  const unmappedLabel =
    (ENGINE_CAPABILITIES as Partial<Record<STTEngineKind, { label: string }>>)[engine]?.label ??
    ENGINE_SELECT_PLACEHOLDER;

  const selectValue = unmapped ? "" : isSidecarFamily(engine) ? LOCAL_SIDECAR_VALUE : engine;

  const iosTextClass = IS_IOS
    ? unmapped
      ? "text-fg"
      : RETENTION_COPY[resolveEngineRetentionClass(engine, sttEngineMode)].textClass
    : "text-fg";

  return (
    <select
      aria-label="转录引擎"
      data-testid="statusline-engine-select"
      disabled={disabled}
      title={selectedGate?.title ?? ENGINE_OVERRIDE_HINT}
      value={selectValue}
      onChange={(e) => {
        const raw = e.target.value;
        if (!raw) return;
        const next = (
          raw === LOCAL_SIDECAR_VALUE
            ? (localTargetOpt?.value ?? "whisper")
            : raw
        ) as (typeof ENGINE_OPTIONS)[number]["value"];
        updateSettings({
          engine: next,
          // Dual capture v1: pass the PRE-click mode as the persisted-
          // source hint ONLY when the engine was ALREADY osspeech (see
          // modeForPersistedEngine's own doc, store.ts, for why this
          // gate matters — a mic/dual pick from a DIFFERENT prior engine
          // must still default to system-audio, never leak in an
          // unrelated mode value).
          mode: modeForPersistedEngine(
            next,
            next,
            MODE_PLATFORM,
            engine === "osspeech" ? settings.mode : undefined,
          ),
        });
      }}
      // F5 fix round (HIGH): below sm this is the WIDER of the two
      // selects (8.5rem vs 音源's 7rem, AudioSourceDropdown above) — its
      // third-party option labels (Soniox/Deepgram/ElevenLabs · 未配置)
      // need more of the row's tight budget. ≥sm unchanged.
      className={`h-full max-w-[8.5rem] shrink-0 border-x border-edge bg-panel2 px-2 font-mono disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-[12rem] sm:px-2 ${iosTextClass}`}
    >
      {unmapped && (
        <option value="" disabled>
          {unmappedLabel}
        </option>
      )}
      {groupedOptions.map((group) => (
        <optgroup key={group.family} label={ENGINE_FAMILY_LABEL[group.family]}>
          {group.family === "local-model"
            ? (() => {
                const gate = localTargetOpt
                  ? engineOptionGate(localTargetOpt, audiocapCaps, osspeechCaps)
                  : undefined;
                return (
                  <option
                    value={LOCAL_SIDECAR_VALUE}
                    disabled={gate?.disabled}
                    title={gate?.title}
                  >
                    {LOCAL_SIDECAR_LABEL}
                  </option>
                );
              })()
            : group.options.map((opt) => {
                const gate = engineOptionGate(opt, audiocapCaps, osspeechCaps);
                return (
                  <option key={opt.value} value={opt.value} disabled={gate.disabled} title={gate.title}>
                    {engineOptionLabel(opt, settings)}
                  </option>
                );
              })}
        </optgroup>
      ))}
    </select>
  );
}

// v0.4.5 AI-status chip (owner ruling on the design doc's Q3: a fuller
// "检测 · luna ✓" label over a single worst-state dot — status bar is
// tight, but she picked legibility). shortModelName strips a
// "vendor/model" OpenRouter-style slug down to its model half (the
// only concrete rule the design gives — the last "/"-separated
// segment); a bare model id with no slash passes through unchanged.
export function shortModelName(model: string): string {
  const idx = model.lastIndexOf("/");
  return idx === -1 ? model : model.slice(idx + 1);
}

// Exported (same "don't re-pin raw zh in the test" convention as
// DETECT_MODE_LABEL above) — the glyph mirrors AiStatusPanel's own
// deriveHealthStatus 3-state collapse (grey/neutral for a keyless
// nokey "failure" too, not just a genuinely-never-called row).
// neutral is "…", not "·" — the label's own "检测 · {model}" separator
// already uses "·", and a glyph identical to the separator would be
// impossible to tell apart at a glance (or in a test assertion).
export const AI_STATUS_CHIP_GLYPH: Record<AiHealthStatus, string> = {
  ok: "✓",
  fail: "✗",
  neutral: "…",
};

export const AI_STATUS_CHIP_DOMAIN_LABEL = "检测";

// TASK 1 truth fix (owner ask): this chip used to show the CONFIGURED
// detect model regardless of whether it's actually what's running —
// dictionary mode (or autoDetect off entirely) never calls it, and llm
// mode with no resolved key never gets past client.ts's own NoKeyError
// fallback to use it either. detectMode (the scheduler's own runtime
// state, detect/scheduler.ts) is already the truth signal AiStatusPanel's
// aiFallenBack reads for the identical reason — no new plumbing, just
// branch the label on it + the resolved key's presence. Exported (same
// "don't re-pin raw zh in the test" convention as DETECT_MODE_LABEL).
export const AI_STATUS_CHIP_DICT_LABEL = "词典";
export const AI_STATUS_CHIP_UNCONFIGURED_LABEL = "未配置";

// D2 fold (task 4): extracted out of the inline JSX that used to sit
// directly in StatusLine's own return — reused byte-identically both in
// the sm+ inline group below and inside OverflowChip's <sm popover, so
// neither copy can drift into a fork of the other's logic.
function DetectModeChip() {
  const detectMode = useApp((s) => s.detectMode);
  const aiDetect = useApp((s) => s.settings.aiDetect);
  const updateSettings = useApp((s) => s.updateSettings);
  const setDetectMode = useApp((s) => s.setDetectMode);

  if (detectMode === "off") {
    return (
      <span className="whitespace-nowrap px-2 sm:px-3">
        {DETECT_MODE_LABEL.off}
      </span>
    );
  }

  // Clickable (E2E feedback): flips settings.aiDetect. The label
  // derives from detectMode (the scheduler's runtime state, see
  // detect/scheduler.ts), which the scheduler only re-reads on its
  // next segment/batch — so the click ALSO echoes the expected
  // mode synchronously, or an idle meeting would show a dead
  // button. The scheduler's own onModeChange remains authoritative
  // and corrects the echo if reality differs (e.g. key-less
  // fallback downgrades llm back to dictionary).
  return (
    <button
      type="button"
      data-testid="statusline-detect-toggle"
      onClick={() => {
        const next = !aiDetect;
        updateSettings({ aiDetect: next });
        setDetectMode(next ? "llm" : "dictionary");
      }}
      title="点击切换 AI 模式（词典模式始终开启）"
      className="flex h-full items-center whitespace-nowrap px-2 hover:bg-panel3 hover:text-fg sm:px-3"
    >
      {DETECT_MODE_LABEL[detectMode]}
    </button>
  );
}

// Chip + popover: always-visible "检测 · {running label} {glyph}" for
// the detect agent (the one every meeting actually uses live), click
// opens the full 4-row AiStatusPanel. Click-outside/Escape close mirrors
// Header.tsx's HamburgerMenu exactly (same pattern, this bar's own
// popover). Opens UPWARD (bottom-full) since this bar sits at the
// bottom of the screen — mirrors HamburgerMenu's positioning inverted.
function AiStatusChip() {
  const settings = useApp((s) => s.settings);
  const detectMode = useApp((s) => s.detectMode);
  const detectStat = useLlmTelemetry((s) => s.detect);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // F4 fix round (HIGH): routed through useOverlayA11y for stack-aware
  // Escape (this popover can itself nest inside StatusLine's <sm
  // OverflowChip popover — see that component's own doc) + Tab-trap +
  // focus-restore-to-trigger. modal:false — role=dialog stays, but this
  // is a non-modal popover, and a nested aria-modal here would be the
  // wrong ARIA shape once it's stacked under the overflow popover's own
  // aria-modal.
  const dialogProps = useOverlayA11y({
    open,
    onClose: () => setOpen(false),
    containerRef: popoverRef,
    modal: false,
  });

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [open]);

  const resolved = resolveTaskCreds(settings, "detect");
  const model = shortModelName(resolved.model);
  const health = deriveHealthStatus(detectStat);
  // F2 fix round (HIGH): 未配置 used to key on resolved.apiKey ALONE —
  // but on the Next.js transport path the SERVER may hold its own
  // funded key (preview tier's shared trial key, or a full-tier
  // server-side key) and subscription-direct works keyless too, so a
  // missing CLIENT key doesn't mean the call can't succeed there.
  // useDirectTransport (client.ts) is the exact gate every *Api call
  // site already uses to decide direct-vs-/api/* for this same
  // resolved cred — 未配置 is honest only when THIS call would actually
  // skip /api/* (desktop, or preview tier with a key — which can't
  // co-occur with "no key"). When the Next path would serve instead,
  // show the model name; its own health glyph (below) tells the truth
  // about whether it's actually succeeding.
  const direct = useDirectTransport(resolved);
  const unconfigured = detectMode === "llm" && direct && !resolved.apiKey;
  // TRUTH: what's actually running, not what's merely configured —
  // dictionary/off never call the model above regardless of what's
  // configured; llm with no resolved key (and no server fallback to
  // catch it) doesn't either.
  const runningLabel =
    detectMode === "off"
      ? DETECT_MODE_LABEL.off
      : detectMode === "dictionary"
        ? AI_STATUS_CHIP_DICT_LABEL
        : unconfigured
          ? AI_STATUS_CHIP_UNCONFIGURED_LABEL
          : model;
  // F10 fix round (MEDIUM): the ✓/✗ telemetry glyph used to render
  // regardless of runningLabel — an OLD failure recorded while llm mode
  // was active stayed "✗" even after switching to 词典 mode (which never
  // calls the model at all), reading as "dictionary is failing" when
  // nothing dictionary-related ever ran. A glyph is only ever earned
  // while a real model name is shown.
  const showingModel = detectMode === "llm" && !unconfigured;
  const glyph = showingModel ? AI_STATUS_CHIP_GLYPH[health] : undefined;
  // Compact (phone-width) variant additionally drops the neutral "…"
  // glyph (reads as a truncation artifact there, not a status — see the
  // span below); ok "✓"/fail "✗" still show, both unambiguous at a glance.
  const compactGlyph = glyph && health !== "neutral" ? glyph : undefined;

  return (
    <div ref={rootRef} className="relative flex h-full items-center">
      <button
        type="button"
        data-testid="statusline-ai-status-chip"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="AI 状态"
        className={`flex h-full items-center whitespace-nowrap px-2 hover:bg-panel3 hover:text-fg sm:px-3 ${unconfigured ? "text-warn-soft" : ""}`}
      >
        <span className="hidden sm:inline">
          {AI_STATUS_CHIP_DOMAIN_LABEL} · {runningLabel}
          {glyph ? ` ${glyph}` : ""}
        </span>
        {/* Compact (phone-width) variant — see compactGlyph above. */}
        <span className="sm:hidden">
          {compactGlyph ? `${AI_STATUS_CHIP_DOMAIN_LABEL} ${compactGlyph}` : AI_STATUS_CHIP_DOMAIN_LABEL}
        </span>
      </button>
      {open && (
        <div
          ref={popoverRef}
          {...dialogProps}
          data-testid="statusline-ai-status-popover"
          // S14.1 field fix (item 4): the ORIGINAL absolute/left-0/w-72
          // anchors the popover to THIS chip's own left edge — fine on
          // desktop, but the chip sits well right of the viewport's own
          // left edge (mode chip + detect toggle precede it), so a
          // fixed 288px-wide box extending further right from there
          // overflowed a 390px phone screen and got cropped by the
          // page's own overflow-hidden root (no way to scroll to the
          // clipped part). Below sm: `fixed` + small viewport-relative
          // margins (inset-x-2) instead — anchored to the VIEWPORT, not
          // this chip's arbitrary x-position, so it can never overflow
          // regardless of where the chip renders; max-h-[60vh] +
          // overflow-y-auto give it internal scroll if the 4 rows (esp.
          // with a failure explanation line, see AiStatusPanel.tsx)
          // are taller than the space above the bar. sm+ (tablet/
          // desktop, where this was never reported broken): reverts to
          // the exact original chip-anchored box, untouched.
          // bottom offset rides the safe-area inset (iOS-cloud round,
          // Sol F3): the bar sits 34pt higher on a full-bleed iOS
          // webview (page.tsx's spacer), so a plain bottom-8 would
          // cover its controls; env() is 0 elsewhere (identical to the
          // old bottom-8).
          className="scroll-thin fixed inset-x-2 bottom-[calc(2rem+env(safe-area-inset-bottom))] z-30 max-h-[60vh] overflow-y-auto border border-edge bg-panel2 glassable p-3 shadow-lg sm:absolute sm:inset-x-auto sm:bottom-[calc(100%+4px)] sm:left-0 sm:w-72 sm:max-h-none sm:overflow-visible"
        >
          <AiStatusPanel />
        </div>
      )}
    </div>
  );
}

// Translation-rework wave 2: 翻译 status chip, immediately right of
// AiStatusChip. Drives off settings.bilingualTranscript (whether the
// live queue is even asked to translate) AND store.translateStatus
// (the queue's own live state — no writer yet as of this lane; wave 2
// wires TranslateQueue to actually call setTranslateStatus, this chip
// just renders whatever it reports). A bare `useApp((s) => s.
// translateStatus)` read is safe per that field's own store.ts doc
// comment (no derived object here, so no useShallow needed).
//
// "off" (bilingualTranscript itself disabled) is the one INTERACTIVE
// state — mirrors the detect-mode toggle immediately to its left
// exactly: a single plain-text button, no compact/full split (its own
// label is already short enough at every width), dim/inactive styling,
// flips the setting on click. The three states that only apply once
// bilingualTranscript is already on (busy/done/stalled) are passive
// status text instead — same hidden-sm:inline / sm:hidden compact-glyph
// split AiStatusChip's own two spans use.
function TranslateStatusChip() {
  // Full settings (not a single-field selector) — the tap-to-enable
  // guard below needs langPairFromSettings' own source+target read,
  // same "whole settings object" posture AiStatusChip already uses.
  const settings = useApp((s) => s.settings);
  const bilingualTranscript = settings.bilingualTranscript;
  const translateStatus = useApp((s) => s.translateStatus);
  const updateSettings = useApp((s) => s.updateSettings);
  const showToast = useApp((s) => s.showToast);

  if (!bilingualTranscript) {
    return (
      <button
        type="button"
        data-testid="statusline-translate-chip"
        onClick={() => {
          // Fix round (MEDIUM): an en->en pair has nothing to
          // translate — flipping the toggle on would just enable a
          // queue that never lands anything (store.updateSettings
          // itself forces it back off for this exact pair, see its own
          // doc comment). Tell the user why instead of silently no-op.
          const pair = langPairFromSettings(settings);
          if (pair.source === pair.target) {
            showToast("解释语言为英文时无需翻译");
            return;
          }
          updateSettings({ bilingualTranscript: true });
        }}
        title="点击开启双语转录"
        className="flex h-full items-center whitespace-nowrap px-2 text-mut hover:bg-panel3 hover:text-fg sm:px-3"
      >
        未译
      </button>
    );
  }

  if (translateStatus.state === "stalled") {
    return (
      <span
        data-testid="statusline-translate-chip"
        title={translateStatus.reason}
        className="flex h-full items-center whitespace-nowrap px-2 text-lab-yellow sm:px-3"
      >
        翻译暂停
      </span>
    );
  }

  // FT-11 fix: a distinct terminal state from "stalled" above — a
  // merely-paused lane self-heals and eventually shows busy/done again,
  // but a lane that has failed every batch this meeting just oscillates
  // stalled<->busy forever, reading as "working, occasionally
  // hiccuping" rather than the truth (see queue.ts's own onState doc
  // for the hysteresis this state is gated on). Byte-for-byte the same
  // structure as 翻译暂停 above — same styling, same testid, same title
  // wiring — this app's flat-design law invents no new visual
  // vocabulary for a fifth state. Sticky: queue.ts's own emitState()
  // checks "dead" BEFORE busy/stalled/done, so a later retry's busy
  // emission never overrides it — this chip only ever leaves 翻译失败
  // once a translation actually lands.
  if (translateStatus.state === "dead") {
    return (
      <span
        data-testid="statusline-translate-chip"
        title={translateStatus.reason}
        className="flex h-full items-center whitespace-nowrap px-2 text-lab-yellow sm:px-3"
      >
        翻译失败
      </span>
    );
  }

  if (translateStatus.state === "busy") {
    return (
      <span
        data-testid="statusline-translate-chip"
        className="flex h-full items-center whitespace-nowrap px-2 sm:px-3"
      >
        翻译中… {translateStatus.pending}
      </span>
    );
  }

  if (translateStatus.state === "off") {
    // Fix round (MEDIUM): bilingualTranscript is on but the queue
    // hasn't landed anything yet (e.g. before the first batch) — this
    // is "enabled, nothing translated yet", not a false claim of
    // success. Neutral/dim, no checkmark, no click handler (unlike the
    // off-toggle button above, this state is already on).
    return (
      <span
        data-testid="statusline-translate-chip"
        className="flex h-full items-center whitespace-nowrap px-2 text-mut sm:px-3"
      >
        翻译
      </span>
    );
  }

  // "done" only — at least one translation has actually landed.
  return (
    <span
      data-testid="statusline-translate-chip"
      className="flex h-full items-center whitespace-nowrap px-2 sm:px-3"
    >
      翻译 ✓
    </span>
  );
}

// Lane W (mid-session STT liveness watchdog + per-channel silence hint,
// lib/stt/audioLiveness.ts) — zh channel labels for this chip's title
// only (a static "我方/对方" pairing, distinct from store.ts's own
// speakerAliases display names); "default" (every whisper-family
// engine, single-lane) carries no channel prefix at all.
const LIVENESS_CHANNEL_LABEL: Record<AudioChannel, string> = { mic: "我方声道", system: "对方声道", default: "" };
// WATCHDOG_WALL_FLOOR_MS is 90_000 (1.5min) — rounded UP for the title's
// copy so it never understates how long this has actually been going on.
const LIVENESS_WATCHDOG_MINUTES = Math.ceil(WATCHDOG_WALL_FLOOR_MS / 60_000);

// Same flat-design law as TranslateStatusChip's own 翻译失败 comment
// above: no new visual vocabulary. Warning verdicts (watchdog/statsStale)
// share the SAME text-lab-yellow styling every other warning chip in
// this bar already uses; the info-only verdict (silentChannel) gets
// neutral/muted styling instead — a seminar where the user legitimately
// never speaks must never read as a warning. Rendered from TWO mount
// points (StatusLine's own sm:flex group + OverflowChip's <sm popover),
// same dual-surface pattern as TranslateStatusChip — this component is
// pure rendering only; the one-shot notice/re-arm side effect lives
// ONCE, in the default-exported StatusLine below, so mounting this twice
// can never double-toast.
function LivenessChip() {
  const armed = useAudioLiveness((s) => s.armed);
  const verdicts = useAudioLiveness((s) => s.verdicts);
  const isListening = useApp((s) => s.status === "listening");

  if (!armed || !isListening) return null;

  const warning = verdicts.statsStale || verdicts.watchdogChannels.length > 0;
  if (!warning && verdicts.silentChannels.length === 0) return null;

  if (warning) {
    const title = verdicts.statsStale
      ? "音频统计中断，转写管线可能已停止"
      : verdicts.watchdogChannels
          .map((c) => {
            const prefix = LIVENESS_CHANNEL_LABEL[c] ? `${LIVENESS_CHANNEL_LABEL[c]}：` : "";
            return `${prefix}有声音但 ${LIVENESS_WATCHDOG_MINUTES} 分钟无转写`;
          })
          .join("；");
    return (
      <span
        data-testid="statusline-liveness-chip"
        title={title}
        className="flex h-full items-center whitespace-nowrap px-2 text-lab-yellow sm:px-3"
      >
        转写停滞
      </span>
    );
  }

  const title = `${verdicts.silentChannels.map((c) => LIVENESS_CHANNEL_LABEL[c]).join("、")}开场至今未检测到声音——检查麦克风输入，或忽略（本场不发言）`;
  return (
    <span
      data-testid="statusline-liveness-chip"
      title={title}
      className="flex h-full items-center whitespace-nowrap px-2 text-mut sm:px-3"
    >
      单路无声
    </span>
  );
}

// TASK 2 (privacy visible at every breakpoint): the color-coded privacy
// SENTENCE below (privacyCopy.hint) is `hidden sm:inline` — this app's
// one privacy promise must never fully disappear below that width. This
// compact chip is its <sm replacement, reading the SAME RETENTION_COPY
// table (lib/stt/engineOptions.ts) the sentence right next to it already
// does. F7 fix round (MEDIUM): this used to collapse to the binary
// local/cloud posture (derivePosture + POSTURE_LABEL) — a cloud-STORED
// engine (ElevenLabs, 可能留存) then read identically to a cloud-
// TRANSIENT one on phones, losing its stronger warning exactly where a
// BYOK phone user is most likely to be looking. No tap-to-expand
// popover: aria-label + title already carry the full sentence for both
// mouse hover and screen readers, and a second popover mechanism for
// one static line has no real payoff over the sentence itself being
// back at sm+.
function PrivacyPostureChip({
  retentionClass,
  sentence,
}: {
  retentionClass: RetentionClass;
  sentence: string;
}) {
  const copy = RETENTION_COPY[retentionClass];
  return (
    <span
      data-testid="statusline-privacy-chip"
      aria-label={sentence}
      title={sentence}
      // F5 budget (below sm): no more fixed w-9 — 云端·可能留存 (7 CJK-
      // width glyphs) can't fit a 36px box. Content-sized with a
      // slimmer px-0.5 instead; see the row-width budget comment above
      // StatusLine's own return for the worst-case pixel accounting.
      className={`flex h-full shrink-0 items-center justify-center whitespace-nowrap px-0.5 font-bold sm:hidden ${copy.textClass}`}
    >
      {copy.label}
    </span>
  );
}

// TASK 4 (D2 fold, <sm only): DetectModeChip + AiStatusChip +
// TranslateStatusChip have no room at phone widths (the S14 field-fix
// history further up this file already documents this exact trio eating
// past a 375px viewport on its own) — this one square "⋯" chip replaces
// them below sm; ≥sm keeps rendering the same three inline, unchanged
// (see the sm:flex group in StatusLine's own return below). The popover
// stacks the SAME three components — no forked copy of their logic —
// mounted only while open, mirroring AiStatusChip's own on-demand
// AiStatusPanel mount just above.
function OverflowChip() {
  const status = useApp((s) => s.status);
  const segments = useApp((s) => s.segments);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // F4 fix round (HIGH): routed through useOverlayA11y — containerRef on
  // the popover panel itself, onClose closes it, and focus returns to
  // this ⋯ trigger via the hook's own restore-on-close (it's whatever
  // was document.activeElement right before `open` flips true, i.e. the
  // trigger the user just clicked). Modal (default): this is the
  // OUTERMOST overlay when open below sm, so aria-modal is correct here
  // — AiStatusChip's own NESTED popover is the one that opts out (modal:
  // false) once stacked inside this one.
  const dialogProps = useOverlayA11y({
    open,
    onClose: () => setOpen(false),
    containerRef: popoverRef,
  });

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative flex h-full sm:hidden">
      <button
        type="button"
        data-testid="statusline-overflow-chip"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="更多状态"
        title="更多状态"
        className="flex h-full w-9 shrink-0 items-center justify-center hover:bg-panel3 hover:text-fg"
      >
        ⋯
      </button>
      {open && (
        <div
          ref={popoverRef}
          {...dialogProps}
          data-testid="statusline-overflow-popover"
          className="scroll-thin fixed inset-x-2 bottom-[calc(2rem+env(safe-area-inset-bottom))] z-30 flex max-h-[60vh] flex-col gap-2 overflow-y-auto border border-edge bg-panel2 glassable p-3 shadow-lg"
        >
          <DetectModeChip />
          <AiStatusChip />
          {(status !== "idle" || segments.length > 0) && <TranslateStatusChip />}
          <LivenessChip />
        </div>
      )}
    </div>
  );
}

export interface StatusLineProps {
  onOpenTaskCenter: () => void;
}

export default function StatusLine({ onOpenTaskCenter }: StatusLineProps) {
  const status = useApp((s) => s.status);
  const segments = useApp((s) => s.segments);
  const cards = useApp((s) => s.cards);
  const terms = useApp((s) => s.terms);
  const engine = useApp((s) => s.settings.engine);
  const sttEngineMode = useApp((s) => s.sttEngineMode);
  const sidecarMode = useApp((s) => s.settings.sidecarMode);
  const sidecarUp = useApp((s) => s.sidecarUp);
  const lagMs = useLatencyStats((s) => s.lagMs);
  // S10 field-fix #8 (LOW, adversarial review): the ON/OFF hysteresis
  // (3 consecutive smoothed samples >2000ms to show, one sample
  // <1200ms to hide, holds through the dead zone otherwise — see
  // latencyStats.ts's own sustained doc comment) lives entirely in
  // latencyStats.ts; this component just reads the derived flag.
  const latencySustained = useLatencyStats((s) => s.sustained);
  // Lane W (mid-session STT liveness watchdog): read here (not inside
  // LivenessChip, which mounts TWICE — the sm:flex group AND
  // OverflowChip's <sm popover) so the one-shot notice/re-arm effect
  // below fires exactly once per activation, never doubled.
  const livenessArmed = useAudioLiveness((s) => s.armed);
  const livenessVerdicts = useAudioLiveness((s) => s.verdicts);
  const showToast = useApp((s) => s.showToast);

  const isListening = status === "listening";
  const isPaused = status === "paused";
  const modeLabel =
    status === "listening"
      ? "-- LISTENING --"
      : status === "paused"
        ? "-- PAUSED --"
        : status === "stopped"
          ? "-- STOPPED --"
          : status === "connecting"
            ? "-- CONNECTING --"
            : "-- IDLE --";
  // Short vim-token variant for phone widths — the full form plus the
  // privacy sentence pushed Bit's perch clear off a 375px screen
  // (Miana's v0.2.2 E2E finding: mascot missing, "N cards" clipped).
  const modeLabelShort =
    status === "listening"
      ? "--LIVE--"
      : status === "paused"
        ? "--PAUS--"
        : status === "stopped"
          ? "--STOP--"
          : status === "connecting"
            ? "--CONN--"
            : "--IDLE--";

  // Lane W: one-shot notice + re-arm, mirroring wsTransport.ts's own
  // flap-notice shape (lastNoticeAt null until the first firing, then
  // re-armed no more often than RENOTICE_INTERVAL_MS) — diagLog + toast
  // fire once per activation, reset the moment the warning clears (a
  // LATER, separate stall gets its own first notice again). Runs off
  // `livenessVerdicts`'s own object identity, which changes on every
  // push/noteResult/sentinel recompute while armed (~5-15s cadence),
  // giving this frequent-enough wall-clock checks without its own timer.
  // Info-only (silentChannel) never toasts — see LivenessChip's own "no
  // new visual vocabulary" doc comment for why that one stays quiet.
  const livenessNoticeAtRef = useRef<number | null>(null);
  useEffect(() => {
    const warningActive =
      isListening &&
      livenessArmed &&
      (livenessVerdicts.statsStale || livenessVerdicts.watchdogChannels.length > 0);
    if (!warningActive) {
      livenessNoticeAtRef.current = null;
      return;
    }
    const now = Date.now();
    if (
      livenessNoticeAtRef.current === null ||
      now - livenessNoticeAtRef.current >= RENOTICE_INTERVAL_MS
    ) {
      livenessNoticeAtRef.current = now;
      diagLog(
        "warn",
        "stt-liveness",
        "转写疑似停滞——有声音但持续无转写结果",
        `watchdogChannels=${livenessVerdicts.watchdogChannels.join(",")} statsStale=${livenessVerdicts.statsStale}`,
      );
      showToast("转写疑似停滞：有声音但持续无转写结果。可尝试暂停后继续，或结束会话保存已有内容。");
    }
  }, [isListening, livenessArmed, livenessVerdicts, showToast]);

  // v0.4.7 Lane C (tri-state privacy label, doc §4/§9 D5-D7): posture's
  // richer replacement. resolveEngineRetentionClass (lib/stt/
  // engineOptions.ts) is the ONE shared place StatusLine and Header's
  // EnginePostureChip both resolve this, so the two surfaces can never
  // disagree — it already folds in everything this used to compute
  // inline: "demo" hard-pinned local (no audio exists at all — the
  // amber cloud warning would be a false claim in the OTHER direction),
  // an engine absent from ENGINE_OPTIONS never assumed local, and the
  // on-device Web Speech runtime overlay (Chrome 139+ `processLocally`,
  // store.sttEngineMode written by useMeeting.ts's onEngineMode
  // handler — belt-and-suspenders guarded on engine==="webspeech" so a
  // stale value can't survive an engine switch).
  const retentionClass = resolveEngineRetentionClass(engine, sttEngineMode);
  const privacyCopy = RETENTION_COPY[retentionClass];
  // Sidecar-down hint (owner ask 2026-07-11): the selected engine needs
  // the local sidecar, nothing is currently running (an active meeting
  // already proves the engine works — never override a live/paused
  // status with a stale probe result), and the last known probe (see
  // SettingsDialog's 转录引擎 status line, lib/stt/sidecarHealth.ts)
  // failed. v1 deliberately stays tooltip-only — no new always-on chip
  // in an already-crowded status bar; see setSidecarUp's own doc.
  //
  // v0.4 S3 chunk 7: on a desktop build, the wording additionally
  // reflects 托管模式 (settings.sidecarMode) — 本地服务·托管 (the app
  // itself manages the sidecar, see lib/desktop/bootstrap.ts) vs
  // 本地服务·外部 (today's manual-install behavior) — reusing this same
  // sidecarUp plumbing, no new probe/state added. Web build copy is
  // byte-identical to before (sidecarMode is meaningless there).
  const sidecarDownHint =
    (engine === "whisper" || engine === "tabaudio" || engine === "appaudio") &&
    status === "idle" &&
    sidecarUp === false
      ? IS_DESKTOP
        ? `本地服务·${sidecarMode === "managed" ? "托管" : "外部"}未连接——见 设置 → 转录引擎`
        : SIDECAR_DOWN_HINT_WEB
      : undefined;

  const count = cards.length + terms.length;

  // F5 fix round (HIGH): below-sm row-width budget. With an active
  // TaskTray + long engine labels this row used to exceed 375px (the
  // page's own overflow-hidden root then just clips whatever falls off
  // the right edge — TaskTray, the last/ml-auto element, is the first
  // casualty). Worst-case sum of every element visible below sm, at
  // text-xs/font-mono (≈7px per ASCII glyph — SF Mono's ~0.6em advance;
  // ≈12px per CJK glyph — full-width East Asian glyphs render at a full
  // 1em, not the ASCII ratio):
  //   mode block   "--LIVE--" (8 ascii) + px-2×2         ≈  72px
  //   ⋯ trigger    w-9 fixed                              =  36px
  //   |            1 glyph, no padding                    ≈   7px
  //   privacy chip "云端·可能留存" (7 CJK, F7) + px-0.5×2  ≈  90px
  //   音源 select  max-w-[7rem] hard cap                  = 112px
  //   引擎 select  max-w-[8.5rem] hard cap                = 136px
  //   延迟 chip    "延迟 ~15s" (listening only) + px-2×2   ≈  80px
  //   TaskTray     icon+gap+2-digit count + px-2×2        ≈  48px
  // idle/paused/stopped/connecting (no 延迟 chip): ≈501px.
  // listening + sustained lag (延迟 chip shown):   ≈581px.
  // The two hard-capped selects alone already claim 248px — this fix's
  // real, bounded lever — down from an unbounded worst case before any
  // cap existed. Neither total clears a literal 320px floor (eight
  // required elements, two of them multi-rem selects, simply can't fit
  // that narrow at once), so 320px stays the aspirational target these
  // two cap values were sized against; TaskTray staying the LAST element
  // (not shrink-0) means it degrades by losing its own padding first,
  // not by vanishing off-screen the way it could pre-fix.
  return (
    <div
      data-testid="statusline"
      className="flex h-9 shrink-0 items-center border-t border-edge bg-panel2 font-mono text-xs text-mut sm:h-7"
    >
      {/* TASK 3 root cause (mode block clipping mid-token at 375px): this
          span was the one major status chip in this row WITHOUT
          shrink-0 (every other leading segment — AudioSourceDropdown,
          EngineDropdown — already carries it defensively). Nested
          flex-in-flex (this span is itself `flex`, wrapping two
          complementary hidden/sm:hidden label spans) plus a crowded
          375px row is exactly the shape where a flex item's automatic
          minimum-size flooring is least reliable cross-browser —
          shrink-0 removes the ambiguity outright instead of relying on
          it. role="status" (implicit aria-live="polite") so a screen
          reader announces LISTENING/PAUSED/STOPPED/IDLE transitions. */}
      <span
        role="status"
        className={`flex h-full shrink-0 items-center whitespace-nowrap px-2 font-bold tracking-wide sm:px-3 ${
          isListening
            ? "bg-lab-green text-ink"
            : isPaused
              ? "bg-lab-orange text-ink"
              : "bg-mut text-ink"
        }`}
      >
        <span className="hidden sm:inline">{modeLabel}</span>
        <span className="sm:hidden">{modeLabelShort}</span>
      </span>
      {/* TASK 4 (D2 fold): this exact trio, byte-identical to before the
          fold, now only at sm+ — <sm it's replaced by the one
          OverflowChip immediately below (its own popover renders the
          SAME three components). */}
      <span className="hidden h-full items-center sm:flex" data-testid="statusline-detect-group">
        <DetectModeChip />
        <span className="text-mut2">|</span>
        <AiStatusChip />
        {/* Translation-rework wave 2: same "visible whenever there's a
            transcript to plausibly translate" gate as the rest of this
            bar's transcript-scoped chips — a live/connecting meeting, OR
            segments already on screen from one that just ended. */}
        {(status !== "idle" || segments.length > 0) && <TranslateStatusChip />}
        <LivenessChip />
      </span>
      <OverflowChip />
      <span className="text-mut2">|</span>
      {/* S14 mobile-preview field-fix: at 375px this segment's own
          neighbors (mode chip, detect toggle, AI status chip, engine
          dropdown) already eat past the viewport width on their own,
          leaving no room for the privacy sentence to truncate into —
          hidden below sm, unchanged at sm+. TASK 2: the sentence must
          never be the ONLY carrier of this bar's privacy promise below
          sm though — PrivacyPostureChip (sm:hidden) replaces it there. */}
      <span
        title={sidecarDownHint}
        className={`hidden min-w-0 truncate px-2 sm:inline sm:px-3 ${privacyCopy.textClass}`}
      >
        {privacyCopy.hint}
      </span>
      <PrivacyPostureChip retentionClass={retentionClass} sentence={privacyCopy.hint} />
      {/* Audio source stays reachable even after ModeSelector's idle-only
          overlay disappears. The native option itself carries the honest
          system-audio/mic caveat; this does not invent a capture state. */}
      <AudioSourceDropdown />
      {/* Recognizer picker, grouped by ENGINE_CAPABILITIES.family. */}
      <EngineDropdown />
      {/* S10 field-fix #5/#8: compact caution chip, hidden whenever
          healthy/null/not-listening/not-local-whisper/not-yet-sustained
          — latencySustained already carries the hysteresis (this
          component adds no threshold of its own). */}
      {isListening && LOCAL_WHISPER_ENGINES.has(engine) && lagMs !== null && latencySustained && (
        <span
          data-testid="statusline-latency-chip"
          className="flex h-full items-center whitespace-nowrap px-2 text-lab-yellow sm:px-3"
        >
          延迟 ~{Math.round(lagMs / 1000)}s
        </span>
      )}
      {/* count hidden <sm: it also lives in the cards tab header. */}
      <span className="ml-auto hidden whitespace-nowrap px-3 tabular-nums sm:inline">
        {count} cards
      </span>
      {/* #58 review fix 1: unlike the count span above, the task tray
          is reachable at every width — it's the only in-app surface
          for import progress/errors on mobile (the drawer's own inline
          job rows require opening 历史 first), so it stays visible
          below sm too; TaskTray itself keeps its own compact-chip
          discipline (icon+count, sm:hidden icon). S10: its own popover
          is gone — onOpen (threaded from page.tsx) now opens
          TaskCenterDrawer instead, the same drawer a desktop Header
          launcher will open in wave 2.
          Bit mascot behavior train: this span inherits the retired
          mascot perch's own ml-auto/sm:ml-0 pair verbatim (TaskTray is
          now the bar's last element) — below sm the count span above
          is hidden, so without this push TaskTray would sit left-packed
          right after the engine dropdown/latency chip instead of using
          the freed phone-width pixels; at sm+ the count's own ml-auto
          already does the pushing, so sm:ml-0 just cancels the
          duplicate margin. */}
      <span className="ml-auto flex h-full items-center sm:ml-0">
        <TaskTray onOpen={onOpenTaskCenter} />
      </span>
    </div>
  );
}
