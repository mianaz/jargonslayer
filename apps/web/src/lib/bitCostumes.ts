// Bit's wardrobe (v0.5.1 Bit sprint) — pure pixel data + the
// theme→costume mapping. Designed by the lead in a render-preview loop
// (3 rounds, scratchpad harness) against the exact BODY_AWAKE /
// SLEEP_BODY / BELLYUP_BODY geometry in PixelDragon.tsx: awake horns
// y6, crown y7-8, eye (5,10,3,3); sleep head crown y21, flat horns
// y20; bellyup head lolls bottom-left, fallen costume sits ON THE
// GROUND at x33-39 clear of the flopped tail (x28-34, y25).
//
// Costumes draw ON TOP of the body inside each pose's own transform
// group (the awake set rides .bit-sway so hats sway with the head).
// Fixed accent hexes are deliberate: a costume is a ≤24px "label"
// element (DESIGN.md v3.1's own size class for non-neutral hue), and
// its identity colors must survive being worn under ANY theme — the
// manual override (Settings.bitCostume) lets 魔典's hat appear on the
// terminal theme, so costume colors cannot resolve through theme
// tokens. The one theme-reactive part stays the body itself (--bit-phos).

/** [x, y, w, h, color, opacity?] — structurally identical to
 *  PixelDragon.tsx's own Px tuple (kept local so the data file has no
 *  component import; TS structural typing makes them interchangeable). */
export type CostumePx = [number, number, number, number, string, number?];

export type BitCostumeId =
  | "glasses"
  | "douli"
  | "wizard"
  | "fedora"
  | "crown"
  | "hero"
  | "pencil";

/** Settings.bitCostume value space: "auto" follows the active theme
 *  (THEME_COSTUME below; custom themes → bare), "none" = 原装. */
export type BitCostumeSetting = "auto" | "none" | BitCostumeId;

export interface CostumeLayers {
  /** Worn in every upright pose (idle/listening/burst) — renders
   *  inside the sway group so it moves with the head. */
  awake: CostumePx[];
  /** Worn while sleeping (head down on the baseline). */
  sleep: CostumePx[];
  /** NOT worn — fallen off during the roll, lying beside the tail. */
  bellyup: CostumePx[];
}

const STRAW = "#c9a86a", STRAW_DK = "#8a6f42";
const VIO = "#5b4a86", VIO_DK = "#463868", GILT = "#e0bc4a";
const FBLK = "#1f1f1f", FBLK_HI = "#4a4a4a", GOLD = "#d4a03c";
const JADE = "#4cb78c";
const RED = "#e7484c";
const YEL = "#ffd24a", WOOD = "#e8c27a", GRAPH = "#5a5a5a", PINK = "#ffb3c7", FERR = "#c0c0c0";
const RIM = "#d9d9d9";

export const BIT_COSTUMES: Record<BitCostumeId, CostumeLayers> = {
  // 清晰 — round reading glasses: open half-rim (no bottom bar — the
  // full ring read as a porthole in round 1), temple arm to the ear.
  glasses: {
    awake: [
      [4, 9, 5, 1, RIM],
      [3, 10, 1, 2, RIM],
      [8, 10, 1, 2, RIM],
      [9, 9, 3, 1, RIM, 0.8],
    ],
    sleep: [
      [4, 22, 5, 1, RIM],
      [3, 23, 1, 1, RIM],
      [8, 23, 1, 1, RIM],
      [9, 22, 3, 1, RIM, 0.8],
    ],
    bellyup: [
      [35, 24, 2, 2, RIM],
      [37, 25, 2, 1, RIM, 0.8],
    ],
  },

  // 水墨 — 斗笠: wide conical straw brim overhanging the whole face,
  // horns tucked underneath.
  douli: {
    awake: [
      [7, 2, 2, 1, STRAW_DK],
      [5, 3, 6, 1, STRAW],
      [3, 4, 10, 1, STRAW],
      [1, 5, 14, 1, STRAW],
      [1, 6, 14, 1, STRAW_DK, 0.55],
    ],
    sleep: [
      [7, 17, 2, 1, STRAW_DK],
      [5, 18, 6, 1, STRAW],
      [3, 19, 10, 1, STRAW],
      [1, 20, 14, 1, STRAW],
      [1, 21, 14, 1, STRAW_DK, 0.55],
    ],
    bellyup: [
      [36, 23, 3, 1, STRAW_DK],
      [35, 24, 5, 1, STRAW],
      [35, 25, 5, 1, STRAW],
    ],
  },

  // 魔典 — droopy wizard hat: bent tip overlaps the cone column so the
  // silhouette joins solid; gilt band + a single gilt star on the cone.
  wizard: {
    awake: [
      [4, 1, 3, 1, VIO_DK],
      [5, 2, 4, 1, VIO],
      [6, 3, 5, 1, VIO],
      [8, 3, 1, 1, GILT],
      [5, 4, 7, 1, VIO],
      [5, 5, 7, 1, GILT],
      [3, 6, 11, 1, VIO],
    ],
    sleep: [
      [4, 16, 3, 1, VIO_DK],
      [5, 17, 4, 1, VIO],
      [6, 18, 5, 1, VIO],
      [8, 18, 1, 1, GILT],
      [5, 19, 7, 1, VIO],
      [5, 20, 7, 1, GILT],
      [3, 21, 11, 1, VIO],
    ],
    bellyup: [
      [35, 25, 4, 1, VIO],
      [35, 24, 3, 1, VIO],
      [36, 23, 2, 1, VIO_DK],
      [38, 21, 1, 1, GILT], // star knocked loose mid-roll
    ],
  },

  // 黑金 — fedora: pinched crown highlight, gold band, wide brim with
  // a snap-brim front dip over the brow. Near-black needs the highlight
  // row + band to read against the charcoal head.
  fedora: {
    awake: [
      [5, 3, 6, 1, FBLK_HI],
      [4, 4, 8, 1, FBLK],
      [4, 5, 8, 1, FBLK],
      [4, 6, 8, 1, GOLD],
      [1, 7, 13, 1, FBLK],
      [1, 8, 2, 1, FBLK],
    ],
    sleep: [
      [5, 18, 6, 1, FBLK_HI],
      [4, 19, 8, 1, FBLK],
      [4, 20, 8, 1, GOLD],
      [1, 21, 13, 1, FBLK],
      [1, 22, 2, 1, FBLK],
    ],
    bellyup: [
      [35, 22, 3, 2, FBLK],
      [35, 23, 3, 1, GOLD],
      [35, 24, 5, 1, FBLK],
      [35, 25, 4, 1, FBLK_HI, 0.5],
    ],
  },

  // 青绿 — small gold three-point crown with a jade gem, sitting
  // BETWEEN the horns (both horns stay visible flanking it).
  crown: {
    awake: [
      [6, 4, 1, 1, GOLD],
      [8, 4, 2, 1, GOLD],
      [11, 4, 1, 1, GOLD],
      [6, 5, 6, 1, GOLD],
      [8, 5, 2, 1, JADE],
    ],
    sleep: [
      [6, 19, 1, 1, GOLD],
      [8, 19, 2, 1, GOLD],
      [11, 19, 1, 1, GOLD],
      [6, 20, 6, 1, GOLD],
      [8, 20, 2, 1, JADE],
    ],
    bellyup: [
      [35, 24, 4, 1, GOLD],
      [35, 23, 1, 1, GOLD],
      [38, 23, 1, 1, GOLD],
      [37, 21, 1, 1, JADE], // gem popped out
    ],
  },

  // 像素 — hero headband across the brow, knot tails fluttering off
  // behind the head (his home theme; the sprite-red matches 8bit's act).
  hero: {
    awake: [
      [2, 8, 11, 1, RED],
      [13, 8, 2, 1, RED],
      [14, 9, 1, 1, RED, 0.8],
      [15, 10, 1, 1, RED, 0.6],
    ],
    sleep: [
      [2, 22, 11, 1, RED],
      [13, 22, 2, 1, RED],
      [14, 23, 1, 1, RED, 0.8],
    ],
    bellyup: [
      [34, 24, 4, 1, RED],
      [37, 23, 2, 1, RED, 0.8],
      [36, 25, 3, 1, RED, 0.6],
    ],
  },

  // 笔记 — a pencil resting across the crown between the horns:
  // graphite tip forward, wood, yellow body, ferrule, pink eraser.
  pencil: {
    awake: [
      [5, 7, 1, 1, GRAPH],
      [6, 7, 1, 1, WOOD],
      [7, 7, 4, 1, YEL],
      [11, 7, 1, 1, FERR],
      [12, 7, 1, 1, PINK],
    ],
    sleep: [
      [5, 20, 1, 1, GRAPH],
      [6, 20, 1, 1, WOOD],
      [7, 20, 4, 1, YEL],
      [11, 20, 1, 1, FERR],
      [12, 20, 1, 1, PINK],
    ],
    bellyup: [
      [34, 24, 1, 1, GRAPH],
      [35, 24, 1, 1, WOOD],
      [36, 24, 2, 1, YEL],
      [38, 24, 1, 1, PINK],
    ],
  },
};

/** zh labels for the settings picker, registry order. */
export const BIT_COSTUME_LABELS: Record<BitCostumeId, string> = {
  glasses: "圆框眼镜",
  douli: "斗笠",
  wizard: "巫师帽",
  fedora: "礼帽",
  crown: "玉冠",
  hero: "勇者头带",
  pencil: "耳后铅笔",
};

/** Which costume each BUILTIN theme dresses Bit in under "auto".
 *  terminal / terminal-light keep him 原装 (absent = none) — the
 *  default look IS the brand. Custom themes are likewise absent. */
export const THEME_COSTUME: Readonly<Record<string, BitCostumeId>> = {
  clarity: "glasses",
  shuimo: "douli",
  grimoire: "wizard",
  noir: "fedora",
  qinglv: "crown",
  "8bit": "hero",
  sketch: "pencil",
};

export function isBitCostumeId(v: unknown): v is BitCostumeId {
  // F2 HIGH (v0.5.1 Bit sprint fix round): `v in BIT_COSTUMES` walks the
  // WHOLE prototype chain, so "__proto__"/"constructor"/"toString" all
  // read as "present" via Object.prototype's own inherited members —
  // Object.hasOwn only ever answers for BIT_COSTUMES' own keys.
  return typeof v === "string" && Object.hasOwn(BIT_COSTUMES, v);
}

/** Resolve the effective costume for the current setting + theme.
 *  null = 原装 (no overlay). `setting` is deliberately the wide
 *  `string` (not BitCostumeSetting): core's Settings.bitCostume is a
 *  structural string (core can't import this union), so every real
 *  caller holds a string — validation happens HERE, once, instead of
 *  as a cast at each call site. Unknown values resolve to null. */
export function resolveBitCostume(
  setting: string,
  themeId: string,
): BitCostumeId | null {
  if (setting === "none") return null;
  // F2 HIGH (v0.5.1 Bit sprint fix round): same prototype-chain hole as
  // isBitCostumeId above, but on THEME_COSTUME — a hostile themeId like
  // "__proto__" or "constructor" would otherwise read back an inherited
  // Object.prototype member (truthy, not a BitCostumeId) instead of
  // falling through to null.
  if (setting === "auto") {
    return Object.hasOwn(THEME_COSTUME, themeId) ? THEME_COSTUME[themeId] : null;
  }
  return isBitCostumeId(setting) ? setting : null;
}
