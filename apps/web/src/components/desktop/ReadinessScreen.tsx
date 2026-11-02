"use client";

// Out-of-box defaults: the desktop first-run 开始前检查 (pre-flight check),
// shown right after EngineChoiceScreen's 系统识别 pick (DesktopWizard.tsx)
// and before the wizard dismisses.
//
// Three jobs, so the user's first real meeting works the way the README
// says it does:
//   1. 收音方式: an explicit choice between 麦克风+系统 (dual capture,
//      auto-tagged 我/对方, recommended) and 只听会议声音. Dual capture
//      trips the microphone permission prompt, so it is only ever
//      switched on by this screen's own 授权并试听 action, never silently.
//      That keeps modeForPersistedEngine's (store.ts) rule that the
//      first mic/dual pick is an explicit user action.
//   2. 试听: runs lib/desktop/soundCheck.ts against the real engine. The
//      macOS permission prompts appear here, while the user is looking,
//      and each channel goes green once its speech is recognized. A
//      denial shows the engine's own error copy with 打开系统设置 and 重试.
//   3. 中英双语: shows whether Apple's English→Chinese language pack is
//      installed and binds the bilingual-transcript toggle to it. If the
//      pack still needs downloading, shows the System Settings path and a
//      重新检查 button.
//
// 跳过 leaves everything as chooseOsSpeechEngine (bootstrap.ts) set it.
// Native calls go through injectable props so the screen renders in
// jsdom tests without Tauri.

import { useEffect, useRef, useState } from "react";
import { CheckCircle, CircleNotch, Circle, WarningCircle } from "@phosphor-icons/react";
import type { STTEngine } from "@jargonslayer/core/types";
import { useApp } from "@/lib/store";
import {
  createSoundCheck,
  initialSoundCheckState,
  requiredChannels,
  type SoundCheckChannel,
  type SoundCheckHandle,
  type SoundCheckMode,
  type SoundCheckState,
} from "@/lib/desktop/soundCheck";
import type { SystemTranslateProbeResult } from "@/lib/translate/providers";
import ToggleSwitch from "@/components/ToggleSwitch";
import { WizardFrame } from "./DesktopWizard";

type TranslateStatus = SystemTranslateProbeResult["status"] | "checking";

export interface ReadinessScreenProps {
  /** Leaves the wizard. */
  onDone: () => void;
  /** Test seam: builds the capture engine. Defaults to stt/index.ts's
   *  createEngine("osspeech"), loaded lazily so the wizard bundle doesn't
   *  pull in every engine up front. */
  createEngine?: () => Promise<STTEngine>;
  /** Test seam: probes the English→Chinese system translation pack.
   *  `fresh` bypasses the probe cache (the 重新检查 button). */
  probeTranslate?: (fresh: boolean) => Promise<SystemTranslateProbeResult["status"]>;
  /** Test seam: opens System Settings → 隐私与安全性. */
  openPrivacySettings?: () => Promise<void>;
}

async function defaultCreateEngine(): Promise<STTEngine> {
  const { createEngine } = await import("@/lib/stt");
  return createEngine("osspeech");
}

async function defaultProbeTranslate(fresh: boolean): Promise<SystemTranslateProbeResult["status"]> {
  const { langPairFromSettings, probeSystemTranslateSupport, refreshSystemTranslateProbe } = await import(
    "@/lib/translate/providers"
  );
  const pair = langPairFromSettings(useApp.getState().settings);
  const result = await (fresh ? refreshSystemTranslateProbe(pair) : probeSystemTranslateSupport(pair));
  return result.status;
}

async function defaultOpenPrivacySettings(): Promise<void> {
  const { getInvoke } = await import("@/lib/desktop/tauriApi");
  const invoke = await getInvoke();
  await invoke("open_privacy_settings");
}

const MODE_CARDS: { value: SoundCheckMode; title: string; points: string[] }[] = [
  {
    value: "dual",
    title: "麦克风+系统（推荐）",
    points: ["同时听会议声音和你自己", "自动标出 我 / 对方", "需要麦克风和系统音频两项权限"],
  },
  {
    value: "system-audio",
    title: "只听会议声音",
    points: ["只转录 Zoom、腾讯会议等 App 里的声音", "不使用麦克风", "需要系统音频权限"],
  },
];

const CHANNEL_COPY: Record<"mic" | "system", { label: string; prompt: string }> = {
  mic: { label: "我", prompt: "对着麦克风用英文说一句话" },
  system: { label: "对方", prompt: "在任意 App 里播放一段英文视频或音频" },
};

function ChannelRow({ channel, state, active }: { channel: "mic" | "system"; state: SoundCheckChannel; active: boolean }) {
  const copy = CHANNEL_COPY[channel];
  return (
    <div data-testid={`readiness-channel-${channel}`} data-heard={state.heard} className="flex items-start gap-2 py-1">
      {state.heard ? (
        <CheckCircle size={18} weight="fill" className="mt-0.5 shrink-0 text-lab-green" aria-hidden />
      ) : active ? (
        <CircleNotch size={18} className="mt-0.5 shrink-0 animate-spin text-lab-cyan" aria-hidden />
      ) : (
        <Circle size={18} className="mt-0.5 shrink-0 text-mut2" aria-hidden />
      )}
      <div className="min-w-0 text-sm">
        <div className="text-fg">
          <span className="font-medium">{copy.label}</span>
          <span className="text-mut"> · {copy.prompt}</span>
        </div>
        {state.heard && state.sample && <div className="mt-0.5 truncate text-xs text-mut2">听到：「{state.sample}」</div>}
      </div>
    </div>
  );
}

export default function ReadinessScreen({
  onDone,
  createEngine = defaultCreateEngine,
  probeTranslate = defaultProbeTranslate,
  openPrivacySettings = defaultOpenPrivacySettings,
}: ReadinessScreenProps) {
  const updateSettings = useApp((s) => s.updateSettings);
  const bilingualTranscript = useApp((s) => s.settings.bilingualTranscript);

  const [mode, setMode] = useState<SoundCheckMode>("dual");
  const [check, setCheck] = useState<SoundCheckState>(initialSoundCheckState);
  const [translateStatus, setTranslateStatus] = useState<TranslateStatus>("checking");
  const handleRef = useRef<SoundCheckHandle | null>(null);

  // Stop any running check when the screen goes away.
  useEffect(() => () => void handleRef.current?.stop(), []);

  const runTranslateProbe = (fresh: boolean) => {
    setTranslateStatus("checking");
    void probeTranslate(fresh)
      .catch((): SystemTranslateProbeResult["status"] => "unsupported")
      .then((status) => {
        setTranslateStatus(status);
        // A pack that's ready turns bilingual on. A fresh install already
        // got this from store.ts's runFreshInstallBilingualDefault; this
        // covers a pack the user downloaded and then re-checked here. The
        // toggle below stays the user's to switch back off.
        if (status === "installed" && fresh) updateSettings({ bilingualTranscript: true });
      });
  };

  useEffect(() => {
    runTranslateProbe(false);
    // Mount-only probe; the 重新检查 button re-runs it with fresh=true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startCheck = async () => {
    await handleRef.current?.stop();
    // The explicit user action that switches capture on. Persisted now,
    // so the first meeting uses exactly what was tested here.
    updateSettings({ engine: "osspeech", mode });
    setCheck({ ...initialSoundCheckState(), phase: "starting" });
    let engine: STTEngine;
    try {
      engine = await createEngine();
    } catch (err) {
      setCheck({
        ...initialSoundCheckState(),
        phase: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const handle = createSoundCheck({
      createEngine: () => engine,
      settings: useApp.getState().settings,
      mode,
      onChange: setCheck,
    });
    handleRef.current = handle;
    await handle.start();
  };

  const finish = () => {
    void handleRef.current?.stop();
    onDone();
  };

  const running = check.phase === "starting" || check.phase === "listening";
  const ran = check.phase !== "idle";
  const channels = requiredChannels(mode);

  return (
    <WizardFrame>
      <div data-testid="readiness-screen" className="space-y-5">
        <div className="space-y-1">
          <div className="text-base font-medium text-fg">开始前检查</div>
          <p className="text-sm leading-[1.8] text-mut">
            先授权并试听一次，确认会议声音和你的声音都能被听到。全程在本机处理，音频不会离开这台 Mac。
          </p>
        </div>

        <div className="space-y-2">
          <div className="text-xs text-mut">收音方式</div>
          <div className="grid grid-cols-2 gap-2">
            {MODE_CARDS.map((card) => (
              <button
                key={card.value}
                type="button"
                data-testid={`readiness-mode-${card.value}`}
                onClick={() => setMode(card.value)}
                disabled={running}
                aria-pressed={mode === card.value}
                className={`border p-3 text-left text-sm transition-colors disabled:opacity-60 ${
                  mode === card.value ? "border-act bg-panel3 text-fg" : "border-edge text-fg hover:bg-panel3"
                }`}
              >
                <div className="font-medium">{card.title}</div>
                <ul className="mt-2 space-y-1 text-xs leading-[1.7] text-mut">
                  {card.points.map((point) => (
                    <li key={point}>· {point}</li>
                  ))}
                </ul>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2 border border-edge bg-panel2 p-3" role="status" aria-live="polite">
          <div className="text-xs text-mut">试听</div>
          {!ran && (
            <p className="text-sm leading-[1.7] text-mut">
              点「授权并试听」后，macOS 会弹出权限提示，请选择「允许」。
            </p>
          )}
          {ran &&
            channels.map((c) => <ChannelRow key={c} channel={c} state={check[c]} active={check.phase === "listening"} />)}
          {check.phase === "starting" && (
            <div className="text-xs leading-[1.7] text-mut2">{check.notice ?? "正在启动收音…"}</div>
          )}
          {check.phase === "passed" && (
            <div data-testid="readiness-passed" className="text-sm text-lab-green">
              都听到了，可以开始了。
            </div>
          )}
          {check.phase === "timeout" && (
            <div data-testid="readiness-timeout" className="text-xs leading-[1.7] text-mut2">
              有一路还没听到声音。确认会议 App 正在播放、麦克风没有静音后重试；也可以先跳过，正式开会时再看。
            </div>
          )}
          {check.phase === "error" && (
            <div data-testid="readiness-error" className="space-y-2">
              <div className="flex items-start gap-2 text-sm text-lab-orange">
                <WarningCircle size={18} className="mt-0.5 shrink-0" aria-hidden />
                <span>{check.error}</span>
              </div>
              <button
                type="button"
                data-testid="btn-readiness-open-privacy"
                onClick={() => void openPrivacySettings().catch(() => {})}
                className="btn-tactile border border-edge px-2 py-1 text-xs text-fg hover:bg-panel3"
              >
                打开系统设置
              </button>
              <div className="text-xs leading-[1.7] text-mut2">
                手动路径：系统设置 → 隐私与安全性 → 麦克风，以及 屏幕与系统音频录制。开启后点「重试」。
              </div>
            </div>
          )}
        </div>

        <div data-testid="readiness-translate" data-status={translateStatus} className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm">
              <div className="text-fg">中英双语转录</div>
              <div className="text-xs leading-[1.7] text-mut2">
                {translateStatus === "checking" && "正在检查本机翻译…"}
                {translateStatus === "installed" && "Apple 本机翻译已就绪，每句英文下面显示中文"}
                {translateStatus === "supported" &&
                  "需要先下载「英语 → 中文」翻译语言包：系统设置 → 通用 → 语言与地区 → 翻译语言"}
                {translateStatus === "unsupported" && "当前系统不支持本机翻译，可稍后在设置里换用其他翻译引擎"}
              </div>
            </div>
            <ToggleSwitch
              checked={bilingualTranscript}
              disabled={translateStatus !== "installed"}
              onChange={(checked) => updateSettings({ bilingualTranscript: checked })}
              ariaLabel="中英双语转录"
            />
          </div>
          {translateStatus === "supported" && (
            <button
              type="button"
              data-testid="btn-readiness-recheck-translate"
              onClick={() => runTranslateProbe(true)}
              className="btn-tactile border border-edge px-2 py-1 text-xs text-fg hover:bg-panel3"
            >
              下载好了，重新检查
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {check.phase === "passed" ? (
            <button
              type="button"
              data-testid="btn-readiness-done"
              onClick={finish}
              className="btn-terminal rounded-none bg-act px-4 py-2 text-sm font-semibold text-ink hover:bg-act/85"
            >
              开始使用
            </button>
          ) : (
            <button
              type="button"
              data-testid="btn-readiness-start"
              onClick={() => void startCheck()}
              disabled={running}
              className="btn-terminal rounded-none bg-act px-4 py-2 text-sm font-semibold text-ink hover:bg-act/85 disabled:opacity-60"
            >
              {running ? "试听中…" : ran ? "重试" : "授权并试听"}
            </button>
          )}
          {check.phase !== "passed" && (
            <button
              type="button"
              data-testid="btn-readiness-skip"
              onClick={finish}
              className="btn-tactile px-4 py-2 text-sm text-mut hover:bg-panel3 hover:text-fg"
            >
              {ran ? "完成" : "跳过"}
            </button>
          )}
        </div>
      </div>
    </WizardFrame>
  );
}
