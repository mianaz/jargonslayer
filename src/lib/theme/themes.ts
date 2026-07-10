// Built-in theme registry (v0.2.1). Exactly two themes ship in this
// release: `terminal` (the existing v3 default — mirrors globals.css's
// `:root, [data-theme="terminal"]` block verbatim, values never
// touched here) and `clarity` (a high-readability dark variant, the
// first theme to travel the full engine pipeline: validated by
// schema.ts, injected by apply.ts via setProperty, never a CSS string).
//
// docs/DESIGN.md v3.5 roadmap: this registry is the "open engine, only
// built-ins for now" foundation — a future community theme source
// would validate against ThemeSchema and slot in beside these two, but
// no loader for that exists yet (out of scope for v0.2.1).

import type { ThemeDefinition } from "./schema";

// Mirrors globals.css `:root, [data-theme="terminal"]` 1:1 — this is
// the CSS-authored default; applyTheme() never needs to inject these
// (switching TO terminal is a resetToDefaultTheme() removeProperty
// pass, see apply.ts), but the values are still declared here so the
// theme picker has a real ThemeDefinition to point at and future
// theme-diffing/export tooling has one source of truth.
export const TERMINAL_THEME: ThemeDefinition = {
  id: "terminal",
  label: "终端（默认）",
  scheme: "dark",
  tokens: {
    ink: "#0a0a0a",
    panel: "#121212",
    panel2: "#1a1a1a",
    panel3: "#202020",
    edge: "#262626",
    edge2: "#333333",
    fg: "#ededed",
    mut: "#9a9a9a",
    // Raised from the pre-v0.2.1 #5c5c5c (2.8:1, failing AA) to clear
    // >=4.5:1 against every panel level in use (ink/panel/panel2/
    // panel3) while staying visibly darker than --mut — see the
    // v0.2.1 contrast-audit findings (mut2 carries real Chinese
    // content text in many components, not just decoration).
    mut2: "#8c8c8c",
    "lab-red": "#ff5f56",
    "lab-orange": "#ffaa44",
    "lab-yellow": "#f7d51d",
    "lab-green": "#4ade80",
    "lab-purple": "#c084fc",
    "lab-cyan": "#22d3ee",
    act: "#ffffff",
    "warn-soft": "#ff8a80",
  },
};

// High-readability dark variant — the first theme to travel the full
// engine pipeline. Token values chosen to clear: mut >=7:1, mut2
// >=5:1, edge2-vs-panel >=3:1 (UI-component contrast, WCAG 1.4.11),
// while keeping the fg > mut > mut2 legibility ladder intact. lab-*
// hues are carried over unchanged from terminal (same label-color
// contract); only the neutral ladder + warn-soft shift for readability.
export const CLARITY_THEME: ThemeDefinition = {
  id: "clarity",
  label: "清晰（高对比深色）",
  scheme: "dark",
  tokens: {
    ink: "#0a0a0a",
    panel: "#141414",
    panel2: "#1c1c1c",
    panel3: "#242424",
    edge: "#3a3a3a",
    // Nudged from the initial #5f5f5f draft (2.89:1 vs panel, just
    // under the 3:1 UI-contrast bar) to #636363 (3.07:1) — the
    // smallest bump that clears the requirement.
    edge2: "#636363",
    fg: "#ffffff",
    mut: "#b5b5b5",
    mut2: "#8c8c8c",
    "lab-red": "#ff5f56",
    "lab-orange": "#ffaa44",
    "lab-yellow": "#f7d51d",
    "lab-green": "#4ade80",
    "lab-purple": "#c084fc",
    "lab-cyan": "#22d3ee",
    act: "#ffffff",
    "warn-soft": "#ff9d94",
  },
};

// Light counterpart of the terminal default (v0.2.4 "light mode"):
// the same neutral-ladder grammar mirrored onto warm paper. Every
// value was tuned programmatically against WCAG before landing here —
// see themes.test.ts's contrast suite, which now enforces the same
// bars on every builtin: fg/mut/mut2 and ALL lab-* + warn-soft >=4.5:1
// against every panel level (panel3, the darkest light surface, is the
// binding constraint that forced the lab-* hues this dark), edge2 and
// the lab-cyan focus ring >=3:1 (WCAG 1.4.11), and the chip pairings
// (`text-ink` on bg-act / bg-lab-green / bg-mut, StatusLine.tsx) >=
// 4.5:1. lab-* stay the SAME HUE FAMILIES as terminal (red/amber/
// gold/green/purple/cyan label contract) but drop to their AA-dark
// cousins — the bright phosphor originals sit at ~1.3-2.5:1 on paper
// and are unusable as text. `act` inverts to near-black (white is the
// dark themes' sanctioned large-area accent; its mirror here is ink-
// black), which is why primary buttons must never hardcode a hover
// hex — they use `hover:bg-act/85` (see the v0.2.4 sweep).
export const TERMINAL_LIGHT_THEME: ThemeDefinition = {
  id: "terminal-light",
  label: "终端（浅色）",
  scheme: "light",
  tokens: {
    ink: "#f2f0eb",
    panel: "#faf9f6",
    panel2: "#efede8",
    panel3: "#e7e4dd",
    edge: "#d6d3ca",
    edge2: "#8e8a7f",
    fg: "#191919",
    mut: "#45443f",
    mut2: "#63615a",
    "lab-red": "#b0302a",
    "lab-orange": "#964b00",
    "lab-yellow": "#7c6200",
    "lab-green": "#137038",
    "lab-purple": "#8440cf",
    "lab-cyan": "#076d82",
    act: "#191919",
    "warn-soft": "#b23a30",
  },
};

// ---------------------------------------------------------------------
// #52 "theme批" (v0.2.5-ish): four of the seven archived visual
// explorations (docs/design-explorations/) tokenized as real builtins.
// Each is its OWN design language (not a terminal reskin), so unlike
// TERMINAL_LIGHT_THEME's monochrome-act mirror, `act` here is each
// theme's own signature accent hue (the color its exploration actually
// used for its primary CTA/seal/wax-stamp) — chosen because `act`
// always pairs with `text-ink` (bg-act + text-ink, see apply.ts /
// SummaryPanel.tsx etc.), and ink is by definition the extreme of the
// neutral ladder (darkest for dark schemes, lightest for light), so act
// MUST be the opposite extreme (bright for dark schemes, dark-enough
// for light) for that pairing to read at all — this is a structural
// constraint of the engine, not a stylistic one, and it holds
// regardless of what a mockup's own button component happened to do.
//
// lab-* stay bound to the app's FIXED category slots (idiom=orange,
// slang=red, indirect=yellow, phrase=green, metaphor=purple, all
// terms=cyan — see DESIGN.md v3.1) but each theme supplies its own hue
// for that slot. None of the four source HTMLs implements all six
// categories, so absent hues were invented in the same pigment family
// as the theme's real accents (documented per-token below) rather than
// left to guess at an interface that doesn't exist yet.
//
// AA note: every source HTML renders its accent hues as small FILLS
// with light/dark text on top (badge ribbons, wax seals, wine
// buttons) — our lab-* tokens are rendered the opposite way, as
// colored TEXT directly on a panel. That swap is why almost every
// accent below is a visibly lighter "AA-text cousin" of the source
// hex, not the literal value — same move TERMINAL_LIGHT_THEME's own
// comment describes ("drop to their AA-dark cousins") mirrored for a
// dark scheme (drop to AA-LIGHT cousins instead). Where a source value
// already doubled as text in its own mockup (qinglv's `-tx` suffixed
// tokens, shuimo's zhusha-deep) it was already close to AA and needed
// only a small nudge, called out per-token below.

// 水墨 shuimo — docs/design-explorations/preview-1-shuimo.html ("国画
// 水墨 · 宣纸朱批" — ink-wash + rice-paper cinnabar annotations). LIGHT
// scheme (verified against the source: `body{ background: var(--paper)
// }`, --paper #F6F1E5 — the palette reads pale/light despite being
// picked provisionally alongside dark candidates). ink/fg/mut/mut2
// mirror the source's own five-tier ink ladder verbatim (焦墨/浓墨/重墨/
// 淡墨/清墨 — scorched/concentrated/heavy/diluted/clear ink, literally
// a "how dark is the ink" scale that already reads as an AA text
// hierarchy); panel/panel2/panel3 and edge2 don't exist as flat values
// in the source (it renders elevation as near-transparent black/warm
// rgba washes over one paper color, e.g. `rgba(26,23,20,0.04)`), so
// they're an interpolated warm-paper ladder in the same family,
// deepening toward --paper-edge (verbatim as panel2).
export const SHUIMO_THEME: ThemeDefinition = {
  id: "shuimo",
  label: "水墨（宣纸朱批）",
  scheme: "light",
  tokens: {
    ink: "#f6f1e5", // --paper, verbatim (page canvas)
    panel: "#f2ecde", // interpolated: paper deepened one step (no flat source value)
    panel2: "#efe8d8", // --paper-edge, verbatim
    panel3: "#e8dfc9", // interpolated: paper-edge deepened one step (hover/active)
    edge: "#c9bfaf", // --ink-qing ("边界/极弱"=border/very faint), verbatim
    // --ink-qing itself (#c9bfaf, the source's own hairline color) is
    // only 3.06:1 vs --paper-edge — too weak for the 1.4.11 divider
    // bar. Darkened to the next ink tier down for a real edge2.
    edge2: "#918577",
    fg: "#2e2a26", // --ink-nong ("正文"=body text), verbatim — this IS the source's body-copy color
    mut: "#57504a", // --ink-zhong ("次要"=secondary), verbatim
    // --ink-dan ("弱化"=weakened, #8b8178) was designed against the
    // single --paper tone only (3.4:1) — darkened to clear 4.5:1
    // against panel3 too, the darkest of the invented paper ladder.
    mut2: "#695f58",
    // zhusha-deep (#9e1f22, "表达高亮" expression-highlight text color
    // in the source) already clears AA as text — used verbatim.
    "lab-red": "#9e1f22",
    // 赭石 (ochre) — invented; shuimo has no orange in its 2-hue accent
    // set (zhusha red + huaqing indigo only), darkened for 4.5:1 text.
    "lab-orange": "#87582a",
    // 藤黄 (gamboge) — invented, same reason; gamboge itself is a pale
    // bright yellow (fails badly on paper), so this is its ink-wash-
    // dark cousin, deep enough to read as body text.
    "lab-yellow": "#726115",
    // 石绿 (mineral green) — invented; no green anywhere in the source.
    "lab-green": "#1f6b4a",
    // Invented purple; no purple in the source's 2-hue accent set.
    "lab-purple": "#6b4a8a",
    "lab-cyan": "#2d5d7b", // --huaqing ("术语专用第二色"=term-dedicated), verbatim — matches the app's own all-terms=cyan rule exactly
    // zhusha ("唯一强色之一"=one of the exploration's only two strong
    // colors), the source's own .btn-primary fill — verbatim.
    act: "#c3272b",
    "warn-soft": "#b0392f", // lightened one step off zhusha-deep — distinguishable from lab-red, clears the panel3 bar
  },
};

// 魔典 grimoire — docs/design-explorations/preview-2-grimoire.html
// (leather-bound spellbook: dark leather page, gilt-edged parchment
// cards). DARK scheme (`body{ background: var(--bg-leather) }`,
// #17120E). The source has no flat elevation ladder either — its
// "cards" are literal parchment-gradient inserts on a dark leather
// page, a treatment our block/panel system can't express (noted, not
// invented past this comment) — panel/panel2/panel3/edge are an
// interpolated warm leather-brown ladder in --bg-leather's own family.
// fg/mut/mut2 use the source's real muted-gold text tiers (brand-sub /
// icon-btn / brand-achievement colors) rather than --parchment-dark
// (which the source only ever used as a CARD-background gradient stop,
// never as text-on-dark).
export const GRIMOIRE_THEME: ThemeDefinition = {
  id: "grimoire",
  label: "魔典（哥特烫金）",
  scheme: "dark",
  tokens: {
    ink: "#17120e", // --bg-leather, verbatim (page canvas)
    panel: "#1f170f", // interpolated leather ladder (no flat source value)
    panel2: "#271f14", // interpolated
    panel3: "#302617", // interpolated (hover/active)
    edge: "#2e2418", // interpolated hairline
    // .icon-btn's own border (#4a3d28) is only 1.67:1 vs the invented
    // panel — brightened to clear the 1.4.11 >=3:1 divider bar.
    edge2: "#786341",
    fg: "#e8dcc3", // --parchment, verbatim — matches body{color} exactly
    mut: "#c9b48a", // .brand-sub / .icon-btn text color, verbatim
    // .brand-achievement's own faint tier (#8f8262) was only ~3.9-4.3:1
    // against the invented panel2/panel3 — brightened to clear 4.5:1.
    mut2: "#9b8e6d",
    // crest-red (#a63d40, the wax-seal/CTA fill) rendered as TEXT is
    // only ~2.4-3.0:1 on these panels — brightened to its AA-light
    // cousin, same hue family.
    "lab-red": "#cd7779",
    // --ochre (#b26e3f, the "b-slang" ribbon gradient's base) — brightened for AA text.
    "lab-orange": "#c28052",
    "lab-yellow": "#c9a227", // --gilt, verbatim — the "b-idiom" ribbon color, already clears AA as text
    // --verdigris (#4a7c6f, the "b-phrase" ribbon / engine-dot hue) — brightened for AA text.
    "lab-green": "#5c9b8a",
    // --purple (#6d5578, the "b-metaphor" ribbon base) — brightened for AA text.
    "lab-purple": "#9f87aa",
    // --steel (#56707a, the term/"badge-shield" hue) — brightened for AA text.
    "lab-cyan": "#77949f",
    act: "#e0bc4a", // --gilt-bright, verbatim — the source's own dominant hover/active/emphasis gold (brand name, icon-btn hover, quote rule)
    "warn-soft": "#d97078", // one step lighter than lab-red, same crest-red family, kept distinguishable
  },
};

// 黑色电影 noir — docs/design-explorations/preview-5-noir.html ("黑金
// 编辑部" black-gold editorial / "黑色大教堂×杂志排印"). DARK scheme
// (`body{ background: var(--black) }`, #050505). The most
// monochrome-restrained of the four sources — only gold + wine as
// saturated accents, everything else ivory/black — so four of the six
// lab-* hues (orange/green/purple/cyan) don't exist in the source at
// all and are invented as muted jewel tones consistent with its "black
// cathedral" mood rather than left unthemed.
export const NOIR_THEME: ThemeDefinition = {
  id: "noir",
  label: "黑色电影（黑金）",
  scheme: "dark",
  tokens: {
    ink: "#050505", // --black, verbatim (page canvas)
    panel: "#0c0c0c", // --panel, verbatim
    panel2: "#101010", // --panel-raise, verbatim
    panel3: "#161616", // interpolated one step further (source has no 4th tier; hover/active)
    // --gold-faint (rgba(185,138,46,0.24), the source's own hairline
    // treatment) flattened to a solid hex over --panel — alpha is a
    // utility-class modifier, never a token value (schema.ts), so the
    // composited result is what's stored here.
    edge: "#362a14",
    // --gold-soft (rgba(185,138,46,0.55)) flattened the same way, then
    // brightened one step further — the direct composite was only
    // 2.6:1 vs panel, short of the 1.4.11 >=3:1 bar.
    edge2: "#785b23",
    fg: "#f3efe6", // --ivory, verbatim
    mut: "#a89f8d", // --ivory-dim, verbatim
    // --ivory-faint (#5e594e) was designed as body-on-black-only in the
    // source (2.6-2.9:1 across our 4-panel ladder) — brightened to
    // clear 4.5:1 against panel3, same move as terminal's own mut2 fix.
    mut2: "#878070",
    // --wine/--wine-bright (#5a1f24/#7a2c33, the .btn-primary fill) as
    // TEXT is only ~2.4-4.4:1 on these panels — brightened to its
    // AA-light cousin (this is also why `act` can't be wine: see the
    // module comment above on the bg-act/text-ink pairing constraint).
    "lab-red": "#c66268",
    "lab-orange": "#c77c3c", // invented — no orange in the source's gold/wine/ivory palette
    "lab-yellow": "#b98a2e", // --gold, verbatim (distinct slot from `act` below, which is a brightened variant)
    "lab-green": "#3f9e76", // invented
    "lab-purple": "#9174c4", // invented
    "lab-cyan": "#4fa3b0", // invented
    // --gold itself (#b98a2e) already reads well as text (used for
    // lab-yellow above) but is a touch dim for a large-fill primary
    // button; brightened slightly for `act`'s "the single accent" role
    // (Ink text on bg-act needs headroom, not just the 4.5:1 floor).
    act: "#d4a03c",
    "warn-soft": "#d98890", // invented — a softer rose off the wine family, distinguishable from lab-red (mirrors terminal's red/warn-soft split)
  },
};

// 青绿 qinglv — docs/design-explorations/preview-7-qinglv.html (青绿
// 山水 mineral-green-and-blue landscape painting). DARK scheme —
// **flagged during mapping**: the task's provisional read guessed
// qinglv might be light-schemed; the source's actual `body{ background:
// var(--pine-0) }` (#0A1F1A, literally commented "深松夜"=deep pine
// night) is unambiguously dark. Of the four sources this one arrived
// closest to AA-ready: its own custom properties are already annotated
// with real contrast ratios against the pine backdrop (see the
// `-tx`-suffixed "text" variants below), and pine-0/pine-1/pine-card/
// pine-card-hi form an actual 4-step elevation ladder in the source —
// a rare case of the mockup already being a ThemeDefinition in
// disguise. Two tokens (orange, purple) have no source value at all
// (青绿 mineral-pigment landscapes don't carry either hue) and were
// invented in the same "mineral pigment" family.
export const QINGLV_THEME: ThemeDefinition = {
  id: "qinglv",
  label: "青绿（矿彩山水）",
  scheme: "dark",
  tokens: {
    ink: "#0a1f1a", // --pine-0 ("深松夜·底·暗端"), verbatim
    panel: "#0d2822", // --pine-1 ("深松夜·底·亮端"), verbatim
    panel2: "#12332b", // --pine-card ("页边批注卡底"), verbatim
    panel3: "#163b31", // --pine-card-hi (card hover), verbatim
    // --hairline (rgba(233,241,233,0.09)) flattened to a solid hex over
    // --pine-1 — alpha is a utility-class modifier, never a token.
    edge: "#213a34",
    // --hairline-2 (rgba(...,0.16)) flattened the same way, then
    // brightened further — the direct composite was only 1.6:1 vs
    // panel, short of the 1.4.11 >=3:1 bar.
    edge2: "#4f766c",
    fg: "#e9f1e9", // --moon ("正文 14.9:1"), verbatim — source's own contrast audit already clears our bar
    mut: "#9db8ac", // --moon-2 ("次文字 8.1:1"), verbatim
    // --moon-3 ("弱文字·仅用于深底(base>=4.58:1)") was explicitly scoped
    // by the source's own comment to the darkest surface only — our
    // suite requires all 4 panel levels, so brightened to clear panel3 too.
    mut2: "#8ca399",
    // --zhu-tx ("朱磦·文字 4.4:1") — the source's own comment admits
    // this is JUST under our 4.5:1 bar. Nudged minimally (same hue
    // family) to clear it.
    "lab-red": "#ee7e6c",
    // Invented — no orange in the source's mineral palette (石绿/石青/
    // 赤金/朱磦 = green/cyan/gold/vermillion only); interpolated between
    // --gold and --zhu-tx to stay in-family.
    "lab-orange": "#e08a3c",
    "lab-yellow": "#e9c77e", // --gold-soft, verbatim
    "lab-green": "#4cb78c", // --shilv-tx ("石绿·文字 5.5:1"), verbatim
    // Invented — 青绿山水 mineral pigments don't include purple; kept
    // desaturated/cool to sit beside the green-cyan-gold trio without
    // clashing.
    "lab-purple": "#a596ca",
    "lab-cyan": "#5fc2d6", // --shiqing-tx ("石青·术语文字 6.6:1"), verbatim — matches the app's own all-terms=cyan rule exactly
    act: "#d9a441", // --gold ("赤金·金线 / 表达 / 标签 6+:1"), verbatim — source's own contrast audit already clears our bar
    "warn-soft": "#f08877", // lightened one step off zhu-tx/lab-red, kept distinguishable
  },
};

export const BUILTIN_THEMES: readonly ThemeDefinition[] = [
  TERMINAL_THEME,
  TERMINAL_LIGHT_THEME,
  CLARITY_THEME,
  SHUIMO_THEME,
  GRIMOIRE_THEME,
  NOIR_THEME,
  QINGLV_THEME,
];

export function getBuiltinTheme(id: string): ThemeDefinition | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id);
}
