"use client";

// Translation-engine settings subcomponent (v0.5 Wave-1 Feature 6, docs/
// design-explorations/v05-wave1-blueprint.md §1 Feature 6 + §5 A6). A
// self-contained, props-driven block per the blueprint's SettingsDialog
// contention rule (§2: "each lane delivers its section as a
// self-contained subcomponent... referenced by a SINGLE import + render
// line; the lead serializes those one-line insertions") — no store
// imports, value+onChange only, mirroring AnkiConnectSection.tsx's own
// shape. Desktop (macOS 26+) got its OWN on-device path in v0.6
// (DesktopTranslationEngineRow below) — un-gated there instead of hidden.
//
// iOS now shares that SAME path (native lane, S13): the Rust workers
// ship the identical 4-invoke-command system-translate surface on iOS
// (system_translate_probe/_prepare/_translate/_stop — see providers.ts's
// own NATIVE_SYSTEM_TRANSLATE gate/header comment), so DesktopTranslation
// EngineRow's probe-driven logic below needs no iOS-specific branch —
// it already IS the "any native Tauri shell" branch, kept named
// "Desktop" to avoid a wider rename (mirrors providers.ts's own
// DesktopSystemTranslationProvider, kept for the same reason). Previously
// (v0.6 field-fix, item 5, iOS TestFlight report) iOS instead rendered
// WebTranslationEngineRow with its 系统 option force-disabled — a
// stopgap for when only desktop had the native surface; reverted now
// that iOS has caught up.
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

/** Platform dispatcher — IS_DESKTOP/IS_IOS are both build-time constants
 *  (never change across this component's lifetime), so branching to a
 *  completely different sub-component per platform here is safe: each
 *  sub-component runs its own hooks in its own stable order, same as any
 *  other build-time-gated render split in this codebase. Both native
 *  Tauri shells (desktop AND iOS) route to DesktopTranslationEngineRow —
 *  see this file's own header comment for why iOS needs no separate
 *  branch; only a plain web build falls through to WebTranslationEngineRow
 *  (the Chrome Translator path, unreachable from either native shell). */
export default function TranslationEngineRow(props: TranslationEngineRowProps) {
  if (IS_DESKTOP || IS_IOS) return <DesktopTranslationEngineRow {...props} />;
  return <WebTranslationEngineRow {...props} />;
}

type Hint = "checking" | "no-api" | TranslatorAvailabilityState;

// Wave-2B reorder (system/deepl/llm) — shared copy so neither variant's
// <option> text nor the test files pinning it can drift out of sync
// with each other (same "exported so a reword can't silently desync a
// test" precedent as StatusLine.tsx's own DETECT_MODE_LABEL). The base
// label is now platform-unified ("本机离线" is equally accurate for
// Chrome's Translator API and Apple's native Translation framework —
// both translate fully on-device, no server round trip) — only the
// disabled-reason suffix still differs per platform/hint (appended by
// each variant's own systemLabel below).
const SYSTEM_TRANSLATE_BASE_LABEL = "系统翻译 · 本机离线";
export const LLM_ENGINE_LABEL = "AI 模型翻译 · Beta（较慢，不建议实时使用）";
export const LLM_TRANSLATE_WARNING =
  "AI 模型逐段翻译要等一次完整模型往返，实时字幕通常慢 3–10 秒；建议只在系统翻译不可用时临时使用。";
export const DEEPL_WEB_DISABLED_REASON = "浏览器版暂不支持 DeepL（跨域限制），请用 App";

/** Rendered under the <select> whenever `llm` is the CURRENTLY SELECTED
 *  value (on either platform variant) — real-time bilingual transcript
 *  now defaults to the instant on-device engines, so picking the
 *  full-model-roundtrip path needs an honest latency warning up front. */
function LlmTranslateWarning() {
  return <div className="mt-1.5 text-xs leading-[1.7] text-lab-yellow">{LLM_TRANSLATE_WARNING}</div>;
}

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

  // This branch is now unreachable on iOS — the dispatcher above routes
  // both native Tauri shells (desktop AND iOS) to DesktopTranslationEngineRow
  // instead (see this file's own header comment); only a plain web build
  // (no Chrome Translator, or this pair unsupported) ever renders here.
  const systemUnavailable = hint === "no-api" || hint === "unavailable";
  const systemLabel =
    hint === "no-api"
      ? `${SYSTEM_TRANSLATE_BASE_LABEL} — 当前浏览器不支持`
      : hint === "unavailable"
        ? `${SYSTEM_TRANSLATE_BASE_LABEL} — 当前语言组合不支持`
        : `${SYSTEM_TRANSLATE_BASE_LABEL}（推荐）`;

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
        <option value="system" disabled={systemUnavailable}>
          {systemLabel}
        </option>
        {/* Cross-origin fetch from a plain browser tab can't reach DeepL's
           API directly — always disabled here (this variant only ever
           renders when NEITHER IS_DESKTOP nor IS_IOS, see the dispatcher
           above), unlike the native variant below where it's un-gated. */}
        <option value="deepl" disabled>
          {`DeepL · 云端 — ${DEEPL_WEB_DISABLED_REASON}`}
        </option>
        <option value="llm">{LLM_ENGINE_LABEL}</option>
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
      {value === "llm" && <LlmTranslateWarning />}
    </div>
  );
}

// ---------------------------------------------------------------
// Native (desktop macOS 26+ AND iOS, v0.6/S13) — Apple's headless
// on-device Translation API, driven by providers.ts's own
// system_translate_probe wrapper instead of checkSystemTranslatorAvailability
// (that one only ever reads window.Translator, which WKWebView has none
// of on either platform). No download button here, unlike the web
// variant above — there is NO headless download trigger for the
// language pack on EITHER platform (verify against the Rust worker's
// own probe semantics): a "supported" pair just points the user at the
// platform's own download surface — 系统设置 on desktop, the system
// 「翻译」App on iOS — downloading it there is the ONLY path.
// ---------------------------------------------------------------

type DesktopHint = "checking" | SystemTranslateProbeResult["status"];

function DesktopTranslationEngineRow({ value, onChange, langPair }: TranslationEngineRowProps) {
  const [hint, setHint] = useState<DesktopHint>("checking");

  // Read-only probe (never spawns/downloads anything) — re-runs
  // whenever the language pair itself changes (e.g. explainLanguage
  // edited in this same dialog). Shares providers.ts's module-level
  // probe cache with resolveTranslationProvider's own background
  // warm-up, so this mount ALSO warms it — but only redundantly: this
  // component only ever mounts once Settings is open (SettingsDialog.tsx's
  // own `if (!open) return null` gate), so it can't be relied on before
  // the FIRST meeting Start. page.tsx's own mount effect is what
  // actually warms the cache at app launch (see providers.ts's
  // warmSystemTranslateProbeForStartup, called once hydration resolves).
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

  // Probe-driven on BOTH platforms now (reverted the old iOS force-
  // disable — see this file's own header comment): "unsupported" covers
  // both "OS too old" (desktop) and "this language pair/device unsupported"
  // (iOS) — the probe itself is what tells them apart per-platform on the
  // Rust side, this component just renders whatever it reports.
  const systemUnavailable = hint === "unsupported";
  const systemLabel =
    hint === "unsupported"
      ? IS_IOS
        ? `${SYSTEM_TRANSLATE_BASE_LABEL} — 当前设备或语言组合不支持`
        : `${SYSTEM_TRANSLATE_BASE_LABEL} — 需要 macOS 26 或更高版本`
      : `${SYSTEM_TRANSLATE_BASE_LABEL}（推荐）`;

  return (
    <div data-testid="translation-engine-row">
      <label className="text-xs text-mut">翻译引擎</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Settings["translateEngine"])}
        className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
      >
        <option value="system" disabled={systemUnavailable}>
          {systemLabel}
        </option>
        {/* Un-gated regardless of deeplKey presence on BOTH native
           platforms — prompting for the actual key is the settings
           field's own job (SettingsDialog.tsx), not this row's. */}
        <option value="deepl">DeepL · 云端（需自备 Key）</option>
        <option value="llm">{LLM_ENGINE_LABEL}</option>
      </select>
      <div className="mt-1 text-xs leading-[1.7] text-mut2">
        Apple 翻译完全在本机处理，无需 API Key，转录内容不会离开{IS_IOS ? "这台设备" : "这台 Mac"}；AI 模型质量更高，但会将转录内容发送给你配置的服务
      </div>
      {hint === "installed" && <div className="mt-1.5 text-xs leading-[1.7] text-mut2">已就绪</div>}
      {hint === "supported" && (
        <div className="mt-1.5 text-xs leading-[1.7] text-mut2">
          {IS_IOS
            ? "该语言组合尚未下载，请在系统「翻译」App 中下载该语言后使用"
            : "该语言组合尚未下载，请前往 系统设置 → 通用 → 语言与地区 → 翻译语言 下载后使用"}
        </div>
      )}
      {value === "llm" && <LlmTranslateWarning />}
    </div>
  );
}
