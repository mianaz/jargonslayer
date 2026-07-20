"use client";

// v0.5 Wave-1 Feature 2 (AI transcript correction, batch/review-gated —
// docs/design-explorations/v05-wave1-blueprint.md §1 Feature 2 + §5
// A5). Separate from TranscriptPanel (only a header button touches that
// file — see the blueprint's §2 contention-resolution note): this owns
// the ENTIRE correction flow — fetch, diff review, per-row accept/
// ignore, batch retranslate of accepted rows.

import { useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { correctApi, translateApi, NoKeyError, RateLimitApiError, UpstreamError } from "@/lib/llm/client";
import { resolveTaskCreds } from "@/lib/llm/taskConfig";
import { buildMeetingLexicon } from "@/lib/stt/lexicon";
import {
  capLexiconChars,
  chunkCorrectSegments,
  CORRECT_MAX_LEXICON_CHARS,
} from "@/lib/llm/tasks/correct";
import { PREVIEW_TIER } from "@/lib/deployTier";
import type { Settings } from "@jargonslayer/core/types";

export interface CorrectionReviewProps {
  open: boolean;
  onClose: () => void;
}

type RowStatus = "pending" | "accepted" | "ignored" | "conflict";

// A5: "review state carries {sessionId, meetingGen, id, beforeText,
// proposedText}" — the exact snapshot acceptance re-checks against, so
// a stale accept (session/meeting moved on, or the text changed under
// the review some other way) never clobbers unrelated new content.
interface ReviewRow {
  sessionId: string;
  meetingGen: number;
  id: string;
  beforeText: string;
  proposedText: string;
  status: RowStatus;
}

// ---------------------------------------------------------------
// Word-level diff — ponytail: common-prefix/common-suffix trim, the
// remaining middle span (if any) is "the change". Handles the realistic
// case (one garbled word/phrase fixed mid-sentence) with no library;
// a genuine multi-hunk diff (several unrelated spans changed in the
// same segment) would collapse into one "changed" block spanning both —
// add a real LCS diff if that turns out to matter in practice.
// ---------------------------------------------------------------

interface DiffPart {
  text: string;
  changed: boolean;
}

function diffWords(before: string, after: string): { beforeParts: DiffPart[]; afterParts: DiffPart[] } {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const build = (arr: string[], lo: number, hi: number): DiffPart[] =>
    [
      { text: arr.slice(0, lo).join(""), changed: false },
      { text: arr.slice(lo, hi + 1).join(""), changed: lo <= hi },
      { text: arr.slice(hi + 1).join(""), changed: false },
    ].filter((p) => p.text.length > 0);
  return {
    beforeParts: build(a, start, endA),
    afterParts: build(b, start, endB),
  };
}

function DiffLine({ parts, changedClass }: { parts: DiffPart[]; changedClass: string }) {
  return (
    <span>
      {parts.map((p, i) =>
        p.changed ? (
          <span key={i} className={changedClass}>
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}

// ---------------------------------------------------------------
// One-shot batch retranslate of accepted rows (A5: "fired directly
// through the translate task IF a key is configured" — do NOT touch
// queue.ts). Only rows that HAD an existing translation before the
// accept are included — a row that never had one (bilingualTranscript
// was off, or it just never landed) has nothing to go "stale", so
// nothing to refresh; this also means the batch is naturally empty
// (silently, no wasted call) when bilingual mode was never used.
// Chunked at 6 (translateApi/route's own per-call cap, same as
// TranslateQueue's BATCH_MAX) since "accept all" can exceed it.
// Fail-soft throughout — same posture as TranslateQueue: a missing
// refreshed translation is a nice-to-have, never a blocking error.
// ---------------------------------------------------------------

async function retranslateBatch(
  items: { id: string; text: string }[],
  settings: Settings,
  meetingGen: number,
  applyTranslations: (map: Record<string, string>, gen: number) => void,
): Promise<void> {
  for (let i = 0; i < items.length; i += 6) {
    const chunk = items.slice(i, i + 6);
    try {
      const res = await translateApi({ segments: chunk, lang: settings.explainLanguage }, settings);
      if (res.translations.length > 0) {
        const map: Record<string, string> = {};
        for (const t of res.translations) map[t.id] = t.text;
        applyTranslations(map, meetingGen);
      }
    } catch {
      // fail-soft — see header comment above.
    }
  }
}

export default function CorrectionReview({ open, onClose }: CorrectionReviewProps) {
  const setCorrectionBusy = useApp((s) => s.setCorrectionBusy);
  const correctionBusy = useApp((s) => s.correctionBusy);
  const updateSegmentText = useApp((s) => s.updateSegmentText);
  const applyTranslations = useApp((s) => s.applyTranslations);

  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setRows(null);
      setError(null);
      return;
    }
    void runCorrection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function runCorrection(): Promise<void> {
    const { segments, settings, activeSessionId, meetingGen, customEntries, learnset } = useApp.getState();
    if (segments.length === 0) {
      onClose();
      return;
    }
    setError(null);
    setRows(null);
    setCorrectionBusy(true);
    try {
      // Finding 1 fix (pre-merge review): a whole meeting can far
      // exceed one call's per-call caps (see tasks/correct.ts's own
      // token-math comment) — cap the shared lexicon once up front
      // (repeated verbatim in every window's request) and split the
      // segments into sequential, bounded windows instead of the old
      // one-shot whole-meeting call.
      const lexicon = capLexiconChars(
        buildMeetingLexicon({
          customEntries,
          enabledPacks: settings.enabledPacks,
          learnset,
        }).terms,
        CORRECT_MAX_LEXICON_CHARS,
      );
      const model = resolveTaskCreds(settings, "detect").model;
      const windows = chunkCorrectSegments(segments.map((s) => ({ id: s.id, text: s.text })));
      const sessionId = activeSessionId ?? "";
      const beforeById = new Map(segments.map((s) => [s.id, s.text]));
      const corrections = new Map<string, string>();
      let succeededOnce = false;
      let lastError: unknown = null;
      // Sequential, not parallel (unlike tasks/summarize.ts's translate
      // pool): each window = one correctApi() call (a route call on
      // web, a direct provider call on desktop/iOS BYOK), so route.ts's
      // existing per-IP 4/min + daily budget naturally account per
      // chunk with no new rate-limiting code. Fail-soft per window: a
      // failed window's segments are simply never added to
      // `corrections` below, so they render as no change rather than
      // aborting the whole review — UNLESS every single window failed,
      // in which case this surfaces exactly like the old single-call
      // path did (see the throw below).
      for (const window of windows) {
        try {
          const res = await correctApi(
            { segments: window.segments, context: window.context, lexicon, model },
            settings,
          );
          succeededOnce = true;
          for (const c of res.corrections) corrections.set(c.id, c.text);
        } catch (err) {
          lastError = err;
          console.warn("[correction] window failed, its segments left unchanged", err);
        }
      }
      if (!succeededOnce && lastError) throw lastError;
      const built: ReviewRow[] = Array.from(corrections.entries())
        .map(([id, text]) => ({
          sessionId,
          meetingGen,
          id,
          beforeText: beforeById.get(id) ?? "",
          proposedText: text,
          status: "pending" as const,
        }))
        // "compute changed CLIENT-side (trimmed inequality)" — only
        // genuine changes are worth a review row.
        .filter((r) => r.beforeText.trim() !== r.proposedText.trim());
      setRows(built);
    } catch (err) {
      setError(
        err instanceof NoKeyError
          ? "需要 API Key（右上角设置）才能使用 AI 校正"
          : err instanceof RateLimitApiError || err instanceof UpstreamError
            ? err.message
            : "AI 校正失败",
      );
    } finally {
      setCorrectionBusy(false);
    }
  }

  /** A5: acceptance ONLY when the current session+text still match this
   *  row's own snapshot — otherwise mark it a conflict instead of
   *  silently clobbering whatever the segment now holds.
   *
   *  Finding 3 fix (pre-merge review): that snapshot check alone
   *  (session/gen/text) does NOT cover status — store.ts's
   *  updateSegmentText has its own separate stopped-only tripwire and
   *  used to return void, so a refused write (status flipped away from
   *  "stopped" without the session/gen/text snapshot itself changing)
   *  was silently indistinguishable from a successful one: the row
   *  still got marked "accepted" and queued for retranslation even
   *  though the segment's text never actually changed. updateSegmentText
   *  now returns a boolean (true = mutation applied) — a false return
   *  is treated exactly like the snapshot conflict above. */
  function acceptOne(row: ReviewRow): { text: string; hadTranslation: boolean } | null {
    const state = useApp.getState();
    const seg = state.segments.find((s) => s.id === row.id);
    const conflict =
      state.activeSessionId !== row.sessionId ||
      state.meetingGen !== row.meetingGen ||
      seg?.text !== row.beforeText;
    if (conflict) {
      setRows((prev) => prev && prev.map((r) => (r.id === row.id ? { ...r, status: "conflict" } : r)));
      return null;
    }
    const hadTranslation = !!state.translations[row.id];
    if (!updateSegmentText(row.id, row.proposedText)) {
      setRows((prev) => prev && prev.map((r) => (r.id === row.id ? { ...r, status: "conflict" } : r)));
      return null;
    }
    setRows((prev) => prev && prev.map((r) => (r.id === row.id ? { ...r, status: "accepted" } : r)));
    return { text: row.proposedText, hadTranslation };
  }

  function fireRetranslate(items: { id: string; text: string }[]): void {
    if (items.length === 0) return;
    const { settings, meetingGen } = useApp.getState();
    const canTranslate = PREVIEW_TIER || !!resolveTaskCreds(settings, "translate").apiKey;
    if (!canTranslate) return;
    void retranslateBatch(items, settings, meetingGen, applyTranslations);
  }

  function handleAccept(row: ReviewRow): void {
    const result = acceptOne(row);
    if (result?.hadTranslation) fireRetranslate([{ id: row.id, text: result.text }]);
  }

  function handleIgnore(row: ReviewRow): void {
    setRows((prev) => prev && prev.map((r) => (r.id === row.id ? { ...r, status: "ignored" } : r)));
  }

  function handleAcceptAll(): void {
    const toRetranslate: { id: string; text: string }[] = [];
    for (const row of rows ?? []) {
      if (row.status !== "pending") continue;
      const result = acceptOne(row);
      if (result?.hadTranslation) toRetranslate.push({ id: row.id, text: result.text });
    }
    fireRetranslate(toRetranslate);
  }

  if (!open) return null;

  const pendingCount = (rows ?? []).filter((r) => r.status === "pending").length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="AI 校正"
      data-testid="correction-review-overlay"
      className="fixed inset-0 z-50 flex flex-col bg-ink/95"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-edge bg-panel px-4 py-3">
        <div className="text-sm font-medium text-fg">AI 校正</div>
        <div className="flex items-center gap-2">
          {rows && rows.length > 0 && (
            <button
              type="button"
              data-testid="btn-correction-accept-all"
              disabled={pendingCount === 0}
              onClick={handleAcceptAll}
              className="btn-terminal min-h-10 bg-act px-3 font-mono text-xs font-medium text-ink hover:bg-act/85 disabled:cursor-not-allowed disabled:opacity-50"
            >
              全部接受
            </button>
          )}
          <button
            type="button"
            data-testid="btn-correction-close"
            onClick={onClose}
            aria-label="关闭"
            className="btn-tactile flex h-10 w-10 items-center justify-center text-mut hover:bg-panel3 hover:text-fg"
          >
            <X size={18} weight="regular" />
          </button>
        </div>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto px-4 py-4">
        {correctionBusy && (
          <div className="flex flex-col items-center gap-3 py-24 text-center">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-lab-cyan border-t-transparent" />
            <div className="text-sm text-mut">校正中，长会议可能需要一会儿</div>
          </div>
        )}
        {!correctionBusy && error && (
          <div className="mx-auto max-w-md py-24 text-center text-sm text-lab-orange">{error}</div>
        )}
        {!correctionBusy && !error && rows && rows.length === 0 && (
          <div className="mx-auto max-w-md py-24 text-center text-sm text-mut">
            未发现需要校正的内容
          </div>
        )}
        {!correctionBusy && !error && rows && rows.length > 0 && (
          <div className="mx-auto max-w-2xl space-y-3">
            {rows.map((row) => {
              const { beforeParts, afterParts } = diffWords(row.beforeText, row.proposedText);
              return (
                <div
                  key={row.id}
                  data-testid={`correction-row-${row.id}`}
                  data-status={row.status}
                  className="border border-edge bg-panel2 p-3"
                >
                  <div className="text-sm leading-[1.7] text-mut2 line-through decoration-lab-red/60">
                    <DiffLine parts={beforeParts} changedClass="bg-lab-red/20 text-lab-red no-underline" />
                  </div>
                  <div className="mt-1 text-sm leading-[1.7] text-fg">
                    <DiffLine parts={afterParts} changedClass="bg-lab-green/20 text-lab-green" />
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    {row.status === "pending" && (
                      <>
                        <button
                          type="button"
                          data-testid={`correction-accept-${row.id}`}
                          onClick={() => handleAccept(row)}
                          className="btn-tactile min-h-10 border border-edge2 px-3 text-xs text-fg hover:bg-panel3"
                        >
                          接受
                        </button>
                        <button
                          type="button"
                          data-testid={`correction-ignore-${row.id}`}
                          onClick={() => handleIgnore(row)}
                          className="btn-tactile min-h-10 border border-edge2 px-3 text-xs text-mut hover:bg-panel3 hover:text-fg"
                        >
                          忽略
                        </button>
                      </>
                    )}
                    {row.status === "accepted" && (
                      <span className="text-xs text-lab-green">已接受</span>
                    )}
                    {row.status === "ignored" && <span className="text-xs text-mut2">已忽略</span>}
                    {row.status === "conflict" && (
                      <span className="text-xs text-lab-orange">内容已变化</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
