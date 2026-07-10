"use client";

// v3 主题基座 vim 状态线 (docs/DESIGN.md v3.3): bottom bar mounted below
// <main> in page.tsx. Left = inverted status block reading store
// status; middle = detect mode + audio-privacy sentence; right =
// {cards+terms} counter, then the mascot perch where Bit the pixel
// dragon lives (overflow-visible so it stands taller than the bar).

import { useApp } from "@/lib/store";
import PixelDragon from "@/components/PixelDragon";
import TaskTray from "@/components/TaskTray";

const ENGINE_POSTURE: Record<string, "local" | "cloud"> = {
  webspeech: "cloud",
  whisper: "local",
  tabaudio: "local",
  demo: "local",
};

const DETECT_MODE_LABEL: Record<string, string> = {
  llm: "词典+AI 检测",
  dictionary: "词典检测",
  off: "检测关闭",
};

export default function StatusLine() {
  const status = useApp((s) => s.status);
  const cards = useApp((s) => s.cards);
  const terms = useApp((s) => s.terms);
  const detectMode = useApp((s) => s.detectMode);
  const engine = useApp((s) => s.settings.engine);
  const aiDetect = useApp((s) => s.settings.aiDetect);
  const updateSettings = useApp((s) => s.updateSettings);

  const isListening = status === "listening";
  const modeLabel =
    status === "listening"
      ? "-- LISTENING --"
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
      : status === "stopped"
        ? "--STOP--"
        : status === "connecting"
          ? "--CONN--"
          : "--IDLE--";

  const posture = ENGINE_POSTURE[engine] ?? "local";
  const privacyLabel =
    posture === "local" ? "音频未离开本机" : "音频将经过浏览器厂商云端识别";
  const privacyLabelShort =
    posture === "local" ? "音频未离开本机" : "音频将经厂商云端";

  const count = cards.length + terms.length;

  return (
    <div
      data-testid="statusline"
      className="flex h-7 shrink-0 items-center border-t border-edge bg-panel2 font-mono text-xs text-mut"
    >
      <span
        className={`flex h-full items-center whitespace-nowrap px-2 font-bold tracking-wide sm:px-3 ${
          isListening ? "bg-lab-green text-ink" : "bg-mut text-ink"
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
        // Clickable (E2E feedback): flips settings.aiDetect — the label
        // itself keeps deriving from detectMode (the scheduler's own
        // derived runtime state, see detect/scheduler.ts), not from the
        // setting directly, so a click reflects a moment later once the
        // scheduler observes the new setting on its next segment/batch.
        <button
          type="button"
          data-testid="statusline-detect-toggle"
          onClick={() => updateSettings({ aiDetect: !aiDetect })}
          title="点击切换 AI 检测（词典检测始终开启）"
          className="flex h-full items-center whitespace-nowrap px-2 hover:bg-panel3 hover:text-fg sm:px-3"
        >
          {DETECT_MODE_LABEL[detectMode]}
        </button>
      )}
      <span className="text-mut2">|</span>
      <span
        className={`min-w-0 truncate px-2 sm:px-3 ${
          posture === "local" ? "text-lab-green" : "text-warn-soft"
        }`}
      >
        <span className="hidden sm:inline">{privacyLabel}</span>
        <span className="sm:hidden">{privacyLabelShort}</span>
      </span>
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
          discipline (icon+count, sm:hidden icon) and gives its popover
          a phone-safe width. */}
      <span className="flex h-full items-center">
        <TaskTray />
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
