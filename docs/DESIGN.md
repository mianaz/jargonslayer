# JargonSlayer Design Constitution

> **Languages:** English · [简体中文](zh/DESIGN.md)

Canonical spec for all UI work. **English is the working language of this document** so every agent can parse it reliably; literal product copy appears as quoted Chinese strings (ship them verbatim — they are content, not commentary). When this file and any older prompt disagree, this file wins.

- Active theme: **v3 "Dark Tech · Meeting REPL" (terminal)** — see §v3 below.
- Retired themes (v1 Linear-calibrated dark, v2 illuminated-manuscript × Swiss grid): summarized in §Lineage; full original text in git history; visual explorations in `docs/design-explorations/`.

---

## Universal rules (apply to every theme, including future skins)

### CJK typography (the pixels users stare at longest)
- Chinese body text: PingFang SC, **≥14px**, line-height 1.6–1.7. Chinese *reading* text (cards, transcript, summaries) is never set in a monospace or display face. Applying `font-mono` to short zh chrome labels (buttons, status line, menu items) is acceptable: the mono stack carries no CJK glyphs, so Chinese falls through to PingFang while Latin/digits render mono. Never add a CJK monospace font to the stack.
- Pangu spacing: half-width space between CJK and Latin/digits ("本地 Whisper", not "本地Whisper").
- Chinese explanation lines are the hero of every card: `text-fg font-medium`, never de-emphasized below `--mut`.
- `--mut2` (faintest grey) may carry only decoration: numerals, ×N counters, arrows, separators — **never Chinese words**.
- Contrast: every text/background pair ≥4.5:1 (WCAG AA). Compute it; do not eyeball.

### Interaction hard standards
- Visible keyboard focus on every interactive element (global `:focus-visible` ring).
- Every empty state names a concrete next action (e.g. pointing at 「演示」), never mood-only copy.
- Loading = skeletons shaped like the final layout; errors say what happened and what to do; toasts only for transient facts.
- All decorative motion collapses under `@media (prefers-reduced-motion: reduce)`. No exceptions, including the mascot.
- Press feedback on buttons: scale(0.97) via `.btn-tactile` / `.btn-terminal`.

### Writing voice (frontend-design rules, zh)
- Buttons say exactly what happens: 「开始监听」 not 「提交」. An action keeps one name through its whole flow.
- Name things by what users control, never by implementation (「说话人分离」, not 「pyannote pipeline」).
- No em-dash (—) in visible copy. No AI-flavored fillers (综上所述 / 值得注意 / 首先其次最后 / "不是A而是B" constructions).
- Dragon-slaying microcopy (屠龙 metaphor) appears in **at most 3 places** app-wide (empty/achievement positions only). Current: transcript empty state, review empty state, practice-deck completion.

### Anti-AI-slop checklist (run during every polish pass)
- No purple-blue gradient glows, no glassmorphism-by-default, no three-equal-feature-cards patterns.
- One icon family only (Phosphor), standardized strokeWidth; no emoji in UI; no hand-rolled icon paths.
- One corner-radius system per theme; one palette temperature; shadows tinted to background hue (when a theme uses shadows at all).

---

# v3 ACTIVE THEME — Dark Tech · Meeting REPL (terminal)

User decision (2026-07-06): direction #4 of the seven explorations is the default theme. The other six (qinglü focus-flow, ink-wash, grimoire, noir editorial, sketch notebook, 8-bit) become optional skins on the roadmap (§v3.5). Approved visual target: `docs/design-explorations/preview-4-terminal.html`.

**Positioning in one line:** the meeting is a running process — every utterance is an output block, every card is a lint diagnostic; a black/white/grey machine where only labels carry color, and a pixel dragon is the ghost in the machine.

## v3.1 Color (single source of truth; no blue-tinted greys anywhere)

CSS variables live in `globals.css` under `:root, [data-theme="terminal"]`; Tailwind mirrors them 1:1 (literal hex, keep in sync manually).

| token | value | role |
|---|---|---|
| ink | #0A0A0A | page canvas (pure neutral black) |
| panel | #121212 | primary panels |
| panel2 | #1A1A1A | raised: dialogs, popovers |
| panel3 | #202020 | hover/active surface |
| edge | #262626 | hairline |
| edge2 | #333333 | strong divider |
| fg | #EDEDED | primary text |
| mut | #9A9A9A | secondary text (minimum tier that may carry Chinese) |
| mut2 | #5C5C5C | decorative micro-elements only, never Chinese |
| lab-red | #FF5F56 | label: slang 俚语 / danger / errors |
| lab-orange | #FFAA44 | label: idiom 习语; **expression highlight underline** |
| lab-yellow | #F7D51D | label: indirect 委婉 / caution |
| lab-green | #4ADE80 | label: listening state / success / diff-flash |
| lab-purple | #C084FC | label: metaphor 隐喻 |
| lab-cyan | #22D3EE | label: terms 术语; **term highlight underline** |
| act | #FFFFFF | the single accent: primary button = white bg, black text |

Category→color map (exact): idiom=orange, slang=red, phrase=green, metaphor=purple, indirect=yellow, other=neutral grey; **all terms=cyan** (term-type chips stay neutral).

Rules:
1. Any hue where R≠G≠B may only appear on elements ≤24px tall (labels, underlines, status dots, glyphs). Large fills are neutral or white.
2. The old v1 blue `--acc #5B9DFF` and every blue-tinted grey are dead. If you find one, replace it.
3. `warn` semantics: fills use lab-red (small elements only); warn **text** uses `warn-soft #FF8A80` (AA-safe on dark panels). Destructive primary buttons are outlined lab-red, not filled (white is the only large filled accent).
4. Migration-era aliases (`acc/acc2/gold/warn`, `--font-display`) are **retired** (2026-07-06) — no component references remain; `warn-soft` was promoted to a real token (rule 3). The one intentional v2 survivor is the Cornell parchment export artifact, which pins its gold/serif values inline: it is a frozen artifact, not a migration straggler.
5. (2026-07-06) The live transcript now also highlights term cards via `.hl-term`, using the reserved lab-cyan term-highlight-underline token from the table above — same dotted-underline pattern as `.hl-expr` (rounded, `decoration-dotted`, `underline-offset-4`, low-alpha background on hover). All-caps terms (`surface === surface.toUpperCase()`) match case-sensitively to avoid false positives against everyday words (e.g. IT/US/REST); mixed-case terms stay case-insensitive.

## v3.2 Type

- **Monospace is the brand identity**: JetBrains Mono (`next/font`, var `--font-mono-brand`, fallback SF Mono/Menlo) for: brand wordmark, English button words, numbers/timestamps/counters, English card headwords, status line, English label text.
- Chinese never gets CJK-mono glyphs: PingFang SC, body ≥14px per Universal rules. `font-mono` on short zh chrome labels (primary buttons, status line) is fine — CJK falls back to PingFang (see Universal rules); zh *reading* text stays `font-sans`. Micro-labels in Chinese: 12px floor, only for pure decoration tiers.
- ALL-CAPS micro-labels (English only) + `tabular-nums` for all numerals.
- Display serifs are retired in this theme; the `font-display` utility and `--font-display` variable are removed. The Cornell parchment artifact pins `"Songti SC", "STSong", serif` inline (frozen v2 artifact).

## v3.3 Shape & structure

- Corner radius 0–2px globally. Tiny status dots may stay round.
- Cards degrade to **blocks**: 2px left status-color bar + `bg-panel` + top/bottom 1px `edge` separators. No full border boxes, no rounded cards, no manuscript double rules.
- Transcript = **Warp-style block flow**: each segment is a block with a left gutter (mono timestamp + speaker glyph). Speaker identity = glyph `$ > # % @ &` + name text colored from the lab palette (deterministic via hashSpeaker); no filled chips. The live interim tail ends with a blinking block cursor (`.cursor-block`).
- Header = **terminal titlebar**: three fake window dots (red/orange/green, decorative), mono path-style title `jargonslayer — {engine}·{本地|云端} — {n} cards`, right-aligned ⌘K hint chip.
- Footer = **vim status line** (`StatusLine.tsx`, 28px, mono 12px): inverted mode block `-- LISTENING -- / -- IDLE -- / -- STOPPED --` (green bg when listening), detect-mode text, privacy sentence (「音频未离开本机」 for local engines / 「音频经浏览器厂商云端」 for webspeech), card counter, and the mascot perch (`#mascot-perch`) at the far right.
- **Hamburger consolidation** (user-requested): header keeps only [Start/Stop primary button] + engine pills + posture chip + detect-mode badge. Demo / History / Review / Settings / Help live inside one ≡ dropdown menu (mono-styled, icon + zh label, original data-testids preserved inside the menu, ESC/outside-click close, keyboard navigable).

## v3.4 Pixel dragon mascot "Bit" (original character, interactive)

**Copyright red lines** — must be clearly distinct from the reference characters (Genshin's A-Qiao: yellow body, green mohawk, sunglasses, bipedal; Chrome's offline T-rex: we borrow silhouette *language*, never the T-rex shape):
- Body: charcoal `#3A3A3A` + phosphor-green `#4ADE80` dorsal fins / belly accents (a terminal ghost, not yellow-green).
- Eyes: square **cursor-block pupils** that blink like a terminal caret — this is the signature. No sunglasses.
- Form: quadruped, low-slung long body (not bipedal); tail tip is a half-block ▌ pixel.
- Fire: exhaled flames are **multicolor ANSI pixel particles** using the five lab colors — the label system baked into the character.

**Craft bar / 画质标准 (user addition 2026-07-06; reference the Chrome dino's silhouette language, not its shape):**
- Pixel grid ≥32×24 (the Chrome dino carries ~44×47 worth of information; do not economize down to ~24×16).
- The silhouette must read "dragon" at a glance: **thick neck** (near head-width), large head mass, **visible small forearms/claws** (even 2–3 cells, but they must exist), sturdy legs.
- Acceptance: reads as a chunky, cute dragon at both 40px actual size and 4× zoom.

**State machine** (all motion gated by reduced-motion; static awake pose as fallback):
- idle: tail sway 6s loop; cursor-pupil pulse 1.2s; random blink every 5–9s.
- listening (`status === "listening"`): dorsal fins light up cell-by-cell like a signal meter; gentle body bob.
- card-burst (cards+terms count increases): mouth opens, 5–8 multicolor pixel particles arc toward the cards panel, 0.6s; bursts queue if rapid.
- sleep: 30s with no events and not listening → lies down, eyes closed, mono `z Z` floats above; any event or click wakes it.
- click: single = blink + small flame; triple within 800ms = big rainbow flame + 1s page-edge ANSI glow (easter egg); press-and-hold ≥600ms = rolls belly-up, legs paddling (easter egg).
- Implementation: self-contained `PixelDragon.tsx` (SVG `shape-rendering: crispEdges`), subscribes to zustand (`status`, cards+terms length), zero business-logic intrusion; timers cleaned up on unmount; SSR-safe.

## v3.5 Theme architecture (skins roadmap)

- Every color/font token is a CSS variable; components reference tokens only. `<html data-theme="terminal">` is the default.
- A future skin = a new `[data-theme="…"]` variable set + a small theme-level decoration layer (banner/watermark/mascot re-skin). Planned ids: `qinglv | shuimo | grimoire | noir | sketch | 8bit` — one per archived exploration. Settings page gets a theme picker when ≥2 themes exist.
- The mascot re-skins per theme (terminal=Bit; qinglü=mineral-green dragon; shuimo=ink dragon; 8bit=retro palette). The skeleton/state machine is shared; the sprite layer is themed.
- Exploration archive: seven preview HTMLs + generated art (`ink-dragon.png`, `qinglv-band.png`) live in `docs/design-explorations/`.

## v3.6 Motion inventory (closed set)

Cursor blink (steps), new-card `.diff-flash` (green wash → transparent, 0.8s), mascot state machine, menu open (80ms), button press scale(0.97). Forbidden: large-area breathing gradients, parallax, hover displacement >2px.

---

## Lineage (retired specs, kept for context)

- **v1 (retired)**: dark product shell calibrated against Warp/Linear/Superhuman references — the blue-grey dev-tool family. Its lasting contributions were absorbed into Universal rules above (CJK typography standards, interaction hard standards, writing voice, gold-as-annotation single-signature discipline). Its palette is dead.
- **v2 (retired)**: "illuminated manuscript × Swiss grid" (泥金手抄本 × 瑞士网格) — Cinzel/Songti display faces, double-line card chrome, ❖ ornaments, drop caps, heraldic red, dragon watermark, 8px baseline grid. The 8px baseline discipline and the Cornell-note parchment artifact survive; everything else lives on as the future `grimoire` skin. Full spec: git history of this file (commit cfeed9d and earlier).
- **The seven explorations (2026-07-06)**: shuimo 水墨宣纸 / grimoire 羊皮纸 / 8bit / terminal / noir 黑金编辑部 / sketch 手绘便签 / qinglü 青绿焦点流. Terminal won as base; the qinglü exploration's "calm core, expressive edges" attention principle (spend boldness where attention is free: transitions, idle, post-meeting — never on the mid-meeting reading surface) is adopted as a universal design value even inside the terminal theme.
