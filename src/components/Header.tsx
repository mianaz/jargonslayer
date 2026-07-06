"use client";

// Top app bar: engine picker, detect-mode/elapsed status, primary
// start/stop action, and icon buttons for history/settings/help.

import { useEffect, useState } from "react";
import {
  ClockCounterClockwise,
  GearSix,
  GraduationCap,
  Question,
  Shield,
  ShieldCheck,
} from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import type { STTEngineKind } from "@/lib/types";

export interface HeaderProps {
  onStart: () => void;
  onStop: () => void;
  onDemo: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
}

// Real capture engines only — demo is a scripted preview, not a peer
// engine, so it has exactly one affordance: the header 演示 button.
// posture drives the 本地/云端 chip: local engines process audio on
// this machine; cloud engines send audio to a third-party service.
const ENGINE_OPTIONS: {
  value: Exclude<STTEngineKind, "demo">;
  label: string;
  posture: "local" | "cloud";
}[] = [
  { value: "webspeech", label: "浏览器识别", posture: "cloud" },
  { value: "whisper", label: "本地 Whisper", posture: "local" },
  { value: "tabaudio", label: "标签页音频", posture: "local" },
];

const POSTURE_LABEL: Record<"local" | "cloud", string> = {
  local: "本地",
  cloud: "云端",
};

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(min)}:${pad(sec)}`;
}

function DetectModeBadge() {
  const detectMode = useApp((s) => s.detectMode);
  const detectBusy = useApp((s) => s.detectBusy);

  const config =
    detectMode === "llm"
      ? { label: "AI 检测", cls: "text-acc2 border-acc2/30", Icon: ShieldCheck }
      : detectMode === "dictionary"
        ? { label: "词典模式", cls: "text-gold border-gold/30", Icon: Shield }
        : { label: "检测关闭", cls: "text-mut border-edge", Icon: null };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${config.cls}`}
    >
      {detectBusy && (
        <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent whitespace-nowrap" />
      )}
      {!detectBusy && config.Icon && <config.Icon size={14} weight="regular" />}
      {config.label}
    </span>
  );
}

function ElapsedTimer() {
  const status = useApp((s) => s.status);
  const startedAt = useApp((s) => s.startedAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (status !== "listening") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  if (status !== "listening" || startedAt === null) return null;

  return (
    <span className="font-mono text-xs tabular-nums text-mut">
      {formatElapsed(now - startedAt)}
    </span>
  );
}

function EnginePillGroup() {
  const engine = useApp((s) => s.settings.engine);
  const status = useApp((s) => s.status);
  const updateSettings = useApp((s) => s.updateSettings);
  const disabled = status === "connecting" || status === "listening";

  return (
    <div className="hidden items-center gap-0.5 rounded-lg border border-edge bg-panel2 p-0.5 md:flex whitespace-nowrap">
      {ENGINE_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          disabled={disabled}
          onClick={() => updateSettings({ engine: opt.value })}
          title={opt.posture === "local" ? "本地：音频不出本机" : "云端：音频会离开设备"}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            engine === opt.value
              ? "bg-panel3 text-fg"
              : "text-mut hover:text-fg"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// Compact 本地/云端 posture chip for the ACTIVE engine, so at a glance
// the user knows where their audio goes. demo has no audio at all, so
// it renders nothing here (the demo button itself makes that obvious).
function EnginePostureChip() {
  const engine = useApp((s) => s.settings.engine);
  const opt = ENGINE_OPTIONS.find((o) => o.value === engine);
  if (!opt) return null;

  const isLocal = opt.posture === "local";
  return (
    <span
      title={isLocal ? "音频只在本机处理，不出设备" : "音频会离开设备，经云端识别"}
      className={`hidden items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] whitespace-nowrap sm:inline-flex ${
        isLocal ? "border-gold/30 text-gold" : "border-warn-soft/30 text-warn-soft"
      }`}
    >
      {POSTURE_LABEL[opt.posture]}
    </span>
  );
}

export default function Header({
  onStart,
  onStop,
  onDemo,
  onOpenHistory,
  onOpenSettings,
  onOpenHelp,
}: HeaderProps) {
  const status = useApp((s) => s.status);
  const activeSessionId = useApp((s) => s.activeSessionId);
  const newMeeting = useApp((s) => s.newMeeting);

  const isConnectingOrListening =
    status === "connecting" || status === "listening";

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-edge bg-panel/85 px-4 backdrop-blur">
      <div className="flex items-center gap-2 whitespace-nowrap">
        <img src="/icon-192.png" alt="" className="h-8 w-8 rounded-lg" />
        <span className="font-display font-semibold tracking-wide text-fg">
          JargonSlayer
        </span>
        <span className="hidden text-xs text-mut md:inline">
          英文会议实时理解
        </span>
      </div>

      <EnginePillGroup />
      <EnginePostureChip />

      <div className="ml-auto flex items-center gap-2">
        <DetectModeBadge />
        <ElapsedTimer />

        {activeSessionId && status === "stopped" && (
          <>
            <span className="rounded-full border border-gold/30 px-2.5 py-1 text-xs text-gold whitespace-nowrap">
              历史会话
            </span>
            <button
              type="button"
              onClick={newMeeting}
              className="btn-tactile h-9 rounded-lg border border-edge px-3 text-sm text-fg hover:bg-panel3 whitespace-nowrap"
            >
              新会议
            </button>
          </>
        )}

        {(status === "idle" || status === "stopped") && (
          <button
            type="button"
            data-testid="btn-start"
            onClick={onStart}
            className="btn-tactile h-9 rounded-lg bg-acc px-4 text-sm font-medium text-white hover:bg-acchover whitespace-nowrap"
          >
            开始监听
          </button>
        )}

        {status === "connecting" && (
          <button
            type="button"
            disabled
            className="h-9 cursor-not-allowed rounded-lg bg-acc/60 px-4 text-sm font-medium text-white whitespace-nowrap"
          >
            连接中…
          </button>
        )}

        {status === "listening" && (
          <button
            type="button"
            data-testid="btn-stop"
            onClick={onStop}
            className="btn-tactile flex h-9 items-center gap-2 rounded-lg bg-warn/90 px-4 text-sm font-medium text-white hover:bg-warn whitespace-nowrap"
          >
            <span className="dot-live h-2 w-2 rounded-full bg-acc2 whitespace-nowrap" />
            停止
          </button>
        )}

        {!isConnectingOrListening && (
          <button
            type="button"
            data-testid="btn-demo"
            onClick={onDemo}
            className="btn-tactile h-9 rounded-lg border border-edge px-3 text-sm text-fg hover:bg-panel3 whitespace-nowrap"
          >
            演示
          </button>
        )}

        <button
          type="button"
          data-testid="btn-history"
          onClick={onOpenHistory}
          aria-label="历史"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-transparent text-mut hover:border-edge hover:bg-panel3 hover:text-fg whitespace-nowrap"
        >
          <ClockCounterClockwise size={20} weight="regular" />
        </button>
        <a
          href="/review"
          data-testid="btn-review"
          title="学习中心"
          aria-label="学习中心"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-transparent text-mut hover:border-edge hover:bg-panel3 hover:text-fg whitespace-nowrap"
        >
          <GraduationCap size={20} weight="regular" />
        </a>
        <button
          type="button"
          data-testid="btn-settings"
          onClick={onOpenSettings}
          aria-label="设置"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-transparent text-mut hover:border-edge hover:bg-panel3 hover:text-fg whitespace-nowrap"
        >
          <GearSix size={20} weight="regular" />
        </button>
        <button
          type="button"
          data-testid="btn-help"
          onClick={onOpenHelp}
          aria-label="帮助"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-transparent text-mut hover:border-edge hover:bg-panel3 hover:text-fg whitespace-nowrap"
        >
          <Question size={20} weight="regular" />
        </button>
      </div>
    </header>
  );
}
