"use client";

// Study center: cross-session stats + two review modes over the
// learn-set — 复习到期 (SRS due-driven, #48 step 2) and 翻卡浏览 (the
// original light flip-through practice over the personal glossary,
// unchanged). Can be opened directly (bookmark, new tab), so it
// hydrates the store itself if needed.

import { useEffect, useState } from "react";
import { useApp } from "@/lib/store";
import ReviewDashboard, { useSessionCache } from "@/components/review/ReviewDashboard";
import PracticeDeck from "@/components/review/PracticeDeck";
import DueReview from "@/components/review/DueReview";
import Toast from "@/components/Toast";
import { withBase } from "@/lib/basePath";

type ReviewMode = "due" | "browse";

const MODE_OPTIONS: { value: ReviewMode; label: string }[] = [
  { value: "due", label: "复习到期" },
  { value: "browse", label: "翻卡浏览" },
];

export default function ReviewPage() {
  const hydrated = useApp((s) => s.hydrated);
  const hydrate = useApp((s) => s.hydrate);
  const [mode, setMode] = useState<ReviewMode>("due");
  // #48 s1 review item 8: one shared session cache for the whole page
  // — ReviewDashboard and DueReview both need it, but each doing its
  // own useSessionCache() call meant every saved session's full body
  // loaded from IndexedDB twice per /review visit.
  const { cache, loading } = useSessionCache();

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-edge bg-panel/85 px-4 backdrop-blur">
        <a
          href={withBase("/")}
          className="flex items-center gap-1.5 text-sm text-mut hover:text-fg"
        >
          ← 返回会议
        </a>
        <span className="font-medium text-fg">学习中心</span>
        <span className="font-mono text-xs text-mut2">/review</span>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-4 py-6">
        <ReviewDashboard cache={cache} loading={loading} />
        <div className="border-t border-edge" aria-hidden="true" />
        <div className="space-y-4">
          <div className="flex items-center gap-1 rounded-none border border-edge bg-panel2 p-0.5">
            {MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setMode(opt.value)}
                className={`rounded-sm px-2.5 py-1 text-xs transition-colors ${
                  mode === opt.value
                    ? "bg-panel3 text-fg"
                    : "text-mut hover:text-fg"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {mode === "due" ? <DueReview cache={cache} /> : <PracticeDeck />}
        </div>
      </main>

      <Toast />
    </div>
  );
}
