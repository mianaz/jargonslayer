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
import CardStrip from "@/components/CardStrip";
import MobilePanels from "@/components/MobilePanels";
import BottomSheet from "@/components/BottomSheet";
import HistoryDrawer from "@/components/HistoryDrawer";
import TaskCenterDrawer from "@/components/TaskCenterDrawer";
import ImportHub, { type HubTab } from "@/components/ImportHub";
import ModeSelector from "@/components/ModeSelector";
import BitCelebrationOverlay from "@/components/BitCelebrationOverlay";
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
import { checkUpdates as checkPackUpdates, listPackSources } from "@/lib/detect/remotePacks";
import { warmSystemTranslateProbeForStartup } from "@/lib/translate/providers";
import { nextHelpOpenForWizardTransition } from "./wizardHelpTransition";
import { triggerDictPackAutoUpdate } from "./dictPackAutoUpdateTrigger";
import { CardArrivalAnnouncer } from "@/lib/a11y";

type RightTab = "cards" | "summary";

export default function Home() {
  const { start, pause, resume, stop, startDemo, stopConfirm, confirmStop, cancelStop } =
    useMeeting();
  const hydrate = useApp((s) => s.hydrate);
  // Round-2 dict-pack auto-update: gates the effect below so its first
  // run reads the REAL persisted settings.packAutoUpdate/
  // packAutoUpdateCheckedAt, not the pre-hydration DEFAULT_SETTINGS
  // placeholder (`settings` itself starts out as DEFAULT_SETTINGS until
  // hydrate() actually resolves — see store.ts's own hydrate() doc).
  const hydrated = useApp((s) => s.hydrated);
  const status = useApp((s) => s.status);
  const summary = useApp((s) => s.summary);
  const segments = useApp((s) => s.segments);
  const focusMode = useApp((s) => s.focusMode);
  const setFocusMode = useApp((s) => s.setFocusMode);
  const setFocusCard = useApp((s) => s.setFocusCard);
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
  // Mobile toolbar migration: 选择/AI 校正 open-state lifted here so
  // Header's mobile 选择/AI 校正 buttons and TranscriptPanel's own desktop
  // buttons can drive the SAME state — see Header.tsx's MobileToolbarButtons
  // and TranscriptPanel.tsx's controlled/uncontrolled hybrid doc comments.
  const [selectMode, setSelectMode] = useState(false);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  // v0.5 Wave-1 Feature 5 (mode-first UI): ModeSelector's 导入/链接
  // tiles want ImportHub to open on a SPECIFIC tab; every other opener
  // (Header's 导入 pill, HistoryDrawer's own button) leaves this
  // undefined, so ImportHub's own default ("file") is unchanged. Reset
  // to undefined on close so a later GENERIC open never inherits a
  // stale tile-requested tab.
  const [importInitialTab, setImportInitialTab] = useState<HubTab | undefined>(undefined);

  // isMobileLayout: starts at IS_IOS (build-time constant — NEXT_PUBLIC_IOS
  // is baked at build time) so an iOS build paints the mobile layout from
  // first render with no hydration flip. Web builds start false and the
  // effect below flips it after the real matchMedia check.
  const [isMobileLayout, setIsMobileLayout] = useState(IS_IOS);
  // Mobile full-screen panels view (CardStrip's 全部卡片 / strip-card tap).
  // null = closed; CardStrip owns focusCardId consumption while closed
  // (focusEnabled prop below), this view owns it while open.
  const [mobilePanelTab, setMobilePanelTab] = useState<RightTab | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023.5px)");
    const apply = () => {
      setIsMobileLayout(mq.matches);
      // Crossing to desktop unmounts the mobile panels view; drop its
      // state too so shrinking the window later doesn't silently
      // reopen it (Sol LOW, review round 1).
      if (!mq.matches) setMobilePanelTab(null);
    };
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

  useEffect(() => {
    const hydration = hydrate();
    void hydration;
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
    if (IS_DESKTOP) {
      void checkAppUpdate();
    }
    // HIGH-1 fix (v0.6 round-2 review), widened for iOS's own native
    // system-translate lane (same 4 invoke commands as desktop — see
    // providers.ts's NATIVE_SYSTEM_TRANSLATE): warm the probe once
    // hydration resolves, so the FIRST meeting after a cold app launch
    // already sees a warm cache when translateEngine is "system" — see
    // warmSystemTranslateProbeForStartup's own doc comment in
    // lib/translate/providers.ts (itself a no-op on neither platform, but
    // gated here too rather than relying on that internal guard alone,
    // matching checkAppUpdate/initIos's own posture in this same effect).
    if (IS_DESKTOP || IS_IOS) {
      void hydration.then(() => warmSystemTranslateProbeForStartup(useApp.getState().settings));
    }
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

  // Round-2 dict-pack auto-update: once hydration settles, and again on
  // every browser "online" event (opportunistic — connectivity just
  // came back), ask runPackAutoUpdate whether an auto-refresh is
  // actually due — see lib/detect/packAutoUpdate.ts for the gate/
  // never-throw contract, and dictPackAutoUpdateTrigger.ts for why this
  // glue lives in its own file rather than inlined here (page.tsx has
  // no component test harness — same reason wizardHelpTransition.ts is
  // split out, see that file's own header comment). Fire-and-forget
  // both times: never awaited, never blocks startup. Web/desktop/iOS
  // all share this one effect (no platform gate) — dict packs are
  // already a cross-platform, IndexedDB-backed feature with no engine/
  // platform restriction of their own.
  //
  // isMeetingActive mirrors the SAME three-status rule bootstrap.ts's
  // own resolveIsMeetingActive and SettingsDialog.tsx's own
  // meetingActive already use ("paused" counts too — refreshing pack
  // manifests while a meeting is merely paused, not stopped, would
  // still rebuild scanDictionary's regex caches out from under a
  // meeting the user intends to resume). No shared export exists for
  // this predicate (see SettingsDialog.tsx's own doc on why it mirrors
  // rather than imports one) — this is a third mirror of the same rule,
  // not a different one.
  useEffect(() => {
    if (!hydrated) return;
    const isMeetingActive = () => {
      const s = useApp.getState().status;
      return s === "connecting" || s === "listening" || s === "paused";
    };
    const runCheck = () => {
      void triggerDictPackAutoUpdate({
        getSettings: () => useApp.getState().settings,
        isOnline: () => navigator.onLine,
        isMeetingActive,
        listPackSources,
        // MEDIUM-2 fix (v0.6 round-2 review): threads the SAME
        // isMeetingActive predicate into checkUpdates' own shouldContinue
        // param — its multi-second refetch loop needs its own re-check
        // right before writing, not just the entry-time one above (see
        // remotePacks.ts's own checkUpdates doc comment).
        checkUpdates: () => checkPackUpdates(() => !isMeetingActive()),
        recordCheckedAt: (checkedAt) =>
          useApp.getState().updateSettings({ packAutoUpdateCheckedAt: checkedAt }),
      });
    };
    runCheck();
    window.addEventListener("online", runCheck);
    return () => window.removeEventListener("online", runCheck);
  }, [hydrated]);

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
    // iOS reads --app-vvh (bootstrap.ts's visualViewport keyboard pin,
    // Opus F4): while the software keyboard is up the shell compresses
    // to the visual viewport instead of letting WebKit slide the whole
    // page; falls back to 100vh (identical to h-screen) otherwise.
    // Web/desktop keep the literal h-screen.
    <div
      className={`flex flex-col overflow-hidden ${
        IS_IOS ? "h-[var(--app-vvh,100vh)]" : "h-screen"
      }`}
    >
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
        isMobileLayout={isMobileLayout}
        selectMode={selectMode}
        onToggleSelectMode={() => setSelectMode((v) => !v)}
        onOpenCorrection={() => setCorrectionOpen(true)}
      />
      <RecoveryBanner />

      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="relative min-h-0 min-w-0 flex-1 border-b border-edge lg:border-b-0 lg:border-r">
          <TranscriptPanel
            isMobileLayout={isMobileLayout}
            selectMode={selectMode}
            onToggleSelectMode={() => setSelectMode((v) => !v)}
            correctionOpen={correctionOpen}
            onCorrectionOpenChange={setCorrectionOpen}
          />
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

        {!focusMode && isMobileLayout && (
          <CardStrip
            onOpenList={(focusId) => {
              if (focusId) setFocusCard(focusId);
              setMobilePanelTab("cards");
            }}
            onHide={() => setFocusMode(true)}
            focusEnabled={mobilePanelTab === null}
          />
        )}

        {!focusMode && !isMobileLayout && (
          <aside className="flex w-full shrink-0 flex-col min-h-0 lg:max-h-none lg:w-[400px] xl:w-[440px]">
            <div className="flex items-center gap-1 border-b border-edge bg-panel2 px-3 pt-2">
              {(
                [
                  ["cards", "实时解释"],
                  ["summary", "纪要与导出"],
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
              {tab === "cards" ? <CardsPanel /> : <SummaryPanel />}
            </div>
          </aside>
        )}
      </main>

      <StatusLine onOpenTaskCenter={() => setTaskCenterOpen(true)} />

      {/* Bit mascot behavior train (chamber B): always mounted (like
          Toast below) so its own bitCelebrateNonce-tracking effect never
          misses a transition — it renders nothing itself except during
          the few seconds a celebration actually plays. */}
      <BitCelebrationOverlay />

      {/* iOS-cloud round (固定顶部/底部 shell): the webview is full-bleed
          to the screen's bottom edge, so without this the home indicator
          sits ON the status line. A spacer painted in the bar's own
          bg-panel2 reads as the bar extending into the safe area — the
          native tab-bar idiom — rather than shrinking the bar itself.
          env() is 0 until layout.tsx's viewportFit:"cover" (same round)
          unlocks it, and 0 on every non-notch device, so this
          collapses to nothing everywhere it isn't needed. */}
      {IS_IOS && (
        <div
          aria-hidden
          className="shrink-0 bg-panel2"
          style={{ height: "env(safe-area-inset-bottom)" }}
        />
      )}

      {focusMode && (
        <button
          data-testid="btn-exit-focus"
          onClick={() => setFocusMode(false)}
          title="退出专注模式"
          // top offset rides the safe-area inset (iOS-cloud round, Sol
          // F3): the header is taller by the top inset on a full-bleed
          // iOS webview; env() is 0 elsewhere (identical to top-[100px]).
          className="btn-tactile fixed right-4 top-[calc(100px+env(safe-area-inset-top))] z-40 flex h-9 w-9 items-center justify-center border border-edge bg-panel text-mut shadow-lg hover:bg-panel3 hover:text-fg"
        >
          <SidebarSimple size={18} weight="fill" />
        </button>
      )}

      {isMobileLayout && mobilePanelTab !== null && (
        <MobilePanels
          tab={mobilePanelTab}
          onTabChange={(tab) => {
            // Leaving the cards tab mid-ring abandons a pending focus
            // request; clear it so CardStrip doesn't re-consume the
            // same request after close (Sol MEDIUM, review round 1).
            if (tab !== "cards") setFocusCard(null);
            setMobilePanelTab(tab);
          }}
          onClose={() => {
            setFocusCard(null);
            setMobilePanelTab(null);
          }}
        />
      )}

      {/* v0.7 stop gate: End pressed while translations are pending.
          BottomSheet's mount contract (no portal) is satisfied here —
          page root, outside any sticky/transformed ancestor. Fix round
          (LOW): mounted AFTER MobilePanels (not before) — both are
          z-50, and a later sibling wins at equal z, so an open
          MobilePanels used to cover this sheet entirely. */}
      <BottomSheet open={stopConfirm !== null} onClose={cancelStop}>
        {stopConfirm && (
          <div className="flex flex-col gap-3 p-4">
            <p className="text-sm text-fg">
              {stopConfirm.stalled
                ? `翻译已暂停${stopConfirm.reason ? `（${stopConfirm.reason}）` : ""}，仍有 ${stopConfirm.pending} 段未翻译，结束吗？`
                : `翻译还没有完成（剩 ${stopConfirm.pending} 段），继续结束吗？`}
            </p>
            <div className="flex gap-2">
              {!stopConfirm.stalled && (
                <button
                  type="button"
                  data-testid="stop-confirm-wait"
                  onClick={() => confirmStop("wait")}
                  className="btn-tactile flex-1 border border-edge bg-panel3 px-3 py-2 text-sm text-fg"
                >
                  等待完成
                </button>
              )}
              <button
                type="button"
                data-testid="stop-confirm-now"
                onClick={() => confirmStop("now")}
                className="btn-tactile flex-1 border border-edge bg-panel2 px-3 py-2 text-sm text-mut hover:text-fg"
              >
                直接结束
              </button>
              {stopConfirm.stalled && (
                <button
                  type="button"
                  data-testid="stop-confirm-cancel"
                  onClick={cancelStop}
                  className="btn-tactile flex-1 border border-edge bg-panel2 px-3 py-2 text-sm text-mut hover:text-fg"
                >
                  取消
                </button>
              )}
            </div>
          </div>
        )}
      </BottomSheet>

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
      <CardArrivalAnnouncer />
      {/* v0.4 S3 chunk 6: first-run local sidecar provisioning wizard —
         renders nothing on an ordinary web build (see DesktopBootstrap.
         tsx's own header comment for why this is gated at BOTH this
         call site and again inside that component). */}
      {IS_DESKTOP && <DesktopBootstrap />}
    </div>
  );
}
