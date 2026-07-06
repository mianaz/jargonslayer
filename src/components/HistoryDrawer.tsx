"use client";

// Right-side drawer listing saved sessions, with search (title +
// lazy-loaded expression match) and delete-confirm.

import { useEffect, useState } from "react";
import { X, Trash } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import * as storage from "@/lib/history/storage";
import type { MeetingSession } from "@/lib/types";

export interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

function formatDurationMin(startMs: number, endMs: number): string {
  const min = Math.max(0, Math.round((endMs - startMs) / 60000));
  return `${min} 分`;
}

export default function HistoryDrawer({ open, onClose }: HistoryDrawerProps) {
  const sessions = useApp((s) => s.sessions);
  const loadSession = useApp((s) => s.loadSession);
  const deleteSession = useApp((s) => s.deleteSession);

  const [query, setQuery] = useState("");
  const [cache, setCache] = useState<Record<string, MeetingSession>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setConfirmDeleteId(null);
    }
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    // Lazy-load full sessions once so we can match by expression text.
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
  }, [query, sessions]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const matchesExpr = (id: string): string | null => {
    if (q.length < 2) return null;
    const full = cache[id];
    if (!full) return null;
    const hit = full.cards.find((c) =>
      c.expression.toLowerCase().includes(q),
    );
    return hit ? hit.expression : null;
  };

  const filtered = sessions.filter((m) => {
    if (!q) return true;
    if (m.title.toLowerCase().includes(q)) return true;
    return matchesExpr(m.id) !== null;
  });

  const handleDeleteClick = (id: string) => {
    if (confirmDeleteId === id) {
      void deleteSession(id);
      setConfirmDeleteId(null);
      return;
    }
    setConfirmDeleteId(id);
    setTimeout(() => {
      setConfirmDeleteId((cur) => (cur === id ? null : cur));
    }, 3000);
  };

  return (
    <>
      <div
        className="fixed inset-0 z-30 bg-black/50"
        onClick={onClose}
        aria-hidden
      />
      <div className="fixed inset-y-0 right-0 z-40 flex w-[380px] translate-x-0 flex-col border-l border-edge bg-panel transition-transform">
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <span className="font-medium text-fg">会议历史</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-mut hover:bg-panel3 hover:text-fg"
          >
            <X size={18} weight="regular" />
          </button>
        </div>

        <div className="shrink-0 px-4 py-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按标题或表达搜索…"
            className="w-full rounded-lg border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
          />
        </div>

        <div className="scroll-thin flex-1 overflow-y-auto px-3 pb-4">
          {filtered.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <div className="text-sm font-medium text-fg">
                {sessions.length === 0 ? "还没有会议记录" : "没有匹配的会议"}
              </div>
              <div className="mt-2 max-w-xs text-xs leading-[1.7] text-mut">
                {sessions.length === 0
                  ? "开一场会议或点「演示」，结束后会自动出现在这里。"
                  : "换个关键词试试。"}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((meta) => {
                const hintExpr = matchesExpr(meta.id);
                return (
                  <div
                    key={meta.id}
                    onClick={() => {
                      void loadSession(meta.id);
                      onClose();
                    }}
                    className="cursor-pointer rounded-xl border border-edge bg-panel2 p-3 hover:bg-panel3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-fg">{meta.title}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteClick(meta.id);
                        }}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-mut hover:bg-panel3 hover:text-warn"
                      >
                        <Trash size={16} weight="regular" />
                      </button>
                    </div>

                    {confirmDeleteId === meta.id && (
                      <div className="mt-1 text-xs text-warn">确认删除?</div>
                    )}

                    <div className="mt-1 font-mono text-xs tabular-nums text-mut2">
                      {formatDateTime(meta.startedAt)} ·{" "}
                      {formatDurationMin(meta.startedAt, meta.endedAt)}
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-mut">
                      <span className="rounded-full border border-edge px-1.5 py-0">
                        {meta.segmentCount} 段
                      </span>
                      <span className="rounded-full border border-edge px-1.5 py-0">
                        {meta.cardCount} 表达
                      </span>
                      <span className="rounded-full border border-edge px-1.5 py-0">
                        {meta.termCount} 术语
                      </span>
                      <span className="rounded-full border border-edge px-1.5 py-0">
                        摘要{meta.hasSummary ? "✓" : "✗"}
                      </span>
                    </div>

                    {hintExpr && (
                      <div className="mt-1.5 text-xs text-gold/80">
                        含 &quot;{hintExpr}&quot;
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
