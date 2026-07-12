"use client";

// v0.4 S3 chunk 6 (docs/design-explorations/s3-tauri-uv-blueprint.md,
// §Chunk 6) — mounted once from app/page.tsx: calls initDesktop() on
// mount (idempotent — a no-op on every render after the first, and a
// stable NOT_DESKTOP handle on an ordinary web build, see bootstrap.ts)
// and renders DesktopWizard.tsx whenever the handle's state means the
// user needs to see it: WIZARD_CONSENT_REQUIRED (unless dismissed),
// any actively-provisioning/erroring STEP, or a post-crash
// TERMINAL_ERROR (chunk 7, unless dismissed). Renders null on web
// (IS_DESKTOP false) and null once HEALTHY — the sidecar just works,
// no chrome.
//
// IS_DESKTOP-gated at BOTH the mount site (page.tsx: `{IS_DESKTOP &&
// <DesktopBootstrap />}`) and again here (belt-and-suspenders, mirrors
// this component's own doc contract "mounts nothing on web") — the
// re-exported IS_DESKTOP const is the right tool at both call sites
// (neither writes an `import()` of its own; see tauriApi.ts's header
// comment on when the literal duplicate is actually required, and
// deployTier.ts's own "a plain re-exported const is fine here" note
// for the same presentation-only-gate reasoning).

import { useEffect, useState } from "react";
import { useApp } from "@/lib/store";
import { diagLog } from "@/lib/diag/log";
import { IS_DESKTOP } from "@/lib/platform/desktop";
import {
  initDesktop,
  redactHomePath,
  type DesktopBootstrapHandle,
  type DesktopBootstrapState,
  type DesktopLogLine,
} from "@/lib/desktop/bootstrap";
import type { PrewarmProgressEvent } from "@/lib/desktop/provisionRunner";
import DesktopWizard from "./DesktopWizard";

// Blueprint §Chunk 6: "cap the buffer ~500 lines".
const LOG_BUFFER_CAP = 500;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function DesktopBootstrap() {
  const showToast = useApp((s) => s.showToast);
  const [handle, setHandle] = useState<DesktopBootstrapHandle | null>(null);
  const [state, setState] = useState<DesktopBootstrapState | null>(null);
  const [logLines, setLogLines] = useState<DesktopLogLine[]>([]);
  // S4 chunk 2's prewarm://progress snapshot, threaded through to
  // DesktopWizard.tsx's StepRowsScreen exactly the same
  // snapshot-then-subscribe shape as `state`/`logLines` below (initial
  // currentDownloadProgress() read, then a downloadProgress$ subscribe).
  const [downloadProgress, setDownloadProgress] = useState<PrewarmProgressEvent | null>(null);
  // "稍后再说" / "关闭，稍后处理" (blueprint §Chunk 6 + §Chunk 7): two
  // INDEPENDENT dismiss flags, each auto-reset the moment its own
  // triggering phase is left (see the two effects below) — so
  // dismissing the first-run consent screen can never suppress a
  // LATER, unrelated post-crash error, and vice versa; leaving either
  // phase for ANY reason (success, a fresh reprovision, …) always
  // clears that phase's own dismissal first.
  const [consentDismissed, setConsentDismissed] = useState(false);
  const [terminalDismissed, setTerminalDismissed] = useState(false);

  useEffect(() => {
    if (!IS_DESKTOP) return;
    let cancelled = false;
    let unsubState: (() => void) | null = null;
    let unsubLog: (() => void) | null = null;
    let unsubDownloadProgress: (() => void) | null = null;
    void initDesktop().then((h) => {
      if (cancelled) return;
      setHandle(h);
      setState(h.currentState());
      setDownloadProgress(h.currentDownloadProgress());
      unsubState = h.state$((s) => {
        if (!cancelled) setState(s);
      });
      unsubLog = h.log$((line) => {
        if (cancelled) return;
        setLogLines((prev) => {
          const next = [...prev, line];
          return next.length > LOG_BUFFER_CAP ? next.slice(next.length - LOG_BUFFER_CAP) : next;
        });
      });
      unsubDownloadProgress = h.downloadProgress$((progress) => {
        if (!cancelled) setDownloadProgress(progress);
      });
    });
    return () => {
      cancelled = true;
      unsubState?.();
      unsubLog?.();
      unsubDownloadProgress?.();
    };
  }, []);

  useEffect(() => {
    if (state?.phase !== "WIZARD_CONSENT_REQUIRED") setConsentDismissed(false);
  }, [state?.phase]);

  useEffect(() => {
    if (state?.phase !== "TERMINAL_ERROR") setTerminalDismissed(false);
  }, [state?.phase]);

  // chunk 7: "TERMINAL_ERROR -> wizard error surface + toast" — the
  // wizard screen itself is the "surface" (rendered below regardless of
  // this toast); this effect adds the toast half exactly once per
  // TERMINAL_ERROR occurrence, same logAndToastError two-step
  // (diagLog then a ref-carrying toast) useMeeting.ts's own choke-point
  // wiring already established, reused here rather than re-invented.
  // `terminalReason` (not `state` itself) is the effect's dependency so
  // it only re-fires when we land on a GENUINELY new TERMINAL_ERROR,
  // never on an unrelated state$ notification.
  const terminalReason = state?.phase === "TERMINAL_ERROR" ? state.reason : null;
  useEffect(() => {
    if (terminalReason === null) return;
    // Finding 4: the SAME diag-ring choke point as bootstrap.ts's own
    // STEP_ERROR logging — redactHomePath before it ever reaches
    // diagLog, never before display (DesktopWizard.tsx's terminal
    // screen below still renders `state.reason` raw).
    const entry = diagLog("error", "desktop-server", "本地服务已停止", redactHomePath(terminalReason));
    showToast({ message: "本地语音识别服务反复异常退出，已停止自动重启", ref: entry.ref });
  }, [terminalReason, showToast]);

  if (!IS_DESKTOP || !handle || !state) return null;

  const visible =
    state.phase === "WIZARD_CONSENT_REQUIRED"
      ? !consentDismissed
      : state.phase === "TERMINAL_ERROR"
        ? !terminalDismissed
        : state.phase === "EXTERNAL_UNMANAGED"
          ? false
          : state.phase === "STEP";
  // ^ every STEP shape (RUNNING/POLLING/ERROR) stays visible once
  //   consent was given — there is no "dismiss mid-install" affordance;
  //   the only up-front choice is at WIZARD_CONSENT_REQUIRED. HEALTHY/
  //   CHECKING/NOT_DESKTOP render nothing (the `!handle` guard above
  //   already excludes NOT_DESKTOP in practice, since IS_DESKTOP false
  //   returns before ever reaching this point). EXTERNAL_UNMANAGED
  //   (Finding 2 — user chose an externally-managed sidecar) is spelled
  //   out explicitly rather than left to the STEP fallthrough: this app
  //   never provisions/starts anything in that mode, so there is no
  //   wizard action to ever offer for it.

  if (!visible) return null;

  return (
    <DesktopWizard
      state={state}
      paths={handle.paths}
      logLines={logLines}
      downloadProgress={downloadProgress}
      onBeginProvision={(model) => handle.beginProvision(model)}
      onDismissConsent={() => setConsentDismissed(true)}
      onDismissTerminal={() => setTerminalDismissed(true)}
      onRetry={() => handle.retryStep()}
      onRecheckHealth={() => handle.recheckHealth()}
      onReprovision={async () => {
        try {
          await handle.reprovision();
        } catch (error) {
          showToast(`重新运行安装向导失败：${describeError(error)}`);
        }
      }}
    />
  );
}
