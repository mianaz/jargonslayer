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
import { MODEL_CATALOG, WIZARD_PRESELECTED_MODEL } from "@/lib/desktop/modelCatalog";
import type { ProvisionStep } from "@/lib/desktop/provisionMachine";
import type { PrewarmProgressEvent } from "@/lib/desktop/provisionRunner";
import type { DesktopPaths } from "@/lib/desktop/uvCommands";
import ModelPicker from "./ModelPicker";
import OnboardingByokStep from "./OnboardingByokStep";
import OnboardingDiarizeStep from "./OnboardingDiarizeStep";

export interface DesktopWizardProps {
  state: DesktopBootstrapState;
  paths: DesktopPaths;
  logLines: DesktopLogLine[];
  /** S4 chunk 2's prewarm://progress snapshot, threaded through the
   *  same "own it in DesktopBootstrap.tsx, pass it down as a plain
   *  prop" shape as logLines — see StepRowsScreen's 下载模型 row below. */
  downloadProgress: PrewarmProgressEvent | null;
  /** S4 chunk 3 (decision A): the consent screen's own <ModelPicker>
   *  pick, passed straight through to bootstrap.ts's beginProvision. */
  onBeginProvision: (model: string) => void;
  onDismissConsent: () => void;
  onDismissTerminal: () => void;
  /** v0.4.0 field fix: the STEP/ERROR screen's own 关闭 — before this,
   *  an install error trapped the user in the full-screen overlay with
   *  只有重试 (and the EscapeHatch text pointing at a Settings panel the
   *  overlay itself made unreachable). Owned by DesktopBootstrap.tsx as
   *  a third dismiss flag with the same auto-reset-on-phase-exit
   *  contract as the other two. */
  onDismissStepError: () => void;
  onRetry: () => void;
  onRecheckHealth: () => Promise<void>;
  onReprovision: () => Promise<void>;
}

const README_URL = "https://github.com/mianaz/jargonslayer#readme";

/** Human-readable byte size, one decimal place, GB above 1 else MB — the
 *  下载模型 row's own progress readout (S4 chunk 2's prewarm://progress
 *  is raw bytes; nothing else in this codebase already formats bytes
 *  this way, see registry.ts's own "12.3MB" precedent for the same
 *  one-decimal convention at a different unit). */
function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
}

function formatDownloadProgress(progress: PrewarmProgressEvent): string {
  const pct = progress.total > 0 ? Math.round((progress.downloaded / progress.total) * 100) : 0;
  return `${pct}% · ${formatBytes(progress.downloaded)}/${formatBytes(progress.total)}`;
}

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

/** Exported for DesktopOnboardingSteps below (same file) and any future
 *  caller that wants the identical full-screen chrome — see that
 *  export's own header comment. */
export function WizardFrame({ children }: { children: React.ReactNode }) {
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

function ConsentScreen({
  onBeginProvision,
  onDismiss,
}: {
  onBeginProvision: (model: string) => void;
  onDismiss: () => void;
}) {
  // S4 chunk 3 (blueprint decision A): the picker's own selection state
  // is UI-only, local to this screen — mirrors LogPane's `expanded`/
  // EscapeHatch's `checking` above (this file's own "the only local
  // state this file owns is its own UI-only toggles" header contract).
  // Pre-selected to WIZARD_PRESELECTED_MODEL (medium — the veto window,
  // see modelCatalog.ts's own doc comment on that constant).
  const [model, setModel] = useState<string>(WIZARD_PRESELECTED_MODEL);
  const chosen = MODEL_CATALOG.find((m) => m.id === model) ?? MODEL_CATALOG[0];
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

        <ModelPicker value={model} onChange={setModel} />

        {/* zh-en guidance (blueprint decision A, verbatim) — honest,
           no overselling: Whisper's own ~30s-per-window language
           detection is stated plainly, right where the pick is made. */}
        <div className="space-y-1.5 text-xs leading-[1.7] text-mut2">
          <p>Whisper 每约 30 秒判定一种语言，句内中英混说无法做到完美；模型只负责转录，术语识别与中文注释是上层能力。</p>
          <p>Apple Silicon 实时→medium；上传录音→large-v3；Win+NVIDIA→large-v3；无独显→small/turbo；英文为主偶尔中文→turbo；中英混说重→large-v3（turbo 在 CJK 上更弱）.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            data-testid="btn-begin-provision"
            onClick={() => onBeginProvision(model)}
            className="btn-terminal rounded-none bg-act px-4 py-2 text-sm font-semibold text-ink hover:bg-act/85"
          >
            开始安装（{chosen.id} · {chosen.size}）
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
  downloadProgress,
  onRetry,
  onRecheckHealth,
  onReprovision,
  onDismissStepError,
}: {
  state: Extract<DesktopBootstrapState, { phase: "STEP" }>;
  paths: DesktopPaths;
  logLines: DesktopLogLine[];
  downloadProgress: PrewarmProgressEvent | null;
  onRetry: () => void;
  onRecheckHealth: () => Promise<void>;
  onReprovision: () => Promise<void>;
  onDismissStepError: () => void;
}) {
  const hasError = state.status === "ERROR";
  // v0.4.0 field fix: 返回重新选择's own transient busy flag — the same
  // UI-only-toggle contract as TerminalErrorScreen's `reprovisioning`
  // below (this file's header comment), around the same awaited
  // onReprovision callback.
  const [returning, setReturning] = useState(false);
  return (
    <WizardFrame>
      <div data-testid="desktop-wizard-steps" className="space-y-4">
        <div className="text-base font-medium text-fg">{hasError ? "安装遇到问题" : "正在安装本地语音识别…"}</div>

        <div className="space-y-1 border border-edge bg-panel2 p-3">
          {WIZARD_UI_STEPS.map((step) => {
            const status = rowStatus(step, state);
            // S4 chunk 2's prewarm://progress only ever describes the
            // 下载模型 row, and only while it's the currently-running
            // step (see bootstrap.ts's own resetDownloadProgress —
            // stale/finished-step values never survive to here).
            const showProgress = step === "DOWNLOAD_MODEL" && status === "running" && downloadProgress !== null;
            return (
              <div key={step} data-testid={`wizard-step-${step}`} data-status={status} className="flex items-center gap-2 py-1.5">
                <RowIcon status={status} />
                <span className={status === "pending" ? "text-mut2" : "text-fg"}>{PROVISION_STEP_LABELS[step]}</span>
                {showProgress && (
                  <span data-testid="wizard-download-progress" className="font-mono text-xs text-mut2">
                    {formatDownloadProgress(downloadProgress!)}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {state.status === "ERROR" && (
          <div className="space-y-3 border border-warn-soft/40 bg-panel2 p-3">
            <div className="text-sm text-warn-soft">{state.error}</div>
            {/* v0.4.0 field fix: 重试 must not be the only way out — a
               deterministic failure (the packaged-app uv ENOENT that
               prompted this) made the full-screen overlay a trap: no way
               back to the model pick, and no way to reach the very
               Settings panel the EscapeHatch text below points at.
               返回重新选择 reuses reprovision() (bootstrap.ts documents it
               "meaningful from every reachable state"): stop whatever
               may be running, clear the marker, land back on the consent
               screen. 关闭 dismisses the overlay so the app (cloud/BYOK,
               Settings) is usable — same wording as TerminalErrorScreen's
               own dismiss. */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="btn-retry-step"
                onClick={onRetry}
                className="btn-tactile border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3"
              >
                重试
              </button>
              <button
                type="button"
                data-testid="btn-back-to-consent"
                disabled={returning}
                onClick={async () => {
                  setReturning(true);
                  try {
                    await onReprovision();
                  } finally {
                    setReturning(false);
                  }
                }}
                className="btn-tactile border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {returning ? "处理中…" : "返回重新选择"}
              </button>
              <button
                type="button"
                data-testid="btn-dismiss-step-error"
                onClick={onDismissStepError}
                className="btn-tactile px-3 py-1.5 text-sm text-mut hover:bg-panel3 hover:text-fg"
              >
                关闭，稍后处理
              </button>
            </div>
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
  downloadProgress,
  onBeginProvision,
  onDismissConsent,
  onDismissTerminal,
  onDismissStepError,
  onRetry,
  onRecheckHealth,
  onReprovision,
}: DesktopWizardProps) {
  if (state.phase === "WIZARD_CONSENT_REQUIRED") {
    return <ConsentScreen onBeginProvision={onBeginProvision} onDismiss={onDismissConsent} />;
  }
  if (state.phase === "STEP") {
    return (
      <StepRowsScreen
        state={state}
        paths={paths}
        logLines={logLines}
        downloadProgress={downloadProgress}
        onRetry={onRetry}
        onRecheckHealth={onRecheckHealth}
        onReprovision={onReprovision}
        onDismissStepError={onDismissStepError}
      />
    );
  }
  if (state.phase === "TERMINAL_ERROR") {
    return <TerminalErrorScreen state={state} onDismiss={onDismissTerminal} onReprovision={onReprovision} />;
  }
  return null;
}

// ---------------------------------------------------------------
// S10 field-fix (docs/design-explorations/s10-fieldfix-blueprint.md,
// item #3 / Chunk C) — two OPTIONAL, SKIPPABLE onboarding steps shown
// AFTER the provisioning flow above. Deliberately NOT woven into the
// phase switch in the default export above: provisionMachine.ts stays
// completely untouched, and DesktopWizard's own phase-driven behavior
// is unchanged (this file's own "HEALTHY -> renders nothing" test
// still holds — HEALTHY never routes here on its own).
//
// Mount/timing is a HANDOFF, owned by whichever file actually renders
// this (expected: DesktopBootstrap.tsx, foreign to this worker) — the
// intended contract: render <DesktopOnboardingSteps> once, right after
// observing a STEP -> HEALTHY transition (i.e. the user just watched a
// REAL provision run finish), never on an ordinary launch that merely
// adopts an already-healthy sidecar (CHECKING -> HEALTHY, skipping
// STEP entirely) — so a returning user is never nagged. A second
// mount point from a future Settings "重新查看引导" entry is expected
// too (also HANDOFF) — this component doesn't care WHY it was mounted,
// only that `onDone` fires when both steps are behind the user.
// ---------------------------------------------------------------

export type OnboardingStep = "byok" | "diarize";

export interface DesktopOnboardingStepsProps {
  /** Fires once the user is past both steps (via 跳过 or a save on
   *  either one) — see this section's own header comment for who's
   *  expected to call this and when. */
  onDone: () => void;
}

/** Sequences the two S10 onboarding steps inside ONE WizardFrame (no
 *  remount flash between them). `onNext`/`onDone` only ever mean
 *  "advance" — each step decides for itself whether skipping vs.
 *  saving actually touched Settings; this sequencer doesn't need to
 *  know which happened. */
export function DesktopOnboardingSteps({ onDone }: DesktopOnboardingStepsProps) {
  const [step, setStep] = useState<OnboardingStep>("byok");
  return (
    <WizardFrame>
      <div data-testid="desktop-onboarding-steps" className="space-y-4">
        <div className="text-xs text-mut2">可选步骤 · {step === "byok" ? "1" : "2"} / 2</div>
        {step === "byok" ? (
          <OnboardingByokStep onNext={() => setStep("diarize")} />
        ) : (
          <OnboardingDiarizeStep onNext={onDone} />
        )}
      </div>
    </WizardFrame>
  );
}
