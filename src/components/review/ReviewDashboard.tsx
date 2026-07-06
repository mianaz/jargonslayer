"use client";

// Study-center stats strip + top-10 frequent expressions across all
// saved sessions. Lazily loads full sessions (metas are cheap, bodies
// are not) and caches them for the lifetime of the page.

import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/lib/store";
import * as storage from "@/lib/history/storage";
import type { MeetingSession } from "@/lib/types";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <div className="font-mono text-2xl tabular-nums text-fg">{value}</div>
      <div className="mt-1 text-xs text-mut">{label}</div>
    </div>
  );
}

function StatsStrip() {
  const sessions = useApp((s) => s.sessions);

  const stats = useMemo(() => {
    const now = Date.now();
    const meetingCount = sessions.length;
    const cardCount = sessions.reduce((sum, m) => sum + m.cardCount, 0);
    const termCount = sessions.reduce((sum, m) => sum + m.termCount, 0);
    const newThisWeek = sessions.filter(
      (m) => now - m.startedAt < WEEK_MS,
    ).length;
    return { meetingCount, cardCount, termCount, newThisWeek };
  }, [sessions]);

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <StatCard label="会议场次" value={stats.meetingCount} />
      <StatCard label="累计表达" value={stats.cardCount} />
      <StatCard label="累计术语" value={stats.termCount} />
      <StatCard label="本周新增会议" value={stats.newThisWeek} />
    </div>
  );
}

interface ExprAgg {
  expression: string;
  count: number;
}

function TopExpressions() {
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

  const top = useMemo(() => {
    const counts = new Map<string, ExprAgg>();
    for (const session of Object.values(cache)) {
      for (const card of session.cards) {
        const key = card.expression.toLowerCase();
        const existing = counts.get(key);
        if (existing) {
          existing.count += card.count;
        } else {
          counts.set(key, { expression: card.expression, count: card.count });
        }
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  }, [cache]);

  if (Object.keys(cache).length === 0 && sessions.length > 0) {
    return (
      <div className="text-sm text-mut">加载中…</div>
    );
  }

  if (top.length === 0) return null;

  const maxCount = top[0]?.count ?? 1;

  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-mut">
        高频表达 Top 10
      </div>
      <div className="mt-2 space-y-1.5">
        {top.map((item) => (
          <div
            key={item.expression}
            className="flex items-center gap-3 rounded-lg px-1 py-1"
          >
            <span className="w-40 shrink-0 truncate text-sm text-fg">
              {item.expression}
            </span>
            <span
              className="inline-block h-1.5 rounded-full bg-gold/60"
              style={{ width: `${Math.max(6, (item.count / maxCount) * 100)}px` }}
            />
            <span className="font-mono text-xs tabular-nums text-mut">
              {item.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-edge bg-panel p-6 text-center">
      <div className="text-sm font-medium text-fg">还没有会议记录</div>
      <div className="mt-2 text-xs leading-[1.7] text-mut">
        开一场会议或点「演示」，结束后这里会显示你的学习统计。
      </div>
    </div>
  );
}

export default function ReviewDashboard() {
  const sessions = useApp((s) => s.sessions);

  if (sessions.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-5">
      <StatsStrip />
      <TopExpressions />
    </div>
  );
}
