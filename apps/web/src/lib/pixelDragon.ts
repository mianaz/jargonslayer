// Pure visual state-machine for the「Bit」pixel-dragon mascot
// (DESIGN v3.4). Kept as a plain .ts module — no React, no DOM — so the
// transition logic is unit-tested in isolation the same way the rest of
// the app's pure logic is (see src/lib/__tests__/pixelDragon.test.ts).
// The React shell in src/components/PixelDragon.tsx imports from here
// and only supplies wall-clock `now` + the heartbeat `tick`.

// ── timing constants (ms) — the contract with the React shell ──────
export const SLEEP_AFTER_MS = 30_000; // idle → sleep
export const BURST_MS = 600; // one fire-breath cycle
export const TRIPLE_WINDOW_MS = 800; // 3 clicks → big rainbow flame
export const HOLD_MS = 600; // press-and-hold → belly-up

export type DragonPose = "idle" | "listening" | "burst" | "sleep" | "bellyUp";

export type DragonEvent =
  | { type: "status"; listening: boolean }
  | { type: "cardIncrease" }
  | { type: "pointer" } // any click / interaction → activity + wake
  | { type: "tick" } // heartbeat: the only thing that can trigger sleep
  | { type: "burstDone" }
  | { type: "holdStart" }
  | { type: "holdEnd" };

export interface DragonMachine {
  pose: DragonPose;
  /** Whether the store currently reports a live meeting. Drives the
   *  awake resting pose (listening vs idle) and gates sleep. */
  listening: boolean;
  /** Pose to fall back to when a burst finishes / belly-up releases.
   *  Always "idle" | "listening". */
  base: DragonPose;
  /** Wall-clock ms of the last activity (store event or interaction).
   *  Sleep is measured from here. */
  lastActivity: number;
  /** Burst breaths still owed — rapid card arrivals queue so each gets
   *  its own 0.6s puff instead of being swallowed. */
  burstQueue: number;
}

/** Fresh machine. `now` seeds lastActivity so the 30s sleep clock
 *  starts at mount, not at epoch. */
export function createMachine(now: number, listening = false): DragonMachine {
  return {
    pose: listening ? "listening" : "idle",
    listening,
    base: listening ? "listening" : "idle",
    lastActivity: now,
    burstQueue: 0,
  };
}

/** The resting (non-transient) pose implied by the listening flag.
 *  Bursts and belly-up return here. */
function restingPose(listening: boolean): DragonPose {
  return listening ? "listening" : "idle";
}

/**
 * Reducer for Bit's visual pose. Total + pure: given the current
 * machine, an event, and the current wall-clock `now`, returns the next
 * machine. No timers, no DOM — the React shell supplies `now` and the
 * heartbeat `tick`.
 *
 * Precedence encoded here:
 *  - belly-up (long-press easter egg) is a hard modal state: only a
 *    hold-release (or becoming listening) leaves it; card bursts that
 *    arrive while belly-up are dropped, not queued (Bit isn't breathing
 *    fire while rolling around).
 *  - any pointer interaction counts as activity (wakes from sleep) and
 *    refreshes the sleep clock.
 *  - a card increase queues a burst; if Bit is asleep it also wakes.
 *  - sleep can ONLY be entered by a `tick` whose elapsed-since-activity
 *    has crossed SLEEP_AFTER_MS AND we're idle (not listening / burst /
 *    belly-up).
 */
export function nextDragonState(
  m: DragonMachine,
  event: DragonEvent,
  now: number,
): DragonMachine {
  switch (event.type) {
    case "status": {
      const base = restingPose(event.listening);
      const pose: DragonPose =
        m.pose === "burst" || m.pose === "bellyUp"
          ? m.pose // a live burst / roll keeps playing; base updates
          : event.listening
            ? "listening"
            : m.pose === "sleep"
              ? "sleep" // status→idle alone doesn't wake from sleep
              : "idle";
      return {
        ...m,
        listening: event.listening,
        base,
        // becoming listening is an activity ping; going idle is not (so
        // Bit can still doze off after a meeting ends).
        lastActivity: event.listening ? now : m.lastActivity,
        pose,
      };
    }

    case "cardIncrease": {
      if (m.pose === "bellyUp") {
        // rolling around — acknowledge activity but don't breathe fire
        return { ...m, lastActivity: now };
      }
      return {
        ...m,
        base: restingPose(m.listening),
        lastActivity: now,
        pose: "burst",
        burstQueue: m.pose === "burst" ? m.burstQueue + 1 : m.burstQueue,
      };
    }

    case "burstDone": {
      if (m.pose !== "burst") return m;
      if (m.burstQueue > 0) {
        // another queued puff — restart the burst, one owed less
        return { ...m, burstQueue: m.burstQueue - 1, pose: "burst" };
      }
      return { ...m, pose: m.base };
    }

    case "pointer": {
      // any interaction is activity and wakes from sleep. Doesn't
      // interrupt a burst or belly-up (those own the body).
      const pose: DragonPose =
        m.pose === "sleep" ? restingPose(m.listening) : m.pose;
      return { ...m, lastActivity: now, pose };
    }

    case "holdStart": {
      if (m.pose === "bellyUp") return { ...m, lastActivity: now };
      return { ...m, pose: "bellyUp", lastActivity: now };
    }

    case "holdEnd": {
      if (m.pose !== "bellyUp") return m;
      return { ...m, pose: restingPose(m.listening), lastActivity: now };
    }

    case "tick": {
      // The only path into sleep. Guarded: never sleep while listening,
      // mid-burst, or belly-up.
      if (
        m.pose === "idle" &&
        !m.listening &&
        now - m.lastActivity >= SLEEP_AFTER_MS
      ) {
        return { ...m, pose: "sleep" };
      }
      return m;
    }

    default:
      return m;
  }
}

/** Is Bit awake and resting (eligible for idle micro-animations like
 *  tail-sway / blink)? Used by the shell + tested directly. */
export function isRestingAwake(m: DragonMachine): boolean {
  return m.pose === "idle" || m.pose === "listening";
}

// ── fire particles ─────────────────────────────────────────────────
// 5–8 multicolor ANSI pixels arcing up-left from the snout, fading.
// Positions are deterministic per-burst (seeded) so the same code path
// also renders a single static frame under reduced-motion, and so the
// generator is testable.

/** ANSI pixel-fire palette = the lab-* label colors (v3.4). */
export const FIRE_COLORS = [
  "#FF5F56", // lab-red
  "#FFAA44", // lab-orange
  "#F7D51D", // lab-yellow
  "#4ADE80", // lab-green
  "#22D3EE", // lab-cyan
] as const;

export interface Particle {
  id: number;
  color: string;
  x: number; // start (grid coords, near snout)
  y: number;
  dx: number; // drift (negative = up / left)
  dy: number;
}

export function makeParticles(
  seed: number,
  count: number,
  big: boolean,
): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < count; i++) {
    // cheap deterministic pseudo-random from seed+i (no RNG state)
    const r = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
    const rand = r - Math.floor(r);
    out.push({
      id: seed * 100 + i,
      color: FIRE_COLORS[i % FIRE_COLORS.length],
      x: 1 + rand * 1.5, // snout-tip area
      y: 5 - rand,
      dx: -(2 + rand * (big ? 5 : 3)), // up-LEFT
      dy: -(3 + rand * (big ? 5 : 3)),
    });
  }
  return out;
}
