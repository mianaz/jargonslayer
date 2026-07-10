"use client";

// Study-center stats strip + top-10 frequent expressions across all
// saved sessions. Lazily loads full sessions (metas are cheap, bodies
// are not) and caches them for the lifetime of the page.

import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/lib/store";
import * as storage from "@/lib/history/storage";
import type { MeetingSession } from "@/lib/types";
import type { LearnRecord } from "@/lib/learn/types";
import { computeReviewStreak, dueLearnRecords } from "@/lib/learn/queue";
import WordCloud from "./WordCloud";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Shared word-frequency map: expressions (gold) + terms (acc blue)
// aggregated across every saved session. Single source of truth for
// both the Top-10 list and the word cloud — nothing else recomputes
// this. `useSessionCache` does the lazy full-session hydration once
// and both consumers derive from the same cache.
export interface WordAgg {
  label: string;
  kind: "expression" | "term";
  count: number;
}

export function useSessionCache() {
  const sessions = useApp((s) => s.sessions);
  const [cache, setCache] = useState<Record<string, MeetingSession>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const meta of sessions) {
        if (cache[meta.id]) continue;
        const full = await storage.getSession(meta.id);
        if (cancelled) return;
        if (full) {
          setCache((prev) => ({ ...prev, [meta.id]: full }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  // Deleting a session while /review is open removes it from `sessions`
  // (the store's live list) but leaves its entry sitting in `cache` —
  // prune on every sessions change so a deleted session's cards can't
  // linger in the word-frequency aggregation below.
  useEffect(() => {
    const liveIds = new Set(sessions.map((m) => m.id));
    setCache((prev) => {
      const staleIds = Object.keys(prev).filter((id) => !liveIds.has(id));
      if (staleIds.length === 0) return prev;
      const next = { ...prev };
      for (const id of staleIds) delete next[id];
      return next;
    });
  }, [sessions]);

  const loading = Object.keys(cache).length === 0 && sessions.length > 0;
  return { cache, loading };
}

function useWordFrequency(cache: Record<string, MeetingSession>) {
  return useMemo(() => {
    const counts = new Map<string, WordAgg>();
    for (const session of Object.values(cache)) {
      for (const card of session.cards) {
        const key = `expression:${card.expression.toLowerCase()}`;
        const existing = counts.get(key);
        if (existing) {
          existing.count += card.count;
        } else {
          counts.set(key, {
            label: card.expression,
            kind: "expression",
            count: card.count,
          });
        }
      }
      for (const term of session.terms) {
        const key = `term:${term.term.toLowerCase()}`;
        const existing = counts.get(key);
        if (existing) {
          existing.count += term.count;
        } else {
          counts.set(key, { label: term.term, kind: "term", count: term.count });
        }
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [cache]);
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-none border-l-2 border-edge2 border-b border-edge bg-panel p-4">
      <div className="font-mono text-4xl tabular-nums text-fg">{value}</div>
      <div className="mt-2 text-xs uppercase tracking-wide text-mut">
        {label}
      </div>
    </div>
  );
}

function StatsStrip() {
  const sessions = useApp((s) => s.sessions);
  const learnset = useApp((s) => s.learnset);

  const stats = useMemo(() => {
    const now = Date.now();
    const meetingCount = sessions.length;
    const cardCount = sessions.reduce((sum, m) => sum + m.cardCount, 0);
    const termCount = sessions.reduce((sum, m) => sum + m.termCount, 0);
    const newThisWeek = sessions.filter(
      (m) => now - m.startedAt < WEEK_MS,
    ).length;
    const dueToday = dueLearnRecords(learnset, now).length;
    const streak = computeReviewStreak(learnset, now);
    return { meetingCount, cardCount, termCount, newThisWeek, dueToday, streak };
  }, [sessions, learnset]);

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <StatCard label="会议场次" value={stats.meetingCount} />
      <StatCard label="累计表达" value={stats.cardCount} />
      <StatCard label="累计术语" value={stats.termCount} />
      <StatCard label="本周新增会议" value={stats.newThisWeek} />
      <StatCard label="今日待复习" value={stats.dueToday} />
      <StatCard label="连续复习天数" value={stats.streak} />
    </div>
  );
}

function TopExpressions({
  words,
  loading,
  selected,
  onSelect,
}: {
  words: WordAgg[];
  loading: boolean;
  selected: string | null;
  onSelect: (label: string) => void;
}) {
  const top = useMemo(
    () => words.filter((w) => w.kind === "expression").slice(0, 10),
    [words],
  );

  if (loading) {
    return <div className="text-sm text-mut">加载中…</div>;
  }

  if (top.length === 0) return null;

  const maxCount = top[0]?.count ?? 1;

  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-mut">
        高频表达 Top 10
      </div>
      <div className="mt-2 space-y-2">
        {top.map((item, i) => {
          const isSelected = selected === item.label.toLowerCase();
          return (
            <button
              key={item.label}
              type="button"
              onClick={() => onSelect(item.label)}
              className={`flex w-full items-center gap-3 px-1 py-1 text-left transition-colors ${
                isSelected ? "bg-panel3" : "hover:bg-panel2"
              }`}
            >
              <span className="w-4 shrink-0 font-mono text-xs tabular-nums text-mut2">
                {i + 1}
              </span>
              <span
                className={`w-40 shrink-0 truncate text-sm ${
                  isSelected ? "font-medium text-lab-orange" : "text-fg"
                }`}
              >
                {item.label}
              </span>
              <span
                className="inline-block h-1.5 rounded-none bg-lab-orange/60"
                style={{
                  width: `${Math.max(6, (item.count / maxCount) * 100)}px`,
                }}
              />
              <span className="font-mono text-xs tabular-nums text-mut">
                {item.count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-none border border-edge bg-panel p-6 text-center">
      <div className="text-sm font-medium text-fg">还没有会议记录</div>
      <div className="mt-2 text-xs leading-[1.7] text-mut">
        装备词典，出门屠龙。开一场会议或点「演示」，结束后这里会显示你的学习统计。
      </div>
    </div>
  );
}

function formatDate(ts: number | undefined): string {
  if (ts === undefined) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts));
}

function KnownTermsSection() {
  const learnset = useApp((s) => s.learnset);
  const unsuppressLearnRecord = useApp((s) => s.unsuppressLearnRecord);

  const known = useMemo(
    () =>
      Object.values(learnset)
        .filter((record): record is LearnRecord => record.suppressed)
        .sort((a, b) => (b.suppressedAt ?? 0) - (a.suppressedAt ?? 0)),
    [learnset],
  );

  if (known.length === 0) return null;

  return (
    <section className="border-l-2 border-edge2 border-b border-edge bg-panel p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-fg">已知词</div>
          <div className="mt-1 font-mono text-xs text-mut">{known.length}</div>
        </div>
      </div>
      <div className="mt-3 divide-y divide-edge">
        {known.map((record) => (
          <div
            key={record.learnKey}
            className="flex items-center justify-between gap-3 py-2"
          >
            <div className="min-w-0">
              <div className="truncate font-mono text-sm text-fg">{record.surface}</div>
              <div className="mt-1 text-xs text-mut">
                {record.kind === "term" ? "术语" : "表达"} · {formatDate(record.suppressedAt)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void unsuppressLearnRecord(record.learnKey)}
              className="shrink-0 border border-edge px-2 py-1 font-mono text-xs text-mut hover:bg-panel3 hover:text-fg"
            >
              恢复提示
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

// #48 s1 review item 8: `cache`/`loading` are now supplied by the
// parent (ReviewPage) via a SINGLE useSessionCache() call, shared with
// DueReview — previously ReviewDashboard and DueReview each called
// useSessionCache() independently, so every saved session's full body
// was loaded from IndexedDB twice on every /review visit. Required
// props (not an internal fallback call) since useSessionCache's own
// loading effect can't be conditionally skipped once a hook — a
// fallback call here would just re-introduce the double load it's
// meant to remove. Only call site today is ReviewPage.
export default function ReviewDashboard({
  cache,
  loading,
}: {
  cache: Record<string, MeetingSession>;
  loading: boolean;
}) {
  const sessions = useApp((s) => s.sessions);
  const words = useWordFrequency(cache);

  // Selection is shared between the word cloud and the Top-10 list —
  // clicking a word in either place highlights the same label in the
  // other, scoped to this dashboard's own aggregation (no new store
  // state, nothing outside these two consumers observes it).
  const [selected, setSelected] = useState<string | null>(null);

  const handleSelect = (label: string) => {
    const key = label.toLowerCase();
    setSelected((prev) => (prev === key ? null : key));
  };

  if (sessions.length === 0) {
    return (
      <div className="space-y-6">
        {/* Streak/due-today can be non-zero even pre-first-meeting
           (glossary saves lazily enroll too — see store.ts's
           addCustomEntry), so the strip stays visible here like
           KnownTermsSection already does. */}
        <StatsStrip />
        <EmptyState />
        <KnownTermsSection />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <StatsStrip />
      <KnownTermsSection />
      <WordCloud
        words={words}
        loading={loading}
        selected={selected}
        onSelect={handleSelect}
      />
      <TopExpressions
        words={words}
        loading={loading}
        selected={selected}
        onSelect={handleSelect}
      />
    </div>
  );
}
