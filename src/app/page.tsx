"use client";

import { useEffect, useRef, useState } from "react";
import { SidebarSimple } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { useMeeting } from "@/hooks/useMeeting";
import Header from "@/components/Header";
import StatusLine from "@/components/StatusLine";
import TranscriptPanel from "@/components/TranscriptPanel";
import CardsPanel from "@/components/CardsPanel";
import SummaryPanel from "@/components/SummaryPanel";
import GlossaryPanel from "@/components/GlossaryPanel";
import HistoryDrawer from "@/components/HistoryDrawer";
import ImportHub from "@/components/ImportHub";
import SettingsDialog from "@/components/SettingsDialog";
import TutorialOverlay, { shouldShowTutorial } from "@/components/TutorialOverlay";
import LookupPopover from "@/components/LookupPopover";
import Toast from "@/components/Toast";
import { installGlobalDiagHandlers } from "@/lib/diag/globalHandlers";

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

  const [tab, setTab] = useState<RightTab>("cards");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // #62 item 2: lifted here (not owned by HistoryDrawer) so Header's
  // 导入 pill (desktop peer of the engine pills + mobile icon button)
  // and HistoryDrawer's own 导入 button open the exact same ImportHub
  // instance/open-state — mounting it once below means it also stays
  // open even if the drawer behind it closes, instead of unmounting
  // with it.
  const [importHubOpen, setImportHubOpen] = useState(false);

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
    if (shouldShowTutorial()) setHelpOpen(true);
  }, [hydrate]);

  // Jump to the report tab the moment a summary lands.
  const prevSummary = useRef(summary);
  useEffect(() => {
    if (!prevSummary.current && summary) setTab("summary");
    prevSummary.current = summary;
  }, [summary]);

  const summaryReady = status === "stopped" && segments.length > 0;

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
      />

      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="min-h-0 min-w-0 flex-1 border-b border-edge lg:border-b-0 lg:border-r">
          <TranscriptPanel onDemo={() => void startDemo()} />
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

      <StatusLine />

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
      <ImportHub open={importHubOpen} onClose={() => setImportHubOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <TutorialOverlay
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        onStartDemo={() => void startDemo()}
      />
      <LookupPopover />
      <Toast />
    </div>
  );
}
