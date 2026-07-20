"use client";

// v0.5 Wave-1 Feature 5 (mode-first UI, docs/design-explorations/
// v05-wave1-blueprint.md §1 Feature 5 + §5 A3/A4) — the empty-state
// entry point: instead of picking an ENGINE first, the user picks what
// she's trying to LISTEN TO (intent); the engine is derived
// automatically (deriveEngineForMode, lib/stt/engineOptions.ts).
//
// Mounted from page.tsx as an absolute overlay covering TranscriptPanel's
// OWN (untouched — out of this lane's scope) idle/empty-state block, on
// the exact same status==="idle" && segments.length===0 gate
// TranscriptPanel's isEmpty already uses internally — so this disappears
// the instant a meeting starts, a session loads, or history reopens.
//
// §3 Q2 (owner-adjudicated): tiles are platform-filtered — ABSENT, not
// disabled — so this renders anywhere from 2 (iOS: 麦克风+导入 only,
// blueprint §3 Q2 verbatim) to 4 (web/desktop — never all 5 tiles at
// once: 本机会议声音 is desktop-only, 浏览器标签页 is web-only).
//
// Import/url tiles ONLY open ImportHub at the right tab (via the
// onOpenImport callback page.tsx wires to its own ImportHub open-state)
// — they deliberately do NOT call updateSettings themselves (unlike the
// three capture tiles below): the task spec's own onClick description
// only ever pairs updateSettings with the CAPTURE tiles. A returning
// user whose persisted mode is "import" (F0a's modeForPersistedEngine
// back-derivation) still sees that tile marked selected — consuming
// existing state, not a new write.

import { useApp } from "@/lib/store";
import { IS_DESKTOP } from "@/lib/platform/desktop";
import { IS_IOS } from "@/lib/platform/ios";
import { PREVIEW_TIER } from "@/lib/deployTier";
import { deriveEngineForMode } from "@/lib/stt/engineOptions";
import { resolveEngineCapability } from "@/lib/stt/engineCapabilities";
import { useOsSpeechCaps } from "@/lib/desktop/osspeechCaps";
import type { Settings, STTEngineKind } from "@jargonslayer/core/types";
import type { HubTab } from "./ImportHub";

type CaptureMode = "system-audio" | "tab" | "mic";

const CAPTURE_MODE_LABEL: Record<CaptureMode, string> = {
  "system-audio": "本机会议声音",
  tab: "浏览器标签页",
  mic: "麦克风",
};

interface ModeTile {
  key: string;
  label: string;
  selected: boolean;
  onClick: () => void;
}

export interface ModeSelectorProps {
  onOpenImport: (tab: HubTab) => void;
  /** 先看演示 — the keyless first-touch path (L8 integration fix: this
   *  overlay covers TranscriptPanel's own empty-state demo CTA, so the
   *  affordance moves INTO the selector instead of being buried). */
  onDemo?: () => void;
}

/** The derived engine's zh label for the "已选 X · 引擎：Y" hint —
 *  resolveEngineCapability only covers LiveEngineKind (demo/import/
 *  browser-whisper excluded), which is every value deriveEngineForMode
 *  can ever return for a capture mode; a fresh install's still-"demo"
 *  default is the one case that needs this guard, before any mode tile
 *  has ever been picked. */
function engineLabelFor(kind: STTEngineKind, settings: Settings): string | null {
  if (kind === "demo" || kind === "import" || kind === "browser-whisper") return null;
  return resolveEngineCapability(kind, settings).label;
}

export default function ModeSelector({ onOpenImport, onDemo }: ModeSelectorProps) {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  // Kicks off the shared osspeech macOS-26 floor probe (lib/desktop/
  // osspeechCaps.ts) as early as possible — this screen is often the
  // very first interactive thing a fresh desktop user sees, before
  // StatusLine/Settings would otherwise warm it. Single-flight/cached
  // (see that module's own doc), so this is a safe no-op if the probe
  // already resolved elsewhere. Return value unused on purpose:
  // deriveEngineForMode reads the synchronous snapshot itself at click
  // time, not this hook's own React state.
  useOsSpeechCaps();

  const platform = { isDesktop: IS_DESKTOP, isIos: IS_IOS };

  const pickCapture = (mode: CaptureMode) => {
    updateSettings({ mode, engine: deriveEngineForMode(mode, platform, settings) });
  };

  const tiles: ModeTile[] = [];
  if (IS_DESKTOP) {
    tiles.push({
      key: "system-audio",
      label: "听本机会议声音",
      selected: settings.mode === "system-audio",
      onClick: () => pickCapture("system-audio"),
    });
  }
  if (!IS_DESKTOP && !IS_IOS) {
    tiles.push({
      key: "tab",
      label: "听浏览器标签页",
      selected: settings.mode === "tab",
      onClick: () => pickCapture("tab"),
    });
  }
  tiles.push({
    key: "mic",
    label: "用麦克风",
    selected: settings.mode === "mic",
    onClick: () => pickCapture("mic"),
  });
  tiles.push({
    key: "import",
    label: "导入文件或文稿",
    selected: settings.mode === "import",
    onClick: () => onOpenImport("file"),
  });
  // "sidecar tiers only" (L8 task spec): full-tier web+desktop only —
  // preview never has a sidecar to reach, and iOS's ImportHub 链接 tab
  // has no sidecar-absent story worth a tile of its own (blueprint
  // table: "sidecar-absent -> locked"). Reachability itself (whisperUrl
  // actually up) isn't knowable synchronously — ImportHub's own url tab
  // already explains that once opened (same posture deriveEngineForMode
  // takes for the "tab" mode's local-sidecar fallback).
  if (!IS_IOS && !PREVIEW_TIER) {
    tiles.push({
      key: "url",
      label: "从链接导入",
      selected: settings.mode === "url",
      onClick: () => onOpenImport("url"),
    });
  }

  const captureMode: CaptureMode | null =
    settings.mode === "system-audio" || settings.mode === "tab" || settings.mode === "mic"
      ? settings.mode
      : null;
  const engineLabel = captureMode ? engineLabelFor(settings.engine, settings) : null;

  return (
    <div
      data-testid="mode-selector"
      className="absolute inset-0 z-10 flex flex-col items-center justify-center overflow-y-auto bg-panel px-6 py-8"
    >
      <div className="border border-edge bg-panel2 px-4 py-2 font-mono text-sm text-mut">
        <span className="text-lab-green">$</span>
        <span className="cursor-block ml-1 inline-block h-[1em] w-[0.55em] translate-y-[0.15em] bg-mut align-baseline">
          &nbsp;
        </span>
      </div>
      <div className="mt-3 max-w-sm text-center text-[15px] leading-[26px] text-mut">
        选择你的收听方式
      </div>

      <div data-testid="mode-selector-grid" className="mt-4 grid w-full max-w-sm grid-cols-2 gap-2">
        {tiles.map((tile) => (
          <button
            key={tile.key}
            type="button"
            data-testid={`mode-tile-${tile.key}`}
            onClick={tile.onClick}
            className={`min-h-10 rounded-none border p-3 text-left text-sm transition-colors ${
              tile.selected
                ? "border-act bg-panel3 text-fg"
                : "border-edge text-fg hover:bg-panel3"
            }`}
          >
            {tile.label}
          </button>
        ))}
      </div>

      {captureMode && engineLabel && (
        <div data-testid="mode-selector-hint" className="mt-3 text-xs text-mut2">
          已选 {CAPTURE_MODE_LABEL[captureMode]} · 引擎：{engineLabel}（可在底栏更换）
        </div>
      )}

      {onDemo && (
        <button
          type="button"
          data-testid="mode-selector-demo"
          onClick={onDemo}
          className="mt-5 text-xs text-mut2 underline decoration-edge underline-offset-4 hover:text-fg"
        >
          ▷ 先看演示——无需麦克风与 API Key
        </button>
      )}
    </div>
  );
}
