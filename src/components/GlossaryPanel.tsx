"use client";

// Personal dictionary panel: the cross-meeting home for user-curated
// glossary entries (collected from cards, AI-defined via lookup, or
// hand-added here). Matches CardsPanel chrome — see docs/DESIGN.md.

import { useMemo, useState } from "react";
import { CheckCircle } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { customEntryToFlashcard, newId } from "@/lib/types";
import { buildAnkiTSV, downloadFile } from "@/lib/history/export";
import type { CustomEntry, CustomEntryKind } from "@/lib/types";

const KIND_LABELS: Record<CustomEntryKind, string> = {
  expression: "表达",
  term: "术语",
};

const SOURCE_LABELS: Record<CustomEntry["source"], string> = {
  ai: "AI",
  manual: "手动",
  session: "会议",
};

interface EntryDraft {
  id: string | null; // null = creating a new entry
  kind: CustomEntryKind;
  headword: string;
  chinese_explanation: string;
  example: string;
  note: string;
}

function emptyDraft(): EntryDraft {
  return {
    id: null,
    kind: "expression",
    headword: "",
    chinese_explanation: "",
    example: "",
    note: "",
  };
}

function draftFromEntry(e: CustomEntry): EntryDraft {
  return {
    id: e.id,
    kind: e.kind,
    headword: e.headword,
    chinese_explanation: e.chinese_explanation,
    example: e.example,
    note: e.note,
  };
}

function EntryForm({
  draft,
  onChange,
  onCancel,
  onSave,
}: {
  draft: EntryDraft;
  onChange: (d: EntryDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="space-y-2 rounded-xl border border-edge bg-panel2 p-3">
      <div className="flex items-center gap-2">
        {(["expression", "term"] as CustomEntryKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onChange({ ...draft, kind: k })}
            className={`btn-tactile rounded-full border px-2.5 py-0.5 text-xs ${
              draft.kind === k
                ? "border-gold/40 text-gold/90"
                : "border-edge text-mut hover:text-fg"
            }`}
          >
            {KIND_LABELS[k]}
          </button>
        ))}
      </div>

      <div>
        <label className="text-xs text-mut">词条</label>
        <input
          type="text"
          value={draft.headword}
          onChange={(e) => onChange({ ...draft, headword: e.target.value })}
          className="mt-1 w-full rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-sm text-fg focus:outline-none"
        />
      </div>

      <div>
        <label className="text-xs text-mut">中文解释</label>
        <textarea
          value={draft.chinese_explanation}
          onChange={(e) =>
            onChange({ ...draft, chinese_explanation: e.target.value })
          }
          placeholder="说明这词在会议里的意思…"
          rows={2}
          className="mt-1 w-full resize-none rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-sm leading-[1.7] text-fg placeholder:text-mut2 focus:outline-none"
        />
      </div>

      <div>
        <label className="text-xs text-mut">例句</label>
        <input
          type="text"
          value={draft.example}
          onChange={(e) => onChange({ ...draft, example: e.target.value })}
          placeholder="可留空"
          className="mt-1 w-full rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
        />
      </div>

      <div>
        <label className="text-xs text-mut">备注</label>
        <input
          type="text"
          value={draft.note}
          onChange={(e) => onChange({ ...draft, note: e.target.value })}
          placeholder="自己的笔记，可留空"
          className="mt-1 w-full rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
        />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="btn-tactile rounded-lg px-3 py-1.5 text-xs text-mut hover:bg-panel3 hover:text-fg"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!draft.chinese_explanation.trim()}
          className="btn-tactile rounded-lg bg-acc px-3 py-1.5 text-xs font-medium text-white hover:bg-acchover disabled:cursor-not-allowed disabled:opacity-50"
        >
          保存
        </button>
      </div>
    </div>
  );
}

function EntryRow({ entry }: { entry: CustomEntry }) {
  const updateCustomEntry = useApp((s) => s.updateCustomEntry);
  const removeCustomEntry = useApp((s) => s.removeCustomEntry);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EntryDraft>(() => draftFromEntry(entry));
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleEdit = () => {
    setDraft(draftFromEntry(entry));
    setEditing(true);
  };

  const handleSave = () => {
    void updateCustomEntry({
      ...entry,
      kind: draft.kind,
      headword: draft.headword.trim() || entry.headword,
      chinese_explanation: draft.chinese_explanation.trim(),
      example: draft.example.trim(),
      note: draft.note.trim(),
    });
    setEditing(false);
  };

  const handleDeleteClick = () => {
    if (confirmDelete) {
      void removeCustomEntry(entry.id);
      setConfirmDelete(false);
      return;
    }
    setConfirmDelete(true);
    setTimeout(() => setConfirmDelete(false), 3000);
  };

  const handleToggleMastered = () => {
    void updateCustomEntry({ ...entry, mastered: !entry.mastered });
  };

  if (editing) {
    return (
      <EntryForm
        draft={draft}
        onChange={setDraft}
        onCancel={() => setEditing(false)}
        onSave={handleSave}
      />
    );
  }

  return (
    <div className="rounded-xl border border-edge bg-panel p-3 transition-colors hover:bg-panel3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-fg">{entry.headword}</span>
        <span className="rounded-full border border-edge px-1.5 py-0 text-[10px] text-mut">
          {KIND_LABELS[entry.kind]}
        </span>
        <span className="rounded-full border border-gold/30 px-1.5 py-0 text-[10px] text-gold/80">
          {SOURCE_LABELS[entry.source]}
        </span>
        {entry.mastered && (
          <CheckCircle size={16} weight="regular" className="text-acc2" />
        )}
      </div>

      <div className="mt-1.5 text-[15px] font-medium leading-[1.7] text-fg">
        {entry.chinese_explanation}
      </div>

      {entry.example && (
        <div className="mt-1.5 text-xs italic text-mut">{entry.example}</div>
      )}

      {entry.context && (
        <div
          className="mt-2 line-clamp-2 border-l-2 border-edge pl-2 text-xs text-mut"
          title={entry.context}
        >
          {entry.context}
        </div>
      )}

      <div className="mt-2 flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={handleEdit}
          className="btn-tactile text-mut hover:text-fg"
        >
          编辑
        </button>
        <button
          type="button"
          onClick={handleToggleMastered}
          className="btn-tactile text-mut hover:text-fg"
        >
          {entry.mastered ? "取消掌握" : "掌握"}
        </button>
        <button
          type="button"
          onClick={handleDeleteClick}
          className={`btn-tactile ${confirmDelete ? "text-warn" : "text-mut hover:text-warn"}`}
        >
          {confirmDelete ? "确认删除?" : "删除"}
        </button>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="text-sm font-medium text-fg">词典还是空的</div>
      <div className="mt-2 max-w-xs text-xs leading-[1.7] text-mut">
        划词收藏或手动添加，你的词条会在以后所有会议里自动高亮。
      </div>
    </div>
  );
}

export default function GlossaryPanel() {
  const customEntries = useApp((s) => s.customEntries);
  const addCustomEntry = useApp((s) => s.addCustomEntry);
  const showToast = useApp((s) => s.showToast);

  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState<EntryDraft>(emptyDraft());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? customEntries.filter(
          (e) =>
            e.headword.toLowerCase().includes(q) ||
            e.chinese_explanation.toLowerCase().includes(q),
        )
      : customEntries;
    return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [customEntries, query]);

  const handleStartCreate = () => {
    setCreateDraft(emptyDraft());
    setCreating(true);
  };

  const handleCreateSave = () => {
    if (!createDraft.chinese_explanation.trim()) return;
    const now = Date.now();
    const entry: CustomEntry = {
      id: newId(),
      kind: createDraft.kind,
      headword: createDraft.headword.trim(),
      variants: [],
      chinese_explanation: createDraft.chinese_explanation.trim(),
      example: createDraft.example.trim(),
      context: "",
      note: createDraft.note.trim(),
      createdAt: now,
      updatedAt: now,
      source: "manual",
      mastered: false,
      reviewCount: 0,
    };
    void addCustomEntry(entry);
    setCreating(false);
  };

  const handleExportAnki = () => {
    const tsv = buildAnkiTSV(customEntries.map(customEntryToFlashcard));
    downloadFile("jargonslayer-glossary.tsv", tsv, "text/tab-separated-values");
    showToast("已导出 Anki .tsv");
  };

  return (
    <div className="flex h-full flex-col" data-testid="glossary-panel">
      <div className="shrink-0 space-y-2 px-3 pt-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg">我的词典</span>
            <span className="font-mono text-xs tabular-nums text-mut2">
              {customEntries.length}
            </span>
          </div>
          <button
            type="button"
            onClick={handleStartCreate}
            className="btn-tactile rounded-lg border border-edge px-2.5 py-1 text-xs text-fg hover:bg-panel3"
          >
            ＋手动添加
          </button>
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索词条或中文解释…"
          className="w-full rounded-lg border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
        />
      </div>

      <div className="scroll-thin flex-1 space-y-2 overflow-y-auto px-3 pb-3 pt-2">
        {creating && (
          <EntryForm
            draft={createDraft}
            onChange={setCreateDraft}
            onCancel={() => setCreating(false)}
            onSave={handleCreateSave}
          />
        )}

        {filtered.length === 0 && !creating ? (
          <EmptyState />
        ) : (
          filtered.map((entry) => <EntryRow key={entry.id} entry={entry} />)
        )}
      </div>

      {customEntries.length > 0 && (
        <div className="shrink-0 border-t border-edge px-3 py-2">
          <button
            type="button"
            onClick={handleExportAnki}
            className="btn-tactile w-full rounded-lg border border-edge px-3 py-1.5 text-xs text-fg hover:bg-panel3"
          >
            导出 Anki .tsv
          </button>
        </div>
      )}
    </div>
  );
}
