"use client";

// Post-meeting report: bilingual summary, action items, flashcards,
// full bilingual transcript, and export actions.

import { useState } from "react";
import { Notebook, Star } from "@phosphor-icons/react";
import { useApp, currentSessionSnapshot } from "@/lib/store";
import { summarizeApi, NoKeyError } from "@/lib/llm/client";
import { resolveTaskCreds } from "@/lib/llm/taskConfig";
import {
  buildAnkiTSV,
  buildMarkdownReport,
  buildSessionJson,
  copyToClipboard,
  downloadFile,
} from "@/lib/history/export";
import { findEntryBySurface } from "@/lib/history/glossary";
import { cardToCustomEntry, termToCustomEntry } from "@jargonslayer/core/types";
import CornellNote from "./CornellNote";

function ExportRow({ onOpenCornell }: { onOpenCornell: () => void }) {
  const cards = useApp((s) => s.cards);
  const showToast = useApp((s) => s.showToast);

  const handleExport = (kind: "md" | "tsv" | "json") => {
    const session = currentSessionSnapshot();
    if (!session) return;
    if (kind === "md") {
      downloadFile(
        `${session.title}.md`,
        buildMarkdownReport(session),
        "text/markdown",
      );
    } else if (kind === "tsv") {
      downloadFile(
        `${session.title}.tsv`,
        buildAnkiTSV(session.summary?.flashcards ?? []),
        "text/tab-separated-values",
      );
    } else {
      downloadFile(
        `${session.title}.json`,
        buildSessionJson(session),
        "application/json",
      );
    }
  };

  const handleCopy = async () => {
    const session = currentSessionSnapshot();
    if (!session) return;
    const ok = await copyToClipboard(buildMarkdownReport(session));
    showToast(ok ? "已复制到剪贴板" : "复制失败");
  };

  const handleCollect = async () => {
    const { cards: liveCards, terms: liveTerms, addCustomEntry } = useApp.getState();
    let added = 0;
    for (const c of liveCards) {
      if (findEntryBySurface(c.expression)) continue;
      await addCustomEntry(cardToCustomEntry(c));
      added += 1;
    }
    for (const t of liveTerms) {
      if (findEntryBySurface(t.term)) continue;
      await addCustomEntry(termToCustomEntry(t));
      added += 1;
    }
    showToast(added === 0 ? "全部已在词典中" : `已收藏 ${added} 条到我的词典`);
  };

  return (
    <div className="flex flex-wrap gap-2 border-t border-edge p-3">
      <button
        type="button"
        onClick={() => handleExport("md")}
        className="btn-tactile border border-edge2 px-3 py-1.5 font-mono text-xs text-fg hover:bg-panel3"
      >
        导出报告 .md
      </button>
      <button
        type="button"
        onClick={() => handleExport("tsv")}
        className="btn-tactile border border-edge2 px-3 py-1.5 font-mono text-xs text-fg hover:bg-panel3"
      >
        导出 Anki .tsv
      </button>
      <button
        type="button"
        onClick={() => handleExport("json")}
        className="btn-tactile border border-edge2 px-3 py-1.5 font-mono text-xs text-fg hover:bg-panel3"
      >
        导出 JSON
      </button>
      <button
        type="button"
        data-testid="btn-cornell"
        onClick={onOpenCornell}
        className="btn-tactile flex items-center gap-2 border border-edge2 px-3 py-1.5 text-xs text-fg hover:bg-panel3"
      >
        <Notebook size={14} weight="regular" />
        康奈尔笔记
      </button>
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="btn-tactile border border-edge2 px-3 py-1.5 text-xs text-fg hover:bg-panel3"
      >
        复制纪要
      </button>
      {cards.length > 0 && (
        <button
          type="button"
          onClick={() => void handleCollect()}
          className="btn-tactile flex items-center gap-2 border border-edge2 px-3 py-1.5 text-xs text-fg hover:bg-panel3"
        >
          <Star size={14} weight="regular" className="text-lab-orange" />
          收藏本场卡片
        </button>
      )}
    </div>
  );
}

function GenerateCta() {
  const settings = useApp((s) => s.settings);
  const cards = useApp((s) => s.cards);
  const terms = useApp((s) => s.terms);
  const segments = useApp((s) => s.segments);
  const setSummary = useApp((s) => s.setSummary);
  const setSummarizing = useApp((s) => s.setSummarizing);
  const saveCurrentSession = useApp((s) => s.saveCurrentSession);
  const showToast = useApp((s) => s.showToast);

  const handleGenerate = async () => {
    setSummarizing(true);
    try {
      const res = await summarizeApi(
        {
          segments: segments.map((s) => ({
            index: s.index,
            speaker: s.speaker,
            text: s.text,
          })),
          expressions: cards,
          terms,
          model: resolveTaskCreds(settings, "summary").model,
        },
        settings,
      );
      setSummary(res);
      await saveCurrentSession();
      showToast("报告已生成并保存");
    } catch (err) {
      if (err instanceof NoKeyError) {
        showToast("需要 API Key（右上角设置）才能生成报告");
      } else {
        const message = err instanceof Error ? err.message : "生成报告失败";
        showToast(message);
      }
    } finally {
      setSummarizing(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <button
        type="button"
        data-testid="btn-generate-summary"
        onClick={() => void handleGenerate()}
        className="btn-terminal h-10 rounded-none bg-act px-5 font-mono text-sm font-semibold text-ink hover:bg-act/85"
      >
        生成会议报告
      </button>
      <div className="text-xs text-mut">
        双语纪要 · 全文翻译 · 学习卡片（约 1–2 分钟）
      </div>
      {!settings.apiKey && (
        <div className="max-w-xs text-xs leading-[1.7] text-mut2">
          需要 API Key（设置里填），无 Key 也可以直接导出词典卡片
        </div>
      )}
    </div>
  );
}

function SummarizingState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-lab-cyan border-t-transparent" />
      <div className="text-sm text-mut">生成中，长会议可能需要一两分钟</div>
    </div>
  );
}

function WaitingState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="text-sm text-mut">会议进行中，结束后在这里生成报告</div>
    </div>
  );
}

function SummaryContent() {
  const summary = useApp((s) => s.summary);
  const segments = useApp((s) => s.segments);
  if (!summary) return null;

  const translationByIndex = new Map(
    summary.translations.map((t) => [t.index, t.zh]),
  );

  return (
    <div className="scroll-thin flex-1 space-y-6 overflow-y-auto px-3 py-3">
      <section>
        <div className="text-xs uppercase tracking-wide text-mut">主题</div>
        <div className="mt-2 text-sm text-fg">{summary.summary.topic.en}</div>
        <div className="mt-2 text-[15px] font-medium leading-[26px] text-fg">
          {summary.summary.topic.zh}
        </div>
      </section>

      <section>
        <div className="text-xs uppercase tracking-wide text-mut">要点</div>
        <ul className="mt-2 space-y-2">
          {summary.summary.key_points.map((p, i) => (
            <li key={i} className="rounded-none border-l-2 border-edge bg-panel2 px-3 py-2">
              <div className="text-sm text-fg/90">{p.en}</div>
              <div className="mt-2 text-sm font-medium leading-[26px] text-fg">
                {p.zh}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="text-xs uppercase tracking-wide text-mut">决定</div>
        {summary.summary.decisions.length === 0 ? (
          <div className="mt-2 text-xs text-mut2">（无）</div>
        ) : (
          <ul className="mt-2 space-y-2">
            {summary.summary.decisions.map((d, i) => (
              <li key={i} className="rounded-none border-l-2 border-edge bg-panel2 px-3 py-2">
                <div className="text-sm text-fg/90">{d.en}</div>
                <div className="mt-2 text-sm font-medium leading-[26px] text-fg">
                  {d.zh}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="text-xs uppercase tracking-wide text-mut">行动项</div>
        {summary.summary.action_items.length === 0 ? (
          <div className="mt-2 text-xs text-mut2">（无）</div>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-mut2">
                <th className="pb-1.5 font-normal">负责人</th>
                <th className="pb-1.5 font-normal">事项</th>
                <th className="pb-1.5 font-normal">期限</th>
              </tr>
            </thead>
            <tbody>
              {summary.summary.action_items.map((item, i) => (
                <tr key={i} className="border-t border-edge align-top">
                  <td className="py-1.5 pr-2 text-fg/90">{item.owner || "未指定"}</td>
                  <td className="py-1.5 pr-2">
                    <div className="font-medium leading-[26px] text-fg">{item.zh}</div>
                    <div className="text-xs text-mut">{item.en}</div>
                  </td>
                  <td className="py-1.5 font-mono text-xs tabular-nums text-mut">
                    {item.due || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <div className="text-xs uppercase tracking-wide text-mut">学习卡片</div>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {summary.flashcards.map((f, i) => (
            <div key={i} className="rounded-none border border-edge bg-panel2 p-3">
              <div className="font-mono font-semibold text-fg">{f.front}</div>
              <div className="mt-2 text-sm font-medium leading-[26px] text-fg">
                {f.back_zh}
              </div>
              <div className="mt-2 text-xs text-mut">{f.back_en}</div>
              <div className="mt-2 line-clamp-1 text-xs italic text-mut">
                {f.example}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <details>
          <summary className="cursor-pointer text-xs uppercase tracking-wide text-mut">
            双语转录
          </summary>
          <div className="mt-2 space-y-2">
            {segments.map((seg) => (
              <div key={seg.id} className="rounded-none border-l-2 border-edge bg-panel2 px-3 py-2">
                <div className="text-sm leading-relaxed text-fg/90">{seg.text}</div>
                <div className="mt-2 text-sm font-medium leading-[26px] text-fg">
                  {translationByIndex.get(seg.index) ?? ""}
                </div>
              </div>
            ))}
          </div>
        </details>
      </section>
    </div>
  );
}

export default function SummaryPanel() {
  const status = useApp((s) => s.status);
  const summary = useApp((s) => s.summary);
  const summarizing = useApp((s) => s.summarizing);
  const segments = useApp((s) => s.segments);
  const [cornellOpen, setCornellOpen] = useState(false);

  const showExportRow = segments.length > 0;

  let body: React.ReactNode;
  if (status === "connecting" || status === "listening") {
    body = <WaitingState />;
  } else if (summarizing) {
    body = <SummarizingState />;
  } else if (summary) {
    body = <SummaryContent />;
  } else if (status === "stopped") {
    body = <GenerateCta />;
  } else {
    body = <WaitingState />;
  }

  return (
    <div className="flex h-full flex-col">
      {body}
      {showExportRow && <ExportRow onOpenCornell={() => setCornellOpen(true)} />}
      <CornellNote open={cornellOpen} onClose={() => setCornellOpen(false)} />
    </div>
  );
}
