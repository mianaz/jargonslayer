"use client";

// ── Bit · 屠龙小助手 ──────────────────────────────────────────────
// JargonSlayer's original terminal-ghost mascot (DESIGN v3.4). A
// charcoal quadruped pixel-dragon that perches at the right end of the
// vim status line, facing left, feet on the bar. Copyright red-lines
// (honored, NOT the reference character): charcoal #3A3A3A body +
// phosphor-green #4ADE80 fins/belly, square CURSOR-BLOCK pupils that
// blink like a terminal cursor, low-slung four-legged posture, tail
// tip = a half-block ▌, and multicolor ANSI pixel fire drawn straight
// from the lab-* label palette.
//
// The visual state machine lives as PURE functions in
// src/lib/pixelDragon.ts (createMachine / nextDragonState / … + the
// particle generator) so the transition logic is unit-tested without a
// DOM (see src/lib/__tests__/pixelDragon.test.ts). This shell just
// drives them off a wall-clock heartbeat + zustand subscriptions.

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useApp } from "@/lib/store";
import {
  BURST_MS,
  HOLD_MS,
  TRIPLE_WINDOW_MS,
  createMachine,
  makeParticles,
  nextDragonState,
  type DragonEvent,
  type DragonMachine,
  type DragonPose,
  type Particle,
} from "@/lib/pixelDragon";

// ── palette (mirrors globals terminal tokens; kept local so the widget
//    is fully self-contained per the component contract) ────────────
const BODY = "#3A3A3A";
const BODY_DK = "#2E2E2E";
const BODY_HL = "#454545";
const FOOT_SHADOW = "#333333"; // sole shading under the two planted feet
const TOE_SHADOW = "#2C2C2C"; // individual toe gaps
const PHOS = "#4ADE80"; // phosphor-green fins / belly / eye / tail tip
const PHOS_DIM = "#2A5F3F"; // closed-eyelid line
const EYE_OFF = "#333333";
const WB = "#2E2E2E"; // wing-bone / membrane-edge stroke (= BODY_DK family)
const MEM = 0.42; // wing membrane fill opacity
const MEM_HI = 0.6; // brighter membrane band under the leading edge

// ───────────────────────────────────────────────────────────────────
// PIXEL ART — 40×30 grid (winged redesign, round 5 — FINAL), facing
// LEFT, feet baseline at y=26–27: thick near-head-width neck, big head,
// visible small forearm + green claw, sturdy legs, green dorsal fin
// pair, 3×3 green cursor-block eye, green horn pair, green half-block
// tail tip, charcoal #3A3A3A body family, ground-contact feet, PLUS a
// folding wing (membrane + bone) that renders BEHIND the body and
// swaps geometry per pose (folded/raised/spread/sleep/bellyup).
// Each part is its own list of rects so states can swap parts cleanly.
// A rect is [x, y, w, h, fill, opacity?].
// ───────────────────────────────────────────────────────────────────

type Px = [number, number, number, number, string, number?];

const GRID_W = 40;
const GRID_H = 30;

// shared body (awake pose) minus the eye + mouth + tail (those swap
// per-frame) and minus the fins (kept as their own array below so
// listening can light them one-by-one, nose→tail).
const BODY_AWAKE: Px[] = [
  // horns
  [7, 6, 2, 1, PHOS],
  [10, 6, 2, 1, PHOS],
  [7, 7, 5, 1, BODY],
  // head
  [4, 8, 9, 1, BODY],
  [3, 9, 10, 1, BODY],
  [2, 10, 11, 1, BODY],
  [2, 11, 11, 1, BODY],
  [2, 12, 11, 1, BODY],
  [3, 13, 10, 1, BODY],
  [4, 14, 5, 1, BODY], // lower jaw
  [1, 11, 1, 1, BODY_DK], // nostril / snout tip
  [2, 13, 4, 1, BODY_DK], // mouth line
  // thick neck (near head width)
  [11, 13, 6, 1, BODY],
  [11, 14, 6, 1, BODY],
  [12, 15, 6, 1, BODY],
  // body barrel
  [14, 14, 8, 1, BODY],
  [13, 15, 12, 1, BODY],
  [12, 16, 14, 1, BODY],
  [12, 17, 15, 1, BODY],
  [12, 18, 15, 1, BODY],
  [12, 19, 15, 1, BODY],
  [13, 20, 14, 1, BODY],
  [14, 21, 12, 1, BODY],
  // belly ventral accent (hugs the chest, above the forearm)
  [13, 17, 2, 1, PHOS, 0.55],
  [13, 18, 2, 1, PHOS, 0.45],
  // visible small forearm reaching forward, green claw
  [11, 18, 3, 1, BODY],
  [9, 19, 3, 1, BODY],
  [8, 19, 1, 1, PHOS, 0.75], // claw
  [8, 20, 1, 1, PHOS, 0.55],
  // front foot (planted, near baseline)
  [14, 22, 3, 3, BODY],
  [14, 25, 4, 1, FOOT_SHADOW],
  [14, 26, 1, 1, TOE_SHADOW],
  [16, 26, 1, 1, TOE_SHADOW],
  // hind leg (chunky, sturdy)
  [21, 21, 4, 4, BODY],
  [21, 25, 5, 1, FOOT_SHADOW],
  [21, 26, 1, 1, TOE_SHADOW],
  [23, 26, 1, 1, TOE_SHADOW],
  [25, 26, 1, 1, TOE_SHADOW],
];

// front dorsal fin PAIR — stays visible above the shoulder, clear of the
// wing membrane (fins that would sit under the wing were dropped by the
// redesign; the wing's own leading edge + scallop claws now carry the
// rest of the nose→tail signal meter, see SIGNAL_SEGMENTS below).
const FINS: Px[] = [
  [15, 13, 1, 1, PHOS],
  [17, 12, 1, 1, PHOS],
];

// tail sway frames — the outer cells (x≥27) drift up/down 1 cell while
// the base (25,18,3,1) and the green half-block tip stay attached.
const TAIL_MID: Px[] = [
  [25, 18, 3, 1, BODY],
  [27, 17, 3, 1, BODY],
  [29, 16, 3, 1, BODY],
  [31, 15, 2, 1, BODY],
  [32, 14, 1, 1, BODY],
  [32, 13, 1, 1, PHOS], // half-block ▌ tip
];
const TAIL_UP: Px[] = [
  [25, 18, 3, 1, BODY],
  [27, 16, 3, 1, BODY],
  [29, 15, 3, 1, BODY],
  [31, 14, 2, 1, BODY],
  [32, 13, 1, 1, BODY],
  [32, 12, 1, 1, PHOS],
];
const TAIL_DOWN: Px[] = [
  [25, 18, 3, 1, BODY],
  [27, 18, 3, 1, BODY],
  [29, 17, 3, 1, BODY],
  [31, 16, 2, 1, BODY],
  [32, 15, 1, 1, BODY],
  [32, 14, 1, 1, PHOS],
];
const TAIL_FRAMES: Px[][] = [TAIL_MID, TAIL_UP, TAIL_MID, TAIL_DOWN];

const EYE_OPEN: Px[] = [[5, 10, 3, 3, PHOS]];
// pupil pulse: a 1×1 inner cell cycling darker/brighter over the block
const EYE_PUPIL: Px[] = [
  [5, 10, 3, 3, PHOS],
  [6, 11, 1, 1, BODY_DK, 0.5],
];
// blink: eyelid row replaces the eye block for a frame (charcoal)
const EYE_BLINK: Px[] = [
  [5, 10, 3, 3, EYE_OFF],
  [5, 12, 3, 1, PHOS_DIM],
];

// ── WINGS — render BEHIND the body (folded/raised/spread swap by pose:
//    idle/listening/burst). Membrane fan (phosphor-green, semi-
//    transparent) + a charcoal wing-bone leading edge/fingers + a green
//    wrist claw + trailing-edge scallop steps. ─────────────────────────

// FOLDED (idle) — continuous leading edge, solid membrane, clean scallops.
const WINGS_FOLDED: Px[] = [
  // membrane fan
  [17, 13, 2, 2, PHOS, MEM],
  [18, 12, 3, 3, PHOS, MEM],
  [19, 11, 4, 4, PHOS, MEM],
  [20, 10, 5, 5, PHOS, MEM],
  [21, 9, 5, 6, PHOS, MEM],
  [22, 8, 4, 6, PHOS, MEM],
  [23, 8, 3, 6, PHOS, MEM],
  // brighter band under leading edge
  [18, 12, 2, 1, PHOS, MEM_HI],
  [20, 10, 2, 1, PHOS, MEM_HI],
  [22, 8, 2, 1, PHOS, MEM_HI],
  // leading-edge bone — CONTINUOUS (no notch): step every ~1.3 cols
  [16, 14, 2, 1, WB],
  [17, 13, 1, 1, WB],
  [18, 12, 1, 1, WB],
  [18, 11, 2, 1, WB],
  [20, 10, 1, 1, WB],
  [20, 9, 2, 1, WB],
  [22, 8, 1, 1, WB],
  [22, 7, 2, 1, WB],
  [24, 7, 2, 1, WB],
  // wrist claw (green hook)
  [26, 7, 1, 1, PHOS],
  // trailing-edge scallop steps (charcoal)
  [26, 9, 1, 2, WB],
  [25, 11, 1, 2, WB],
  [23, 13, 2, 1, WB],
];

// RAISED (listening) — lifted + slightly opened.
const WINGS_RAISED: Px[] = [
  [17, 12, 2, 2, PHOS, MEM],
  [18, 11, 3, 3, PHOS, MEM],
  [19, 10, 4, 4, PHOS, MEM],
  [20, 8, 5, 6, PHOS, MEM],
  [21, 7, 5, 6, PHOS, MEM],
  [22, 6, 4, 7, PHOS, MEM],
  [23, 6, 3, 6, PHOS, MEM],
  [18, 11, 2, 1, PHOS, MEM_HI],
  [20, 8, 2, 1, PHOS, MEM_HI],
  [22, 6, 2, 1, PHOS, MEM_HI],
  [16, 13, 2, 1, WB],
  [17, 12, 1, 1, WB],
  [18, 11, 1, 1, WB],
  [18, 10, 2, 1, WB],
  [20, 8, 1, 1, WB],
  [20, 7, 2, 1, WB],
  [22, 6, 1, 1, WB],
  [22, 5, 2, 1, WB],
  [24, 5, 2, 1, WB],
  [26, 5, 1, 1, PHOS],
  [26, 8, 1, 2, WB],
  [25, 10, 1, 2, WB],
  [23, 12, 2, 1, WB],
];

// SIGNAL SEGMENTS (listening light-up), ordered nose→tail. Each is an
// [x, y, w, h] cell that pulses one-by-one along the wing's leading edge
// + scallop claws, sized to sit on the RAISED wing geometry above so
// they read while listening. Front fins are segments 0-1 (drawn from
// FINS); replaces the old 5-entry sequential dorsal-fin meter.
const SIGNAL_SEGMENTS: [number, number, number, number][] = [
  [15, 13, 1, 1], // 0  front fin (nose-most)
  [17, 12, 1, 1], // 1  front fin
  [18, 11, 2, 1], // 2  wing leading edge (low)
  [20, 8, 2, 1], // 3  wing leading edge (mid)
  [22, 6, 2, 1], // 4  wing leading edge (high)
  [26, 5, 1, 1], // 5  wrist-tip claw
  [26, 9, 1, 1], // 6  scallop claw 1
  [25, 11, 1, 1], // 7  scallop claw 2 (tail-most)
];

// SPREAD (burst) — thrown open, tapered wingtip.
const WINGS_SPREAD: Px[] = [
  [17, 11, 3, 3, PHOS, MEM],
  [18, 9, 4, 4, PHOS, MEM],
  [19, 7, 5, 6, PHOS, MEM],
  [20, 5, 6, 8, PHOS, MEM],
  [22, 4, 5, 8, PHOS, MEM],
  [24, 3, 5, 8, PHOS, MEM],
  [26, 3, 4, 7, PHOS, MEM],
  [28, 4, 4, 6, PHOS, MEM],
  [30, 6, 3, 4, PHOS, MEM], // tapered tip (was blocky)
  [19, 6, 2, 1, PHOS, MEM_HI],
  [22, 4, 2, 1, PHOS, MEM_HI],
  [25, 3, 2, 1, PHOS, MEM_HI],
  [28, 5, 2, 1, PHOS, MEM_HI],
  // leading-edge bone arc, tapering to a point at top-right
  [17, 10, 2, 1, WB],
  [18, 8, 2, 1, WB],
  [19, 6, 2, 1, WB],
  [21, 4, 2, 1, WB],
  [23, 3, 2, 1, WB],
  [25, 2, 2, 1, WB],
  [27, 3, 2, 1, WB],
  [29, 5, 2, 1, WB],
  // finger bones
  [24, 5, 1, 6, WB],
  [28, 6, 1, 3, WB],
  // wingtip green claws
  [30, 5, 1, 1, PHOS],
  [25, 2, 1, 1, PHOS],
  // trailing-edge scallops
  [32, 7, 1, 2, WB],
  [30, 9, 2, 1, WB],
  [27, 10, 2, 1, WB],
];

// mouth-open head override: the upper head keeps its full neutral
// silhouette (brow/skull unchanged) but the lower jaw drops 2 rows and
// shifts forward, opening a visible gap at the snout so fire has a
// clear exit path at ~(1–2, 7–8).
const MOUTH_OPEN: Px[] = [
  [7, 6, 2, 1, PHOS],
  [10, 6, 2, 1, PHOS],
  [7, 7, 5, 1, BODY],
  [4, 8, 9, 1, BODY],
  [3, 9, 10, 1, BODY],
  [2, 10, 11, 1, BODY], // upper head unchanged
  [3, 11, 10, 1, BODY], // snout tip trimmed 1 cell — mouth gap starts
  [1, 12, 1, 1, BODY], // dropped lower jaw, forward + open
  [2, 13, 6, 1, BODY],
  [2, 14, 6, 1, BODY_DK], // shadow under the dropped jaw
  [5, 10, 3, 3, PHOS], // alert eye (unchanged position)
  [11, 13, 6, 1, BODY],
  [11, 14, 6, 1, BODY],
  [12, 15, 6, 1, BODY],
  [14, 14, 8, 1, BODY],
  [13, 15, 12, 1, BODY],
  [12, 16, 14, 1, BODY],
  [12, 17, 15, 1, BODY],
  [12, 18, 15, 1, BODY],
  [12, 19, 15, 1, BODY],
  [13, 20, 14, 1, BODY],
  [14, 21, 12, 1, BODY],
  [13, 17, 2, 1, PHOS, 0.55],
  [13, 18, 2, 1, PHOS, 0.45],
  [11, 18, 3, 1, BODY],
  [9, 19, 3, 1, BODY],
  [8, 19, 1, 1, PHOS, 0.75],
  [8, 20, 1, 1, PHOS, 0.55],
  [14, 22, 3, 3, BODY],
  [14, 25, 4, 1, FOOT_SHADOW],
  [14, 26, 1, 1, TOE_SHADOW],
  [16, 26, 1, 1, TOE_SHADOW],
  [21, 21, 4, 4, BODY],
  [21, 25, 5, 1, FOOT_SHADOW],
  [21, 26, 1, 1, TOE_SHADOW],
  [23, 26, 1, 1, TOE_SHADOW],
  [25, 26, 1, 1, TOE_SHADOW],
];

// sleeping pose — whole dragon lowers onto the ground: a rounded head
// blob (same proportions as the awake head, just squashed onto the
// baseline) attached to a long low body log, eyes closed, tail relaxed
// straight. Feet/belly disappear under the body; everything sits on
// the baseline (y=26–27). The old flat dorsal-fin row along the back is
// dropped here — WINGS_SLEEP (rendered behind this, see below) now
// covers the back as a wrapped blanket, with its own dim fin-peek detail.
const SLEEP_BODY: Px[] = [
  // horns lie flat against the head
  [7, 20, 2, 1, PHOS],
  [10, 20, 2, 1, PHOS],
  // head resting on the ground — same rounded silhouette as awake,
  // just shifted down onto the baseline (rows 21-27 instead of 8-14)
  [4, 21, 9, 1, BODY],
  [3, 22, 10, 1, BODY],
  [2, 23, 11, 1, BODY],
  [2, 24, 11, 1, BODY],
  [2, 25, 11, 1, BODY],
  [3, 26, 10, 1, BODY],
  [4, 27, 5, 1, BODY], // lower jaw, closed
  [1, 24, 1, 1, BODY_DK], // snout tip
  [2, 26, 4, 1, BODY_DK], // closed mouth line
  [5, 23, 3, 1, PHOS_DIM], // closed eye (thin dim line, not the alert block)
  // long low body log, same barrel width as awake but only 3 rows
  // tall (vs. 8) — the "lying flat" read
  [11, 25, 15, 1, BODY],
  [11, 26, 15, 1, BODY],
  [12, 27, 13, 1, BODY],
  // belly accent, barely visible along the ground contact line
  [14, 26, 2, 1, PHOS, 0.35],
  // forearm relaxed flat against the ground, claw visible
  [9, 26, 3, 1, BODY],
  [8, 27, 1, 1, PHOS, 0.5],
  // tail relaxed straight along the ground, tip still green
  [26, 26, 6, 1, BODY],
  [32, 26, 1, 1, PHOS],
];

// wing wrapped as a low blanket over the curled body — renders BEHIND
// SLEEP_BODY. A folded wrist claw peeks over the top edge, and a couple
// of dim fins still peek along the very top of the back (replacing the
// old flat dorsal-fin row that lived directly on SLEEP_BODY).
const WINGS_SLEEP: Px[] = [
  [12, 23, 12, 2, PHOS, MEM],
  [13, 22, 10, 1, PHOS, MEM],
  [15, 21, 6, 1, PHOS, MEM],
  [13, 22, 9, 1, PHOS, MEM_HI],
  [12, 22, 1, 2, WB],
  [23, 22, 1, 3, WB],
  [16, 21, 1, 1, PHOS], // folded wrist claw peeking over the blanket
  [18, 21, 1, 1, PHOS, 0.7],
  [21, 21, 1, 1, PHOS, 0.7],
];

// belly-up easter egg — rolled over onto its back: a wide rounded body
// mass sits low on the ground (belly-accent band now on TOP, facing
// up), the head lolls off to the side tilted with a big happy eye, and
// four chunky stubby legs stick straight up from the body top (2
// wiggle frames alternate on the BELLYUP_LEGS group). Goofy on purpose.
const BELLYUP_BODY: Px[] = [
  // head lolling off to the side, tilted (rotated silhouette, resting
  // on its crown against the ground)
  [1, 24, 1, 1, BODY],
  [1, 25, 3, 1, BODY],
  [1, 26, 5, 1, BODY],
  [2, 27, 6, 1, BODY],
  [4, 23, 1, 1, PHOS, 0.6], // horn tip poking out, splayed
  [6, 23, 1, 1, PHOS, 0.6],
  [4, 25, 3, 2, PHOS], // big happy eye
  // wide rolled body, back flat on the ground — one broad rounded mass
  [10, 23, 16, 1, BODY],
  [9, 24, 18, 1, BODY],
  [9, 25, 19, 1, BODY],
  [9, 26, 19, 1, BODY],
  [10, 27, 17, 1, BODY],
  // belly accent band now facing UP, wide across the top of the roll
  [11, 22, 14, 1, PHOS, 0.7],
  [13, 21, 8, 1, PHOS, 0.45],
  // relaxed tail, flopped flat off the back
  [28, 25, 6, 1, BODY],
  [34, 25, 1, 1, PHOS],
];

// wings splayed flat, hugging the roll's sides (connected, not floating)
// — renders BEHIND BELLYUP_BODY.
const WINGS_BELLYUP: Px[] = [
  [6, 25, 4, 2, PHOS, MEM],
  [5, 26, 2, 1, PHOS, MEM], // left
  [26, 25, 4, 2, PHOS, MEM],
  [29, 26, 3, 1, PHOS, MEM], // right (moved in to touch body)
  [6, 25, 3, 1, PHOS, MEM_HI],
  [26, 25, 3, 1, PHOS, MEM_HI],
];

// the four stubby legs pointing up off the body (separate so CSS can
// wiggle them, 2-frame alternation between BELLYUP_LEGS_A / _B — each
// leg is a clear 2-wide block, not a sliver, spaced across the belly)
const BELLYUP_LEGS_A: Px[] = [
  [12, 18, 2, 4, BODY],
  [11, 17, 2, 1, BODY_HL], // foot pad, splayed left
  [16, 17, 2, 5, BODY],
  [16, 16, 2, 1, BODY_HL],
  [20, 17, 2, 5, BODY],
  [20, 16, 2, 1, BODY_HL],
  [24, 18, 2, 4, BODY],
  [25, 17, 2, 1, BODY_HL], // foot pad, splayed right
];
const BELLYUP_LEGS_B: Px[] = [
  [12, 17, 2, 5, BODY],
  [11, 16, 2, 1, BODY_HL],
  [16, 18, 2, 4, BODY],
  [16, 17, 2, 1, BODY_HL],
  [20, 18, 2, 4, BODY],
  [20, 17, 2, 1, BODY_HL],
  [24, 17, 2, 5, BODY],
  [25, 16, 2, 1, BODY_HL],
];

function Rects({ px }: { px: Px[] }) {
  return (
    <>
      {px.map(([x, y, w, h, fill, opacity], i) => (
        <rect
          key={i}
          x={x}
          y={y}
          width={w}
          height={h}
          fill={fill}
          opacity={opacity}
        />
      ))}
    </>
  );
}

// FIRE PARTICLES: Particle + makeParticles are imported from
// src/lib/pixelDragon (moved there so tests cover the generator too).

// ───────────────────────────────────────────────────────────────────
// REACT SHELL
// ───────────────────────────────────────────────────────────────────

export default function PixelDragon({ size = 40 }: { size?: number }) {
  // store subscriptions (read-only — never mutate the store)
  const status = useApp((s) => s.status);
  const cardCount = useApp((s) => s.cards.length + s.terms.length);
  const listening = status === "listening";

  const now0 = useRef<number>(Date.now());
  const [machine, dispatch] = useReducer(
    (m: DragonMachine, e: DragonEvent) => nextDragonState(m, e, Date.now()),
    undefined,
    () => createMachine(now0.current, listening),
  );

  // reduced-motion: static poses, click still yields a static flame
  const reduced = usePrefersReducedMotion();

  // ── heartbeat: one interval drives the sleep clock (tick) ─────────
  useEffect(() => {
    const id = window.setInterval(() => dispatch({ type: "tick" }), 1000);
    return () => window.clearInterval(id);
  }, []);

  // ── react to store: listening status ──────────────────────────────
  useEffect(() => {
    dispatch({ type: "status", listening });
  }, [listening]);

  // ── react to store: cards+terms count INCREASE → burst ────────────
  const prevCount = useRef(cardCount);
  useEffect(() => {
    if (cardCount > prevCount.current) {
      dispatch({ type: "cardIncrease" });
    }
    prevCount.current = cardCount;
  }, [cardCount]);

  // ── burst lifecycle: when pose enters "burst", spawn particles and
  //    schedule burstDone after BURST_MS (skipped under reduced-motion,
  //    which shows a single static flame frame instead) ──────────────
  const [particles, setParticles] = useState<Particle[]>([]);
  const [edgeGlow, setEdgeGlow] = useState(false);
  const burstSeed = useRef(0);
  useEffect(() => {
    if (machine.pose !== "burst") return;
    burstSeed.current += 1;
    const count = 5 + (burstSeed.current % 4); // 5–8
    setParticles(makeParticles(burstSeed.current, count, false));
    if (reduced) {
      // static frame only — no timers, drop straight back
      const id = window.setTimeout(() => dispatch({ type: "burstDone" }), 0);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(() => {
      setParticles([]);
      dispatch({ type: "burstDone" });
    }, BURST_MS);
    return () => window.clearTimeout(id);
  }, [machine.pose, machine.burstQueue, reduced]);

  // ── click / triple-click / press-and-hold on the dragon ───────────
  const clickTimes = useRef<number[]>([]);
  const holdTimer = useRef<number | null>(null);
  const heldRef = useRef(false);

  function pingActivity() {
    dispatch({ type: "pointer" });
  }

  function fireBigRainbow() {
    burstSeed.current += 1;
    setParticles(makeParticles(burstSeed.current, 8, true));
    dispatch({ type: "cardIncrease" }); // reuse the mouth-open burst
    if (reduced) return;
    // brief page-edge ANSI glow via a portal overlay, removed after 1s
    setEdgeGlow(true);
    window.setTimeout(() => setEdgeGlow(false), 1000);
  }

  function onPointerDown() {
    pingActivity();
    heldRef.current = false;
    holdTimer.current = window.setTimeout(() => {
      heldRef.current = true;
      dispatch({ type: "holdStart" });
    }, HOLD_MS);
  }

  function endHold() {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (heldRef.current) {
      dispatch({ type: "holdEnd" });
      heldRef.current = false;
      return true; // was a hold — don't also treat as a click
    }
    return false;
  }

  function onPointerUp() {
    const wasHold = endHold();
    if (wasHold) return;
    // register a click (blink + small flame); detect triple
    const t = Date.now();
    clickTimes.current = clickTimes.current.filter(
      (x) => t - x < TRIPLE_WINDOW_MS,
    );
    clickTimes.current.push(t);
    if (clickTimes.current.length >= 3) {
      clickTimes.current = [];
      fireBigRainbow();
    } else {
      dispatch({ type: "cardIncrease" }); // small mouth-open flame puff
    }
  }

  // cleanup any dangling hold timer on unmount
  useEffect(() => {
    return () => {
      if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    };
  }, []);

  // ── scope class for the injected <style>. Deterministic (not random):
  //    a random uid diverges between server and client render and trips
  //    a hydration mismatch. If the widget is ever mounted twice, both
  //    instances share identical keyframe/style text, so the collision
  //    is harmless. ────────────────────────────────────────────────────
  const uid = "bit-scope";

  const pose = machine.pose;
  const showFire = pose === "burst";
  const px = size;
  // baseline-align: the 30-tall grid should sit so feet (y26–27) rest
  // on the bar, same "perch" convention as the pre-wing 26-tall grid (2
  // rows of clearance below the feet for the overflow-visible look). We
  // render at the given size and let the parent align via
  // vertical-align:bottom / flex end.

  return (
    <span
      className={`${uid} bit-root`}
      aria-hidden="true"
      title="Bit · 常驻进程"
      onMouseDown={onPointerDown}
      onMouseUp={onPointerUp}
      onMouseLeave={endHold}
      onTouchStart={onPointerDown}
      onTouchEnd={(e) => {
        e.preventDefault();
        onPointerUp();
      }}
      style={{
        display: "inline-block",
        lineHeight: 0,
        cursor: "pointer",
        userSelect: "none",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <StyleTag uid={uid} reduced={reduced} />
      <svg
        width={(px * GRID_W) / GRID_H}
        height={px}
        viewBox={`0 0 ${GRID_W} ${GRID_H}`}
        shapeRendering="crispEdges"
        style={{ display: "block", overflow: "visible" }}
      >
        {/* z Z above while sleeping — anchored above the wing-blanket
            (WINGS_SLEEP top row sits at y=21, SLEEP_BODY horns at
            y=20), shifted +4y from the pre-wing sleep pose to keep
            floating clear of the raised back. */}
        {pose === "sleep" && !reduced && (
          <g className="bit-zzz">
            <ZGlyphSmall x={16} y={8} />
            <ZGlyphBig x={18} y={5} />
          </g>
        )}
        {pose === "sleep" && reduced && (
          <g opacity={0.5}>
            <ZGlyphSmall x={16} y={8} />
            <ZGlyphBig x={18} y={5} />
          </g>
        )}

        {/* ── body by pose ── */}
        {pose === "sleep" ? (
          <>
            <Rects px={WINGS_SLEEP} />
            <Rects px={SLEEP_BODY} />
          </>
        ) : pose === "bellyUp" ? (
          <g>
            <Rects px={WINGS_BELLYUP} />
            <Rects px={BELLYUP_BODY} />
            {/* 2-frame paddle: two leg groups cross-fade via steps() so
                the legs visibly alternate rather than smoothly rotate */}
            <g className={reduced ? "" : "bit-paddle-a"}>
              <Rects px={BELLYUP_LEGS_A} />
            </g>
            <g className={reduced ? "" : "bit-paddle-b"}>
              <Rects px={BELLYUP_LEGS_B} />
            </g>
          </g>
        ) : (
          // awake: idle / listening / burst
          <g className={pose === "listening" ? "" : "bit-sway"}>
            {/* wings render BEHIND the body, geometry keyed by pose */}
            <Rects
              px={
                pose === "listening"
                  ? WINGS_RAISED
                  : showFire
                    ? WINGS_SPREAD
                    : WINGS_FOLDED
              }
            />
            {showFire ? (
              <Rects px={MOUTH_OPEN} />
            ) : (
              <>
                <Rects px={BODY_AWAKE} />
                {/* eye: cursor-block; blink + pupil-pulse only when resting */}
                {reduced ? (
                  <Rects px={EYE_OPEN} />
                ) : (
                  <>
                    <g className="bit-eye-open">
                      <Rects px={EYE_OPEN} />
                    </g>
                    <g className="bit-eye-pupil">
                      <Rects px={EYE_PUPIL} />
                    </g>
                    <g className="bit-eye-blink">
                      <Rects px={EYE_BLINK} />
                    </g>
                  </>
                )}
              </>
            )}
            {/* tail: sways through 2-3 frames when resting, static (mid)
                frame during burst / reduced-motion */}
            {showFire || reduced ? (
              <Rects px={TAIL_MID} />
            ) : (
              TAIL_FRAMES.map((frame, i) => (
                <g key={i} className={`bit-tail bit-tail-${i}`}>
                  <Rects px={frame} />
                </g>
              ))
            )}
            {/* front fin pair — static in all awake poses (the listening
                signal meter lives on the wing edge, see below) */}
            {!showFire && <Rects px={FINS} />}
            {/* signal meter — 8 segments (front fins → wing leading edge
                → scallop claws, nose→tail) pulse one-by-one while
                listening, replacing the old 5-fin sequential meter */}
            {pose === "listening" &&
              !reduced &&
              SIGNAL_SEGMENTS.map(([x, y, w, h], i) => (
                <rect
                  key={i}
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  fill={PHOS}
                  className={`bit-signal bit-signal-${i}`}
                  opacity={0.35}
                />
              ))}
            {pose === "listening" && reduced && (
              <Rects px={SIGNAL_SEGMENTS.map(([x, y, w, h]) => [x, y, w, h, PHOS])} />
            )}
          </g>
        )}

        {/* ── fire particles ──
            the particle generator (src/lib/pixelDragon.ts, not editable
            here) seeds positions around the OLD 24×16 snout (~x:1-2.5,
            y:4-5). The mouth notch sits at ~(1.5, 11.5) in the current
            40×30 grid (MOUTH_OPEN's snout/jaw rebased +4y from the
            36×26 draft), so the whole group is offset at render time
            instead of touching the lib. */}
        {showFire && (
          <g transform="translate(0, 7)">
            {particles.map((p) => (
              <rect
                key={p.id}
                x={0}
                y={0}
                width={1}
                height={1}
                fill={p.color}
                className={reduced ? "" : "bit-spark"}
                style={
                  {
                    // start pose (also the static frame under reduced-
                    // motion) + drift target, both consumed by bitSpark
                    transform: `translate(${p.x}px, ${p.y}px)`,
                    ["--x" as string]: `${p.x}px`,
                    ["--y" as string]: `${p.y}px`,
                    ["--dx" as string]: `${p.x + p.dx}px`,
                    ["--dy" as string]: `${p.y + p.dy}px`,
                  } as React.CSSProperties
                }
              />
            ))}
          </g>
        )}
      </svg>

      {/* page-edge ANSI glow for the triple-click easter egg */}
      {edgeGlow && <EdgeGlowOverlay />}
    </span>
  );
}

// small pixel "z" / "Z" glyphs for the sleep state
function ZGlyphSmall({ x, y }: { x: number; y: number }) {
  const p: Px[] = [
    [x, y, 2, 1, PHOS, 0.5],
    [x + 1, y + 1, 1, 1, PHOS, 0.5],
    [x, y + 2, 2, 1, PHOS, 0.5],
  ];
  return <Rects px={p} />;
}
function ZGlyphBig({ x, y }: { x: number; y: number }) {
  const p: Px[] = [
    [x, y, 3, 1, PHOS, 0.4],
    [x + 1, y + 1, 1, 1, PHOS, 0.4],
    [x, y + 2, 3, 1, PHOS, 0.4],
  ];
  return <Rects px={p} />;
}

// ── page-edge ANSI streak overlay (portal to <body>, self-removing) ─
function EdgeGlowOverlay() {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 9999,
        boxShadow:
          "inset 0 0 0 2px rgba(74,222,128,0.5), inset 0 0 24px 2px rgba(34,211,238,0.25), inset 0 0 40px 6px rgba(255,95,86,0.18)",
        animation: "bitEdgeGlow 1s ease-out forwards",
      }}
    />,
    document.body,
  );
}

// ── prefers-reduced-motion hook (SSR-safe) ─────────────────────────
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

// ── scoped keyframes (component-local <style>; the app's other
//    components keep keyframes in globals.css, but this widget is
//    self-contained by contract so its motion lives with it) ─────────
function StyleTag({ uid, reduced }: { uid: string; reduced: boolean }) {
  // Under reduced-motion we emit ONLY the edge-glow keyframe (used by
  // the portal overlay, which itself is suppressed) and no looping
  // animation — the poses render statically.
  const motion = reduced
    ? ""
    : `
    .${uid} .bit-sway { animation: bitSway 6s ease-in-out infinite; transform-origin: 19px 25px; }
    .${uid} .bit-eye-open { animation: bitEyeOpen 6s steps(1) infinite; }
    .${uid} .bit-eye-pupil { animation: bitEyePupil 6s steps(1) infinite; }
    .${uid} .bit-eye-blink { animation: bitEyeBlink 6s steps(1) infinite; }
    .${uid} .bit-spark { animation: bitSpark ${BURST_MS}ms steps(6) forwards; }
    .${uid} .bit-zzz { animation: bitZzz 3s ease-in-out infinite; }
    .${uid} .bit-paddle-a { animation: bitPaddleA 0.8s steps(1) infinite; transform-origin: 19px 19px; }
    .${uid} .bit-paddle-b { animation: bitPaddleB 0.8s steps(1) infinite; transform-origin: 19px 19px; }
    .${uid} .bit-signal { animation: bitSignal 1.6s steps(1) infinite; }
    .${uid} .bit-signal-0 { animation-delay: 0ms; }
    .${uid} .bit-signal-1 { animation-delay: 200ms; }
    .${uid} .bit-signal-2 { animation-delay: 400ms; }
    .${uid} .bit-signal-3 { animation-delay: 600ms; }
    .${uid} .bit-signal-4 { animation-delay: 800ms; }
    .${uid} .bit-signal-5 { animation-delay: 1000ms; }
    .${uid} .bit-signal-6 { animation-delay: 1200ms; }
    .${uid} .bit-signal-7 { animation-delay: 1400ms; }
    .${uid} .bit-tail { animation: bitTail 6s steps(1) infinite; }
    .${uid} .bit-tail-0 { animation-delay: 0ms; }
    .${uid} .bit-tail-1 { animation-delay: 1500ms; }
    .${uid} .bit-tail-2 { animation-delay: 3000ms; }
    .${uid} .bit-tail-3 { animation-delay: 4500ms; }
  `;
  return (
    <style
      // keyframes are global-by-nature; scoping the *selectors* by uid
      // keeps the applied rules local to this instance.
      dangerouslySetInnerHTML={{
        __html: `
    @keyframes bitSway { 0%,100%{ transform: rotate(0deg);} 25%{ transform: rotate(-1.5deg);} 75%{ transform: rotate(1.5deg);} }
    /* eye: three states cross-fade on a shared 6s clock — open most of
       the time, a brief pupil-pulse, then a blink (eyelid) frame. Each
       layer is drawn full-opacity/hidden in its own window so exactly
       one is visible at a time (mirrors the old single-layer bitBlink,
       extended to 3 frames instead of 2). */
    @keyframes bitEyeOpen { 0%,84%,100%{ opacity:1;} 86%,98%{ opacity:0;} }
    @keyframes bitEyePupil { 0%,84%,100%{ opacity:0;} 86%,92%{ opacity:1;} 94%,98%{ opacity:0;} }
    @keyframes bitEyeBlink { 0%,92%,100%{ opacity:0;} 94%,98%{ opacity:1;} }
    @keyframes bitSpark { 0%{ transform: translate(var(--x,1px), var(--y,5px)); opacity:1;} 100%{ transform: translate(var(--dx,-2px), var(--dy,0px)); opacity:0;} }
    @keyframes bitZzz { 0%,100%{ transform: translateY(0); opacity:0.55;} 50%{ transform: translateY(-1px); opacity:0.9;} }
    /* belly-up paddle: two leg groups alternate hard (steps(1), no
       fade) so all four stubby legs visibly swap position each beat */
    @keyframes bitPaddleA { 0%,49%{ opacity:1;} 50%,100%{ opacity:0;} }
    @keyframes bitPaddleB { 0%,49%{ opacity:0;} 50%,100%{ opacity:1;} }
    @keyframes bitSignal { 0%,74%{ opacity:0.3;} 75%,99%{ opacity:1;} }
    /* tail sway: 4 frames (mid→up→mid→down) shown one at a time */
    @keyframes bitTail { 0%,25%{ opacity:1;} 25.01%,100%{ opacity:0;} }
    @keyframes bitEdgeGlow { 0%{ opacity:0;} 20%{ opacity:1;} 100%{ opacity:0;} }
    ${motion}
  `,
      }}
    />
  );
}
