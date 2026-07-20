"use client";

// Crash/refresh recovery banner (v0.5 closeout, owner field report: a
// random iOS-Safari refresh mid-meeting lost the whole transcript — see
// lib/history/liveDraft.ts's own header comment for the underlying
// write policy). Mounted once in page.tsx, above <main> (the S10
// on-launch update check is deliberately silent — no banner/toast, see
// page.tsx's own checkAppUpdate comment — so there is no existing
// global-notice banner to mirror here); styled like the rest of the
// app's own in-flow notices (AiStatusPanel's zero-config banner,
// Toast.tsx's action buttons) rather than inventing a new visual
// language.

import { useEffect, useState } from "react";
import { useApp } from "@/lib/store";
import * as liveDraft from "@/lib/history/liveDraft";
import type { LiveDraft } from "@/lib/history/liveDraft";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

export default function RecoveryBanner() {
  const hydrated = useApp((s) => s.hydrated);
  const status = useApp((s) => s.status);
  const restoreLiveDraft = useApp((s) => s.restoreLiveDraft);
  const [draft, setDraft] = useState<LiveDraft | null>(null);

  // Boot check, AFTER hydrate (task spec — a pre-hydrate read could
  // still see a stale/absent IndexedDB connection). Skips showing a
  // draft that's already moot: if a new meeting somehow got going before
  // this async load resolved, useApp.getState() is read fresh here
  // (rather than trusting the `hydrated`-gated closure) so that race
  // can't flash the banner over an already-live meeting.
  useEffect(() => {
    if (!hydrated) return;
    void liveDraft.loadDraft().then((d) => {
      if (!d || d.snapshot.segments.length === 0) return;
      if (useApp.getState().status !== "idle") return;
      setDraft(d);
    });
  }, [hydrated]);

  // "If a NEW meeting starts while the banner is up, hide the banner but
  // KEEP the draft" (task spec) — a one-way latch: once status leaves
  // "idle" (a real meeting start, a demo start, or loading a saved
  // session), the banner never reappears in THIS page load even if
  // status later returns to "idle", so it can never show stale info that
  // no longer matches whatever's now on disk. `liveDraft.clearDraft` is
  // deliberately NOT called here — only 丢弃/恢复 (below) or a normal
  // saveCurrentSession may ever remove the draft from disk.
  useEffect(() => {
    if (status !== "idle") setDraft(null);
  }, [status]);

  if (!draft) return null;

  const handleRestore = () => {
    void restoreLiveDraft(draft.snapshot);
    setDraft(null);
  };

  const handleDiscard = () => {
    void liveDraft.clearDraft();
    setDraft(null);
  };

  return (
    <div
      data-testid="recovery-banner"
      className="flex flex-wrap items-center gap-3 border-b border-edge bg-panel2 px-4 py-2 text-sm text-fg"
    >
      <span>
        检测到未保存的会议（{formatDateTime(draft.startedAt)}，{draft.snapshot.segments.length} 段），
        可能因页面刷新或崩溃中断
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          data-testid="recovery-banner-restore"
          onClick={handleRestore}
          className="btn-tactile border border-edge px-2 py-0.5 font-mono text-xs text-act hover:bg-panel3"
        >
          恢复到历史记录
        </button>
        <button
          type="button"
          data-testid="recovery-banner-discard"
          onClick={handleDiscard}
          className="btn-tactile px-2 py-0.5 font-mono text-xs text-mut hover:text-warn-soft"
        >
          丢弃
        </button>
      </div>
    </div>
  );
}
