"use client";

// Study center: cross-session stats + a light flip-through practice
// deck over the personal glossary. Can be opened directly (bookmark,
// new tab), so it hydrates the store itself if needed.

import { useEffect } from "react";
import { useApp } from "@/lib/store";
import ReviewDashboard from "@/components/review/ReviewDashboard";
import PracticeDeck from "@/components/review/PracticeDeck";
import Toast from "@/components/Toast";

export default function ReviewPage() {
  const hydrated = useApp((s) => s.hydrated);
  const hydrate = useApp((s) => s.hydrate);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-edge bg-panel/85 px-4 backdrop-blur">
        <a
          href="/"
          className="flex items-center gap-1.5 text-sm text-mut hover:text-fg"
        >
          ← 返回会议
        </a>
        <span className="font-display font-semibold text-fg">学习中心</span>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-4 py-6">
        <ReviewDashboard />
        <div className="text-center text-sm text-edge2" aria-hidden="true">
          ❖
        </div>
        <PracticeDeck />
      </main>

      <Toast />
    </div>
  );
}
