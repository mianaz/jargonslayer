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
//
// Visibility (Sol adversarial-review fix — replaces a one-way "hide on
// new-meeting-start" latch): a loaded draft stays visible for as long as
// its OWN draftId differs from whatever THIS TAB's current meeting
// derives to (liveDraft.deriveDraftId(meetingGen, startedAt)). Starting
// a NEW meeting no longer hides an unresolved OLD meeting's recoverable
// draft — the user can still 恢复/丢弃 the old one while the new meeting
// runs (see liveDraft.ts's own header doc for why the new meeting's OWN
// writes can't clobber it in the meantime). This also fully subsumes the
// old "boot race" guard: visibility is re-derived from live state on
// every render rather than decided once at load time, so a meeting that
// started (or that IS this same draft) before loadDraft() resolves is
// handled by the exact same comparison, not a special case.

import { useEffect, useRef, useState } from "react";
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
  const meetingGen = useApp((s) => s.meetingGen);
  const startedAt = useApp((s) => s.startedAt);
  const restoreLiveDraft = useApp((s) => s.restoreLiveDraft);
  const [draft, setDraft] = useState<LiveDraft | null>(null);
  // Double-click guard (Sol adversarial-review fix): a REF, not just
  // `busy` state, gates re-entrancy — two clicks dispatched in the same
  // tick (a fast double-click, or a test driving .click() twice back to
  // back) both run the CURRENT render's closure before React ever gets a
  // chance to re-render with an updated `busy`/`disabled`, so a
  // state-only check can't reliably catch the second one. Mutating a
  // ref is visible synchronously to any closure holding it, regardless
  // of render timing. `busy` state stays purely for the visual
  // disabled attribute.
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  // Draft check AFTER hydrate (a pre-hydrate read could still see a
  // stale/absent IndexedDB connection) — and RE-checked on every
  // meetingGen change (Sol re-verify HIGH): a draft that survives its
  // banner being ignored (or a clearDraft that silently failed) makes
  // every LATER meeting's writes buffer-skip — if this component only
  // ever read the disk once at boot, that stuck draft would be
  // unresolvable without a reload, and a stale cached entry could
  // conversely resurrect a banner for a draft already cleared. Each
  // new meeting start is exactly the moment the buffer-skip starts
  // biting, so it's the right moment to re-sync banner state to disk
  // truth (in BOTH directions — set when a foreign draft exists,
  // clear when it no longer does).
  useEffect(() => {
    if (!hydrated) return;
    let stale = false;
    void liveDraft.loadDraft().then(({ ok, draft: d }) => {
      if (stale) return;
      // A FAILED read keeps whatever we last knew (Sol round-3 M):
      // treating a transient IndexedDB error as "no draft" would hide
      // a valid banner while the on-disk draft keeps buffer-skipping
      // the live meeting's writes — the next meetingGen change (or
      // action-time re-check) re-reads disk anyway.
      if (!ok) return;
      if (!d || d.snapshot.segments.length === 0) {
        setDraft(null);
        return;
      }
      setDraft(d);
    });
    return () => {
      stale = true;
    };
  }, [hydrated, meetingGen]);

  // This tab's OWN current-meeting identity — a "gen:none"-shaped value
  // when no meeting has ever started this page load (see deriveDraftId's
  // own doc), which never collides with a real crashed meeting's id.
  const currentDraftId = liveDraft.deriveDraftId(meetingGen, startedAt);
  if (draft === null || draft.draftId === currentDraftId) return null;
  const shown: LiveDraft = draft;

  // Re-checks the draft's draftId against disk right before acting (Sol
  // adversarial-review fix) — guards against a stale banner: e.g. the
  // meeting this draft belongs to already ended normally (and cleared
  // its OWN draft) between render and click, in which case there's
  // nothing left to restore/discard, so this just hides the (now-moot)
  // banner instead of resurrecting/duplicating history.
  const handleRestore = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const { ok: readOk, draft: fresh } = await liveDraft.loadDraft();
      // Failed READ: keep the banner as-is (Sol round-3 M) — nothing
      // was proven absent; the user can simply retry the click.
      if (!readOk) return;
      if (!fresh || fresh.draftId !== shown.draftId) {
        setDraft(null);
        return;
      }
      const ok = await restoreLiveDraft(fresh.snapshot, fresh.draftId);
      // H1 fix: only dismiss on an actual successful save — on failure
      // restoreLiveDraft already showed its own 恢复失败 toast, and the
      // draft (still unresolved on disk) must stay recoverable.
      if (ok) setDraft(null);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleDiscard = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const { ok: readOk, draft: fresh } = await liveDraft.loadDraft();
      // Failed READ: keep the banner (same rationale as handleRestore).
      if (!readOk) return;
      if (fresh && fresh.draftId === shown.draftId) {
        await liveDraft.clearDraft(shown.draftId);
      }
      setDraft(null);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="recovery-banner"
      className="flex flex-wrap items-center gap-3 border-b border-edge bg-panel2 px-4 py-2 text-sm text-fg"
    >
      <span>
        检测到未保存的会议（{formatDateTime(shown.startedAt)}，{shown.snapshot.segments.length} 段），
        可能因页面刷新或崩溃中断
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          data-testid="recovery-banner-restore"
          onClick={() => void handleRestore()}
          disabled={busy}
          className="btn-tactile border border-edge px-2 py-0.5 font-mono text-xs text-act hover:bg-panel3 disabled:opacity-50"
        >
          恢复到历史记录
        </button>
        <button
          type="button"
          data-testid="recovery-banner-discard"
          onClick={() => void handleDiscard()}
          disabled={busy}
          className="btn-tactile px-2 py-0.5 font-mono text-xs text-mut hover:text-warn-soft disabled:opacity-50"
        >
          丢弃
        </button>
      </div>
    </div>
  );
}
