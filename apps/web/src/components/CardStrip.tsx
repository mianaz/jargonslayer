"use client";

// Mobile main-screen replacement for the vertical cards dock: a single
// horizontal swipeable strip. Index 0 (newest, sortAt-first — see
// lib/cards/unified.ts) renders leftmost; swiping left reveals older
// cards to the right. Reuses the same unified card model as CardsPanel
// (the full-screen list this strip's "全部卡片" button opens) so both
// surfaces sort/merge expression+term cards identically.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, CaretDown, ListBullets } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { toUnified, type UnifiedItem } from "@/lib/cards/unified";

export interface CardStripProps {
  onOpenList: (focusId?: string) => void;
  onHide: () => void;
  focusEnabled: boolean;
}

const FOCUS_RING_MS = 1500;
// snap-mandatory + the row's px-3 padding rests the "at latest"
// position at ~12px, not 0 — anything under this counts as pinned.
const PINNED_EPSILON_PX = 24;
// While a 回到最新 smooth scroll is in flight, scroll events must not
// demote the pinned state or re-show the pill; the window clears the
// moment the row arrives at 0 (or expires, if a touch interrupted the
// animation).
const RETURN_WINDOW_MS = 1000;

function StripCardContent({ item }: { item: UnifiedItem }) {
  if (item.kind === "expression" && item.expression) {
    const c = item.expression;
    return (
      <>
        <span className="truncate text-sm font-medium text-fg">{c.expression}</span>
        <span className="line-clamp-2 text-xs text-mut">{c.chinese_explanation}</span>
        {c.plain_english && (
          <span className="truncate text-xs text-mut">{c.plain_english}</span>
        )}
      </>
    );
  }
  if (item.kind === "term" && item.term) {
    const t = item.term;
    return (
      <>
        <span className="truncate text-sm font-medium text-fg">{t.term}</span>
        <span className="line-clamp-2 text-xs text-mut">{t.gloss_zh}</span>
      </>
    );
  }
  return null;
}

export default function CardStrip(props: CardStripProps) {
  const cards = useApp((s) => s.cards);
  const terms = useApp((s) => s.terms);
  const focusCardId = useApp((s) => s.focusCardId);
  const setFocusCard = useApp((s) => s.setFocusCard);

  const items = toUnified(cards, terms);

  const rowRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  // The card currently at the viewer's left edge + its visual offset —
  // restored after any list change so live inserts AND re-detection
  // re-promotions (which reorder the whole list) never shift what a
  // scrolled-away viewer is reading. (v1 used "head id changed →
  // scrollLeft += card width" diff compensation; re-promotions made
  // that drift rightward without bound during live meetings.)
  const anchorRef = useRef<{ id: string; off: number } | null>(null);
  const returnUntilRef = useRef(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const [showBackToLatest, setShowBackToLatest] = useState(false);
  const [ringId, setRingId] = useState<string | null>(null);

  const syncScrollState = () => {
    const row = rowRef.current;
    if (!row) return;
    pinnedRef.current = row.scrollLeft < PINNED_EPSILON_PX;
    setShowBackToLatest(row.scrollLeft > 40);
    let anchor: { id: string; off: number } | null = null;
    for (const el of Array.from(row.querySelectorAll<HTMLElement>("[data-card-id]"))) {
      if (el.offsetLeft + el.offsetWidth > row.scrollLeft) {
        anchor = { id: el.dataset.cardId as string, off: el.offsetLeft - row.scrollLeft };
        break;
      }
    }
    anchorRef.current = anchor;
  };

  const handleScroll = () => {
    const row = rowRef.current;
    if (!row) return;
    if (Date.now() < returnUntilRef.current) {
      if (row.scrollLeft < PINNED_EPSILON_PX) returnUntilRef.current = 0;
      return;
    }
    syncScrollState();
  };

  // Keep the view stable across list changes: pinned viewers snap to
  // the newest card; scrolled-away viewers get their anchor card put
  // back at the same visual offset. Layout effect so the correction
  // lands before paint. If the anchor card was removed, leave the
  // scroll position alone.
  const itemsKey = items.map((i) => i.id).join("|");
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    if (pinnedRef.current) {
      if (row.scrollLeft !== 0) row.scrollTo({ left: 0 });
      return;
    }
    const anchor = anchorRef.current;
    if (!anchor) return;
    const el = row.querySelector<HTMLElement>(`[data-card-id="${anchor.id}"]`);
    if (el) row.scrollLeft = el.offsetLeft - anchor.off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);

  // A touch can interrupt the smooth return mid-flight; if the user then
  // rests, no further scroll event arrives after the window expires and
  // the stale pinned/hidden-pill state would leak (Sol HIGH, review
  // round 1). The expiry timer reconciles from the actual scrollLeft.
  const returnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (returnTimerRef.current) clearTimeout(returnTimerRef.current);
  }, []);

  const backToLatest = () => {
    const row = rowRef.current;
    if (!row) return;
    pinnedRef.current = true;
    anchorRef.current = null;
    returnUntilRef.current = Date.now() + RETURN_WINDOW_MS;
    setShowBackToLatest(false);
    if (returnTimerRef.current) clearTimeout(returnTimerRef.current);
    returnTimerRef.current = setTimeout(() => {
      returnUntilRef.current = 0;
      syncScrollState();
    }, RETURN_WINDOW_MS + 50);
    row.scrollTo({ left: 0, behavior: "smooth" });
  };

  // focusCardId consumption (mirrors CardsPanel's useFocusRing): only
  // when this strip owns focus (the full-screen list is closed).
  // itemsRef sidesteps putting `items` in the dependency array, which
  // would re-run this effect (and re-consume) on every unrelated card
  // update during the 1.5s ring window — same one-shot-per-request
  // posture useFocusRing gets for free from its per-card scoping.
  useEffect(() => {
    if (!props.focusEnabled || !focusCardId) return;
    const exists = itemsRef.current.some((i) => i.id === focusCardId);
    if (!exists) {
      setFocusCard(null);
      return;
    }
    const el = rowRef.current?.querySelector(
      `[data-card-id="${focusCardId}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    setRingId(focusCardId);
    const t = setTimeout(() => {
      setRingId(null);
      setFocusCard(null);
    }, FOCUS_RING_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusEnabled, focusCardId, setFocusCard]);

  return (
    <div>
      <div className="flex h-8 items-center justify-between px-3">
        <span className="text-xs text-mut">实时解释 · {items.length}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="全部卡片"
            onClick={() => props.onOpenList()}
            className="btn-tactile flex h-9 w-9 items-center justify-center border border-transparent text-mut hover:border-edge hover:bg-panel3 hover:text-fg"
          >
            <ListBullets size={18} />
          </button>
          <button
            type="button"
            aria-label="隐藏卡片"
            onClick={props.onHide}
            className="btn-tactile flex h-9 w-9 items-center justify-center border border-transparent text-mut hover:border-edge hover:bg-panel3 hover:text-fg"
          >
            <CaretDown size={18} />
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="px-3 pb-2 text-xs text-mut">卡片将随会议自动出现</div>
      ) : (
        <div className="relative">
          <div
            ref={rowRef}
            onScroll={handleScroll}
            style={{ scrollbarWidth: "none" }}
            className="flex gap-2 overflow-x-auto snap-x snap-mandatory px-3 pb-2 [&::-webkit-scrollbar]:hidden"
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-label={item.kind === "expression" ? item.expression?.expression : item.term?.term}
                data-testid="strip-card"
                data-kind={item.kind}
                data-card-id={item.id}
                onClick={() => props.onOpenList(item.id)}
                className={`flex h-[7.5rem] w-[min(19rem,80vw)] shrink-0 snap-start flex-col justify-start gap-1 overflow-hidden border-b border-l-2 border-edge bg-panel p-2 text-left transition-colors hover:bg-panel3 ${
                  item.kind === "expression" ? "border-l-lab-orange" : "border-l-lab-cyan"
                } ${ringId === item.id ? "ring-1 ring-act" : ""}`}
              >
                <StripCardContent item={item} />
              </button>
            ))}
          </div>

          {showBackToLatest && (
            <button
              type="button"
              data-testid="strip-back-to-latest"
              onClick={backToLatest}
              className="absolute left-3 top-1/2 flex -translate-y-1/2 items-center gap-1 border border-edge bg-panel2/90 px-2 py-1 text-xs text-mut shadow hover:bg-panel3 hover:text-fg"
            >
              <ArrowLeft size={14} />
              最新
            </button>
          )}
        </div>
      )}
    </div>
  );
}
