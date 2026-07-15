"use client";

// v3 主题基座 vim 状态线 (docs/DESIGN.md v3.3): bottom bar mounted below
// <main> in page.tsx. Left = inverted status block reading store
// status; middle = detect mode + audio-privacy sentence; right =
// {cards+terms} counter, then the mascot perch where Bit the pixel
// dragon lives (overflow-visible so it stands taller than the bar).

import { useApp } from "@/lib/store";
import { IS_DESKTOP } from "@/lib/platform/desktop";
import { useLatencyStats } from "@/lib/stt/latencyStats";
import { ENGINE_OPTIONS, engineOptionGate, useAudiocapCaps } from "@/lib/stt/engineOptions";
import { useOsSpeechCaps } from "@/lib/desktop/osspeechCaps";
import { isEngineControlBusy } from "@/components/Header";
import PixelDragon from "@/components/PixelDragon";
import TaskTray from "@/components/TaskTray";

const DETECT_MODE_LABEL: Record<string, string> = {
  llm: "词典+AI 检测",
  dictionary: "词典检测",
  off: "检测关闭",
};

// S10 field-fix #5: engines whose transcription actually flows through
// wsTransport.ts (the ONE lag_ms producer, via the local Whisper
// sidecar) — mirrors sidecarDownHint's own identical three-way gate
// just below, which already established "these are the sidecar-backed
// engines" for this exact file.
const LOCAL_WHISPER_ENGINES = new Set(["whisper", "tabaudio", "appaudio"]);

// S10 field-fix — engine picker as a bottom-bar dropdown (Miana's
// explicit ask: 与其作为tab，engine不如改成dropdown，且显示在下方状态栏).
// Native <select>, same house terminal aesthetic + handler semantics as
// Header.tsx's pre-S10 mobile <select> variant it replaces (0px radius,
// mono, border-edge, bg-panel2; same store write on change; same
// disabled-while-meeting-active gate, isEngineControlBusy — reused
// verbatim rather than re-implemented, still exported from Header.tsx).
// Per-<option> gating (engineOptionGate, lib/stt/engineOptions.ts) is
// the same preview-tier/macOS-floor policy every other engine surface
// shares. The SELECT's own `title` additionally carries the CURRENTLY
// SELECTED option's own lock reason (if any) — a per-<option> title is
// only ever visible while the dropdown is actually open; the closed
// control needs its own tooltip for a locked selection to be
// explorable at all.
function EngineDropdown() {
  const engine = useApp((s) => s.settings.engine);
  const status = useApp((s) => s.status);
  const updateSettings = useApp((s) => s.updateSettings);
  const disabled = isEngineControlBusy(status);
  const audiocapCaps = useAudiocapCaps();
  // Lead integration fix (S11): without the caps arg the osspeech option
  // would render enabled on macOS <26 and only fail at start_os_speech's
  // runtime recheck — pass it so the option locks with a reason, same
  // posture as the appaudio floor gate.
  const osspeechCaps = useOsSpeechCaps();
  const selectedOpt = ENGINE_OPTIONS.find((o) => o.value === engine);
  const selectedGate = selectedOpt ? engineOptionGate(selectedOpt, audiocapCaps, osspeechCaps) : undefined;

  return (
    <select
      aria-label="转录引擎"
      data-testid="statusline-engine-select"
      disabled={disabled}
      title={selectedGate?.title}
      value={engine === "demo" || engine === "import" ? "" : engine}
      onChange={(e) => {
        const v = e.target.value as (typeof ENGINE_OPTIONS)[number]["value"] | "";
        if (v) updateSettings({ engine: v });
      }}
      className="h-full max-w-[6.5rem] shrink-0 border-x border-edge bg-panel2 px-1.5 font-mono text-fg disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-[8.5rem] sm:px-2"
    >
      {(engine === "demo" || engine === "import") && (
        <option value="" disabled>
          选择引擎
        </option>
      )}
      {ENGINE_OPTIONS.map((opt) => {
        const gate = engineOptionGate(opt, audiocapCaps, osspeechCaps);
        return (
          <option key={opt.value} value={opt.value} disabled={gate.disabled} title={gate.title}>
            {opt.label}
          </option>
        );
      })}
    </select>
  );
}

export interface StatusLineProps {
  onOpenTaskCenter: () => void;
}

export default function StatusLine({ onOpenTaskCenter }: StatusLineProps) {
  const status = useApp((s) => s.status);
  const cards = useApp((s) => s.cards);
  const terms = useApp((s) => s.terms);
  const detectMode = useApp((s) => s.detectMode);
  const engine = useApp((s) => s.settings.engine);
  const sttEngineMode = useApp((s) => s.sttEngineMode);
  const aiDetect = useApp((s) => s.settings.aiDetect);
  const sidecarMode = useApp((s) => s.settings.sidecarMode);
  const sidecarUp = useApp((s) => s.sidecarUp);
  const updateSettings = useApp((s) => s.updateSettings);
  const setDetectMode = useApp((s) => s.setDetectMode);
  const lagMs = useLatencyStats((s) => s.lagMs);
  // S10 field-fix #8 (LOW, adversarial review): the ON/OFF hysteresis
  // (3 consecutive smoothed samples >2000ms to show, one sample
  // <1200ms to hide, holds through the dead zone otherwise — see
  // latencyStats.ts's own sustained doc comment) lives entirely in
  // latencyStats.ts; this component just reads the derived flag.
  const latencySustained = useLatencyStats((s) => s.sustained);

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

  // On-device Web Speech (Chrome 139+, `processLocally` — see
  // docs/research/stt-live-engines-2026-07.md item #1): when the
  // ACTIVE webspeech session reported "on-device" (store.sttEngineMode,
  // written by useMeeting.ts's onEngineMode handler), audio never
  // leaves this machine either — same green posture as whisper/
  // tabaudio, reusing their exact copy/token below verbatim rather
  // than adding a third label. Guarded on engine==="webspeech" too
  // (belt-and-suspenders against a stale value briefly surviving an
  // engine switch — sttEngineMode is only ever set by the webspeech
  // engine and reset at the start of every new meeting).
  // S10 field-fix #2 (HIGH, adversarial review): posture derives from
  // ENGINE_OPTIONS (the same option metadata the dropdown below and
  // Header's EnginePostureChip already read — one definition, not a
  // second map that can drift out of sync, which is exactly how a
  // CLOUD engine (soniox) used to render the green local sentence via
  // a stale ?? "local" fallback here). An engine absent from
  // ENGINE_OPTIONS (import/browser-whisper, or any future value) must
  // never be assumed local — falls back to "cloud". One deliberate
  // exception (lead adjudication on the F2 fix's flagged side effect):
  // "demo" is the scripted preview — no audio exists at all, so the
  // amber cloud warning would be a false claim in the OTHER direction;
  // it keeps the local posture the old map always gave it.
  const posture: "local" | "cloud" =
    engine === "demo" || (engine === "webspeech" && sttEngineMode === "on-device")
      ? "local"
      : (ENGINE_OPTIONS.find((o) => o.value === engine)?.posture ?? "cloud");
  const privacyLabel =
    posture === "local" ? "音频在本地处理" : "音频将经过浏览器厂商云端识别";
  const privacyLabelShort =
    posture === "local" ? "音频在本地处理" : "音频将经厂商云端";
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
        : "本地 Whisper sidecar 未连接——见 设置 → 转录引擎"
      : undefined;

  const count = cards.length + terms.length;

  return (
    <div
      data-testid="statusline"
      className="flex h-7 shrink-0 items-center border-t border-edge bg-panel2 font-mono text-xs text-mut"
    >
      <span
        className={`flex h-full items-center whitespace-nowrap px-2 font-bold tracking-wide sm:px-3 ${
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
      {detectMode === "off" ? (
        <span className="whitespace-nowrap px-2 sm:px-3">
          {DETECT_MODE_LABEL.off}
        </span>
      ) : (
        // Clickable (E2E feedback): flips settings.aiDetect. The label
        // derives from detectMode (the scheduler's runtime state, see
        // detect/scheduler.ts), which the scheduler only re-reads on its
        // next segment/batch — so the click ALSO echoes the expected
        // mode synchronously, or an idle meeting would show a dead
        // button. The scheduler's own onModeChange remains authoritative
        // and corrects the echo if reality differs (e.g. key-less
        // fallback downgrades llm back to dictionary).
        <button
          type="button"
          data-testid="statusline-detect-toggle"
          onClick={() => {
            const next = !aiDetect;
            updateSettings({ aiDetect: next });
            setDetectMode(next ? "llm" : "dictionary");
          }}
          title="点击切换 AI 检测（词典检测始终开启）"
          className="flex h-full items-center whitespace-nowrap px-2 hover:bg-panel3 hover:text-fg sm:px-3"
        >
          {DETECT_MODE_LABEL[detectMode]}
        </button>
      )}
      <span className="text-mut2">|</span>
      <span
        title={sidecarDownHint}
        className={`min-w-0 truncate px-2 sm:px-3 ${
          posture === "local" ? "text-lab-green" : "text-warn-soft"
        }`}
      >
        <span className="hidden sm:inline">{privacyLabel}</span>
        <span className="sm:hidden">{privacyLabelShort}</span>
      </span>
      {/* Engine dropdown (S10 field-fix wave 2, EngineDropdown above):
          right here, between the privacy segment and the latency chip,
          reads most naturally (STT posture/health cluster together
          left-to-right) — THE picker at every width now (Header.tsx's
          old desktop pills + mobile <select> are both gone). */}
      <EngineDropdown />
      {/* S10 field-fix #5/#8: compact caution chip, hidden whenever
          healthy/null/not-listening/not-local-whisper/not-yet-sustained
          — latencySustained already carries the hysteresis (this
          component adds no threshold of its own). */}
      {isListening && LOCAL_WHISPER_ENGINES.has(engine) && lagMs !== null && latencySustained && (
        <span
          data-testid="statusline-latency-chip"
          className="whitespace-nowrap px-2 text-lab-yellow sm:px-3"
        >
          延迟 ~{Math.round(lagMs / 1000)}s
        </span>
      )}
      {/* count hidden <sm: it also lives in the cards tab header, and
          Bit outranks it for the remaining phone-width pixels. */}
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
          launcher will open in wave 2. */}
      <span className="flex h-full items-center">
        <TaskTray onOpen={onOpenTaskCenter} />
      </span>
      <span
        id="mascot-perch"
        data-slot="mascot"
        className="relative ml-auto flex h-10 shrink-0 items-end self-end overflow-visible pr-2 sm:ml-0"
      >
        <PixelDragon />
      </span>
    </div>
  );
}
