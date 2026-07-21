"use client";

// Selection-triggered explanation popover: user selects text in the
// transcript, which kicks off detection (AI or dictionary) on it and
// feeds any hits into the shared session card stream. Display-only as
// of v0.5 closeout (background 划词 card generation) — the detect/
// dictionary pipeline itself runs in lib/tasks/selectionLookup.ts,
// triggered by store.ts's setLookup and detached from this component's
// own lifecycle, so closing this popover early no longer discards an
// in-flight ~20s AI result. This component just renders whatever that
// pipeline has written for the current request id. Also offers a
// footer action to save the selected phrase into the personal glossary
// (AI-defined preview, or a blank hand-filled form) — that flow stays
// entirely component-local (user-initiated inside an open popover, no
// background need).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { defineApi, NoKeyError } from "@/lib/llm/client";
import { resolveTaskCreds } from "@/lib/llm/taskConfig";
import { useSelectionLookup } from "@/lib/tasks/selectionLookup";
import { findEntryBySurface } from "@/lib/history/glossary";
import { newId } from "@jargonslayer/core/types";
import type { CustomEntry, CustomEntryKind } from "@jargonslayer/core/types";

const KIND_LABELS: Record<CustomEntryKind, string> = {
  expression: "表达",
  term: "术语",
};

interface GlossaryDraft {
  kind: CustomEntryKind;
  headword: string;
  chinese_explanation: string;
  example: string;
  note: string;
  variants: string[];
  source: "ai" | "manual";
}

function emptyDraft(headword: string): GlossaryDraft {
  return {
    kind: "expression",
    headword,
    chinese_explanation: "",
    example: "",
    note: "",
    variants: [],
    source: "manual",
  };
}

const POPOVER_WIDTH = 320; // w-80
const POPOVER_MAX_HEIGHT = 384; // max-h-96
const VIEWPORT_MARGIN = 8;

export default function LookupPopover() {
  const lookup = useApp((s) => s.lookup);
  const setLookup = useApp((s) => s.setLookup);
  const settings = useApp((s) => s.settings);
  const addCustomEntry = useApp((s) => s.addCustomEntry);
  const showToast = useApp((s) => s.showToast);
  const customEntries = useApp((s) => s.customEntries);

  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // "Add to my glossary" flow.
  const [glossaryLoading, setGlossaryLoading] = useState(false);
  const [draft, setDraft] = useState<GlossaryDraft | null>(null);

  // Display-only (background 划词 card generation, v0.5 closeout): the
  // detect/dictionary pipeline itself now lives in
  // lib/tasks/selectionLookup.ts, triggered by store.ts's setLookup and
  // detached from this component's lifecycle entirely — closing this
  // popover no longer cancels/discards an in-flight result (see that
  // module's own header for the bug this fixes). This just reads
  // whatever the pipeline has written for the CURRENT request id; no
  // entry yet reads the same as still loading.
  const progress = useSelectionLookup((s) => (lookup ? s.byId[lookup.id] : undefined));
  const loading = !progress || progress.status === "loading";
  const error = progress?.status === "error" ? progress.error : null;
  const result = progress?.status === "done" ? progress.result : null;
  const dictFallback = progress?.status === "done" && progress.dictFallback;

  // The glossary-draft flow is unrelated to detect progress above (and
  // stays component-local, per design — see handleAddToGlossary below)
  // but must still reset per fresh lookup / on close, exactly like
  // before this pipeline was extracted.
  useEffect(() => {
    setDraft(null);
    setGlossaryLoading(false);
  }, [lookup?.id]);

  // Clamp position to viewport.
  useLayoutEffect(() => {
    if (!lookup) {
      setPos(null);
      return;
    }
    const maxLeft = window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - POPOVER_MAX_HEIGHT - VIEWPORT_MARGIN;
    const left = Math.min(Math.max(VIEWPORT_MARGIN, lookup.x), Math.max(VIEWPORT_MARGIN, maxLeft));
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, lookup.y + 8),
      Math.max(VIEWPORT_MARGIN, maxTop),
    );
    setPos({ left, top });
  }, [lookup]);

  // Escape key + outside mousedown close the popover.
  useEffect(() => {
    if (!lookup) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLookup(null);
    };
    const handleMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setLookup(null);
      }
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [lookup, setLookup]);

  // Re-derive whenever the glossary list changes (e.g. right after
  // this same popover just saved a new entry) so the footer flips to
  // "already in glossary" without needing to reopen the popover.
  const existingEntry = useMemo(
    () => (lookup ? findEntryBySurface(lookup.text) : null),
    [lookup, customEntries],
  );

  const handleAddToGlossary = async () => {
    if (!lookup) return;
    if (!settings.aiDetect) {
      setDraft(emptyDraft(lookup.text));
      return;
    }
    setGlossaryLoading(true);
    try {
      const defined = await defineApi(
        {
          phrase: lookup.text,
          context: lookup.contextText,
          model: resolveTaskCreds(settings, "detect").model,
        },
        settings,
      );
      setDraft({
        kind: defined.kind,
        headword: defined.headword,
        chinese_explanation: defined.chinese_explanation,
        example: defined.example,
        note: "",
        variants: defined.variants,
        source: "ai",
      });
    } catch (err) {
      if (err instanceof NoKeyError) {
        setDraft(emptyDraft(lookup.text));
      } else {
        showToast(err instanceof Error ? err.message : "解释失败，请重试");
      }
    } finally {
      setGlossaryLoading(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!lookup || !draft) return;
    const now = Date.now();
    const entry: CustomEntry = {
      id: newId(),
      kind: draft.kind,
      packId: "personal",
      headword: draft.headword.trim() || lookup.text,
      variants: draft.variants,
      chinese_explanation: draft.chinese_explanation.trim(),
      example: draft.example.trim(),
      context: lookup.contextText,
      note: draft.note.trim(),
      createdAt: now,
      updatedAt: now,
      source: draft.source,
      mastered: false,
      reviewCount: 0,
    };
    await addCustomEntry(entry);
    showToast("已加入我的词典");
    setDraft(null);
    setLookup(null);
  };

  if (!lookup || !pos) return null;

  return (
    <div
      ref={ref}
      className="scroll-thin fixed z-50 max-h-96 w-80 overflow-auto rounded-none border border-edge bg-panel2 glassable p-3 shadow-xl"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-fg">{lookup.text}</span>
        <button
          type="button"
          onClick={() => setLookup(null)}
          aria-label="关闭"
          className="flex h-6 w-6 shrink-0 items-center justify-center text-mut hover:bg-panel3 hover:text-fg"
        >
          <X size={14} weight="regular" />
        </button>
      </div>

      {dictFallback && (
        <span className="mt-1 inline-block border border-lab-orange/30 px-1.5 py-0 text-[10px] text-lab-orange">
          词典
        </span>
      )}

      <div className="mt-2">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-mut">
            <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
            解释中…
          </div>
        )}

        {!loading && error && (
          <div className="text-xs text-warn-soft">{error}</div>
        )}

        {!loading && !error && result && (
          <div className="space-y-2">
            {result.expressions.map((e, i) => (
              <div key={i} className="rounded-none bg-panel p-2">
                <div className="font-medium text-fg">{e.expression}</div>
                <div className="mt-2 text-sm font-medium leading-[26px] text-fg">
                  {e.chinese_explanation}
                </div>
                <div className="mt-2 text-xs text-mut">{e.plain_english}</div>
              </div>
            ))}
            {result.terms.map((t, i) => (
              <div key={i} className="rounded-none bg-panel p-2">
                <div className="font-medium text-fg">{t.term}</div>
                <div className="mt-2 text-sm text-mut">{t.gloss_zh}</div>
              </div>
            ))}
            {result.expressions.length === 0 && result.terms.length === 0 && (
              <div className="text-xs text-mut">
                未检测到需要特别解释的表达
              </div>
            )}
          </div>
        )}
      </div>

      {!loading && draft === null && (
        <div className="mt-3 border-t border-edge pt-2">
          {existingEntry ? (
            <button
              type="button"
              disabled
              className="w-full cursor-not-allowed border border-edge px-3 py-1.5 text-xs text-mut2"
            >
              已在词典中
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleAddToGlossary()}
              disabled={glossaryLoading}
              className="btn-tactile flex w-full items-center justify-center gap-2 border border-edge px-3 py-1.5 text-xs text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {glossaryLoading ? (
                <>
                  <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
                  生成中…
                </>
              ) : (
                "＋ 加入我的词典"
              )}
            </button>
          )}
        </div>
      )}

      {draft && (
        <div className="mt-3 space-y-2 border-t border-edge pt-3">
          <div className="flex items-center gap-2">
            <span
              className={`border px-1.5 py-0 text-[10px] ${
                draft.kind === "expression"
                  ? "border-lab-orange/30 text-lab-orange"
                  : "border-lab-cyan/30 text-lab-cyan"
              }`}
            >
              {KIND_LABELS[draft.kind]}
            </span>
            {draft.source === "ai" && (
              <span className="text-[10px] text-mut2">AI 已生成，可编辑</span>
            )}
          </div>

          <div>
            <label className="text-xs text-mut">词条</label>
            <input
              type="text"
              value={draft.headword}
              onChange={(e) =>
                setDraft((d) => (d ? { ...d, headword: e.target.value } : d))
              }
              className="mt-1 w-full border border-edge bg-panel px-2.5 py-1.5 text-sm text-fg focus:outline-none"
            />
          </div>

          <div>
            <label className="text-xs text-mut">中文解释</label>
            <textarea
              value={draft.chinese_explanation}
              onChange={(e) =>
                setDraft((d) =>
                  d ? { ...d, chinese_explanation: e.target.value } : d,
                )
              }
              placeholder="说明这词在会议里的意思…"
              rows={2}
              className="mt-1 w-full resize-none border border-edge bg-panel px-2.5 py-1.5 text-sm leading-[1.7] text-fg placeholder:text-mut2 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-xs text-mut">例句</label>
            <input
              type="text"
              value={draft.example}
              onChange={(e) =>
                setDraft((d) => (d ? { ...d, example: e.target.value } : d))
              }
              placeholder="可留空"
              className="mt-1 w-full border border-edge bg-panel px-2.5 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-xs text-mut">备注</label>
            <input
              type="text"
              value={draft.note}
              onChange={(e) =>
                setDraft((d) => (d ? { ...d, note: e.target.value } : d))
              }
              placeholder="自己的笔记，可留空"
              className="mt-1 w-full border border-edge bg-panel px-2.5 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="btn-tactile px-3 py-1.5 text-xs text-mut hover:bg-panel3 hover:text-fg"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleSaveDraft()}
              disabled={!draft.chinese_explanation.trim()}
              className="btn-terminal rounded-none bg-act px-3 py-1.5 text-xs font-mono font-semibold text-ink hover:bg-act/85 disabled:cursor-not-allowed disabled:opacity-50"
            >
              保存
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
