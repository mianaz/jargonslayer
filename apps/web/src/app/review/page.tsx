"use client";

// Study center: cross-session stats + two review modes over the
// learn-set — 到期复习 (SRS due-driven, #48 step 2) and 翻卡浏览 (the
// original light flip-through practice over the personal glossary,
// unchanged). Can be opened directly (bookmark, new tab), so it
// hydrates the store itself if needed.

import { useEffect, useState } from "react";
import Link from "next/link";
import { IS_IOS } from "@/lib/platform/ios";
import { useApp } from "@/lib/store";
import ReviewDashboard, { useSessionCache } from "@/components/review/ReviewDashboard";
import PracticeDeck from "@/components/review/PracticeDeck";
import DueReview from "@/components/review/DueReview";
import Toast from "@/components/Toast";
import PixelDragon from "@/components/PixelDragon";

type ReviewMode = "due" | "browse";

const MODE_OPTIONS: { value: ReviewMode; label: string }[] = [
  { value: "due", label: "到期复习" },
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

  // Bit celebration seam (v0.5.1 Bit sprint): DueReview owns the queue
  // and reports the "a grade just cleared the last due card" moment
  // through onQueueEmptied (see its prop doc for the transition
  // semantics) — store nonce (celebrateBit) → PixelDragon.
  const handleQueueEmptied = () => useApp.getState().celebrateBit();

  return (
    // iOS-cloud round (固定顶部/底部 shell): this was the ONE in-app
    // route still built on document scroll (min-h-screen + sticky
    // header) — on iOS the whole page moved, header included, exactly
    // the webby posture the round removes. iOS gets the main page's own
    // proven frame instead (page.tsx: h-screen overflow-hidden flex-col
    // + a single internal scroller — component-level, NOT html/body
    // overflow, which FIX 11 in globals.css bans for hit-testing
    // reasons). Web/desktop keep the document-scroll layout untouched.
    <div className={IS_IOS ? "flex h-[var(--app-vvh,100vh)] flex-col overflow-hidden" : "min-h-screen"}>
      <header
        className={`flex shrink-0 items-center gap-3 border-b border-edge px-4 ${
          IS_IOS
            ? // static bar in a fixed frame (nothing scrolls under it, no
              // sticky/blur) that carries the full-bleed top inset itself
              // — bg extends to the physical top, same as Header.tsx.
              "h-[calc(3.5rem+env(safe-area-inset-top))] bg-panel pt-[env(safe-area-inset-top)]"
            : "sticky top-0 z-20 h-14 bg-panel/85 backdrop-blur"
        }`}
      >
        {/* Client-side nav back to "/" (E2E feedback 2026-07-11): a
            plain <a href> full-page-loaded the app, wiping in-memory
            state (running import tasks, transcript, cards) on the way
            back just as badly as the outbound Header.tsx link did — see
            that file's matching comment. Link auto-prefixes basePath,
            so no withBase() here. */}
        <Link
          href="/"
          className="flex items-center gap-1.5 text-sm text-mut hover:text-fg"
        >
          ← 返回会议
        </Link>
        <span className="font-medium text-fg">学习中心</span>
        <span className="font-mono text-xs text-mut2">/review</span>
      </header>

      <main
        className={`mx-auto max-w-5xl space-y-8 px-4 py-6 ${
          IS_IOS
            ? // the frame's single scroller; bottom padding keeps the
              // last card clear of the home indicator (layout.tsx's
              // viewportFit:"cover" is what makes env() non-zero).
              "scroll-thin min-h-0 w-full flex-1 overflow-y-auto pb-[calc(1.5rem+env(safe-area-inset-bottom))]"
            : ""
        }`}
      >
        <ReviewDashboard cache={cache} loading={loading} />
        <div className="border-t border-edge" aria-hidden="true" />
        <div className="space-y-4">
          <div className="flex items-center gap-1 rounded-none border border-edge bg-panel2 p-0.5">
            {MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setMode(opt.value)}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  mode === opt.value
                    ? "bg-panel3 text-fg"
                    : "text-mut hover:text-fg"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {mode === "due" ? <DueReview cache={cache} onQueueEmptied={handleQueueEmptied} /> : <PracticeDeck />}
        </div>
      </main>

      <Toast />

      {/* F1 (v0.5.1 Bit sprint fix round): PixelDragon previously only
          mounted inside the main page's StatusLine — handleQueueEmptied
          above bumps the store's celebrateBit nonce, but with no mascot
          mounted on THIS route the celebration had no consumer and was
          invisible. Fixed bottom-right perch, decorative (PixelDragon
          reads the store itself — no props/route coupling, see its own
          file), safe-area-aware for the iOS home-indicator strip, z-20
          so it never competes with the z-30+ dialogs/drawers/Toast
          above. */}
      <div
        aria-hidden="true"
        className="fixed bottom-2 right-2 z-20 sm:bottom-4 sm:right-4"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <PixelDragon />
      </div>
    </div>
  );
}
