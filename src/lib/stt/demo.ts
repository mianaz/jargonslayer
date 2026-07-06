// Scripted demo replay engine — no microphone, no network. Replays a
// realistic ~2-minute quarterly-planning meeting so the product can
// be evaluated without a mic or API key.

import type { STTEngine, STTEngineKind, STTEvents, Settings } from "../types";

interface ScriptLine {
  speaker: string;
  text: string;
}

// 16-line quarterly planning meeting between three speakers. Every
// line naturally contains its target idiom/term (context-correct,
// non-literal). Lines flow: opening -> metrics -> debate -> wrap-up.
const SCRIPT: ScriptLine[] = [
  {
    speaker: "Sarah",
    text: "Okay everyone, let's get the ball rolling. Thanks for joining, I know Q3 planning snuck up on us fast.",
  },
  {
    speaker: "Sarah",
    text: "Quick context: ARR is up nicely this quarter, but I want us aligned before we lock the roadmap.",
  },
  {
    speaker: "Mike",
    text: "From engineering's side, we shipped the MVP of the onboarding flow, and a few OKR items are already tracking green.",
  },
  {
    speaker: "Lily",
    text: "On the data side, churn ticked down two points, which is great, but it's not enough to move the needle on retention.",
  },
  {
    speaker: "Sarah",
    text: "Right, and with our current runway, we can't afford another quarter of marginal wins. We need something bigger.",
  },
  {
    speaker: "Mike",
    text: "There's some low-hanging fruit in the billing flow though, a couple of fixes could pay off fast with minimal cost.",
  },
  {
    speaker: "Lily",
    text: "Agreed, but let's not boil the ocean trying to fix every edge case at once. We should scope this tightly.",
  },
  {
    speaker: "Sarah",
    text: "That's fair. Mike, are we on the same page on which fix ships first, or do we circle back after standup?",
  },
  {
    speaker: "Mike",
    text: "We're mostly aligned, but honestly my team's bandwidth is tight until the Series B diligence calls wrap up.",
  },
  {
    speaker: "Sarah",
    text: "That's the elephant in the room, isn't it. Investor calls are eating half our engineering time this month.",
  },
  {
    speaker: "Lily",
    text: "I want to push back a little on deprioritizing the churn dashboard though, since leadership keeps asking for it.",
  },
  {
    speaker: "Mike",
    text: "Can we table this specific dashboard debate for now and revisit once the Series B numbers are finalized?",
  },
  {
    speaker: "Sarah",
    text: "Let's take this offline, actually. Mike and Lily, grab fifteen minutes after this call to sort out the priority order.",
  },
  {
    speaker: "Lily",
    text: "Sure. If you read the room here, everyone's nodding, so I think we already know roughly where this lands.",
  },
  {
    speaker: "Sarah",
    text: "Good. Let's unpack the OKR numbers one more time before we close, so nothing here can raise eyebrows in the board deck.",
  },
  {
    speaker: "Sarah",
    text: "Great meeting. Action items: Mike owns billing, Lily owns the churn dashboard, and I'll circle back with runway updates Friday.",
  },
];

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
        speaker: line.speaker,
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
    this.events.onInterim(cumulative, line.speaker);

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
