"use client";

// First-run onboarding: 5-step carousel, engine-picker as the core
// step (Handy-app style). shouldShowTutorial() is an SSR-safe pure
// check consumed by app/page.tsx to decide whether to auto-open this
// overlay on first load. OWNER: this worker (#21).

import { useState } from "react";
import { CaretRight, CheckCircle } from "@phosphor-icons/react";
import { modeForPersistedEngine, useApp, type ModePlatform } from "@/lib/store";
import { RETENTION_COPY, resolveEngineRetentionClass } from "@/lib/stt/engineOptions";
import type { STTEngineKind } from "@jargonslayer/core/types";
import { withBase } from "@/lib/basePath";
import { IS_DESKTOP } from "@/lib/platform/desktop";
import { IS_IOS } from "@/lib/platform/ios";

// ITEM 4 fix (fix round, Opus#2): platform for modeForPersistedEngine
// below — IS_DESKTOP/IS_IOS are build-time consts, so this resolves once
// at module load, mirroring store.ts's own migrateSettings computation
// of the identical value.
const PLATFORM: ModePlatform = IS_IOS ? "ios" : IS_DESKTOP ? "desktop" : "web";

export interface TutorialOverlayProps {
  open: boolean;
  onClose: () => void;
  /** Starts the scripted demo (same mechanism as the header's 演示
   *  button) and closes the tutorial so the user lands on the live
   *  transcript right away. Optional so this overlay still renders
   *  standalone if a caller doesn't wire it up. */
  onStartDemo?: () => void;
}

const TUTORIAL_DONE_KEY = "jargonslayer:tutorial_done";

export function shouldShowTutorial(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(TUTORIAL_DONE_KEY) !== "1";
  } catch {
    return false;
  }
}

function markTutorialDone(): void {
  try {
    window.localStorage.setItem(TUTORIAL_DONE_KEY, "1");
  } catch {
    // non-fatal — worst case the tutorial reappears next visit
  }
}

const STEP_COUNT = 5;

// ---------------------------------------------------------------
// Step 2: engine picker card grid — Handy-app style. Demo is NOT a
// capture engine (no audio, scripted preview) so it is not a card
// peer here — it gets its own visually-separated "先看演示" row above
// the grid, still driving the same settings.engine="demo" + onStart
// demo mechanism as the header's 演示 button. The retention chip below
// each card (ITEM 2 fix, fix round Sol#4 + Lane C flag) is derived from
// resolveEngineRetentionClass/RETENTION_COPY (lib/stt/engineOptions.ts)
// — the SAME tri-state source Header/StatusLine already read — instead
// of a hand-rolled binary 本地/云端 pair, so this first-run picker can
// never disagree with what the app shows once a meeting starts.
//
// D7 desktop tabaudio replacement (docs/design-explorations/
// s9-app-audio-tap-blueprint.md): tabaudio can only ever fail inside
// Tauri's WKWebView (no tab-share picker) — desktop shows appaudio (a
// CoreAudio process tap, S9) in its slot instead; the web build keeps
// tabaudio exactly as before (D7 pinned decision: browser behavior
// stays byte-identical). IS_DESKTOP is a build-time const, resolved
// once at module load.
//
// S13 (docs/design-explorations/s13-ios-blueprint.md, §6 Sol F5): this
// overlay mounts unconditionally from app/page.tsx (no IS_DESKTOP-style
// wizard supersedes it on a Tauri shell — verified: it's iOS's own
// first-run onboarding too), so IS_IOS branches FIRST to the one iOS v1
// engine — osspeech, label byte-identical to engineOptions.ts's own
// ENGINE_OPTIONS entry (Miana-veto #2).
//
// v0.5 Wave-1 Feature 5 (mode-first UI, docs/design-explorations/
// v05-wave1-blueprint.md §1 Feature 5, L8 task spec: "speak intent/mode,
// not engine names"): `label` copy only — reworded to lead with the
// SAME mode nouns ModeSelector.tsx's own tiles use (麦克风/本机会议声音/
// 浏览器标签页), dropping the one literal engine BRAND name this array
// had ("本地 Whisper" -> "本地识别", mirroring its 系统识别/浏览器识别
// siblings' existing naming pattern). Values/hint/onClick mechanics
// below are UNCHANGED apart from the ITEM 2/4 fixes documented at their
// own call sites — this step still writes settings.engine directly.
// ---------------------------------------------------------------

const ENGINE_OPTIONS: {
  value: Exclude<STTEngineKind, "demo">;
  label: string;
  hint: string;
}[] = IS_IOS
  ? [
      {
        value: "osspeech",
        label: "麦克风 · 系统识别",
        hint: "无需下载模型，音频不离开设备，开箱即用",
      },
    ]
  : [
      {
        value: "webspeech",
        label: "麦克风 · 浏览器识别",
        hint: "零配置，Chrome/Edge 最佳，开箱即用",
      },
      {
        value: "whisper",
        label: "麦克风 · 本地识别",
        hint: "隐私保护最强，需启动本地 Whisper",
      },
      IS_DESKTOP
        ? {
            value: "appaudio",
            label: "本机会议声音",
            hint: "转录对方与其他声音，非你的麦克风",
          }
        : {
            value: "tabaudio",
            label: "浏览器标签页",
            hint: "共享标签页，听懂对方声音",
          },
    ];

function EnginePickerStep({ onStartDemo }: { onStartDemo: () => void }) {
  const engine = useApp((s) => s.settings.engine);
  // ITEM 2 fix: the D7 webspeech on-device runtime overlay
  // (resolveEngineRetentionClass) reads this exactly like Header/
  // StatusLine do — almost always null here (this overlay only shows
  // pre-first-use, before any engine session could have reported a
  // mode), but reading the real store value keeps this call site
  // byte-identical to the other two surfaces rather than hardcoding null.
  const sttEngineMode = useApp((s) => s.sttEngineMode);
  const updateSettings = useApp((s) => s.updateSettings);

  return (
    <div>
      <div className="text-lg font-medium text-fg">
        选择你的收听方式
      </div>

      <button
        type="button"
        onClick={onStartDemo}
        className="btn-tactile mt-3 flex w-full items-center justify-between gap-2 rounded-none border border-dashed border-edge2 bg-panel2 px-3 py-2 text-left text-xs text-mut hover:border-lab-orange/40 hover:text-fg"
      >
        <span>
          <span className="font-mono text-mut2">$</span> demo —
          先看演示（无需麦克风/API Key）
        </span>
        <CaretRight size={14} weight="regular" className="shrink-0 text-lab-orange" />
      </button>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {ENGINE_OPTIONS.map((opt) => {
          const selected = engine === opt.value;
          // ITEM 2 fix: tri-state retention badge, sourced from the
          // SAME resolver/copy table Header/StatusLine already use.
          const retention = RETENTION_COPY[resolveEngineRetentionClass(opt.value, sttEngineMode)];
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                // ITEM 4 fix (fix round, Opus#2): this picker used to
                // write `engine` alone, leaving `mode` stuck on
                // whatever it was before (default "mic" on a fresh
                // install) — contradicting ModeSelector, whose grid
                // reads `mode` to decide which tile shows selected.
                // modeForPersistedEngine (store.ts) is the SAME
                // engine->mode back-derivation store hydration already
                // uses; rawEngine/legalEngine are both the freshly
                // picked value here (nothing to back-derive FROM).
                updateSettings({
                  engine: opt.value,
                  mode: modeForPersistedEngine(opt.value, opt.value, PLATFORM),
                });
              }}
              className={`rounded-none border p-3 text-left text-sm transition-colors ${
                selected
                  ? "border-act bg-panel3 text-fg"
                  : "border-edge text-fg hover:bg-panel3"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{opt.label}</span>
                {selected && (
                  <CheckCircle size={18} weight="regular" className="shrink-0 text-act" />
                )}
              </div>
              <div className="mt-2 text-xs leading-[1.7] text-mut">{opt.hint}</div>
              <div
                title={retention.hint}
                className={`mt-2 inline-block border px-2 py-0.5 text-[10px] ${retention.borderClass} ${retention.textClass}`}
              >
                {retention.label}
              </div>
            </button>
          );
        })}
      </div>
      <div className="mt-3 text-xs leading-[1.7] text-mut2">
        之后随时可在设置里更换；上传录音/文稿/视频链接转录在「历史→导入」（文件/文稿/链接三个标签）。
      </div>
    </div>
  );
}

export default function TutorialOverlay({
  open,
  onClose,
  onStartDemo,
}: TutorialOverlayProps) {
  const [step, setStep] = useState(0);

  if (!open) return null;

  const isLast = step === STEP_COUNT - 1;

  const finish = () => {
    markTutorialDone();
    setStep(0);
    onClose();
  };

  const handleStartDemo = () => {
    finish();
    onStartDemo?.();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[560px] max-w-[92vw] rounded-none border border-edge2 bg-panel p-6">
        <div className="flex items-center justify-center gap-2 font-mono text-xs tabular-nums text-mut">
          <span className="text-fg">
            [{step + 1}/{STEP_COUNT}]
          </span>
          <span className="flex items-center gap-1">
            {Array.from({ length: STEP_COUNT }, (_, i) => (
              <span
                key={i}
                className={`h-1 w-3 ${i === step ? "bg-act" : "bg-edge2"}`}
              />
            ))}
          </span>
        </div>

        <div className="mt-6 min-h-[260px]">
          {step === 0 && (
            <div>
              <div className="flex items-center gap-2">
                <img src={withBase("/icon-192.png")} alt="" className="h-8 w-8 rounded-none" />
                <span className="font-mono text-lg font-bold tracking-wide text-fg">
                  JargonSlayer
                </span>
              </div>
              <div className="mt-4 text-base font-medium leading-[26px] text-fg">
                把听不懂的行话，一条条屠掉。
              </div>
              <div className="mt-3 text-sm leading-[26px] text-mut">
                开会时它听英文，你看中文解释卡片。英文习语、俚语、缩写第一时间变成看得懂的解释，不用中途打断会议去查词典。
              </div>
            </div>
          )}

          {step === 1 && <EnginePickerStep onStartDemo={handleStartDemo} />}

          {step === 2 && (
            <div>
              <div className="text-lg font-medium text-fg">
                三种用法
              </div>
              <div className="mt-4 space-y-3">
                <div className="rounded-none border border-edge p-3">
                  <div className="text-sm font-medium text-fg">免费词典模式</div>
                  <div className="mt-2 text-xs leading-[1.7] text-mut">
                    开箱即用，428 条内置商务表达与术语，无需任何配置。
                  </div>
                </div>
                <div className="rounded-none border border-edge p-3">
                  <div className="text-sm font-medium text-fg">填 API Key 解锁 AI 上下文检测</div>
                  <div className="mt-2 text-xs leading-[1.7] text-mut">
                    设置→AI 检测，兼容 DeepSeek/Ollama，解释更贴合当前语境。
                  </div>
                </div>
                <div className="rounded-none border border-edge p-3">
                  <div className="text-sm font-medium text-fg">全离线</div>
                  <div className="mt-2 text-xs leading-[1.7] text-mut">
                    本地 Whisper + Ollama，音频和内容完全不出本机。
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <div className="text-lg font-medium text-fg">
                实时体验
              </div>
              <div className="mt-3 text-sm leading-[26px] text-fg/90">
                新卡片到达有金色高亮提示；转录文本里的金色虚线下划线可以点击定位到对应卡片。最新几张卡片全展开，其余折叠为摘要，随手展开/折叠。选中任意英文文字即可划词收藏，直接存入个人词库。专注模式下折叠右栏，鼠标悬停在高亮上就能看到释义。
              </div>
            </div>
          )}

          {step === 4 && (
            <div>
              <div className="text-lg font-medium text-fg">
                会后
              </div>
              <div className="mt-3 text-sm leading-[26px] text-fg/90">
                结束会议后可以生成双语纪要、全文翻译和学习卡片，一键导出 Markdown 或 Anki。练习卡支持复习页反复巩固，所有历史记录自动落盘保存在本机，不上传任何服务器。
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-edge pt-4">
          <button
            type="button"
            onClick={finish}
            className="text-xs text-mut hover:text-fg"
          >
            跳过
          </button>

          <div className="flex gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                className="btn-tactile border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3"
              >
                上一步
              </button>
            )}
            {isLast ? (
              <button
                type="button"
                onClick={finish}
                className="btn-terminal rounded-none bg-act px-3 py-1.5 font-mono text-sm font-semibold text-ink hover:bg-act/85"
              >
                开始使用
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setStep((s) => Math.min(STEP_COUNT - 1, s + 1))}
                className="btn-terminal rounded-none bg-act px-3 py-1.5 font-mono text-sm font-semibold text-ink hover:bg-act/85"
              >
                下一步
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
