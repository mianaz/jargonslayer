"use client";

// v3 主题基座 vim 状态线 (docs/DESIGN.md v3.3): bottom bar mounted below
// <main> in page.tsx. Left = inverted status block reading store
// status; middle = detect mode + audio-privacy sentence; right =
// {cards+terms} counter, then the mascot perch where Bit the pixel
// dragon lives (overflow-visible so it stands taller than the bar).

import { useApp } from "@/lib/store";
import PixelDragon from "@/components/PixelDragon";

const ENGINE_POSTURE: Record<string, "local" | "cloud"> = {
  webspeech: "cloud",
  whisper: "local",
  tabaudio: "local",
  demo: "local",
};

const DETECT_MODE_LABEL: Record<string, string> = {
  llm: "AI 检测",
  dictionary: "词典模式",
  off: "检测关闭",
};

export default function StatusLine() {
  const status = useApp((s) => s.status);
  const cards = useApp((s) => s.cards);
  const terms = useApp((s) => s.terms);
  const detectMode = useApp((s) => s.detectMode);
  const engine = useApp((s) => s.settings.engine);

  const isListening = status === "listening";
  const modeLabel =
    status === "listening"
      ? "-- LISTENING --"
      : status === "stopped"
        ? "-- STOPPED --"
        : status === "connecting"
          ? "-- CONNECTING --"
          : "-- IDLE --";

  const posture = ENGINE_POSTURE[engine] ?? "local";
  const privacyLabel =
    posture === "local" ? "音频未离开本机" : "音频经浏览器厂商云端识别";

  const count = cards.length + terms.length;

  return (
    <div
      data-testid="statusline"
      className="flex h-7 shrink-0 items-center border-t border-edge bg-panel2 font-mono text-xs text-mut"
    >
      <span
        className={`flex h-full items-center whitespace-nowrap px-3 font-bold tracking-wide ${
          isListening ? "bg-lab-green text-ink" : "bg-mut text-ink"
        }`}
      >
        {modeLabel}
      </span>
      <span className="whitespace-nowrap px-3">
        {DETECT_MODE_LABEL[detectMode] ?? DETECT_MODE_LABEL.off}
      </span>
      <span className="text-mut2">|</span>
      <span className="whitespace-nowrap px-3">{privacyLabel}</span>
      <span className="ml-auto whitespace-nowrap px-3 tabular-nums">
        {count} cards
      </span>
      <span
        id="mascot-perch"
        data-slot="mascot"
        className="relative flex h-10 items-end self-end overflow-visible pr-2"
      >
        <PixelDragon />
      </span>
    </div>
  );
}
