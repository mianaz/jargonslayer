"use client";

// Personal dictionary panel: the cross-meeting home for user-curated
// glossary entries (collected from cards, AI-defined via lookup, or
// hand-added here). Matches CardsPanel chrome — see docs/DESIGN.md.
//
// v0.5 Wave-1 Feature 8 (named custom dictionary packs, docs/design-
// explorations/v05-wave1-blueprint.md §1 F8 + §5 A7/A9): pack
// management (tabs, enable toggle, create/rename/delete) lives here,
// NOT in SettingsDialog (A9's last sentence). Packs themselves are
// glossary.ts's own registry (not zustand state) — this component
// loads/mutates them directly through that module and only reaches
// into the store for entry CRUD (unchanged, existing actions).

import { useEffect, useMemo, useState } from "react";
import { CheckCircle } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { customEntryToFlashcard, newId } from "@jargonslayer/core/types";
import { buildAnkiTSV, downloadFile } from "@/lib/history/export";
import * as glossary from "@/lib/history/glossary";
import ToggleSwitch from "./ToggleSwitch";
import type { CustomEntry, CustomEntryKind, CustomPack } from "@jargonslayer/core/types";

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
  packId: string;
  headword: string;
  chinese_explanation: string;
  example: string;
  note: string;
}

function emptyDraft(packId: string): EntryDraft {
  return {
    id: null,
    kind: "expression",
    packId,
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
    packId: e.packId,
    headword: e.headword,
    chinese_explanation: e.chinese_explanation,
    example: e.example,
    note: e.note,
  };
}

/** Personal pinned first, everything else in creation order — shared
 *  by the tab bar and every pack <select>. */
function sortPacks(packs: CustomPack[]): CustomPack[] {
  const personal = packs.find((p) => p.id === glossary.PERSONAL_PACK_ID);
  const rest = packs
    .filter((p) => p.id !== glossary.PERSONAL_PACK_ID)
    .sort((a, b) => a.createdAt - b.createdAt);
  return personal ? [personal, ...rest] : rest;
}

function EntryForm({
  draft,
  packs,
  onChange,
  onCancel,
  onSave,
}: {
  draft: EntryDraft;
  packs: CustomPack[];
  onChange: (d: EntryDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="space-y-2 rounded-none border border-edge bg-panel2 p-3">
      <div className="flex items-center gap-2">
        {(["expression", "term"] as CustomEntryKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onChange({ ...draft, kind: k })}
            className={`btn-tactile border px-2.5 py-0.5 text-xs ${
              draft.kind === k
                ? "border-lab-orange/40 text-lab-orange"
                : "border-edge text-mut hover:text-fg"
            }`}
          >
            {KIND_LABELS[k]}
          </button>
        ))}
      </div>

      <div>
        <label className="text-xs text-mut">词包</label>
        <select
          value={draft.packId}
          onChange={(e) => onChange({ ...draft, packId: e.target.value })}
          className="mt-1 w-full border border-edge bg-panel px-2.5 py-1.5 text-sm text-fg focus:outline-none"
        >
          {packs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-xs text-mut">词条</label>
        <input
          type="text"
          value={draft.headword}
          onChange={(e) => onChange({ ...draft, headword: e.target.value })}
          className="mt-1 w-full border border-edge bg-panel px-2.5 py-1.5 text-sm text-fg focus:outline-none"
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
          className="mt-1 w-full resize-none border border-edge bg-panel px-2.5 py-1.5 text-sm leading-[1.7] text-fg placeholder:text-mut2 focus:outline-none"
        />
      </div>

      <div>
        <label className="text-xs text-mut">例句</label>
        <input
          type="text"
          value={draft.example}
          onChange={(e) => onChange({ ...draft, example: e.target.value })}
          placeholder="可留空"
          className="mt-1 w-full border border-edge bg-panel px-2.5 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
        />
      </div>

      <div>
        <label className="text-xs text-mut">备注</label>
        <input
          type="text"
          value={draft.note}
          onChange={(e) => onChange({ ...draft, note: e.target.value })}
          placeholder="自己的笔记，可留空"
          className="mt-1 w-full border border-edge bg-panel px-2.5 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
        />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="btn-tactile px-3 py-1.5 text-xs text-mut hover:bg-panel3 hover:text-fg"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!draft.chinese_explanation.trim()}
          className="btn-terminal rounded-none bg-act px-3 py-1.5 text-xs font-mono font-semibold text-ink hover:bg-act/85 disabled:cursor-not-allowed disabled:opacity-50"
        >
          保存
        </button>
      </div>
    </div>
  );
}

function EntryRow({
  entry,
  packs,
  showPackTag,
}: {
  entry: CustomEntry;
  packs: CustomPack[];
  showPackTag: boolean;
}) {
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
      packId: draft.packId,
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
        packs={packs}
        onChange={setDraft}
        onCancel={() => setEditing(false)}
        onSave={handleSave}
      />
    );
  }

  const kindBorderCls =
    entry.kind === "expression" ? "border-l-lab-orange" : "border-l-lab-cyan";
  const packName = packs.find((p) => p.id === entry.packId)?.name ?? entry.packId;

  return (
    <div
      className={`rounded-none border-l-2 ${kindBorderCls} border-b border-edge bg-panel p-3 transition-colors hover:bg-panel3`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-semibold text-fg">{entry.headword}</span>
        <span className="border border-edge px-1.5 py-0 text-[10px] text-mut">
          {KIND_LABELS[entry.kind]}
        </span>
        <span className="border border-edge2 px-1.5 py-0 text-[10px] text-mut">
          {SOURCE_LABELS[entry.source]}
        </span>
        {showPackTag && (
          <span className="border border-edge2 px-1.5 py-0 text-[10px] text-mut">
            {packName}
          </span>
        )}
        {entry.mastered && (
          <CheckCircle size={16} weight="regular" className="text-lab-green" />
        )}
      </div>

      <div className="mt-2 text-[15px] font-medium leading-[26px] text-fg">
        {entry.chinese_explanation}
      </div>

      {entry.example && (
        <div className="mt-2 text-xs italic text-mut">{entry.example}</div>
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
          className={`btn-tactile ${confirmDelete ? "text-warn-soft" : "text-mut hover:text-warn-soft"}`}
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
  const updateCustomEntry = useApp((s) => s.updateCustomEntry);
  const showToast = useApp((s) => s.showToast);

  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState<EntryDraft>(() =>
    emptyDraft(glossary.PERSONAL_PACK_ID),
  );

  const [packs, setPacks] = useState<CustomPack[]>(() => glossary.getCustomPacks());
  const [selectedPackId, setSelectedPackId] = useState<string>("all");
  const [creatingPack, setCreatingPack] = useState(false);
  const [newPackName, setNewPackName] = useState("");
  const [renamingPackId, setRenamingPackId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDeletePackId, setConfirmDeletePackId] = useState<string | null>(null);

  useEffect(() => {
    void glossary.loadCustomPacks().then(setPacks);
  }, []);

  const sortedPacks = useMemo(() => sortPacks(packs), [packs]);
  const selectedPack = packs.find((p) => p.id === selectedPackId) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = customEntries;
    if (selectedPackId !== "all") {
      list = list.filter((e) => e.packId === selectedPackId);
    }
    if (q) {
      list = list.filter(
        (e) =>
          e.headword.toLowerCase().includes(q) ||
          e.chinese_explanation.toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [customEntries, query, selectedPackId]);

  const handleStartCreate = () => {
    setCreateDraft(emptyDraft(selectedPackId === "all" ? glossary.PERSONAL_PACK_ID : selectedPackId));
    setCreating(true);
  };

  const handleCreateSave = () => {
    if (!createDraft.chinese_explanation.trim()) return;
    const now = Date.now();
    const entry: CustomEntry = {
      id: newId(),
      kind: createDraft.kind,
      packId: createDraft.packId,
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

  const handleCreatePack = async () => {
    const name = newPackName.trim();
    if (!name) return;
    try {
      const next = await glossary.createCustomPack(name);
      setPacks(next);
      setNewPackName("");
      setCreatingPack(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "创建词包失败");
    }
  };

  const handleRenamePack = async (id: string) => {
    const name = renameDraft.trim();
    if (!name) return;
    try {
      const next = await glossary.renameCustomPack(id, name);
      setPacks(next);
      setRenamingPackId(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "重命名失败");
    }
  };

  const handleTogglePack = async (id: string, enabled: boolean) => {
    try {
      const next = await glossary.setCustomPackEnabled(id, enabled);
      setPacks(next);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "更新词包失败");
    }
  };

  const handleDeletePack = async (id: string) => {
    try {
      // Move affected entries to personal FIRST (via the existing
      // store action — keeps zustand's customEntries authoritative)
      // so the pack is only removed once its entries have somewhere
      // to land.
      const affected = customEntries.filter((e) => e.packId === id);
      for (const entry of affected) {
        await updateCustomEntry({ ...entry, packId: glossary.PERSONAL_PACK_ID });
      }
      const next = await glossary.deleteCustomPack(id, true);
      setPacks(next);
      if (selectedPackId === id) setSelectedPackId("all");
      setConfirmDeletePackId(null);
      showToast("词包已删除，词条已移至个人词库");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "删除词包失败");
    }
  };

  const handleDeletePackClick = (id: string) => {
    if (confirmDeletePackId === id) {
      void handleDeletePack(id);
      return;
    }
    setConfirmDeletePackId(id);
    setTimeout(() => setConfirmDeletePackId((cur) => (cur === id ? null : cur)), 3000);
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
            className="btn-tactile border border-edge2 px-2.5 py-1 text-xs text-fg hover:bg-panel3"
          >
            ＋手动添加
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5" data-testid="glossary-pack-tabs">
          <button
            type="button"
            onClick={() => setSelectedPackId("all")}
            className={`btn-tactile border px-2.5 py-1 text-xs ${
              selectedPackId === "all"
                ? "border-lab-orange/40 text-lab-orange"
                : "border-edge text-mut hover:text-fg"
            }`}
          >
            全部
          </button>
          {sortedPacks.map((pack) => {
            const active = selectedPackId === pack.id;
            return (
              <button
                key={pack.id}
                type="button"
                onClick={() => setSelectedPackId(pack.id)}
                title={pack.enabled ? undefined : "已停用 — 不参与识别"}
                className={`btn-tactile border px-2.5 py-1 text-xs ${
                  active ? "border-lab-orange/40 text-lab-orange" : "border-edge text-mut hover:text-fg"
                } ${pack.enabled ? "" : "opacity-50"}`}
              >
                {pack.name}
              </button>
            );
          })}
          {creatingPack ? (
            <div className="flex items-center gap-1">
              <input
                type="text"
                autoFocus
                value={newPackName}
                onChange={(e) => setNewPackName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreatePack();
                  if (e.key === "Escape") {
                    setCreatingPack(false);
                    setNewPackName("");
                  }
                }}
                placeholder="词包名称"
                className="w-28 border border-edge bg-panel px-2 py-1 text-xs text-fg placeholder:text-mut2 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void handleCreatePack()}
                className="btn-tactile border border-edge2 px-2 py-1 text-xs text-fg hover:bg-panel3"
              >
                创建
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreatingPack(true)}
              className="btn-tactile border border-edge2 px-2.5 py-1 text-xs text-mut hover:bg-panel3 hover:text-fg"
            >
              ＋新建词包
            </button>
          )}
        </div>

        {selectedPack && (
          <div className="flex flex-wrap items-center gap-3 text-xs">
            {/* ITEM 7a fix (fix round, Opus sub-bar, lead-accepted):
               personal is the fixed default glossary — it must not be
               silently disable-able (the enable-toggle) or renamable
               (kept hidden here, mirroring the delete button's existing
               `!== PERSONAL_PACK_ID` guard just below) — only its own
               entries/creation flow are ever editable. */}
            {selectedPack.id !== glossary.PERSONAL_PACK_ID && (
              <label className="flex items-center gap-1.5 text-mut">
                <ToggleSwitch
                  checked={selectedPack.enabled}
                  onChange={(checked) => void handleTogglePack(selectedPack.id, checked)}
                  ariaLabel={`启用词包 ${selectedPack.name}`}
                />
                启用
              </label>
            )}
            {selectedPack.id !== glossary.PERSONAL_PACK_ID &&
              (renamingPackId === selectedPack.id ? (
                <>
                  <input
                    type="text"
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleRenamePack(selectedPack.id);
                      if (e.key === "Escape") setRenamingPackId(null);
                    }}
                    className="w-28 border border-edge bg-panel px-2 py-1 text-xs text-fg focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleRenamePack(selectedPack.id)}
                    className="btn-tactile text-mut hover:text-fg"
                  >
                    保存
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setRenamingPackId(selectedPack.id);
                    setRenameDraft(selectedPack.name);
                  }}
                  className="btn-tactile text-mut hover:text-fg"
                >
                  重命名
                </button>
              ))}
            {selectedPack.id !== glossary.PERSONAL_PACK_ID && (
              <button
                type="button"
                onClick={() => handleDeletePackClick(selectedPack.id)}
                title="删除后词条会移至个人词库"
                className={`btn-tactile ${
                  confirmDeletePackId === selectedPack.id ? "text-warn-soft" : "text-mut hover:text-warn-soft"
                }`}
              >
                {confirmDeletePackId === selectedPack.id ? "确认删除?" : "删除词包"}
              </button>
            )}
          </div>
        )}

        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索词条或中文解释…"
          className="w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
        />
      </div>

      {/* S14.1 field fix (item 9): pb matches StatusLine's own h-7
          (page.tsx renders it as a separate sibling BELOW this whole
          tab panel) + a safe-area-inset-bottom no-op for now — see
          CardsPanel.tsx's own identical fix for the full rationale. */}
      <div className="scroll-thin flex-1 space-y-2 overflow-y-auto px-3 pb-[calc(1.75rem+env(safe-area-inset-bottom))] pt-2">
        {creating && (
          <EntryForm
            draft={createDraft}
            packs={packs}
            onChange={setCreateDraft}
            onCancel={() => setCreating(false)}
            onSave={handleCreateSave}
          />
        )}

        {filtered.length === 0 && !creating ? (
          <EmptyState />
        ) : (
          filtered.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              packs={packs}
              showPackTag={selectedPackId === "all"}
            />
          ))
        )}
      </div>

      {customEntries.length > 0 && (
        <div className="shrink-0 border-t border-edge px-3 py-2">
          <button
            type="button"
            onClick={handleExportAnki}
            className="btn-tactile w-full border border-edge2 px-3 py-1.5 font-mono text-xs text-fg hover:bg-panel3"
          >
            导出 Anki .tsv
          </button>
        </div>
      )}
    </div>
  );
}
