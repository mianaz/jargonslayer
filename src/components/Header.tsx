"use client";

// Terminal titlebar (docs/DESIGN.md v3.3, preview-4-terminal.html):
// top strip = mono path-style title + ⌘K hint (the v3.3-era three fake
// window dots were removed in v0.2.1 — decorative macOS chrome that
// didn't earn its place, see 可读性与主题机制 polish pass);
// brand row = dragon mark + JargonSlayer wordmark + engine posture +
// primary start/stop + engine pills + ≡ menu (演示/历史/学习中心/设置/帮助
// moved inside per the v3 汉堡收纳 decision — every old data-testid is
// preserved inside the dropdown so existing tests/QA flows still pass).

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ClockCounterClockwise,
  GearSix,
  GraduationCap,
  List,
  Play,
  Question,
  Shield,
  ShieldCheck,
  UploadSimple,
} from "@phosphor-icons/react";
import { elapsedActiveMs, useApp } from "@/lib/store";
import type { MeetingStatus, STTEngineKind } from "@/lib/types";
import { withBase } from "@/lib/basePath";
import { PREVIEW_TIER } from "@/lib/deployTier";

export interface HeaderProps {
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onDemo: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onOpenImport: () => void;
}

// Shared "is a meeting live enough that switching engines (or opening
// the import hub, #62 item 2) would be unsafe" gate — connecting means
// a socket is already mid-handshake, listening means audio is actively
// flowing; both must finish/stop first. Exported so it has exactly one
// definition instead of the inline duplicate this file used to carry
// per pill/select/menu.
export function isEngineControlBusy(status: MeetingStatus): boolean {
  return status === "connecting" || status === "listening";
}

// Pause availability (B4): 暂停 is hidden entirely (end-only posture)
// for engines where a resume can't safely reattach mid-meeting —
// tabaudio (resuming would have to re-open the OS/browser tab-share
// picker, a jarring interruption to re-request every pause), demo (a
// scripted replay that only knows how to restart from line 0, not
// "resume"), and whisper WITH realtime diarization on (the sidecar's
// seg-id numbering isn't guaranteed stable across a stop()/reattach
// pair — a post-resume diarization segment could collide with a
// pre-pause one; known beta limitation). Exported so it's
// independently unit-testable, same pattern as isEngineControlBusy.
export function canPause(engine: STTEngineKind): boolean {
  // webspeech ONLY for v1. whisper is deferred pending a stop-drain
  // ack protocol — WsTransport.stop() closes right after {type:"stop"},
  // so the sidecar's post-stop final can be dropped or interleave past
  // a resume (codex review 2026-07-10); tabaudio would re-open the OS
  // share picker on resume; demo restarts its script.
  return engine === "webspeech";
}

// Real capture engines only — demo is a scripted preview, not a peer
// engine, so it has exactly one affordance: the menu's 演示 item.
// posture drives the 本地/云端 label: local engines process audio on
// this machine; cloud engines send audio to a third-party service.
// sidecarOnly (#61 preview tier): whisper/tabaudio require the local
// sidecar process, which the hosted preview build never has — greyed
// out there rather than removed (showroom posture: show everything,
// no dead ends).
const ENGINE_OPTIONS: {
  value: Exclude<STTEngineKind, "demo">;
  label: string;
  posture: "local" | "cloud";
  sidecarOnly?: boolean;
}[] = [
  { value: "webspeech", label: "浏览器识别", posture: "cloud" },
  { value: "whisper", label: "本地 Whisper", posture: "local", sidecarOnly: true },
  { value: "tabaudio", label: "标签页音频", posture: "local", sidecarOnly: true },
];

const PREVIEW_SIDECAR_TITLE = "本地版功能：需要本地 sidecar";

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
  const aiDetect = useApp((s) => s.settings.aiDetect);
  const updateSettings = useApp((s) => s.updateSettings);
  const setDetectMode = useApp((s) => s.setDetectMode);

  const config =
    detectMode === "llm"
      ? { label: "词典+AI 检测", cls: "text-lab-green", Icon: ShieldCheck }
      : detectMode === "dictionary"
        ? { label: "词典检测", cls: "text-lab-orange", Icon: Shield }
        : { label: "检测关闭", cls: "text-mut", Icon: null };

  const content = (
    <>
      {detectBusy && (
        <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent whitespace-nowrap" />
      )}
      {!detectBusy && config.Icon && <config.Icon size={14} weight="regular" />}
      {config.label}
    </>
  );

  // hidden <md (#55): the bottom StatusLine shows the same mode text,
  // and the mobile header row needs the width for the engine select.
  // Borderless (E2E feedback 2026-07-11): the old bordered span read as
  // a disabled control even though it never did anything — chrome with
  // no affordance behind it is worse than plain text. Border removed in
  // every mode, including the interactive one below.
  if (detectMode === "off") {
    return (
      <span
        className={`hidden items-center gap-1.5 px-2.5 py-1 font-mono text-xs md:inline-flex ${config.cls}`}
      >
        {content}
      </span>
    );
  }

  return (
    // Clickable, mirroring StatusLine.tsx's statusline-detect-toggle
    // (same E2E batch item): flips settings.aiDetect. The label derives
    // from detectMode (the scheduler's runtime state, see
    // detect/scheduler.ts), which the scheduler only re-reads on its
    // next segment/batch — so the click ALSO echoes the expected mode
    // synchronously, or an idle meeting would show a dead button. The
    // scheduler's own onModeChange remains authoritative and corrects
    // the echo if reality differs (e.g. key-less fallback downgrades
    // llm back to dictionary). Deliberately duplicated here rather than
    // extracted into a shared hook — see StatusLine.tsx's toggle for
    // the twin copy.
    <button
      type="button"
      data-testid="header-detect-toggle"
      onClick={() => {
        const next = !aiDetect;
        updateSettings({ aiDetect: next });
        setDetectMode(next ? "llm" : "dictionary");
      }}
      title="点击切换 AI 检测（词典检测始终开启）"
      className={`hidden items-center gap-1.5 px-2.5 py-1 font-mono text-xs hover:text-fg md:inline-flex ${config.cls}`}
    >
      {content}
    </button>
  );
}

function ElapsedTimer() {
  const status = useApp((s) => s.status);
  const startedAt = useApp((s) => s.startedAt);
  const pausedAccumMs = useApp((s) => s.pausedAccumMs);
  const pauseStartedAt = useApp((s) => s.pauseStartedAt);
  const [now, setNow] = useState(() => Date.now());

  // 1s ticking only while actually listening — while paused the
  // readout is frozen (elapsedActiveMs ignores `now` once
  // pauseStartedAt is set, see its own doc comment), so there's
  // nothing for a running interval to do.
  useEffect(() => {
    if (status !== "listening") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  if ((status !== "listening" && status !== "paused") || startedAt === null) {
    return null;
  }

  return (
    <span className="font-mono text-xs tabular-nums text-mut">
      {formatElapsed(elapsedActiveMs(startedAt, now, pausedAccumMs, pauseStartedAt))}
    </span>
  );
}

function EnginePillGroup({ onOpenImport }: { onOpenImport: () => void }) {
  const engine = useApp((s) => s.settings.engine);
  const status = useApp((s) => s.status);
  const updateSettings = useApp((s) => s.updateSettings);
  const busy = isEngineControlBusy(status);

  return (
    <div className="hidden items-center gap-0.5 border border-edge bg-panel2 p-0.5 md:flex whitespace-nowrap">
      {ENGINE_OPTIONS.map((opt) => {
        // Preview tier (#61): sidecar-only pills stay visible but
        // disabled — never removed (showroom posture).
        const previewLocked = PREVIEW_TIER && opt.sidecarOnly;
        const disabled = busy || previewLocked;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => updateSettings({ engine: opt.value })}
            title={
              previewLocked
                ? PREVIEW_SIDECAR_TITLE
                : opt.posture === "local"
                  ? "本地：音频不出本机"
                  : "云端：音频会离开设备"
            }
            className={`px-2.5 py-1 font-mono text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              engine === opt.value
                ? "bg-panel3 text-fg"
                : "text-mut hover:text-fg"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
      {/* 导入 (#62 item 2, owner's explicit ask: upload local audio/
          video side by side with the other modes) — sits in the same
          pill row as a PEER of the engine buttons above, but it is an
          action (opens ImportHub), never a selectable engine: no
          active/inactive styling, a left divider + icon mark it as
          distinct, and its onClick never touches settings.engine. */}
      <button
        type="button"
        data-testid="btn-import"
        disabled={busy}
        onClick={onOpenImport}
        title="导入本地音频/视频或文稿"
        className="ml-0.5 flex items-center gap-1 border-l border-edge px-2.5 py-1 font-mono text-xs text-mut transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
      >
        <UploadSimple size={13} weight="regular" />
        导入
      </button>
    </div>
  );
}

// #55: below md the pill group above is hidden — without this select,
// mobile had NO way to pick a realtime engine at all (Settings has no
// engine field either), so the default demo engine stuck and 开始监听
// could only ever replay the demo script. A native <select> keeps the
// row narrow enough for 375px. While the engine is still the default
// "demo" it shows a disabled 选择引擎 placeholder — demo isn't a pill
// on desktop either (it lives in the ≡ menu as 演示).
function MobileEngineSelect() {
  const engine = useApp((s) => s.settings.engine);
  const status = useApp((s) => s.status);
  const updateSettings = useApp((s) => s.updateSettings);
  const disabled = isEngineControlBusy(status);

  return (
    <select
      aria-label="转录引擎"
      disabled={disabled}
      value={engine === "demo" || engine === "import" ? "" : engine}
      onChange={(e) => {
        const v = e.target.value as (typeof ENGINE_OPTIONS)[number]["value"] | "";
        if (v) updateSettings({ engine: v });
      }}
      className="h-8 max-w-[8.5rem] border border-edge bg-panel2 px-1.5 font-mono text-xs text-fg disabled:cursor-not-allowed disabled:opacity-50 md:hidden"
    >
      {(engine === "demo" || engine === "import") && (
        <option value="" disabled>
          选择引擎
        </option>
      )}
      {ENGINE_OPTIONS.map((opt) => {
        // Preview tier (#61): same sidecar-only lock as the pill group
        // above, applied per-<option> since a native <select> can't
        // grey a single option's styling — disabled + title is the
        // full affordance a native option supports.
        const previewLocked = PREVIEW_TIER && opt.sidecarOnly;
        return (
          <option
            key={opt.value}
            value={opt.value}
            disabled={previewLocked}
            title={previewLocked ? PREVIEW_SIDECAR_TITLE : undefined}
          >
            {opt.label}
          </option>
        );
      })}
    </select>
  );
}

// Mobile counterpart of EnginePillGroup's 导入 pill (#62 item 2): the
// native <select> above can't host a non-engine action as a peer
// option without misrepresenting it as a selectable engine, so this
// sits directly beside it instead — same row, same busy gating, same
// dialog. Icon-only (375px width budget, see MobileEngineSelect above).
function MobileImportButton({ onOpenImport }: { onOpenImport: () => void }) {
  const status = useApp((s) => s.status);
  const disabled = isEngineControlBusy(status);

  return (
    <button
      type="button"
      data-testid="btn-import-mobile"
      disabled={disabled}
      onClick={onOpenImport}
      aria-label="导入"
      title="导入本地音频/视频或文稿"
      className="flex h-8 w-8 shrink-0 items-center justify-center border border-edge bg-panel2 text-mut hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 md:hidden"
    >
      <UploadSimple size={14} weight="regular" />
    </button>
  );
}

// Compact 本地/云端 posture chip for the ACTIVE engine, so at a glance
// the user knows where their audio goes. demo has no audio at all, so
// it renders nothing here (the demo menu item itself makes that obvious).
function EnginePostureChip() {
  const engine = useApp((s) => s.settings.engine);
  const opt = ENGINE_OPTIONS.find((o) => o.value === engine);
  if (!opt) return null;

  const isLocal = opt.posture === "local";
  return (
    <span
      title={isLocal ? "音频只在本机处理，不出设备" : "音频将经过浏览器厂商云端识别"}
      className={`hidden items-center gap-1 border px-2 py-0.5 text-[10px] whitespace-nowrap sm:inline-flex ${
        isLocal ? "border-lab-green/30 text-lab-green" : "border-warn-soft/30 text-warn-soft"
      }`}
    >
      {POSTURE_LABEL[opt.posture]}
    </span>
  );
}

// ≡ 汉堡菜单 (v3.3 汉堡收纳): 演示/学习中心/设置/帮助 live here now — 历史
// moved back out to its own standalone header button (E2E feedback:
// history is used often enough to deserve one click, not two). Old
// testids (btn-demo/btn-review/btn-settings/btn-help) are preserved
// unchanged on the items themselves — only their container/visibility
// moved, not their identity.
function HamburgerMenu({
  onDemo,
  onOpenSettings,
  onOpenHelp,
}: Pick<HeaderProps, "onDemo" | "onOpenSettings" | "onOpenHelp">) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const status = useApp((s) => s.status);
  const activeSessionId = useApp((s) => s.activeSessionId);
  const newMeeting = useApp((s) => s.newMeeting);
  // Includes "paused": starting the demo begins a NEW meeting, which
  // would silently clobber a paused one the user intends to resume.
  const meetingActive =
    status === "connecting" || status === "listening" || status === "paused";

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

  const itemCls =
    "flex items-center gap-2.5 px-3 py-2 text-left font-mono text-xs text-fg hover:bg-panel3 whitespace-nowrap";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="btn-menu"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="菜单"
        className="flex h-9 w-9 items-center justify-center border border-edge text-mut hover:border-edge2 hover:bg-panel3 hover:text-fg"
      >
        <List size={18} weight="regular" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+4px)] z-30 flex w-56 flex-col border border-edge bg-panel2 py-1 shadow-lg"
        >
          {!meetingActive && (
            <button
              type="button"
              role="menuitem"
              data-testid="btn-demo"
              onClick={() => {
                setOpen(false);
                onDemo();
              }}
              className={itemCls}
            >
              <Play size={16} weight="regular" />
              演示
            </button>
          )}
          {/* 学习中心 nav (E2E feedback 2026-07-11): a plain <a href>
              full-page-loaded /review, wiping every bit of in-memory
              state on the way there AND back (running import tasks,
              transcript, cards) — Link does a client-side transition
              instead, Next auto-prefixing basePath so this must NOT be
              wrapped in withBase (see src/lib/basePath.ts's own doc
              comment). Gated on meetingActive: useMeeting's unmount
              cleanup (the effect below its stop()) stops the engine but
              never resets the store's status, so a client-side nav
              mid-meeting would strand a zombie "listening"/"paused" UI
              back on "/" instead of ending the meeting — disabled here
              until the meeting actually ends. */}
          {meetingActive ? (
            <div
              role="menuitem"
              aria-disabled="true"
              data-testid="btn-review"
              title="会议进行中，结束后可进入学习中心"
              className={`${itemCls} cursor-not-allowed opacity-50`}
            >
              <GraduationCap size={16} weight="regular" />
              学习中心
            </div>
          ) : (
            <Link
              href="/review"
              role="menuitem"
              data-testid="btn-review"
              onClick={() => setOpen(false)}
              className={itemCls}
            >
              <GraduationCap size={16} weight="regular" />
              学习中心
            </Link>
          )}
          <button
            type="button"
            role="menuitem"
            data-testid="btn-settings"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
            className={itemCls}
          >
            <GearSix size={16} weight="regular" />
            设置
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="btn-help"
            onClick={() => {
              setOpen(false);
              onOpenHelp();
            }}
            className={itemCls}
          >
            <Question size={16} weight="regular" />
            帮助
          </button>

          {activeSessionId && status === "stopped" && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                newMeeting();
              }}
              className={`${itemCls} border-t border-edge mt-1 pt-2`}
            >
              <span className="text-lab-orange">●</span>
              新会议
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function Header({
  onStart,
  onPause,
  onResume,
  onStop,
  onDemo,
  onOpenHistory,
  onOpenSettings,
  onOpenHelp,
  onOpenImport,
}: HeaderProps) {
  const status = useApp((s) => s.status);
  const activeSessionId = useApp((s) => s.activeSessionId);
  const engine = useApp((s) => s.settings.engine);
  const realtimeDiarize = useApp((s) => s.settings.realtimeDiarize);

  return (
    // Single-row header (Miana's v0.2.2 E2E feedback: the old h-9
    // terminal title strip above this row duplicated every piece of
    // information on screen — "jargonslayer" (wordmark), engine·posture
    // (pills + chip), "N cards" (StatusLine) — and made the frame feel
    // heavy. The strip and its ⌘K placeholder chip are gone; the brand
    // row below is now the whole header. docs/DESIGN.md updated.)
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-edge bg-panel px-4">
        <div className="flex items-center gap-2 whitespace-nowrap">
          {/* Scheme-aware brand mark (v0.2.4): transparent-background
              renditions per scheme — the old opaque icon-192 left a
              baked ink-dark square floating on light themes. Both are
              rendered and CSS picks one via <html data-scheme> (the
              .scheme-*-only rules in globals.css), so the right
              variant shows from the first paint with zero JS. */}
          <img
            src={withBase("/icon-ui-dark.png")}
            alt=""
            className="scheme-dark-only h-9 w-auto"
          />
          <img
            src={withBase("/icon-ui-light.png")}
            alt=""
            className="scheme-light-only h-9 w-auto"
          />
          {/* wordmark hidden <sm (#55): the phone-width row needs the
              space for the engine select + start button; the icon (now
              Bit himself) carries the brand there. */}
          <div className="hidden flex-col leading-tight sm:flex">
            <span className="font-mono font-bold tracking-wide text-fg">
              JargonSlayer
            </span>
            <span className="hidden text-[11px] text-mut md:inline">
              英文会议实时理解
            </span>
          </div>
        </div>

        <EnginePillGroup onOpenImport={onOpenImport} />
        <MobileEngineSelect />
        <MobileImportButton onOpenImport={onOpenImport} />
        <EnginePostureChip />

        <div className="ml-auto flex items-center gap-2">
          <DetectModeBadge />
          <ElapsedTimer />

          {(status === "idle" || status === "stopped") && (
            <button
              type="button"
              data-testid="btn-start"
              onClick={onStart}
              className="btn-terminal h-9 rounded-none bg-act px-4 font-mono text-sm font-semibold text-ink hover:bg-act/85 whitespace-nowrap"
            >
              开始监听
            </button>
          )}

          {status === "connecting" && (
            <button
              type="button"
              disabled
              className="h-9 cursor-not-allowed rounded-none bg-act/60 px-4 font-mono text-sm font-semibold text-ink whitespace-nowrap"
            >
              连接中…
            </button>
          )}

          {status === "listening" && canPause(engine) && (
            <button
              type="button"
              data-testid="btn-pause"
              onClick={onPause}
              className="h-9 rounded-none border border-edge px-4 font-mono text-sm text-fg hover:bg-panel3 whitespace-nowrap"
            >
              暂停
            </button>
          )}

          {status === "paused" && (
            <button
              type="button"
              data-testid="btn-resume"
              onClick={onResume}
              className="btn-terminal h-9 rounded-none bg-act px-4 font-mono text-sm font-semibold text-ink hover:bg-act/85 whitespace-nowrap"
            >
              继续
            </button>
          )}

          {(status === "listening" || status === "paused") && (
            <button
              type="button"
              data-testid="btn-stop"
              onClick={onStop}
              className="btn-terminal flex h-9 items-center gap-2 rounded-none border border-lab-red px-4 font-mono text-sm font-semibold text-lab-red hover:bg-lab-red/10 whitespace-nowrap"
            >
              <span className="dot-live h-2 w-2 rounded-full bg-lab-red whitespace-nowrap" />
              结束
            </button>
          )}

          {activeSessionId && status === "stopped" && (
            // State descriptor, not a control (E2E feedback 2026-07-11):
            // sitting right next to btn-history's icon button, the old
            // bordered chip read as a second clickable affordance. It's
            // plain text — no border/chrome — so it can only be read as
            // "you're viewing a saved session", never mistaken for a button.
            <span
              data-testid="chip-saved"
              className="px-2.5 py-1 font-mono text-xs text-lab-green whitespace-nowrap"
            >
              已保存
            </span>
          )}

          {/* 历史 (E2E feedback): standalone button, directly left of ≡ —
              used often enough that burying it a menu-item deep cost an
              extra click every time. Identical footprint to ≡ itself. */}
          <button
            type="button"
            data-testid="btn-history"
            onClick={onOpenHistory}
            aria-label="历史"
            title="历史"
            className="flex h-9 w-9 items-center justify-center border border-edge text-mut hover:border-edge2 hover:bg-panel3 hover:text-fg"
          >
            <ClockCounterClockwise size={18} weight="regular" />
          </button>

          <HamburgerMenu
            onDemo={onDemo}
            onOpenSettings={onOpenSettings}
            onOpenHelp={onOpenHelp}
          />
        </div>
    </header>
  );
}
