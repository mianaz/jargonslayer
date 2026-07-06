"use client";

import { useEffect, useRef, useState } from "react";
import { SidebarSimple } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { useMeeting } from "@/hooks/useMeeting";
import Header from "@/components/Header";
import TranscriptPanel from "@/components/TranscriptPanel";
import CardsPanel from "@/components/CardsPanel";
import SummaryPanel from "@/components/SummaryPanel";
import GlossaryPanel from "@/components/GlossaryPanel";
import HistoryDrawer from "@/components/HistoryDrawer";
import SettingsDialog from "@/components/SettingsDialog";
import TutorialOverlay, { shouldShowTutorial } from "@/components/TutorialOverlay";
import LookupPopover from "@/components/LookupPopover";
import Toast from "@/components/Toast";

type RightTab = "cards" | "summary" | "glossary";

export default function Home() {
  const { start, stop, startDemo } = useMeeting();
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

  useEffect(() => {
    void hydrate();
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
        onStop={() => void stop()}
        onDemo={() => void startDemo()}
        onOpenHistory={() => setHistoryOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
      />

      <main className="flex min-h-0 flex-1">
        <section className="min-w-0 flex-1 border-r border-edge">
          <TranscriptPanel />
        </section>

        {!focusMode && (
          <aside className="flex w-[400px] shrink-0 flex-col min-h-0 xl:w-[440px]">
            <div className="flex items-center gap-1 border-b border-edge px-3 pt-2">
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
                  className={`relative rounded-t-lg px-3 py-2 text-sm transition-colors ${
                    tab === key
                      ? "bg-panel text-fg border border-b-0 border-edge"
                      : "text-mut hover:text-fg"
                  }`}
                >
                  {label}
                  {key === "summary" && summaryReady && !summary && (
                    <span className="absolute -right-0.5 top-1.5 h-1.5 w-1.5 rounded-full bg-gold" />
                  )}
                </button>
              ))}
              <button
                data-testid="btn-focus-mode"
                onClick={() => setFocusMode(true)}
                title="专注模式：只看转录，悬停高亮表达即可查看释义"
                className="btn-tactile ml-auto flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-mut hover:border-edge hover:bg-panel3 hover:text-fg"
              >
                <SidebarSimple size={18} />
              </button>
            </div>
            <div className="min-h-0 flex-1 bg-panel/40">
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

      {focusMode && (
        <button
          data-testid="btn-exit-focus"
          onClick={() => setFocusMode(false)}
          title="退出专注模式"
          className="btn-tactile fixed right-4 top-16 z-40 flex h-9 w-9 items-center justify-center rounded-lg border border-edge bg-panel text-mut shadow-lg hover:bg-panel3 hover:text-fg"
        >
          <SidebarSimple size={18} weight="fill" />
        </button>
      )}

      <HistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <TutorialOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      <LookupPopover />
      <Toast />
    </div>
  );
}
