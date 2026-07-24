"use client";

import { useEffect, useRef, useState } from "react";
import { SidebarSimple } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { useMeeting } from "@/hooks/useMeeting";
import { IS_DESKTOP } from "@/lib/platform/desktop";
import { IS_IOS } from "@/lib/platform/ios";
import DesktopBootstrap from "@/components/desktop/DesktopBootstrap";
import Header from "@/components/Header";
import StatusLine from "@/components/StatusLine";
import TranscriptPanel from "@/components/TranscriptPanel";
import CardsPanel from "@/components/CardsPanel";
import SummaryPanel from "@/components/SummaryPanel";
import GlossaryPanel from "@/components/GlossaryPanel";
import HistoryDrawer from "@/components/HistoryDrawer";
import TaskCenterDrawer from "@/components/TaskCenterDrawer";
import ImportHub, { type HubTab } from "@/components/ImportHub";
import ModeSelector from "@/components/ModeSelector";
import SettingsDialog from "@/components/SettingsDialog";
import TutorialOverlay, { shouldShowTutorial } from "@/components/TutorialOverlay";
import LookupPopover from "@/components/LookupPopover";
import Toast from "@/components/Toast";
import RecoveryBanner from "@/components/RecoveryBanner";
import FloatingCaption from "@/components/FloatingCaption";
import { installGlobalDiagHandlers } from "@/lib/diag/globalHandlers";
import { checkAppUpdate } from "@/lib/desktop/updateCheck";
import { initIos } from "@/lib/desktop/bootstrap";
import { enterDesktopCaptionMode, exitDesktopCaptionMode } from "@/lib/captionWindow";
import { nextHelpOpenForWizardTransition } from "./wizardHelpTransition";

type RightTab = "cards" | "summary" | "glossary";

// Mobile bottom-panel height (Miana's v0.2.2 E2E request: the bottom
// bar must be user-resizable on phones). Persisted per device — this
// is an ergonomic viewport preference like display scale, so it lives
// in plain localStorage (displayStorage mirror pattern), not Settings.
const PANEL_H_KEY = "js-mobile-panel-h";
const PANEL_MIN_PX = 120;
const PANEL_MAX_VH = 0.8;

function clampPanelH(h: number): number {
  const max = Math.round(window.innerHeight * PANEL_MAX_VH);
  return Math.min(max, Math.max(PANEL_MIN_PX, Math.round(h)));
}

function loadPanelH(): number | null {
  try {
    const raw = localStorage.getItem(PANEL_H_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function savePanelH(h: number): void {
  try {
    localStorage.setItem(PANEL_H_KEY, String(h));
  } catch {
    // storage unavailable (private mode) — resize still works for the session
  }
}

export default function Home() {
  const { start, pause, resume, stop, startDemo } = useMeeting();
  const hydrate = useApp((s) => s.hydrate);
  const status = useApp((s) => s.status);
  const summary = useApp((s) => s.summary);
  const segments = useApp((s) => s.segments);
  const focusMode = useApp((s) => s.focusMode);
  const setFocusMode = useApp((s) => s.setFocusMode);
  const captionMode = useApp((s) => s.captionMode);
  const setCaptionMode = useApp((s) => s.setCaptionMode);
  // Field-test fix (desktop first-run onboarding never seen): mirrored
  // from DesktopBootstrap.tsx's own effect — see store.ts's wizardVisible
  // doc for the full contract. Permanently false on a web build.
  const wizardVisible = useApp((s) => s.wizardVisible);

  const [tab, setTab] = useState<RightTab>("cards");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // S10 field-fix #6 (Q2 verdict): TaskCenterDrawer's own open state,
  // same "lifted to page.tsx" posture as historyOpen/settingsOpen above
  // — StatusLine's TaskTray chip (threaded down as onOpenTaskCenter)
  // opens it; wave 2 adds a desktop Header launcher for the same state.
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  // #62 item 2: lifted here (not owned by HistoryDrawer) so Header's
  // 导入 pill (desktop peer of the engine pills + mobile icon button)
  // and HistoryDrawer's own 导入 button open the exact same ImportHub
  // instance/open-state — mounting it once below means it also stays
  // open even if the drawer behind it closes, instead of unmounting
  // with it.
  const [importHubOpen, setImportHubOpen] = useState(false);
  // v0.5 Wave-1 Feature 5 (mode-first UI): ModeSelector's 导入/链接
  // tiles want ImportHub to open on a SPECIFIC tab; every other opener
  // (Header's 导入 pill, HistoryDrawer's own button) leaves this
  // undefined, so ImportHub's own default ("file") is unchanged. Reset
  // to undefined on close so a later GENERIC open never inherits a
  // stale tile-requested tab.
  const [importInitialTab, setImportInitialTab] = useState<HubTab | undefined>(undefined);

  // Mobile bottom-panel resize state. null = never dragged on this
  // device → the default content-driven max-h-[55vh] behavior. Only
  // applied below lg (the panel is a right sidebar on desktop, where
  // its width is fixed by design).
  const [panelH, setPanelH] = useState<number | null>(null);
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    setPanelH(loadPanelH());
    const mq = window.matchMedia("(max-width: 1023.5px)");
    const apply = () => setIsMobileLayout(mq.matches);
    apply();
    // Both listeners on purpose: MQL "change" is the semantic signal,
    // but some environments (DevTools device emulation, some zoom
    // paths) update mq.matches without firing it — the plain resize
    // fallback re-reads it so the inline height can never stick to
    // the desktop layout.
    mq.addEventListener("change", apply);
    window.addEventListener("resize", apply);
    return () => {
      mq.removeEventListener("change", apply);
      window.removeEventListener("resize", apply);
    };
  }, []);

  const beginPanelDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const aside = e.currentTarget.parentElement;
    if (!aside) return;
    dragRef.current = { startY: e.clientY, startH: aside.getBoundingClientRect().height };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // capture unsupported for this pointer type — move/up on the
      // handle itself still resize, just without off-element tracking
    }
  };
  const movePanelDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    // Panel is bottom-docked: dragging the handle UP grows it.
    setPanelH(clampPanelH(dragRef.current.startH + (dragRef.current.startY - e.clientY)));
  };
  const endPanelDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setPanelH((h) => {
      if (h != null) savePanelH(h);
      return h;
    });
  };
  const nudgePanel = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const current =
      panelH ?? Math.round(window.innerHeight * 0.4); // ≈ the default posture
    let next: number | null = null;
    if (e.key === "ArrowUp") next = clampPanelH(current + 24);
    else if (e.key === "ArrowDown") next = clampPanelH(current - 24);
    if (next != null) {
      e.preventDefault();
      setPanelH(next);
      savePanelH(next);
    }
  };

  useEffect(() => {
    void hydrate();
    // Diagnostics (item 2): window error/unhandledrejection -> diag
    // ring buffer, registered once right alongside hydrate() — see
    // lib/diag/globalHandlers.ts's own doc comment.
    installGlobalDiagHandlers();
    // Field-test fix (desktop first-run onboarding never seen — verified
    // root cause): skip the auto-open while the desktop provisioning
    // wizard is covering the screen (wizardVisible — see store.ts's own
    // doc). This mount-time gate alone can't catch a TRUE first-run
    // wizard on its own: wizardVisible is still its just-mounted default
    // (false) at this exact tick on every platform, since
    // DesktopBootstrap's initDesktop() call is inherently async and
    // can't have reported a real value yet — the watcher effect below
    // (which reopens the tutorial the moment wizardVisible actually
    // transitions back to false) is what closes that gap. This gate's
    // own job is simpler: web builds and any desktop launch that never
    // needs the wizard at all, where wizardVisible just never leaves
    // `false` — byte-equivalent to the old unconditional open for both.
    if (shouldShowTutorial() && !wizardVisible) setHelpOpen(true);
    // S10 field-fix #8: on-launch update check, desktop only, quiet —
    // no toast/banner, Header's 后台任务 dot + TaskCenterDrawer's own
    // system-status row are the only surfacing (Q2 verdict). Fires
    // once per app session alongside this same mount effect.
    // checkAppUpdate() is IS_DESKTOP-guarded internally too (inert
    // no-op on a web build, never throws — see that module's own doc
    // comment); the check here just skips the call outright on web
    // rather than relying on that internal guard alone.
    if (IS_DESKTOP) void checkAppUpdate();
    // S13 (docs/design-explorations/s13-ios-blueprint.md, §6 D4/D6) —
    // iOS init: ONLY the LLM transport wiring (bootstrap.ts's own
    // initIos() doc comment) — no wizard/update-check chrome, so unlike
    // DesktopBootstrap below this needs no component of its own, the
    // same "inline call in this mount effect" shape as checkAppUpdate()
    // just above. initIos() is IS_IOS-guarded internally too (inert
    // no-op on a non-iOS build); the check here just skips the call
    // outright rather than relying on that internal guard alone.
    if (IS_IOS) void initIos();
  }, [hydrate]);

  // Jump to the report tab the moment a summary lands.
  const prevSummary = useRef(summary);
  useEffect(() => {
    if (!prevSummary.current && summary) setTab("summary");
    prevSummary.current = summary;
  }, [summary]);

  // S14 floating caption, desktop host: captionMode is a plain store
  // flag (Header.tsx's ≡ menu writes it) — this effect is what actually
  // drives the OS window on a real transition, mirroring prevSummary's
  // own "compare against the previous value" shape just above (skips
  // the mount-time firing, which would otherwise call
  // exitDesktopCaptionMode() once on every launch since captionMode
  // always starts false). enterDesktopCaptionMode()/exitDesktopCaptionMode()
  // are fire-and-forget (void promises, no rect round-trip through this
  // effect) — captionWindow.ts's own module-level queue+generation
  // serialization is what keeps a pending enter from landing after an
  // exit (S14 fix-round findings 1+3).
  const prevCaptionMode = useRef(captionMode);
  useEffect(() => {
    if (IS_DESKTOP && prevCaptionMode.current !== captionMode) {
      if (captionMode) {
        void enterDesktopCaptionMode();
      } else {
        void exitDesktopCaptionMode();
      }
    }
    prevCaptionMode.current = captionMode;
  }, [captionMode]);

  // Field-test fix (desktop first-run onboarding never seen): once the
  // desktop wizard (or its optional post-install onboarding steps — both
  // fold into wizardVisible, see DesktopBootstrap.tsx's own doc) stops
  // covering the screen, open the first-run tutorial THEN — see the
  // mount-time gate's own comment above for why this transition watcher
  // is the half that actually catches a true first-run wizard. Also
  // fires on an ordinary dismiss (稍后再说 etc.): any transition off
  // "covering the screen" is a fair "the user can see the tutorial now"
  // moment, not just a completed install. prevWizardVisible starts at
  // wizardVisible's own initial (false) value, so there's no false->false
  // no-op misfire the instant this effect first subscribes — same
  // "compare against the previous value" shape as prevSummary/
  // prevCaptionMode above.
  //
  // F3 fix (Sol MEDIUM / Opus LOW, fieldtest-a review): symmetric
  // false->true arm added. The mount-time gate above can only see
  // wizardVisible's just-mounted default (false), so on a real desktop
  // first run it opens the tutorial BEFORE DesktopBootstrap's async
  // initDesktop() has had a chance to report wizardVisible:true — for
  // one render window BOTH full-screen overlays are mounted (the wizard
  // paints on top by DOM order, but the tutorial stays mounted
  // underneath with focus/tab-order still reachable into its now-
  // invisible controls). Closing the tutorial the instant wizardVisible
  // flips true shrinks that window to nothing; shouldShowTutorial()'s
  // own re-check in the other arm still reopens it once the wizard is
  // done. NOT handled: a user who manages to click 跳过 inside that
  // sub-second pre-wizard window still permanently marks the tutorial
  // done (markTutorialDone writes localStorage synchronously in
  // TutorialOverlay's finish()) — accepted residual, not chased here.
  const prevWizardVisible = useRef(wizardVisible);
  useEffect(() => {
    setHelpOpen((cur) =>
      nextHelpOpenForWizardTransition(prevWizardVisible.current, wizardVisible, cur, shouldShowTutorial()),
    );
    prevWizardVisible.current = wizardVisible;
  }, [wizardVisible]);

  const summaryReady = status === "stopped" && segments.length > 0;

  // Caption mode (desktop only, set via Header's ≡ menu): replace the
  // ENTIRE normal layout with the shared floating-caption view — the
  // effect above has already shrunk this window into a caption strip
  // by the time this can even be true (captionMode only flips on
  // IS_DESKTOP builds — see Header.tsx's own gate). Its ✕ close button
  // is this mode's only exit affordance; onClose flips the store flag
  // back, which the effect above observes and restores the window.
  if (captionMode) {
    return <FloatingCaption onClose={() => setCaptionMode(false)} />;
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header
        onStart={() => void start()}
        onPause={() => void pause()}
        onResume={() => void resume()}
        onStop={() => void stop()}
        onDemo={() => void startDemo()}
        onOpenHistory={() => setHistoryOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
        onOpenImport={() => setImportHubOpen(true)}
        onOpenTaskCenter={() => setTaskCenterOpen(true)}
      />
      <RecoveryBanner />

      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="relative min-h-0 min-w-0 flex-1 border-b border-edge lg:border-b-0 lg:border-r">
          <TranscriptPanel onDemo={() => void startDemo()} />
          {/* v0.5 Wave-1 Feature 5 (mode-first UI): overlays TranscriptPanel's
              OWN (untouched) idle/empty-state block on the exact same gate
              its isEmpty check uses — replaces the old "选择下方引擎" copy
              with mode-first tiles without editing that owned file. */}
          {status === "idle" && segments.length === 0 && (
            <ModeSelector
              onOpenImport={(tab) => {
                setImportInitialTab(tab);
                setImportHubOpen(true);
              }}
              onDemo={() => void startDemo()}
            />
          )}
        </section>

        {!focusMode && (
          <aside
            className="flex max-h-[55vh] w-full shrink-0 flex-col min-h-0 lg:max-h-none lg:w-[400px] xl:w-[440px]"
            style={
              isMobileLayout && panelH != null
                ? { height: panelH, maxHeight: `${PANEL_MAX_VH * 100}vh` }
                : undefined
            }
          >
            {/* Drag handle — phones only (bottom-sheet grab bar). */}
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="拖动调整解释面板高度"
              tabIndex={0}
              onPointerDown={beginPanelDrag}
              onPointerMove={movePanelDrag}
              onPointerUp={endPanelDrag}
              onPointerCancel={endPanelDrag}
              onKeyDown={nudgePanel}
              className="flex h-4 shrink-0 cursor-row-resize touch-none items-center justify-center border-b border-edge bg-panel2 focus:outline-none focus-visible:bg-panel3 lg:hidden"
            >
              <span className="h-1 w-10 bg-mut2/60" aria-hidden />
            </div>
            <div className="flex items-center gap-1 border-b border-edge bg-panel2 px-3 pt-2">
              {(
                [
                  ["cards", "实时解释"],
                  ["summary", "纪要与导出"],
                  ["glossary", "我的词典"],
                ] as [RightTab, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  data-testid={`tab-${key}`}
                  onClick={() => setTab(key)}
                  className={`relative px-3 py-2 font-mono text-xs uppercase tracking-wide transition-colors ${
                    tab === key
                      ? "border border-b-0 border-edge bg-panel text-fg"
                      : "text-mut hover:text-fg"
                  }`}
                >
                  {label}
                  {key === "summary" && summaryReady && !summary && (
                    <span className="absolute -right-0.5 top-1.5 h-1.5 w-1.5 rounded-full bg-lab-orange" />
                  )}
                </button>
              ))}
              <button
                data-testid="btn-focus-mode"
                onClick={() => setFocusMode(true)}
                title="专注模式：只看转录，悬停高亮表达即可查看释义"
                className="btn-tactile ml-auto flex h-8 w-8 items-center justify-center border border-transparent text-mut hover:border-edge hover:bg-panel3 hover:text-fg"
              >
                <SidebarSimple size={18} />
              </button>
            </div>
            <div className="min-h-0 flex-1 bg-panel">
              {tab === "cards" ? (
                <CardsPanel />
              ) : tab === "summary" ? (
                <SummaryPanel />
              ) : (
                <GlossaryPanel />
              )}
            </div>
          </aside>
        )}
      </main>

      <StatusLine onOpenTaskCenter={() => setTaskCenterOpen(true)} />

      {focusMode && (
        <button
          data-testid="btn-exit-focus"
          onClick={() => setFocusMode(false)}
          title="退出专注模式"
          className="btn-tactile fixed right-4 top-[100px] z-40 flex h-9 w-9 items-center justify-center border border-edge bg-panel text-mut shadow-lg hover:bg-panel3 hover:text-fg"
        >
          <SidebarSimple size={18} weight="fill" />
        </button>
      )}

      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onOpenImport={() => setImportHubOpen(true)}
      />
      <TaskCenterDrawer open={taskCenterOpen} onClose={() => setTaskCenterOpen(false)} />
      <ImportHub
        open={importHubOpen}
        onClose={() => {
          setImportHubOpen(false);
          setImportInitialTab(undefined);
        }}
        initialTab={importInitialTab}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <TutorialOverlay
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        onStartDemo={() => void startDemo()}
      />
      <LookupPopover />
      <Toast />
      {/* v0.4 S3 chunk 6: first-run local sidecar provisioning wizard —
         renders nothing on an ordinary web build (see DesktopBootstrap.
         tsx's own header comment for why this is gated at BOTH this
         call site and again inside that component). */}
      {IS_DESKTOP && <DesktopBootstrap />}
    </div>
  );
}
