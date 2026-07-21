"use client";

// Custom theme editor subcomponent (v0.5.1 appearance sprint, D4).
// Self-contained, props-driven — no direct store access (mirrors
// AnkiConnectSection.tsx's own convention), EXCEPT for lib/theme/apply's
// activateTheme, which this component calls DIRECTLY for live preview
// (a raw CSSOM mutation, not a store write — see the preview effect
// below). SettingsDialog.tsx renders this INSTEAD of the 显示 section's
// normal theme grid while editing (inner panel swap, not a second
// dialog), and owns the actual persistence: onSave/onDelete write
// straight through updateSettings({customThemes}) — NOT the dialog
// draft (D1) — while this component only ever builds/validates the
// ThemeDefinition and hands it up.
//
// Builtins are immutable — editing one is really "复制并编辑": the
// editor always operates on a fresh in-memory draft seeded from
// whatever `sourceThemeId` resolves to, and only WRITES to
// `editingThemeId` (an existing CUSTOM theme's own id) when that prop
// is set; otherwise 保存主题 mints a new id (mintCustomThemeId).

import { useEffect, useRef, useState } from "react";
import { activateTheme, resetToDefaultTheme } from "@/lib/theme/apply";
import { contrastRatio } from "@/lib/theme/contrast";
import {
  CUSTOM_THEME_CAP,
  CUSTOM_THEME_ID_PREFIX,
  mintCustomThemeId,
  resolveThemeById,
} from "@/lib/theme/resolve";
import {
  HEX_COLOR_RE,
  parseTheme,
  THEME_TOKEN_KEYS,
  type ThemeDefinition,
  type ThemeScheme,
  type ThemeTokenKey,
  type ThemeTokens,
} from "@/lib/theme/schema";
import { BUILTIN_THEMES, TERMINAL_THEME } from "@/lib/theme/themes";

// Preview activations use a fixed, never-"terminal" id — activateTheme's
// own dispatcher special-cases the literal string "terminal" to always
// go through resetToDefaultTheme() and IGNORE whatever tokens/scheme
// were passed (see apply.ts), which would silently break preview the
// moment someone duplicates FROM terminal without renaming anything
// yet. dataset.theme's value during a preview has no other meaning —
// no CSS selector keys off it besides `[data-theme="terminal"]`.
const PREVIEW_THEME_ID = `${CUSTOM_THEME_ID_PREFIX}preview`;
const PREVIEW_DEBOUNCE_MS = 150;

// One-line zh role hints per token, transcribed from docs/DESIGN.md
// v3.1's color table (the canonical per-token role description) —
// shown next to each row so a first-time editor doesn't have to guess
// what e.g. "edge2" governs.
const TOKEN_ROLE_HINTS: Record<ThemeTokenKey, string> = {
  ink: "页面底色（纯黑背景）",
  panel: "常规面板背景",
  panel2: "浮层背景（弹窗、下拉）",
  panel3: "悬停/激活态背景",
  edge: "一般分隔线",
  edge2: "强分隔线（区块分界）",
  fg: "主要文字",
  mut: "次要文字",
  mut2: "装饰性微元素，不承载中文",
  "lab-red": "俚语标签 / 危险 / 错误",
  "lab-orange": "习语标签；表达高亮下划线",
  "lab-yellow": "委婉标签 / 警示",
  "lab-green": "聆听态 / 成功 / 新卡高亮",
  "lab-purple": "隐喻标签",
  "lab-cyan": "术语标签；术语高亮下划线",
  act: "唯一强调色（主按钮：亮底黑字）",
  "warn-soft": "警示文字专用（比 lab-red 柔和）",
};

// Backgrounds every contrast hint below is checked against — the same
// 4-panel-level sweep themes.test.ts's own AA suite applies to every
// BUILTIN theme; here it's advisory only (never blocks saving a custom
// theme — that suite's bars are a gate for BUILTINS, not a user's own).
const PANEL_KEYS: readonly ThemeTokenKey[] = ["ink", "panel", "panel2", "panel3"];

// Which tokens get a hint row, and each one's own bar: 4.5:1 for every
// token that's rendered AS TEXT somewhere (fg/mut/mut2/all lab-*/
// warn-soft — DESIGN.md v3.1's own table), "act" included even though
// its REAL usage is a fill-with-ink-text-on-top (bg-act + text-ink,
// see apply.ts's own comment on that pairing) — treated uniformly
// "as text" here for a simpler mental model, not because that's its
// actual role. edge2 is the one non-text token in this list (a UI
// divider drawn over a panel), so it gets WCAG 1.4.11's 3:1 non-text
// bar instead of 1.4.3's 4.5:1 text bar.
const CONTRAST_ROWS: { key: ThemeTokenKey; threshold: number }[] = [
  { key: "fg", threshold: 4.5 },
  { key: "mut", threshold: 4.5 },
  { key: "mut2", threshold: 4.5 },
  { key: "lab-red", threshold: 4.5 },
  { key: "lab-orange", threshold: 4.5 },
  { key: "lab-yellow", threshold: 4.5 },
  { key: "lab-green", threshold: 4.5 },
  { key: "lab-purple", threshold: 4.5 },
  { key: "lab-cyan", threshold: 4.5 },
  { key: "act", threshold: 4.5 },
  { key: "warn-soft", threshold: 4.5 },
  { key: "edge2", threshold: 3.0 },
];
const CONTRAST_THRESHOLD_BY_KEY = new Map(CONTRAST_ROWS.map((r) => [r.key, r.threshold]));

/** Worst-case contrast of `tokens[key]` against every panel level. */
function worstContrast(tokens: ThemeTokens, key: ThemeTokenKey): number {
  return Math.min(...PANEL_KEYS.map((bg) => contrastRatio(tokens[key], tokens[bg])));
}

function allThemeOptions(customThemes: readonly ThemeDefinition[]): readonly ThemeDefinition[] {
  return [...BUILTIN_THEMES, ...customThemes];
}

// `<input type="color">` only ever accepts an exact 7-char "#rrggbb"
// value — a 3-digit shorthand (valid per HEX_COLOR_RE, so a user CAN
// type "#0f0" into the hex text field and have it land in draftTokens)
// would otherwise make the native picker silently reject/reset the
// value. Expand-only, never used for the hex TEXT input itself (that
// one echoes exactly what was typed, shorthand included — schema.ts
// accepts either form, no need to force-normalize what gets saved).
function toSixDigitHex(hex: string): string {
  if (hex.length === 4) {
    const [, r, g, b] = hex;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return hex;
}

// Filesystem-illegal characters only (not a Unicode-stripping ASCII
// sanitizer like autoExport.ts's filenameBase — a theme label is very
// often Chinese, and modern filesystems handle Unicode filenames fine;
// this only guards the handful of characters that are ACTUALLY illegal
// on some platform, e.g. `/` and `:` on macOS/Windows).
function sanitizeFilename(label: string): string {
  return label.replace(/[/\\:*?"<>|]/g, "_").trim() || "自定义主题";
}

export interface ThemeEditorProps {
  /** All CUSTOM themes (not builtins — those come from BUILTIN_THEMES
   *  directly) — used for the "基于" dropdown's custom half and for
   *  id-collision checks when minting. */
  customThemes: readonly ThemeDefinition[];
  /** Initial "基于" source + initial token/scheme/label fill. For a
   *  fresh 新建 this is the dialog draft's currently-selected theme id;
   *  for 编辑 on an existing tile (builtin or custom) it's that tile's
   *  own id. */
  sourceThemeId: string;
  /** Set only when editing an EXISTING CUSTOM theme in place — 保存主题
   *  then UPDATES this id instead of minting a new one, and 删除
   *  becomes available. Undefined for a fresh create or a builtin
   *  duplicate (builtins are immutable — nothing to update/delete). */
  editingThemeId?: string;
  /** The SAVED (store) theme id — i.e. the theme actually applied to
   *  the page right now — read only on 取消/返回 to know what to
   *  re-activate so this panel's live preview never leaks past it (D4).
   *  Deliberately NOT the dialog draft's themeId: tile clicks only
   *  patch the draft (nothing applies until the dialog's own 保存), so
   *  reverting to a draft selection would paint a theme the user never
   *  saved. Saving/deleting don't need this: both write straight
   *  through updateSettings, whose own side effect (store.ts) already
   *  re-resolves+re-applies the correct live theme as a direct
   *  consequence of the customThemes write itself. */
  activeThemeId: string;
  onSave: (theme: ThemeDefinition) => void;
  onDelete: (id: string) => void;
  onBack: () => void;
  showToast: (message: string) => void;
}

export default function ThemeEditor({
  customThemes,
  sourceThemeId,
  editingThemeId,
  activeThemeId,
  onSave,
  onDelete,
  onBack,
  showToast,
}: ThemeEditorProps) {
  const [basedOnId, setBasedOnId] = useState(sourceThemeId);
  const initial = resolveThemeById(sourceThemeId, customThemes) ?? TERMINAL_THEME;
  const [label, setLabel] = useState(editingThemeId ? initial.label : `${initial.label} 副本`);
  const [scheme, setScheme] = useState<ThemeScheme>(initial.scheme);
  const [draftTokens, setDraftTokens] = useState<ThemeTokens>(initial.tokens);
  // What's literally typed in each hex text field — MAY be momentarily
  // invalid mid-edit (e.g. "#ff"), unlike draftTokens (see below).
  const [rawInputs, setRawInputs] = useState<ThemeTokens>(initial.tokens);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleBasedOnChange = (id: string) => {
    setBasedOnId(id);
    const source = resolveThemeById(id, customThemes) ?? TERMINAL_THEME;
    setScheme(source.scheme);
    setDraftTokens(source.tokens);
    setRawInputs(source.tokens);
  };

  // Hex text input: reflects EXACTLY what was typed (never fights the
  // user mid-edit); only promoted into draftTokens — the "last known
  // GOOD" value used for preview/contrast/color-swatch/save — once it
  // actually clears HEX_COLOR_RE. An in-progress invalid value (e.g.
  // "#f") just leaves the swatch/preview/contrast on the previous
  // valid value for that ONE token until it's finished.
  const handleHexTextChange = (key: ThemeTokenKey, value: string) => {
    setRawInputs((prev) => ({ ...prev, [key]: value }));
    if (HEX_COLOR_RE.test(value)) {
      setDraftTokens((prev) => ({ ...prev, [key]: value }));
    }
  };

  // Native color inputs only ever emit a valid 6-digit hex — no
  // validity gate needed, both copies update together.
  const handleColorPickerChange = (key: ThemeTokenKey, value: string) => {
    setRawInputs((prev) => ({ ...prev, [key]: value }));
    setDraftTokens((prev) => ({ ...prev, [key]: value }));
  };

  // Live preview (D4): throttled ~150ms so a fast drag across a color
  // picker doesn't fire a setProperty storm — same useRef+setTimeout
  // debounce pattern as ImportHub.tsx's own live-parse preview. Fires
  // on mount too (React runs effects after the first render), so
  // opening the editor immediately previews its initial fill, not just
  // once the user makes an edit.
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      activateTheme(PREVIEW_THEME_ID, draftTokens, scheme);
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [draftTokens, scheme]);

  // 取消/返回: no store write happens on this path (unlike save/delete,
  // which self-heal the live theme as a side effect of their own
  // updateSettings call — see the props doc above), so THIS is the one
  // path that must explicitly undo whatever this panel's own preview
  // left on the page, reverting to the SAVED/applied theme (see the
  // activeThemeId props doc for why never the dialog draft's pick).
  const handleBack = () => {
    const target = resolveThemeById(activeThemeId, customThemes);
    if (target) {
      activateTheme(target.id, target.tokens, target.scheme);
    } else {
      resetToDefaultTheme();
    }
    onBack();
  };

  const handleSaveTheme = () => {
    if (!editingThemeId && customThemes.length >= CUSTOM_THEME_CAP) {
      showToast(`最多保存 ${CUSTOM_THEME_CAP} 个自定义主题，请先删除一些再新建`);
      return;
    }
    const trimmedLabel = label.trim() || "自定义主题";
    const id =
      editingThemeId ??
      mintCustomThemeId(
        trimmedLabel,
        customThemes.map((t) => t.id),
      );
    const result = parseTheme({ id, label: trimmedLabel, scheme, tokens: draftTokens });
    if (!result.ok) {
      showToast(`主题保存失败：${result.error}`);
      return;
    }
    onSave(result.theme);
    onBack();
  };

  const handleExport = () => {
    const trimmedLabel = label.trim() || "自定义主题";
    const id =
      editingThemeId ??
      mintCustomThemeId(
        trimmedLabel,
        customThemes.map((t) => t.id),
      );
    const theme: ThemeDefinition = { id, label: trimmedLabel, scheme, tokens: draftTokens };
    const json = JSON.stringify(theme, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sanitizeFilename(trimmedLabel)}.jargonslayer-theme.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("已导出主题文件");
  };

  const handleDeleteClick = () => {
    if (!editingThemeId) return;
    if (confirmDelete) {
      onDelete(editingThemeId);
      setConfirmDelete(false);
      onBack();
      return;
    }
    setConfirmDelete(true);
    setTimeout(() => setConfirmDelete(false), 3000);
  };

  return (
    <div className="space-y-3 border-t border-edge pt-5" data-testid="theme-editor">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleBack}
          className="btn-tactile border border-edge px-2 py-1 text-xs text-mut hover:bg-panel3 hover:text-fg"
        >
          ← 返回
        </button>
        <div className="text-xs uppercase tracking-wide text-mut">
          {editingThemeId ? "编辑主题" : "新建主题"}
        </div>
      </div>

      <div>
        <label className="text-xs text-mut">名称</label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="自定义主题"
          className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
        />
      </div>

      <div>
        <label className="text-xs text-mut">基于</label>
        <select
          value={basedOnId}
          onChange={(e) => handleBasedOnChange(e.target.value)}
          className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
        >
          {allThemeOptions(customThemes).map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <div className="mt-1 text-xs text-mut2">复制该主题的全部取值作为起点，不影响原主题</div>
      </div>

      <div>
        <label className="text-xs text-mut">配色方案</label>
        <div className="mt-1 flex items-center gap-0.5 border border-edge bg-panel2 p-0.5">
          <button
            type="button"
            onClick={() => setScheme("dark")}
            className={`flex-1 px-2 py-1.5 text-sm transition-colors ${
              scheme === "dark" ? "bg-panel3 text-fg" : "text-mut hover:text-fg"
            }`}
          >
            深色
          </button>
          <button
            type="button"
            onClick={() => setScheme("light")}
            className={`flex-1 px-2 py-1.5 text-sm transition-colors ${
              scheme === "light" ? "bg-panel3 text-fg" : "text-mut hover:text-fg"
            }`}
          >
            浅色
          </button>
        </div>
      </div>

      <div className="space-y-1.5 border-t border-edge pt-3">
        <div className="text-xs uppercase tracking-wide text-mut">颜色 token</div>
        {THEME_TOKEN_KEYS.map((key) => {
          const threshold = CONTRAST_THRESHOLD_BY_KEY.get(key);
          const ratio = threshold !== undefined ? worstContrast(draftTokens, key) : null;
          const passes = ratio !== null && threshold !== undefined && ratio >= threshold;
          return (
            <div key={key} className="flex items-center gap-2 py-1">
              <div className="w-24 shrink-0 font-mono text-xs text-fg">{key}</div>
              <div className="flex-1 truncate text-xs text-mut2">{TOKEN_ROLE_HINTS[key]}</div>
              <input
                type="color"
                value={toSixDigitHex(draftTokens[key])}
                onChange={(e) => handleColorPickerChange(key, e.target.value)}
                className="h-7 w-7 shrink-0 cursor-pointer border border-edge bg-panel2 p-0"
                aria-label={`${key} 取色`}
              />
              <input
                type="text"
                value={rawInputs[key]}
                onChange={(e) => handleHexTextChange(key, e.target.value)}
                className="w-24 shrink-0 border border-edge bg-panel2 px-2 py-1 font-mono text-xs text-fg focus:outline-none"
                aria-label={`${key} 十六进制值`}
              />
              {ratio !== null && (
                <div
                  className={`w-16 shrink-0 text-right text-xs ${passes ? "text-lab-green" : "text-warn-soft"}`}
                  title={`对 ink/panel/panel2/panel3 最差对比度 ${ratio.toFixed(1)}:1（要求 ≥${threshold}:1）`}
                >
                  {passes ? "✓" : "⚠"} {ratio.toFixed(1)}
                </div>
              )}
            </div>
          );
        })}
        <div className="text-xs leading-[1.7] text-mut2">
          对比度提示仅供参考，不会阻止保存——你的主题、你的取舍
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-edge pt-3">
        <button
          type="button"
          onClick={handleSaveTheme}
          className="btn-terminal rounded-none bg-act px-4 py-2 text-sm font-semibold text-ink hover:bg-act/85"
        >
          保存主题
        </button>
        <button
          type="button"
          onClick={handleExport}
          className="btn-tactile border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3"
        >
          导出
        </button>
        {editingThemeId && (
          <button
            type="button"
            onClick={handleDeleteClick}
            className={`btn-tactile border px-3 py-1.5 text-sm ${
              confirmDelete
                ? "border-warn-soft/50 text-warn-soft"
                : "border-edge text-mut hover:text-warn-soft"
            }`}
          >
            {confirmDelete ? "确认删除？" : "删除"}
          </button>
        )}
      </div>
    </div>
  );
}
