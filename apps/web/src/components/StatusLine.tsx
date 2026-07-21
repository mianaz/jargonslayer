"use client";

// v3 主题基座 vim 状态线 (docs/DESIGN.md v3.3): bottom bar mounted below
// <main> in page.tsx. Left = inverted status block reading store
// status; middle = detect mode + audio-privacy sentence; right =
// {cards+terms} counter, then the mascot perch where Bit the pixel
// dragon lives (overflow-visible so it stands taller than the bar).

import { useEffect, useRef, useState } from "react";
import { useApp } from "@/lib/store";
import { IS_DESKTOP } from "@/lib/platform/desktop";
import { useLatencyStats } from "@/lib/stt/latencyStats";
import {
  ENGINE_OPTIONS,
  RETENTION_COPY,
  engineOptionGate,
  resolveEngineRetentionClass,
  useAudiocapCaps,
} from "@/lib/stt/engineOptions";
import { useOsSpeechCaps } from "@/lib/desktop/osspeechCaps";
import { isEngineControlBusy } from "@/components/Header";
import PixelDragon from "@/components/PixelDragon";
import TaskTray from "@/components/TaskTray";
import AiStatusPanel, { deriveHealthStatus, type AiHealthStatus } from "@/components/AiStatusPanel";
import { useLlmTelemetry } from "@/lib/llm/telemetry";
import { resolveTaskCreds } from "@/lib/llm/taskConfig";

// Exported (tech-debt ledger #4, 2026-07-17): StatusLine.test.tsx
// imports this instead of re-pinning its own copy of the zh labels, so
// a reword here can't silently desync from a test asserting the old
// string.
export const DETECT_MODE_LABEL: Record<string, string> = {
  llm: "词典+AI 检测",
  dictionary: "词典检测",
  off: "检测关闭",
};

// Same reasoning — the engine <select>'s own placeholder + sidecar-down
// hint below, both pinned by exact-equality assertions in
// StatusLine.test.tsx.
export const ENGINE_SELECT_PLACEHOLDER = "选择引擎";
export const SIDECAR_DOWN_HINT_WEB = "本地 Whisper 未连接——见 设置 → 转录引擎";

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
//
// v0.5 Wave-1 Feature 5 (mode-first UI, docs/design-explorations/
// v05-wave1-blueprint.md §1 Feature 5): this dropdown is now reframed
// as a POWER-USER OVERRIDE — ModeSelector.tsx's tiles are the primary,
// mode-first way to pick a capture path, and they derive+write `engine`
// automatically. This control's own mechanics stay fully unchanged: it
// still writes `settings.engine` directly on change and never touches
// `settings.mode` (mode/engine may legitimately diverge — see
// Settings.mode's own doc comment, types.ts) — only the title hint
// below is new, so a user hovering the closed control (when no
// lock reason applies) understands what this control now IS relative
// to ModeSelector.
const ENGINE_OVERRIDE_HINT = "引擎覆盖（模式自动选择的引擎可在此覆盖）";

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
      title={selectedGate?.title ?? ENGINE_OVERRIDE_HINT}
      value={engine === "demo" || engine === "import" ? "" : engine}
      onChange={(e) => {
        const v = e.target.value as (typeof ENGINE_OPTIONS)[number]["value"] | "";
        if (v) updateSettings({ engine: v });
      }}
      className="h-full max-w-[6.5rem] shrink-0 border-x border-edge bg-panel2 px-1.5 font-mono text-fg disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-[8.5rem] sm:px-2"
    >
      {(engine === "demo" || engine === "import") && (
        <option value="" disabled>
          {ENGINE_SELECT_PLACEHOLDER}
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

// Chip + popover: always-visible "检测 · {model} {glyph}" label for the
// detect agent (the one every meeting actually uses live), click opens
// the full 4-row AiStatusPanel. Click-outside/Escape close mirrors
// Header.tsx's HamburgerMenu exactly (same pattern, this bar's own
// popover). Opens UPWARD (bottom-full) since this bar sits at the
// bottom of the screen — mirrors HamburgerMenu's positioning inverted.
function AiStatusChip() {
  const settings = useApp((s) => s.settings);
  const detectStat = useLlmTelemetry((s) => s.detect);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const handleMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [open]);

  const resolved = resolveTaskCreds(settings, "detect");
  const model = shortModelName(resolved.model);
  const glyph = AI_STATUS_CHIP_GLYPH[deriveHealthStatus(detectStat)];

  return (
    <div ref={rootRef} className="relative flex h-full items-center">
      <button
        type="button"
        data-testid="statusline-ai-status-chip"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="AI 状态"
        className="flex h-full items-center whitespace-nowrap px-2 hover:bg-panel3 hover:text-fg sm:px-3"
      >
        <span className="hidden sm:inline">
          {AI_STATUS_CHIP_DOMAIN_LABEL} · {model} {glyph}
        </span>
        <span className="sm:hidden">
          {AI_STATUS_CHIP_DOMAIN_LABEL} {glyph}
        </span>
      </button>
      {open && (
        <div
          role="dialog"
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
          className="scroll-thin fixed inset-x-2 bottom-8 z-30 max-h-[60vh] overflow-y-auto border border-edge bg-panel2 glassable p-3 shadow-lg sm:absolute sm:inset-x-auto sm:bottom-[calc(100%+4px)] sm:left-0 sm:w-72 sm:max-h-none sm:overflow-visible"
        >
          <AiStatusPanel />
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
      <AiStatusChip />
      {/* S14 mobile-preview field-fix: at 375px this segment's own
          neighbors (mode chip, detect toggle, AI status chip, engine
          dropdown) already eat past the viewport width on their own,
          leaving no room for the privacy sentence to truncate into —
          hidden below sm (its preceding "|" separator too, so none
          dangles on its own), unchanged at sm+. */}
      <span className="hidden text-mut2 sm:inline">|</span>
      <span
        title={sidecarDownHint}
        className={`hidden min-w-0 truncate px-2 sm:inline sm:px-3 ${privacyCopy.textClass}`}
      >
        <span className="hidden sm:inline">{privacyCopy.hint}</span>
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
