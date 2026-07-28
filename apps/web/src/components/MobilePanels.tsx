"use client";

// Mobile full-screen panels view — opened from CardStrip's 全部卡片
// button (or a strip-card tap, which also sets focusCardId before this
// mounts). Same two tabs/panels the desktop <aside> in page.tsx hosts,
// just full-screen instead of a sidebar — mirrors ImportHub's own
// IS_IOS full-screen idiom (ImportHub.tsx ~L615-654). 我的词典 lives in
// /review's own tab switcher now, not here or in the desktop aside.

import { CaretLeft } from "@phosphor-icons/react";
import CardsPanel from "@/components/CardsPanel";
import SummaryPanel from "@/components/SummaryPanel";

export type MobilePanelTab = "cards" | "summary";

export interface MobilePanelsProps {
  tab: MobilePanelTab;
  onTabChange: (tab: MobilePanelTab) => void;
  onClose: () => void;
}

const TABS: [MobilePanelTab, string][] = [
  ["cards", "实时解释"],
  ["summary", "纪要与导出"],
];

export default function MobilePanels(props: MobilePanelsProps) {
  return (
    <div
      data-testid="mobile-panels-fullscreen"
      role="dialog"
      aria-modal="true"
      aria-label="会议面板"
      // h-[--app-vvh] instead of inset-0's implicit height so the iOS
      // keyboard-height signal (page.tsx root uses the same var) also
      // bounds this overlay (Sol MEDIUM, review round 1).
      className="fixed inset-x-0 top-0 z-50 flex h-[var(--app-vvh,100vh)] flex-col bg-ink pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      <div className="flex items-center gap-1 border-b border-edge bg-panel2 px-3 pt-2">
        <button
          type="button"
          aria-label="返回"
          onClick={props.onClose}
          className="btn-tactile flex h-9 w-9 items-center justify-center border border-transparent text-mut hover:border-edge hover:bg-panel3 hover:text-fg"
        >
          <CaretLeft size={20} />
        </button>
        {TABS.map(([key, label]) => (
          <button
            key={key}
            data-testid={`tab-${key}`}
            onClick={() => props.onTabChange(key)}
            className={`relative px-3 py-2 font-mono text-xs uppercase tracking-wide transition-colors ${
              props.tab === key
                ? "border border-b-0 border-edge bg-panel text-fg"
                : "text-mut hover:text-fg"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col bg-panel">
        {props.tab === "cards" ? <CardsPanel /> : <SummaryPanel />}
      </div>
    </div>
  );
}
