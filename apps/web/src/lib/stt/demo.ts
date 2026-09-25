// Scripted demo replay engine — no microphone, no network. Replays a
// realistic ~2-minute quarterly-planning meeting so the product can
// be evaluated without a mic or API key.
//
// UI-1 (ui-upgrade-plan-2026-09 U-1): the replay shows the product's
// headline, not just the cards. The listener's own lines arrive on the
// mic channel (CH_MIC, resolved to 我 through the store's normal
// dual-capture alias path in addFinal); the remote speakers keep their
// names, the way speaker separation labels the meeting side of a real
// session. Every line carries a recorded Chinese translation that
// DemoTranslationProvider (translate/providers.ts) replays through the
// real TranslateQueue.

import type { STTEngine, STTEngineKind, STTEvents, Settings } from "@jargonslayer/core/types";
import { CH_MIC_SPEAKER } from "../store";

interface ScriptLine {
  // Who says it. Mike is the listener, so his mic-channel lines show as
  // 我; Sarah and Lily are remote and show by name.
  speaker: string;
  channel: "mic" | "system";
  text: string;
  zh: string;
}

// 16-line quarterly planning meeting between three speakers. Every
// line naturally contains its target idiom/term (context-correct,
// non-literal). Lines flow: opening -> metrics -> debate -> wrap-up.
const SCRIPT: ScriptLine[] = [
  {
    speaker: "Sarah",
    channel: "system",
    text: "Okay everyone, let's get the ball rolling. Thanks for joining, I know Q3 planning snuck up on us fast.",
    zh: "好，大家开始吧。谢谢各位参加，我知道第三季度规划来得有点突然。",
  },
  {
    speaker: "Sarah",
    channel: "system",
    text: "Quick context: ARR is up nicely this quarter, but I want us aligned before we lock the roadmap.",
    zh: "先简单说下背景：这个季度 ARR 涨得不错，但在敲定路线图之前，我希望大家先统一想法。",
  },
  {
    speaker: "Mike",
    channel: "mic",
    text: "From engineering's side, we shipped the MVP of the onboarding flow, and a few OKR items are already tracking green.",
    zh: "工程这边，新用户引导流程的 MVP 已经上线，有几项 OKR 目前进展顺利。",
  },
  {
    speaker: "Lily",
    channel: "system",
    text: "On the data side, churn ticked down two points, which is great, but it's not enough to move the needle on retention.",
    zh: "数据这边，流失率降了两个百分点，挺好的，但还不足以真正拉动留存。",
  },
  {
    speaker: "Sarah",
    channel: "system",
    text: "Right, and with our current runway, we can't afford another quarter of marginal wins. We need something bigger.",
    zh: "对，按我们现在的现金储备，再来一个只有小幅改进的季度是撑不住的。我们需要更大的突破。",
  },
  {
    speaker: "Mike",
    channel: "mic",
    text: "There's some low-hanging fruit in the billing flow though, a couple of fixes could pay off fast with minimal cost.",
    zh: "不过计费流程里有些容易做的改进，修几处就能以很低的成本很快见效。",
  },
  {
    speaker: "Lily",
    channel: "system",
    text: "Agreed, but let's not boil the ocean trying to fix every edge case at once. We should scope this tightly.",
    zh: "同意，但别想一次把所有边缘情况都修完，范围要控制紧一点。",
  },
  {
    speaker: "Sarah",
    channel: "system",
    text: "That's fair. Mike, are we on the same page on which fix ships first, or do we circle back after standup?",
    zh: "有道理。Mike，先上线哪个修复我们意见一致吗？还是站会之后再讨论？",
  },
  {
    speaker: "Mike",
    channel: "mic",
    text: "We're mostly aligned, but honestly my team's bandwidth is tight until the Series B diligence calls wrap up.",
    zh: "基本一致，不过说实话，B 轮尽调电话结束之前，我们组的人手都很紧。",
  },
  {
    speaker: "Sarah",
    channel: "system",
    text: "That's the elephant in the room, isn't it. Investor calls are eating half our engineering time this month.",
    zh: "这才是大家都心知肚明的问题吧。这个月投资人电话占掉了工程团队一半的时间。",
  },
  {
    speaker: "Lily",
    channel: "system",
    text: "I want to push back a little on deprioritizing the churn dashboard though, since leadership keeps asking for it.",
    zh: "不过我对把流失看板往后放有点不同意见，因为管理层一直在要。",
  },
  {
    speaker: "Mike",
    channel: "mic",
    text: "Can we table this specific dashboard debate for now and revisit once the Series B numbers are finalized?",
    zh: "看板这个争论能不能先放一放，等 B 轮数字定下来再说？",
  },
  {
    speaker: "Sarah",
    channel: "system",
    text: "Let's take this offline, actually. Mike and Lily, grab fifteen minutes after this call to sort out the priority order.",
    zh: "这个我们会后单独聊吧。Mike 和 Lily，会后抽十五分钟把优先级理清楚。",
  },
  {
    speaker: "Lily",
    channel: "system",
    text: "Sure. If you read the room here, everyone's nodding, so I think we already know roughly where this lands.",
    zh: "好的。看大家的反应都在点头，我觉得结论大致已经有了。",
  },
  {
    speaker: "Sarah",
    channel: "system",
    text: "Good. Let's unpack the OKR numbers one more time before we close, so nothing here can raise eyebrows in the board deck.",
    zh: "好。结束前我们再把 OKR 数字过一遍，免得董事会材料里有什么让人起疑的地方。",
  },
  {
    speaker: "Sarah",
    channel: "system",
    text: "Great meeting. Action items: Mike owns billing, Lily owns the churn dashboard, and I'll circle back with runway updates Friday.",
    zh: "会开得很好。待办：Mike 负责计费，Lily 负责流失看板，我周五再同步现金储备的最新情况。",
  },
];

const DEMO_TRANSLATIONS = new Map(SCRIPT.map((l) => [l.text, l.zh]));

/** The recorded translation for one scripted line (finals are trimmed
 *  by addFinal; script lines carry no surrounding whitespace, so the
 *  lookup is exact). undefined for anything not in the script. */
export function demoTranslationFor(text: string): string | undefined {
  return DEMO_TRANSLATIONS.get(text.trim());
}

// The listener's mic lines ride the dual-capture channel id (display
// 我 via the store's alias map); remote lines carry their speaker name
// directly, like a separated-speaker label, and no channel id.
function sttSpeakerFor(line: ScriptLine): string | undefined {
  return line.channel === "mic" ? CH_MIC_SPEAKER : undefined;
}

function displaySpeaker(line: ScriptLine): string {
  return line.channel === "mic" ? "我" : line.speaker;
}

const WORDS_PER_TICK = 2.5; // 2-3 words per interim tick
const TICK_MIN_MS = 250;
const TICK_MAX_MS = 320;
const LINE_PAUSE_MIN_MS = 900;
const LINE_PAUSE_MAX_MS = 1600;

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export class DemoEngine implements STTEngine {
  readonly kind: STTEngineKind = "demo";

  private timers: ReturnType<typeof setTimeout>[] = [];
  private stopped = false;
  private events: STTEvents | null = null;

  async start(events: STTEvents, _settings: Settings): Promise<void> {
    void _settings;
    this.events = events;
    this.stopped = false;
    events.onStatus("listening");
    this.scheduleLine(0);
  }

  private scheduleLine(lineIndex: number): void {
    if (this.stopped || !this.events) return;

    if (lineIndex >= SCRIPT.length) {
      this.events.onStatus("idle", "demo_finished");
      return;
    }

    const line = SCRIPT[lineIndex];
    const words = line.text.split(" ");
    const lineStartTime = Date.now();
    this.playWords(line, words, 0, lineStartTime, lineIndex);
  }

  private playWords(
    line: ScriptLine,
    words: string[],
    wordIndex: number,
    lineStartTime: number,
    lineIndex: number,
  ): void {
    if (this.stopped || !this.events) return;

    if (wordIndex >= words.length) {
      this.events.onFinal(line.text, {
        ...(line.channel === "mic" ? { sttSpeaker: sttSpeakerFor(line) } : { speaker: line.speaker }),
        startedAt: lineStartTime,
      });
      const pause = randRange(LINE_PAUSE_MIN_MS, LINE_PAUSE_MAX_MS);
      const t = setTimeout(() => this.scheduleLine(lineIndex + 1), pause);
      this.timers.push(t);
      return;
    }

    const nextCount = Math.min(
      words.length,
      wordIndex + Math.round(randRange(2, 3)),
    );
    const cumulative = words.slice(0, nextCount).join(" ");
    this.events.onInterim(cumulative, displaySpeaker(line), sttSpeakerFor(line));

    const delay = randRange(TICK_MIN_MS, TICK_MAX_MS);
    const t = setTimeout(
      () => this.playWords(line, words, nextCount, lineStartTime, lineIndex),
      delay,
    );
    this.timers.push(t);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.events = null;
    for (const t of this.timers) {
      clearTimeout(t);
    }
    this.timers = [];
  }
}
