// Auto meeting-context detection (field request: "need AI to auto
// detect the context for better detection") — the pure threshold/gate
// decision + its supporting pure helpers, unit-tested directly without
// mounting useMeeting() itself (this repo has no hook-render test
// harness — see useMeeting.diag.test.ts's identical header note, which
// established this "import the exported pure helper straight from
// useMeeting.ts" pattern).

import { describe, expect, it } from "vitest";
import {
  buildContextExcerpt,
  CONTEXT_INITIAL_CHARS,
  CONTEXT_REFRESH_CHARS,
  CONTEXT_RETRY_CHARS,
  decideContextTrigger,
  shouldDropContextResult,
  sumFinalTextLength,
  type ContextTriggerState,
} from "../useMeeting";

function baseState(overrides: Partial<ContextTriggerState> = {}): ContextTriggerState {
  return {
    live: true,
    aiDetect: true,
    cumulativeChars: 0,
    inferredContext: null,
    contextOverride: false,
    contextAttempts: 0,
    contextRefreshed: false,
    ...overrides,
  };
}

describe("decideContextTrigger — thresholds", () => {
  it("does nothing below the 1200-char initial threshold", () => {
    expect(decideContextTrigger(baseState({ cumulativeChars: CONTEXT_INITIAL_CHARS - 1 }))).toBeNull();
  });

  it("fires 'initial' at exactly the 1200-char threshold, on a fresh meeting (attempts:0, no context yet)", () => {
    expect(decideContextTrigger(baseState({ cumulativeChars: CONTEXT_INITIAL_CHARS }))).toBe("initial");
  });

  it("fires 'initial' well above the threshold too, as long as attempts is still 0", () => {
    expect(decideContextTrigger(baseState({ cumulativeChars: CONTEXT_INITIAL_CHARS + 500 }))).toBe(
      "initial",
    );
  });

  it("does NOT retry below the 1800-char threshold even after the first attempt failed", () => {
    expect(
      decideContextTrigger(
        baseState({ contextAttempts: 1, cumulativeChars: CONTEXT_RETRY_CHARS - 1 }),
      ),
    ).toBeNull();
  });

  // F3 fix (field-test batch C, Sol M2) ties into this exact case: this
  // proves the pure DECISION is already "retry" the instant attempts
  // flips to 1 with chars already >= 1800 — see the settlement-path
  // describe block below for why useMeeting.ts's trigger effect must
  // re-run (not just re-decide) at that same instant.
  it("fires 'retry' at exactly the 1800-char threshold when the first attempt already failed (attempts:1)", () => {
    expect(
      decideContextTrigger(baseState({ contextAttempts: 1, cumulativeChars: CONTEXT_RETRY_CHARS })),
    ).toBe("retry");
  });

  it("gives up silently after both attempts are exhausted (attempts:2), regardless of how much text accumulates", () => {
    expect(
      decideContextTrigger(
        baseState({ contextAttempts: 2, cumulativeChars: CONTEXT_REFRESH_CHARS + 1000 }),
      ),
    ).toBeNull();
  });

  it("does NOT fire 'initial' again once attempts is already 1 (even past the 1200 mark) — only 'retry' applies past the first attempt", () => {
    expect(
      decideContextTrigger(baseState({ contextAttempts: 1, cumulativeChars: CONTEXT_INITIAL_CHARS + 1 })),
    ).toBeNull();
  });
});

describe("decideContextTrigger — one-shot refresh at 7000", () => {
  function successState(overrides: Partial<ContextTriggerState> = {}): ContextTriggerState {
    return baseState({ inferredContext: "生物信息学组会", ...overrides });
  }

  it("does nothing below the 7000-char refresh threshold once a context already exists", () => {
    expect(
      decideContextTrigger(successState({ cumulativeChars: CONTEXT_REFRESH_CHARS - 1 })),
    ).toBeNull();
  });

  it("fires 'refresh' at exactly the 7000-char threshold", () => {
    expect(decideContextTrigger(successState({ cumulativeChars: CONTEXT_REFRESH_CHARS }))).toBe(
      "refresh",
    );
  });

  it("never fires the refresh twice — contextRefreshed already true is a hard stop", () => {
    expect(
      decideContextTrigger(
        successState({ cumulativeChars: CONTEXT_REFRESH_CHARS + 5000, contextRefreshed: true }),
      ),
    ).toBeNull();
  });
});

describe("decideContextTrigger — aiDetect gate", () => {
  it("never fires anything when aiDetect is off, however much text has accumulated", () => {
    expect(
      decideContextTrigger(baseState({ aiDetect: false, cumulativeChars: CONTEXT_REFRESH_CHARS + 1 })),
    ).toBeNull();
  });
});

describe("decideContextTrigger — live gate (status connecting/listening/paused only)", () => {
  it("never fires while not live (e.g. status:'stopped' — browsing a loaded history session)", () => {
    expect(
      decideContextTrigger(baseState({ live: false, cumulativeChars: CONTEXT_REFRESH_CHARS + 1 })),
    ).toBeNull();
  });
});

describe("decideContextTrigger — contextOverride is a hard stop for every action", () => {
  it("suppresses the initial attempt even past the 1200-char threshold", () => {
    expect(
      decideContextTrigger(baseState({ contextOverride: true, cumulativeChars: CONTEXT_INITIAL_CHARS })),
    ).toBeNull();
  });

  it("suppresses the retry even past the 1800-char threshold", () => {
    expect(
      decideContextTrigger(
        baseState({ contextOverride: true, contextAttempts: 1, cumulativeChars: CONTEXT_RETRY_CHARS }),
      ),
    ).toBeNull();
  });

  it("suppresses the refresh even past the 7000-char threshold", () => {
    expect(
      decideContextTrigger(
        baseState({
          contextOverride: true,
          inferredContext: "已有背景",
          cumulativeChars: CONTEXT_REFRESH_CHARS,
        }),
      ),
    ).toBeNull();
  });

  it("a user-CLEARED override (inferredContext: null, contextOverride: true) is never reinterpreted as 'still needs an initial guess'", () => {
    expect(
      decideContextTrigger(
        baseState({
          contextOverride: true,
          inferredContext: null,
          contextAttempts: 0,
          cumulativeChars: CONTEXT_INITIAL_CHARS + 5000,
        }),
      ),
    ).toBeNull();
  });
});

// F3 fix (field-test batch C, Sol M2): useMeeting.ts's trigger effect
// used to depend on `[segments]` ALONE — an in-flight initial attempt
// that settles empty/rejected (bumpContextAttempts) never re-ran the
// effect unless a NEW final segment also happened to land, so a retry
// threshold already crossed DURING the in-flight window sat unfired
// until (if ever) more transcript arrived. The fix adds a reactive
// `contextAttempts` subscription to the effect's own dep array
// (`}, [segments, contextAttempts]);`) so settlement itself (not just a
// new segment) re-runs the decision. This repo has no hook-render test
// harness (see this file's own header note) so the reactive re-run
// can't be exercised directly here; what CAN be pinned at this layer is
// that the settlement moment's OWN state already resolves to "retry" —
// i.e. there is genuinely a decision waiting to be picked up the
// instant settlement happens, which is exactly what the dep-array fix
// makes the effect notice.
describe("decideContextTrigger — settlement-path scenario the F3 dep-array fix re-evaluates", () => {
  it("decideContextTrigger itself has NO concept of 'in flight' — called again with attempts still 0 (attempt not yet settled), it fires 'initial' again. This is exactly WHY useMeeting.ts needs its own separate contextInFlightRef guard (imperative, not exercised here) to avoid double-dispatching while the first attempt is still pending.", () => {
    expect(
      decideContextTrigger(baseState({ contextAttempts: 0, cumulativeChars: CONTEXT_RETRY_CHARS + 200 })),
    ).toBe("initial");
  });

  it("the instant that in-flight attempt settles (attempts:0 -> 1), with cumulativeChars unchanged (no new segment arrived since dispatch), the decision is ALREADY 'retry'", () => {
    // Same cumulativeChars as the in-flight moment above — only
    // contextAttempts changed (the settlement itself), proving the
    // decision doesn't need a new segment to know it should retry. This
    // is exactly the moment useMeeting.ts's `contextAttempts` dep-array
    // entry (F3 fix) must re-run the effect, since `segments` alone
    // wouldn't have changed.
    expect(
      decideContextTrigger(baseState({ contextAttempts: 1, cumulativeChars: CONTEXT_RETRY_CHARS + 200 })),
    ).toBe("retry");
  });
});

describe("sumFinalTextLength", () => {
  it("sums .text.length across every segment", () => {
    expect(sumFinalTextLength([{ text: "abc" }, { text: "de" }, { text: "" }])).toBe(5);
  });

  it("returns 0 for an empty list", () => {
    expect(sumFinalTextLength([])).toBe(0);
  });
});

describe("buildContextExcerpt", () => {
  it("joins segment texts with newlines, in order", () => {
    expect(buildContextExcerpt([{ text: "first" }, { text: "second" }], 100)).toBe("first\nsecond");
  });

  it("caps the joined text at `cap` chars", () => {
    const segments = [{ text: "a".repeat(50) }, { text: "b".repeat(50) }];
    const excerpt = buildContextExcerpt(segments, 60);
    expect(excerpt.length).toBe(60);
    expect(excerpt).toBe(`${"a".repeat(50)}\n${"b".repeat(9)}`);
  });

  it("returns '' for an empty segment list", () => {
    expect(buildContextExcerpt([], 100)).toBe("");
  });
});

describe("shouldDropContextResult — gen-mismatch / override-at-write-time drop", () => {
  it("keeps a result whose dispatch gen still matches the current gen and no override happened meanwhile", () => {
    expect(shouldDropContextResult(3, 3, false)).toBe(false);
  });

  it("drops a result when the meetingGen has since moved on (a new meeting began while the call was in flight)", () => {
    expect(shouldDropContextResult(3, 4, false)).toBe(true);
  });

  it("drops a result when the user set an override WHILE the call was in flight, even in the SAME meeting (gen guard alone can't catch this)", () => {
    expect(shouldDropContextResult(3, 3, true)).toBe(true);
  });

  it("drops on BOTH conditions at once too", () => {
    expect(shouldDropContextResult(3, 4, true)).toBe(true);
  });
});
