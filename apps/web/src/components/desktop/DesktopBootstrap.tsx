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

import { useEffect, useRef, useState } from "react";
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
import { trackPrewarm } from "@/lib/desktop/jobsBridge";
import DesktopWizard, { DesktopOnboardingSteps } from "./DesktopWizard";

// Blueprint §Chunk 6: "cap the buffer ~500 lines".
const LOG_BUFFER_CAP = 500;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function DesktopBootstrap() {
  const showToast = useApp((s) => s.showToast);
  const setWizardVisible = useApp((s) => s.setWizardVisible);
  const [handle, setHandle] = useState<DesktopBootstrapHandle | null>(null);
  const [state, setState] = useState<DesktopBootstrapState | null>(null);
  const [logLines, setLogLines] = useState<DesktopLogLine[]>([]);
  // S4 chunk 2's prewarm://progress snapshot, threaded through to
  // DesktopWizard.tsx's StepRowsScreen exactly the same
  // snapshot-then-subscribe shape as `state`/`logLines` below (initial
  // currentDownloadProgress() read, then a downloadProgress$ subscribe).
  const [downloadProgress, setDownloadProgress] = useState<PrewarmProgressEvent | null>(null);
  // "稍后再说" / "关闭，稍后处理" (blueprint §Chunk 6 + §Chunk 7), plus
  // the STEP/ERROR 关闭 (v0.4.0 field fix — see DesktopWizardProps.
  // onDismissStepError): three INDEPENDENT dismiss flags, each
  // auto-reset the moment its own triggering phase/status is left (see
  // the effects below) — so dismissing the first-run consent screen can
  // never suppress a LATER, unrelated post-crash error, and vice versa;
  // leaving either phase for ANY reason (success, a fresh reprovision,
  // …) always clears that phase's own dismissal first. The STEP/ERROR
  // flag only ever suppresses the ERROR status — a retry kicked off
  // from elsewhere (Settings → 重新运行安装向导 lands on the consent
  // phase, which resets it) re-shows the wizard as usual.
  const [consentDismissed, setConsentDismissed] = useState(false);
  const [terminalDismissed, setTerminalDismissed] = useState(false);
  const [stepErrorDismissed, setStepErrorDismissed] = useState(false);
  // Field-test issue 6 (cancellable first-run model downloads) — set by
  // the wizard's own 「后台继续」 button (onBackgroundDownload below).
  // UNLIKE the three dismiss flags above (each resets the moment its
  // own triggering phase/status is left), this one deliberately stays
  // true for the REST of the STEP-phase drive once set — through
  // STARTING/POLLING_HEALTH and even a LATER STEP/ERROR in that SAME
  // drive — because "后台继续" promises the user the wizard won't force
  // back open on completion OR failure; both instead surface via the
  // tray row (jobsBridge.ts's trackPrewarm) and existing toasts. Only
  // resets once the drive actually LEAVES the STEP phase (HEALTHY, or
  // bounced back to WIZARD_CONSENT_REQUIRED/TERMINAL_ERROR by some
  // other path) — see the effect below — so a FUTURE, unrelated
  // provisioning attempt never inherits a stale backgrounding choice.
  // A "userBackgrounded" flag added alongside the existing never-
  // dismissible-mid-flight invariant (`visible` below), not a weakening
  // of it — every OTHER RUNNING step stays exactly as un-dismissible as
  // before this fix.
  const [downloadBackgrounded, setDownloadBackgrounded] = useState(false);
  // S10 field-fix (item #3 / Chunk C handoff, wave 2 mount): the two
  // OPTIONAL onboarding steps (DesktopWizard.tsx's own
  // DesktopOnboardingSteps — see that export's header comment for the
  // full contract) show exactly ONCE per app session, right after
  // observing a REAL STEP -> HEALTHY transition (this launch's own
  // provisioning wizard just finished) — never on CHECKING -> HEALTHY
  // (an ordinary launch adopting an already-healthy sidecar; a
  // returning user is never nagged), never persisted. prevPhaseRef/
  // onboardingShownRef are plain session-local refs, not store/
  // localStorage state — a fresh app launch always starts both unset,
  // and this component itself only ever mounts once for the app's
  // whole lifetime (see page.tsx's own `{IS_DESKTOP && <DesktopBootstrap
  // />}`).
  //
  // F6 (MEDIUM, adversarial review): a bare STEP -> HEALTHY transition
  // is NOT unique to a first-run provisioning drive — bootstrap.ts's
  // own performSwitchModel/landOnSwitchFailure reuse the exact same
  // "STEP" phase for a LATER model-switch failure, so a returning user
  // whose switch fails then recovers (HEALTHY -> STEP/ERROR -> HEALTHY)
  // was getting nagged with first-run onboarding too. provisionBegunRef
  // is armed ONLY by the consent screen's own begin-provision action
  // (onBeginProvision below, the one real "a first-run drive is
  // starting" seam) — the trigger below now requires BOTH refs, not
  // just the phase transition shape.
  // F3 (review round, K1 = Sol MEDIUM #14 + Opus IMPORTANT): the 后台
  // continues promise (downloadBackgrounded's own doc comment above)
  // extends to this onboarding pop too — a first-run download the user
  // explicitly backgrounded must not ambush them with the full-screen
  // onboarding overlay when it completes to HEALTHY while they're away.
  // downloadBackgrounded itself can't gate the trigger below — it
  // resets the moment the drive leaves the STEP phase (see that flag's
  // own comment), so by the time the effect below observes STEP ->
  // HEALTHY, it may already be back to false. Fixed per Opus's guidance:
  // onBackgroundDownload sets onboardingShownRef directly (below),
  // permanently suppressing the pop for the rest of this app session —
  // exactly as if onboarding HAD already been shown, same one-shot
  // contract this ref already carries.
  const prevPhaseRef = useRef<DesktopBootstrapState["phase"] | null>(null);
  const provisionBegunRef = useRef(false);
  const onboardingShownRef = useRef(false);
  // Field-test issue 6: the wizard's own <ModelPicker> pick, captured at
  // onBeginProvision time (the one place this component already learns
  // it) purely so onBackgroundDownload below can pass it to jobsBridge.
  // ts's trackPrewarm for its tray row's label (modelLabel(model)) — a
  // ref, not state, since it never needs to trigger a re-render on its
  // own.
  const provisioningModelRef = useRef<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

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

  // The STEP/ERROR dismiss flag resets on leaving the ERROR status, not
  // just the STEP phase — so a 重试 that re-enters RUNNING (or a
  // reprovision landing back on consent) always re-arms the overlay for
  // the NEXT error, mirroring the two per-phase resets above.
  const inStepError = state?.phase === "STEP" && state.status === "ERROR";
  useEffect(() => {
    if (!inStepError) setStepErrorDismissed(false);
  }, [inStepError]);

  // Field-test issue 6: resets downloadBackgrounded once the drive
  // actually LEAVES the STEP phase — see that flag's own doc comment
  // above for why this is phase-level (not status-level like
  // inStepError above): the whole point is to stay true across every
  // STEP status/step transition WITHIN the same drive.
  const inStepPhase = state?.phase === "STEP";
  useEffect(() => {
    if (!inStepPhase) setDownloadBackgrounded(false);
  }, [inStepPhase]);

  // S10 field-fix onboarding mount: watches for a STEP -> HEALTHY
  // transition (this launch's own provisioning wizard just finished) —
  // see prevPhaseRef/onboardingShownRef/provisionBegunRef's own doc
  // comment above for the full contract. prevPhaseRef starts `null`, so
  // the FIRST snapshot ever observed (whatever phase it lands on,
  // including an immediate HEALTHY on a returning user's ordinary
  // launch) can never itself satisfy `prevPhase === "STEP"` — CHECKING
  // -> HEALTHY is excluded by construction, not a special case below.
  // provisionBegunRef additionally excludes a LATER STEP/ERROR ->
  // HEALTHY that never went through a real provisioning begin (F6 — a
  // model-switch failure recovering reuses the same "STEP" phase).
  useEffect(() => {
    const prevPhase = prevPhaseRef.current;
    prevPhaseRef.current = state?.phase ?? null;
    if (
      !onboardingShownRef.current &&
      provisionBegunRef.current &&
      prevPhase === "STEP" &&
      state?.phase === "HEALTHY"
    ) {
      onboardingShownRef.current = true;
      setShowOnboarding(true);
    }
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

  // Field-test fix (desktop first-run onboarding never seen — verified
  // root cause): mirrors `visible`/`showOnboarding` below into
  // store.ts's wizardVisible, so page.tsx can sequence the first-run
  // tutorial's auto-open AFTER this component stops covering the screen
  // instead of racing it (both this and TutorialOverlay.tsx render
  // `fixed inset-0 z-50`; this component mounts LATER in page.tsx's own
  // JSX, so equal z-index + later DOM always won that tie before this
  // fix). ALSO folds in showOnboarding — DesktopOnboardingSteps renders
  // the exact same WizardFrame chrome (see that component's own header
  // comment), so it's every bit as much "covering the screen" as the
  // wizard itself; omitting it here would just move the same race to the
  // STEP -> HEALTHY handoff into those two optional steps. Computed here
  // (duplicating `visible`'s own phase ternary below, not reusing that
  // const directly) because every hook — including this effect — must
  // run unconditionally, ahead of the `!state` early return just below
  // (Rules of Hooks); `!!state` keeps it a safe `false` before
  // initDesktop() has resolved rather than reading `state.phase` on a
  // possibly-null `state`.
  const wizardOverlayVisible =
    !!state &&
    (showOnboarding ||
      (state.phase === "WIZARD_CONSENT_REQUIRED"
        ? !consentDismissed
        : state.phase === "TERMINAL_ERROR"
          ? !terminalDismissed
          : state.phase === "EXTERNAL_UNMANAGED"
            ? false
            : state.phase === "STEP" &&
              !(state.status === "ERROR" && stepErrorDismissed) &&
              !downloadBackgrounded));
  useEffect(() => {
    setWizardVisible(wizardOverlayVisible);
    return () => setWizardVisible(false);
  }, [wizardOverlayVisible, setWizardVisible]);

  if (!IS_DESKTOP || !handle || !state) return null;

  // Onboarding takes priority once triggered — by construction it only
  // ever fires after landing on HEALTHY (see the effect above), which
  // is exactly the phase the `visible` computation below always treats
  // as "nothing to show" anyway, so there's no real overlay conflict to
  // adjudicate here. onDone unmounts it (falls back through to the
  // `visible` branch below, which stays false for HEALTHY).
  if (showOnboarding) {
    return <DesktopOnboardingSteps onDone={() => setShowOnboarding(false)} />;
  }

  const visible =
    state.phase === "WIZARD_CONSENT_REQUIRED"
      ? !consentDismissed
      : state.phase === "TERMINAL_ERROR"
        ? !terminalDismissed
        : state.phase === "EXTERNAL_UNMANAGED"
          ? false
          : state.phase === "STEP" && !(state.status === "ERROR" && stepErrorDismissed) && !downloadBackgrounded;
  // ^ an actively-advancing STEP (RUNNING/POLLING) stays visible once
  //   consent was given — install progress is never dismissible
  //   mid-flight — but the ERROR status is (v0.4.0 field fix): a
  //   deterministic failure otherwise traps the user in a full-screen
  //   overlay whose only affordance is a 重试 that can never succeed,
  //   with the Settings panel its own escape-hatch text points at
  //   unreachable behind it. HEALTHY/CHECKING/NOT_DESKTOP render
  //   nothing (the `!handle` guard above already excludes NOT_DESKTOP
  //   in practice, since IS_DESKTOP false returns before ever reaching
  //   this point). EXTERNAL_UNMANAGED (Finding 2 — user chose an
  //   externally-managed sidecar) is spelled out explicitly rather than
  //   left to the STEP fallthrough: this app never provisions/starts
  //   anything in that mode, so there is no wizard action to ever offer
  //   for it. downloadBackgrounded (field-test issue 6) is the ONE
  //   dismissibility this invariant now carves out — see that flag's
  //   own doc comment above for why it's added alongside the
  //   never-dismissible-mid-flight rule rather than a weakening of it.

  if (!visible) return null;

  return (
    <DesktopWizard
      state={state}
      paths={handle.paths}
      logLines={logLines}
      downloadProgress={downloadProgress}
      onBeginProvision={(model) => {
        // F6: the ONE seam that means "a real first-run provisioning
        // is actually starting" — see provisionBegunRef's own doc
        // comment above.
        provisionBegunRef.current = true;
        // Field-test issue 6: stashed for onBackgroundDownload below —
        // see provisioningModelRef's own doc comment above.
        provisioningModelRef.current = model;
        handle.beginProvision(model);
      }}
      onDismissConsent={() => setConsentDismissed(true)}
      onDismissTerminal={() => setTerminalDismissed(true)}
      onDismissStepError={() => setStepErrorDismissed(true)}
      onRetry={() => handle.retryStep()}
      onRecheckHealth={() => handle.recheckHealth()}
      onReprovision={async () => {
        try {
          await handle.reprovision();
        } catch (error) {
          showToast(`重新运行安装向导失败：${describeError(error)}`);
        }
      }}
      onBackgroundDownload={() => {
        setDownloadBackgrounded(true);
        // F3 (review round): permanently suppresses the S10 onboarding
        // pop for the rest of this session — see onboardingShownRef's
        // own doc comment above for why downloadBackgrounded itself
        // can't gate that trigger. A later, unrelated first-run drive
        // (if one somehow still happens this session) also skips
        // onboarding as a result — accepted: onboarding is already a
        // one-shot-per-session affordance by design, and a user who
        // backgrounded once has already signaled "leave me alone".
        onboardingShownRef.current = true;
        // DOWNLOAD_MODEL/RUNNING is only ever reached via a fresh
        // beginProvision() call (the provisioned-dead auto-drive path
        // skips straight to STARTING, marker already on disk) — the ref
        // is always set by the time this button is even reachable; the
        // "" fallback is defense-in-depth only (modelLabel("") degrades
        // to an empty label, never a crash).
        trackPrewarm(handle, provisioningModelRef.current ?? "");
      }}
      onCancelPrewarm={async () => {
        try {
          await handle.cancelPrewarm();
        } catch (error) {
          showToast(`取消下载失败：${describeError(error)}`);
        }
      }}
    />
  );
}
