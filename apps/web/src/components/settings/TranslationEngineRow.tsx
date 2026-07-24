"use client";

// Translation-engine settings subcomponent (v0.5 Wave-1 Feature 6, docs/
// design-explorations/v05-wave1-blueprint.md §1 Feature 6 + §5 A6). A
// self-contained, props-driven block per the blueprint's SettingsDialog
// contention rule (§2: "each lane delivers its section as a
// self-contained subcomponent... referenced by a SINGLE import + render
// line; the lead serializes those one-line insertions") — no store
// imports, value+onChange only, mirroring AnkiConnectSection.tsx's own
// shape. Hidden on iOS — no on-device translator there (A6 scope,
// unchanged). Desktop (macOS 26+) got its OWN on-device path in v0.6
// (DesktopTranslationEngineRow below) — un-gated there instead of hidden.
//
// INSERTION POINT for the lead: SettingsDialog.tsx's AI 检测 section,
// directly after the existing 双语转录 row (`data-ui-level=
// "aiDetectBilingual"`, currently the LAST line of that block is the
// closing `</label>` at :2907) and before the 背景画像 block's opening
// comment (:2909) —
//   import TranslationEngineRow from "@/components/settings/TranslationEngineRow";
//   import { langPairFromSettings } from "@/lib/translate/providers";
//   ...
//   <div data-ui-level="aiDetectTranslateEngine">
//     <TranslationEngineRow
//       value={draft.translateEngine}
//       onChange={(v) => patch({ translateEngine: v })}
//       langPair={langPairFromSettings(draft)}
//     />
//   </div>
// Also needs ONE new entry in lib/settingsSections.ts's SETTINGS_UI_LEVELS
// (completeness-test-enforced, so this must land together with the JSX
// above): `aiDetectTranslateEngine: "simple"` (same level as its
// 双语转录/解释语言 neighbors).

import { useEffect, useRef, useState } from "react";
import type { Settings } from "@jargonslayer/core/types";
import { IS_IOS } from "@/lib/platform/ios";
import { IS_DESKTOP } from "@/lib/platform/desktop";
import {
  ChromeTranslatorProvider,
  checkSystemTranslatorAvailability,
  probeSystemTranslateSupport,
  type SystemTranslateProbeResult,
  type TranslationLangPair,
  type TranslatorAvailabilityState,
} from "@/lib/translate/providers";

export interface TranslationEngineRowProps {
  value: Settings["translateEngine"];
  onChange: (value: Settings["translateEngine"]) => void;
  /** The transcript-source/explanation-target pair the live queue would
   *  actually use right now — drives the Chrome Translator/Apple
   *  translate availability hint below. Build via providers.ts's
   *  langPairFromSettings(draft). */
  langPair: TranslationLangPair;
}

/** Platform dispatcher — IS_IOS/IS_DESKTOP are build-time constants
 *  (never change across this component's lifetime), so branching to a
 *  completely different sub-component per platform here is safe: each
 *  sub-component runs its own hooks in its own stable order, same as any
 *  other build-time-gated render split in this codebase. */
export default function TranslationEngineRow(props: TranslationEngineRowProps) {
  if (IS_IOS) return null; // no on-device translator on iOS — unchanged v0.5 A6 scope
  if (IS_DESKTOP) return <DesktopTranslationEngineRow {...props} />;
  return <WebTranslationEngineRow {...props} />;
}

type Hint = "checking" | "no-api" | TranslatorAvailabilityState;

const POLL_INTERVAL_MS = 2000;
// ponytail: a bounded poll (30 x 2s = 60s) refreshes the hint once a
// download finishes, rather than wiring up Translator.create()'s
// `monitor` download-progress callback for an exact completion signal.
// Simplest thing that reflects reality for the common case; upgrade
// path if 60s isn't enough runway on a slow connection is either a
// longer cap or switching to the monitor callback.
const MAX_POLL_ATTEMPTS = 30;

function WebTranslationEngineRow({ value, onChange, langPair }: TranslationEngineRowProps) {
  const providerRef = useRef<ChromeTranslatorProvider | null>(null);
  const [hint, setHint] = useState<Hint>("checking");
  const [polling, setPolling] = useState(false);

  // Read-only probe (never triggers a download) — re-runs whenever the
  // language pair itself changes (e.g. explainLanguage edited in this
  // same dialog).
  useEffect(() => {
    let cancelled = false;
    setHint("checking");
    void checkSystemTranslatorAvailability(langPair).then((state) => {
      if (!cancelled) setHint(state ?? "no-api");
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [langPair.source, langPair.target]);

  // Optimistic post-download refresh — see MAX_POLL_ATTEMPTS' own doc
  // comment above for why this is a bounded poll rather than a progress
  // callback.
  useEffect(() => {
    if (!polling) return;
    let attempts = 0;
    const id = setInterval(() => {
      attempts += 1;
      void checkSystemTranslatorAvailability(langPair).then((state) => {
        if (state && state !== "downloading") {
          setHint(state);
          setPolling(false);
        }
      });
      if (attempts >= MAX_POLL_ATTEMPTS) setPolling(false);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling, langPair.source, langPair.target]);

  const systemUnavailable = hint === "no-api" || hint === "unavailable";
  const systemLabel =
    hint === "no-api"
      ? "系统翻译（Chrome 内置·本机处理）— 当前浏览器不支持"
      : hint === "unavailable"
        ? "系统翻译（Chrome 内置·本机处理）— 当前语言组合不支持"
        : "系统翻译（Chrome 内置·本机处理）";

  function handleDownloadClick() {
    // A6: MUST fire synchronously inside THIS click's own user gesture —
    // Translator.create() itself fires here, inside prepare(), before
    // any await (see providers.ts's own header comment for the full
    // contract). A separate ChromeTranslatorProvider instance from
    // whatever the live meeting queue will later resolve — harmless:
    // the underlying browser model download is a shared resource keyed
    // by language pair (providers.ts's own module-level session cache),
    // so this still warms the SAME download a later meeting's own
    // prepare() call will reuse.
    if (!providerRef.current) providerRef.current = new ChromeTranslatorProvider();
    providerRef.current.prepare(langPair);
    setHint("downloading");
    setPolling(true);
  }

  return (
    <div data-testid="translation-engine-row">
      <label className="text-xs text-mut">翻译引擎</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Settings["translateEngine"])}
        className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
      >
        <option value="llm">AI 模型（默认）</option>
        <option value="system" disabled={systemUnavailable}>
          {systemLabel}
        </option>
      </select>
      <div className="mt-1 text-xs leading-[1.7] text-mut2">
        系统翻译在本机处理，无需发送到任何服务器；AI 模型质量更高，但会将转录内容发送给你配置的服务
      </div>
      {(hint === "downloadable" || hint === "downloading") && (
        <div className="mt-1.5 flex items-center gap-2 text-xs leading-[1.7] text-mut2">
          <span>{hint === "downloading" ? "语言包下载中…" : "首次使用系统翻译需下载语言包"}</span>
          {hint === "downloadable" && (
            <button
              type="button"
              onClick={handleDownloadClick}
              className="btn-tactile shrink-0 border border-edge px-2 py-1 text-xs text-fg hover:bg-panel3"
            >
              下载并启用
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Desktop (macOS 26+, v0.6) — Apple's headless on-device Translation
// API, driven by providers.ts's own system_translate_probe wrapper
// instead of checkSystemTranslatorAvailability (that one only ever
// reads window.Translator, which WKWebView has none of). No download
// button here, unlike the web variant above — there is NO headless
// download trigger for the language pack (verify against the Rust
// worker's own probe semantics): a "supported" pair just points the
// user at System Settings; downloading it there is the ONLY path.
// ---------------------------------------------------------------

type DesktopHint = "checking" | SystemTranslateProbeResult["status"];

function DesktopTranslationEngineRow({ value, onChange, langPair }: TranslationEngineRowProps) {
  const [hint, setHint] = useState<DesktopHint>("checking");

  // Read-only probe (never spawns/downloads anything) — re-runs
  // whenever the language pair itself changes (e.g. explainLanguage
  // edited in this same dialog). Shares providers.ts's module-level
  // probe cache with resolveTranslationProvider's own background
  // warm-up, so this mount doubles as the cache-warming trigger a cold
  // app boot needs before the FIRST meeting Start can pick this engine.
  useEffect(() => {
    let cancelled = false;
    setHint("checking");
    void probeSystemTranslateSupport(langPair).then((result) => {
      if (!cancelled) setHint(result.status);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [langPair.source, langPair.target]);

  const systemUnavailable = hint === "unsupported";
  const systemLabel =
    hint === "unsupported" ? "Apple 翻译 · 本机离线 — 需要 macOS 26 或更高版本" : "Apple 翻译 · 本机离线";

  return (
    <div data-testid="translation-engine-row">
      <label className="text-xs text-mut">翻译引擎</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Settings["translateEngine"])}
        className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
      >
        <option value="llm">AI 模型（默认）</option>
        <option value="system" disabled={systemUnavailable}>
          {systemLabel}
        </option>
      </select>
      <div className="mt-1 text-xs leading-[1.7] text-mut2">
        Apple 翻译完全在本机处理，无需 API Key，转录内容不会离开这台 Mac；AI 模型质量更高，但会将转录内容发送给你配置的服务
      </div>
      {hint === "installed" && <div className="mt-1.5 text-xs leading-[1.7] text-mut2">已就绪</div>}
      {hint === "supported" && (
        <div className="mt-1.5 text-xs leading-[1.7] text-mut2">
          该语言组合尚未下载，请前往 系统设置 → 通用 → 语言与地区 → 翻译语言 下载后使用
        </div>
      )}
    </div>
  );
}
