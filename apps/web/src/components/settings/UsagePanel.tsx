"use client";

// Local usage panel (v0.6, BYOK spend-visibility ask — lib/usage/
// ledger.ts's own header for the full local-only design: NO
// TELEMETRY, nothing here ever leaves the device). Self-contained,
// props-driven block per the established SettingsDialog contention
// rule (mirrors AnkiConnectSection.tsx/TranslationEngineRow.tsx's own
// shape) — no store imports, `value`/`onChange` for the single
// Settings.usageTracking boolean it owns (TranslationEngineRow's own
// single-field precedent, not AnkiConnectSection's multi-field object
// wrapper — there is only one field here).
//
// INSERTION POINT for the lead: SettingsDialog.tsx, wherever the 数据与
// 联动/隐私-flavored settings live (near AnkiConnectSection's own
// render line) —
//   import UsagePanel from "@/components/settings/UsagePanel";
//   <UsagePanel
//     value={draft.usageTracking}
//     onChange={(v) => patch({ usageTracking: v })}
//   />

import { useEffect, useState } from "react";
import ToggleSwitch from "@/components/ToggleSwitch";
import {
  clearUsage,
  dateKeyDaysAgo,
  getUsage,
  summarizeUsage,
  type UsageSummary,
} from "@/lib/usage/ledger";

export interface UsagePanelProps {
  value: boolean;
  onChange: (value: boolean) => void;
}

// Mirrors GlossaryPanel.tsx's own confirmDelete window (2-click
// destructive-action pattern: click once to arm, a second click within
// this window actually clears; the arm auto-reverts otherwise).
const CLEAR_CONFIRM_TIMEOUT_MS = 3000;

function formatMinutes(seconds: number): string {
  return (seconds / 60).toFixed(1);
}

function formatDateRange(summary: UsageSummary): string | null {
  if (!summary.earliestDay || !summary.latestDay) return null;
  if (summary.earliestDay === summary.latestDay) return summary.earliestDay;
  return `${summary.earliestDay} ~ ${summary.latestDay}`;
}

export default function UsagePanel({ value, onChange }: UsagePanelProps) {
  const [loading, setLoading] = useState(true);
  const [overall, setOverall] = useState<UsageSummary | null>(null);
  const [week, setWeek] = useState<UsageSummary | null>(null);
  const [month, setMonth] = useState<UsageSummary | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // Bumped to re-run the load effect after clearUsage() — simplest way
  // to refresh without duplicating the fetch-and-summarize logic in two
  // places (mirrors TranslationEngineRow's own effect-driven reload).
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void getUsage().then((records) => {
      if (cancelled) return;
      const now = new Date();
      setOverall(summarizeUsage(records));
      setWeek(summarizeUsage(records, { since: dateKeyDaysAgo(6, now) }));
      setMonth(summarizeUsage(records, { since: dateKeyDaysAgo(29, now) }));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const handleClearClick = () => {
    if (confirmClear) {
      setConfirmClear(false);
      void clearUsage().then(() => setReloadToken((n) => n + 1));
      return;
    }
    setConfirmClear(true);
    setTimeout(() => setConfirmClear(false), CLEAR_CONFIRM_TIMEOUT_MS);
  };

  const empty = !loading && overall !== null && overall.providers.length === 0;
  const dateRange = overall ? formatDateRange(overall) : null;

  return (
    <div className="space-y-3 border-t border-edge pt-3" data-testid="usage-panel">
      <div className="text-xs uppercase tracking-wide text-mut">使用统计</div>

      <label className="flex items-center justify-between gap-3 py-1">
        <span className="text-sm text-fg">记录本地用量</span>
        <ToggleSwitch checked={value} onChange={onChange} />
      </label>
      <div className="text-xs leading-[1.7] text-mut2">
        仅保存在本机，不会发送到任何服务器；用于查看你自己的 Key 花在了哪里
      </div>
      {!value && (
        <div className="text-xs leading-[1.7] text-mut2">已关闭，不会记录新的用量（已有记录仍可查看、清除）</div>
      )}

      {loading ? (
        <div className="text-xs text-mut2">加载中…</div>
      ) : empty ? (
        <div className="text-xs leading-[1.7] text-mut2" data-testid="usage-panel-empty">
          还没有使用记录，开始一场会议后这里会显示语音识别和 AI 用量
        </div>
      ) : (
        <div className="space-y-3">
          {dateRange && <div className="text-xs text-mut2">记录范围：{dateRange}</div>}
          <UsageWindow title="近 7 天" summary={week} />
          <UsageWindow title="近 30 天" summary={month} />
        </div>
      )}

      {!empty && (
        <button
          type="button"
          onClick={handleClearClick}
          className={`btn-tactile border border-edge px-3 py-1.5 text-sm ${
            confirmClear ? "text-warn-soft" : "text-fg hover:bg-panel3"
          }`}
        >
          {confirmClear ? "确认清除？" : "清除使用记录"}
        </button>
      )}
    </div>
  );
}

function UsageWindow({ title, summary }: { title: string; summary: UsageSummary | null }) {
  return (
    <div>
      <div className="text-xs text-mut">{title}</div>
      {!summary || summary.providers.length === 0 ? (
        <div className="mt-1 text-xs text-mut2">无记录</div>
      ) : (
        <div className="mt-1 space-y-1">
          {summary.providers.map((p) => (
            <div key={p.provider} className="flex items-center justify-between gap-3 text-xs">
              <span className="font-mono text-fg">{p.provider}</span>
              <span className="text-mut2">
                {[
                  p.sttSeconds > 0 ? `语音识别 ${formatMinutes(p.sttSeconds)} 分钟` : null,
                  p.llmCalls > 0
                    ? `调用 ${p.llmCalls.toLocaleString("zh-CN")} 次${
                        p.llmInputTokens || p.llmOutputTokens
                          ? ` · 输入 ${p.llmInputTokens.toLocaleString("zh-CN")} / 输出 ${p.llmOutputTokens.toLocaleString("zh-CN")} tokens`
                          : ""
                      }`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
