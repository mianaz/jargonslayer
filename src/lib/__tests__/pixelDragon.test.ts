import { describe, expect, it } from "vitest";
import {
  createMachine,
  nextDragonState,
  isRestingAwake,
  SLEEP_AFTER_MS,
  BURST_MS,
  TRIPLE_WINDOW_MS,
  HOLD_MS,
  type DragonMachine,
} from "@/lib/pixelDragon";

// Small time base so arithmetic reads clearly.
const T0 = 1_000_000;

function idle(now = T0): DragonMachine {
  return createMachine(now, false);
}
function live(now = T0): DragonMachine {
  return createMachine(now, true);
}

describe("createMachine", () => {
  it("starts idle when not listening, seeding the sleep clock at `now`", () => {
    const m = idle(T0);
    expect(m.pose).toBe("idle");
    expect(m.base).toBe("idle");
    expect(m.listening).toBe(false);
    expect(m.lastActivity).toBe(T0);
    expect(m.burstQueue).toBe(0);
  });

  it("starts in the listening pose when a meeting is already live", () => {
    const m = live(T0);
    expect(m.pose).toBe("listening");
    expect(m.base).toBe("listening");
    expect(m.listening).toBe(true);
  });
});

describe("status transitions", () => {
  it("idle → listening when a meeting starts, refreshing lastActivity", () => {
    const m = nextDragonState(idle(T0), { type: "status", listening: true }, T0 + 500);
    expect(m.pose).toBe("listening");
    expect(m.base).toBe("listening");
    expect(m.listening).toBe(true);
    expect(m.lastActivity).toBe(T0 + 500);
  });

  it("listening → idle when the meeting stops, WITHOUT resetting the sleep clock", () => {
    // going idle must not count as activity, or Bit could never doze off
    const m = nextDragonState(live(T0), { type: "status", listening: false }, T0 + 500);
    expect(m.pose).toBe("idle");
    expect(m.base).toBe("idle");
    expect(m.lastActivity).toBe(T0); // unchanged
  });

  it("a status→idle event does NOT wake a sleeping dragon", () => {
    let m = idle(T0);
    m = nextDragonState(m, { type: "tick" }, T0 + SLEEP_AFTER_MS);
    expect(m.pose).toBe("sleep");
    m = nextDragonState(m, { type: "status", listening: false }, T0 + SLEEP_AFTER_MS + 1);
    expect(m.pose).toBe("sleep");
  });

  it("becoming listening wakes a sleeping dragon", () => {
    let m = idle(T0);
    m = nextDragonState(m, { type: "tick" }, T0 + SLEEP_AFTER_MS);
    expect(m.pose).toBe("sleep");
    m = nextDragonState(m, { type: "status", listening: true }, T0 + SLEEP_AFTER_MS + 1);
    expect(m.pose).toBe("listening");
  });
});

describe("card-burst", () => {
  it("a card increase drops the idle dragon into a burst and marks the fallback base", () => {
    const m = nextDragonState(idle(T0), { type: "cardIncrease" }, T0 + 100);
    expect(m.pose).toBe("burst");
    expect(m.base).toBe("idle");
    expect(m.lastActivity).toBe(T0 + 100);
    expect(m.burstQueue).toBe(0);
  });

  it("while listening, a burst falls back to listening (not idle)", () => {
    let m = nextDragonState(live(T0), { type: "cardIncrease" }, T0 + 10);
    expect(m.pose).toBe("burst");
    expect(m.base).toBe("listening");
    m = nextDragonState(m, { type: "burstDone" }, T0 + BURST_MS);
    expect(m.pose).toBe("listening");
  });

  it("burstDone with an empty queue returns to base", () => {
    let m = nextDragonState(idle(T0), { type: "cardIncrease" }, T0);
    m = nextDragonState(m, { type: "burstDone" }, T0 + BURST_MS);
    expect(m.pose).toBe("idle");
    expect(m.burstQueue).toBe(0);
  });

  it("rapid card arrivals QUEUE extra puffs, each drained by one burstDone", () => {
    let m = nextDragonState(idle(T0), { type: "cardIncrease" }, T0); // enter burst
    m = nextDragonState(m, { type: "cardIncrease" }, T0 + 50); // queue +1
    m = nextDragonState(m, { type: "cardIncrease" }, T0 + 90); // queue +1
    expect(m.pose).toBe("burst");
    expect(m.burstQueue).toBe(2);

    m = nextDragonState(m, { type: "burstDone" }, T0 + 600);
    expect(m.pose).toBe("burst");
    expect(m.burstQueue).toBe(1);

    m = nextDragonState(m, { type: "burstDone" }, T0 + 1200);
    expect(m.pose).toBe("burst");
    expect(m.burstQueue).toBe(0);

    m = nextDragonState(m, { type: "burstDone" }, T0 + 1800);
    expect(m.pose).toBe("idle"); // finally back to rest
  });

  it("burstDone is a no-op when not currently bursting", () => {
    const m = idle(T0);
    expect(nextDragonState(m, { type: "burstDone" }, T0 + 10)).toEqual(m);
  });
});

describe("sleep timeout + wake", () => {
  it("does not sleep before SLEEP_AFTER_MS elapses", () => {
    const m = nextDragonState(idle(T0), { type: "tick" }, T0 + SLEEP_AFTER_MS - 1);
    expect(m.pose).toBe("idle");
  });

  it("sleeps exactly at SLEEP_AFTER_MS of inactivity", () => {
    const m = nextDragonState(idle(T0), { type: "tick" }, T0 + SLEEP_AFTER_MS);
    expect(m.pose).toBe("sleep");
  });

  it("never sleeps while listening, no matter how long idle", () => {
    const m = nextDragonState(live(T0), { type: "tick" }, T0 + SLEEP_AFTER_MS * 3);
    expect(m.pose).toBe("listening");
  });

  it("never sleeps mid-burst", () => {
    let m = nextDragonState(idle(T0), { type: "cardIncrease" }, T0);
    m = nextDragonState(m, { type: "tick" }, T0 + SLEEP_AFTER_MS * 2);
    expect(m.pose).toBe("burst");
  });

  it("any pointer interaction wakes from sleep and resets the clock", () => {
    let m = nextDragonState(idle(T0), { type: "tick" }, T0 + SLEEP_AFTER_MS);
    expect(m.pose).toBe("sleep");
    m = nextDragonState(m, { type: "pointer" }, T0 + SLEEP_AFTER_MS + 5);
    expect(m.pose).toBe("idle");
    expect(m.lastActivity).toBe(T0 + SLEEP_AFTER_MS + 5);
  });

  it("a card increase also wakes a sleeping dragon (into a burst)", () => {
    let m = nextDragonState(idle(T0), { type: "tick" }, T0 + SLEEP_AFTER_MS);
    m = nextDragonState(m, { type: "cardIncrease" }, T0 + SLEEP_AFTER_MS + 10);
    expect(m.pose).toBe("burst");
  });

  it("a fresh interaction pushes the sleep deadline forward", () => {
    let m = idle(T0);
    m = nextDragonState(m, { type: "pointer" }, T0 + 20_000); // reset clock
    // 30s after T0 would have slept, but the clock moved to T0+20000
    m = nextDragonState(m, { type: "tick" }, T0 + SLEEP_AFTER_MS);
    expect(m.pose).toBe("idle");
    // now push past the new deadline
    m = nextDragonState(m, { type: "tick" }, T0 + 20_000 + SLEEP_AFTER_MS);
    expect(m.pose).toBe("sleep");
  });
});

describe("press-and-hold belly-up easter egg", () => {
  it("holdStart rolls the dragon belly-up", () => {
    const m = nextDragonState(idle(T0), { type: "holdStart" }, T0 + 10);
    expect(m.pose).toBe("bellyUp");
  });

  it("holdEnd returns to the resting pose (listening if a meeting is live)", () => {
    let m = nextDragonState(live(T0), { type: "holdStart" }, T0 + 10);
    expect(m.pose).toBe("bellyUp");
    m = nextDragonState(m, { type: "holdEnd" }, T0 + 700);
    expect(m.pose).toBe("listening");
  });

  it("card increases are DROPPED (not queued) while belly-up", () => {
    let m = nextDragonState(idle(T0), { type: "holdStart" }, T0);
    m = nextDragonState(m, { type: "cardIncrease" }, T0 + 100);
    expect(m.pose).toBe("bellyUp"); // still rolling, no burst
    expect(m.burstQueue).toBe(0);
    expect(m.lastActivity).toBe(T0 + 100); // but activity is acknowledged
  });

  it("holdEnd is a no-op if the dragon wasn't belly-up", () => {
    const m = idle(T0);
    expect(nextDragonState(m, { type: "holdEnd" }, T0 + 10)).toEqual(m);
  });
});

describe("isRestingAwake", () => {
  it("is true only for idle / listening (not burst / sleep / bellyUp)", () => {
    expect(isRestingAwake(idle(T0))).toBe(true);
    expect(isRestingAwake(live(T0))).toBe(true);
    expect(isRestingAwake(nextDragonState(idle(T0), { type: "cardIncrease" }, T0))).toBe(false);
    expect(isRestingAwake(nextDragonState(idle(T0), { type: "tick" }, T0 + SLEEP_AFTER_MS))).toBe(false);
    expect(isRestingAwake(nextDragonState(idle(T0), { type: "holdStart" }, T0))).toBe(false);
  });
});

describe("timing constants (contract with the React shell)", () => {
  it("match the DESIGN v3.4 spec values", () => {
    expect(SLEEP_AFTER_MS).toBe(30_000);
    expect(BURST_MS).toBe(600);
    expect(TRIPLE_WINDOW_MS).toBe(800);
    expect(HOLD_MS).toBe(600);
  });
});
