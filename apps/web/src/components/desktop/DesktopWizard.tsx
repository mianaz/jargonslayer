"use client";

// v0.4 S3 chunk 6 (docs/design-explorations/s3-tauri-uv-blueprint.md,
// §Chunk 6) — the first-run provisioning wizard: a full-screen overlay
// (mounted by DesktopBootstrap.tsx, which owns the actual lib/desktop/
// bootstrap.ts handle) rendered whenever the user needs to either
// consent to a local install, watch it run, recover from a step error,
// or recover from a post-crash TERMINAL_ERROR (chunk 7). Purely
// presentational — every action here is a callback prop; the only
// local state this file owns is its own UI-only toggles (详细日志
// expand/collapse, a button's own transient "checking…"/"处理中…"
// busy flag around an awaited callback).
//
// Terminal aesthetic, matching the rest of the app (SettingsDialog.tsx/
// TutorialOverlay.tsx): 0px radius (no rounded-* class anywhere below),
// the existing bg-panel/border-edge/text-fg/text-mut token set, no new
// colors. "Full-screen overlay" (owner's own wording) is taken
// literally — `fixed inset-0`, not a centered modal box like the two
// dialogs above — this is a first-run gate, not an incidental popover.

import { useEffect, useRef, useState } from "react";
import { CaretDown, CaretRight, CheckCircle, CircleNotch, WarningCircle } from "@phosphor-icons/react";
import {
  PROVISION_STEP_LABELS,
  WIZARD_UI_STEPS,
  wizardRowStep,
  type DesktopBootstrapState,
  type DesktopLogLine,
} from "@/lib/desktop/bootstrap";
import type { ProvisionStep } from "@/lib/desktop/provisionMachine";
import type { DesktopPaths } from "@/lib/desktop/uvCommands";

export interface DesktopWizardProps {
  state: DesktopBootstrapState;
  paths: DesktopPaths;
  logLines: DesktopLogLine[];
  onBeginProvision: () => void;
  onDismissConsent: () => void;
  onDismissTerminal: () => void;
  onRetry: () => void;
  onRecheckHealth: () => Promise<void>;
  onReprovision: () => Promise<void>;
}

const README_URL = "https://github.com/mianaz/jargonslayer#readme";

type RowStatus = "pending" | "running" | "done" | "error";

function rowStatus(uiStep: ProvisionStep, state: DesktopBootstrapState): RowStatus {
  if (state.phase !== "STEP") return "pending";
  const currentUiStep = wizardRowStep(state.step);
  const uiIndex = WIZARD_UI_STEPS.indexOf(uiStep);
  const currentIndex = WIZARD_UI_STEPS.indexOf(currentUiStep);
  if (uiIndex < currentIndex) return "done";
  if (uiIndex > currentIndex) return "pending";
  return state.status === "ERROR" ? "error" : "running"; // RUNNING or POLLING both read as "running"
}

function RowIcon({ status }: { status: RowStatus }) {
  if (status === "done") {
    return <CheckCircle size={18} weight="fill" className="shrink-0 text-lab-green" aria-hidden />;
  }
  if (status === "error") {
    return <WarningCircle size={18} weight="fill" className="shrink-0 text-warn-soft" aria-hidden />;
  }
  if (status === "running") {
    return <CircleNotch size={18} className="shrink-0 animate-spin text-lab-cyan" aria-hidden />;
  }
  return <span className="h-[18px] w-[18px] shrink-0 border border-edge2" aria-hidden />;
}

/** 详细日志: collapsible, monospace, auto-scrolling to the newest line
 *  whenever expanded — the ~500-line cap itself is enforced by the
 *  caller (DesktopBootstrap.tsx), not here. */
function LogPane({ lines }: { lines: DesktopLogLine[] }) {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!expanded) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [expanded, lines.length]);

  return (
    <div className="border-t border-edge pt-2">
      <button
        type="button"
        data-testid="btn-toggle-wizard-log"
        onClick={() => setExpanded((v) => !v)}
        className="btn-tactile flex items-center gap-1 text-xs text-mut hover:text-fg"
      >
        {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
        详细日志{lines.length > 0 ? `（${lines.length}）` : ""}
      </button>
      {expanded && (
        <div
          ref={scrollRef}
          data-testid="wizard-log-pane"
          className="scroll-thin mt-2 max-h-40 overflow-y-auto border border-edge bg-panel2 p-2 font-mono text-[11px] leading-[1.6] text-mut2"
        >
          {lines.length === 0 ? (
            <div className="text-mut2">暂无输出</div>
          ) : (
            lines.map((l, i) => (
              <div key={i} className={l.stream === "stderr" ? "text-lab-orange" : undefined}>
                {l.line}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function EscapeHatch({ paths, onRecheckHealth }: { paths: DesktopPaths; onRecheckHealth: () => Promise<void> }) {
  const [checking, setChecking] = useState(false);
  return (
    <div className="space-y-2 border border-edge2 bg-panel2 p-3 text-xs leading-[1.7] text-mut">
      <div className="text-fg">装不上？也可以自己动手：</div>
      <div>
        参考{" "}
        <a href={README_URL} target="_blank" rel="noreferrer" className="text-lab-cyan underline decoration-lab-cyan/40">
          README「本地版安装」
        </a>{" "}
        手动安装 Python 环境和依赖，或者在 设置 → 转录引擎 中把托管模式切换为「外部」，直接连接你自己启动的 sidecar。
      </div>
      <div className="space-y-0.5 font-mono text-[11px] text-mut2">
        <div>安装目录：{paths.appData}</div>
        <div>Python：{paths.venvPython}</div>
        <div>日志文件：{paths.logPath}</div>
      </div>
      <button
        type="button"
        data-testid="btn-manual-recheck"
        disabled={checking}
        onClick={async () => {
          setChecking(true);
          try {
            await onRecheckHealth();
          } finally {
            setChecking(false);
          }
        }}
        className="btn-tactile border border-edge px-3 py-1.5 text-xs text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {checking ? "检测中…" : "我已手动安装 → 重新检测"}
      </button>
    </div>
  );
}

function WizardFrame({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="desktop-wizard" className="fixed inset-0 z-50 flex flex-col bg-panel font-mono text-fg">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-5 py-4">
        <span className="text-lg font-semibold">JargonSlayer</span>
        <span className="text-sm text-mut">本地语音识别设置</span>
      </div>
      <div className="scroll-thin flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-6">
        <div className="w-[560px] max-w-full space-y-5">{children}</div>
      </div>
    </div>
  );
}

function ConsentScreen({ onBeginProvision, onDismiss }: { onBeginProvision: () => void; onDismiss: () => void }) {
  return (
    <WizardFrame>
      <div data-testid="desktop-wizard-consent" className="space-y-4">
        <div className="text-base font-medium text-fg">首次使用需要安装本地语音识别</div>
        <div className="space-y-2 text-sm leading-[1.8] text-mut">
          <p>
            JargonSlayer 会在本机装一份独立的 Python 运行环境、语音识别引擎（faster-whisper）和一个较小的识别模型，全部安装在应用自己的数据目录下——不碰系统
            Python，卸载应用时随手就能删干净。
          </p>
          <p className="text-mut2">预计下载体积约 0.5–1.5 GB，视网络情况需要几分钟到十几分钟。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            data-testid="btn-begin-provision"
            onClick={onBeginProvision}
            className="btn-terminal rounded-none bg-act px-4 py-2 text-sm font-semibold text-ink hover:bg-act/85"
          >
            开始安装
          </button>
          <button
            type="button"
            data-testid="btn-dismiss-wizard"
            onClick={onDismiss}
            className="btn-tactile px-4 py-2 text-sm text-mut hover:bg-panel3 hover:text-fg"
          >
            稍后再说
          </button>
        </div>
        <div className="border-t border-edge pt-3 text-xs leading-[1.7] text-mut2">
          稍后再说也完全可以正常使用云端 / BYOK 转录与检测；随时可以在 设置 → 转录引擎 里重新打开这个向导。已经有自己的本地 sidecar？见{" "}
          <a href={README_URL} target="_blank" rel="noreferrer" className="text-lab-cyan underline decoration-lab-cyan/40">
            README「本地版安装」
          </a>
          ，装好后在 设置 → 转录引擎 中把托管模式切换为「外部」即可直接连接。
        </div>
      </div>
    </WizardFrame>
  );
}

function StepRowsScreen({
  state,
  paths,
  logLines,
  onRetry,
  onRecheckHealth,
}: {
  state: Extract<DesktopBootstrapState, { phase: "STEP" }>;
  paths: DesktopPaths;
  logLines: DesktopLogLine[];
  onRetry: () => void;
  onRecheckHealth: () => Promise<void>;
}) {
  const hasError = state.status === "ERROR";
  return (
    <WizardFrame>
      <div data-testid="desktop-wizard-steps" className="space-y-4">
        <div className="text-base font-medium text-fg">{hasError ? "安装遇到问题" : "正在安装本地语音识别…"}</div>

        <div className="space-y-1 border border-edge bg-panel2 p-3">
          {WIZARD_UI_STEPS.map((step) => {
            const status = rowStatus(step, state);
            return (
              <div key={step} data-testid={`wizard-step-${step}`} data-status={status} className="flex items-center gap-2 py-1.5">
                <RowIcon status={status} />
                <span className={status === "pending" ? "text-mut2" : "text-fg"}>{PROVISION_STEP_LABELS[step]}</span>
              </div>
            );
          })}
        </div>

        {state.status === "ERROR" && (
          <div className="space-y-3 border border-warn-soft/40 bg-panel2 p-3">
            <div className="text-sm text-warn-soft">{state.error}</div>
            <button
              type="button"
              data-testid="btn-retry-step"
              onClick={onRetry}
              className="btn-tactile border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3"
            >
              重试
            </button>
          </div>
        )}

        {state.status === "ERROR" && <EscapeHatch paths={paths} onRecheckHealth={onRecheckHealth} />}

        <LogPane lines={logLines} />
      </div>
    </WizardFrame>
  );
}

function TerminalErrorScreen({
  state,
  onDismiss,
  onReprovision,
}: {
  state: Extract<DesktopBootstrapState, { phase: "TERMINAL_ERROR" }>;
  onDismiss: () => void;
  onReprovision: () => Promise<void>;
}) {
  const [reprovisioning, setReprovisioning] = useState(false);
  return (
    <WizardFrame>
      <div data-testid="desktop-wizard-terminal" className="space-y-4">
        <div className="text-base font-medium text-warn-soft">本地服务反复异常退出</div>
        <div className="text-sm leading-[1.8] text-mut">{state.reason}</div>
        <div className="text-xs leading-[1.7] text-mut2">
          已停止自动重启，避免反复占用资源。可以重新运行安装向导（会清空当前的本地安装记录，重新走一遍安装），也可以先关闭这个提示继续使用云端 / BYOK
          功能——具体日志见 设置 → 数据与联动 → 诊断信息 → 查看本地服务日志。
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            data-testid="btn-reprovision"
            disabled={reprovisioning}
            onClick={async () => {
              setReprovisioning(true);
              try {
                await onReprovision();
              } finally {
                setReprovisioning(false);
              }
            }}
            className="btn-terminal rounded-none bg-act px-4 py-2 text-sm font-semibold text-ink hover:bg-act/85 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {reprovisioning ? "处理中…" : "重新运行安装向导"}
          </button>
          <button
            type="button"
            data-testid="btn-dismiss-wizard"
            onClick={onDismiss}
            className="btn-tactile px-4 py-2 text-sm text-mut hover:bg-panel3 hover:text-fg"
          >
            关闭，稍后处理
          </button>
        </div>
      </div>
    </WizardFrame>
  );
}

export default function DesktopWizard({
  state,
  paths,
  logLines,
  onBeginProvision,
  onDismissConsent,
  onDismissTerminal,
  onRetry,
  onRecheckHealth,
  onReprovision,
}: DesktopWizardProps) {
  if (state.phase === "WIZARD_CONSENT_REQUIRED") {
    return <ConsentScreen onBeginProvision={onBeginProvision} onDismiss={onDismissConsent} />;
  }
  if (state.phase === "STEP") {
    return <StepRowsScreen state={state} paths={paths} logLines={logLines} onRetry={onRetry} onRecheckHealth={onRecheckHealth} />;
  }
  if (state.phase === "TERMINAL_ERROR") {
    return <TerminalErrorScreen state={state} onDismiss={onDismissTerminal} onReprovision={onReprovision} />;
  }
  return null;
}
