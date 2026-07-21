import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // v3 主题基座:暗黑科技 · 会议 REPL (docs/DESIGN.md v3.1) — pure
        // neutral-black surface ladder, R=G=B outside of the lab-*
        // label tokens.
        //
        // v0.2.1 INTEGRATION FIX: these are NOT literal hex — every
        // value is `rgb(var(--*-rgb) / <alpha-value>)`, so Tailwind's
        // generated utilities (text-fg, bg-panel, border-edge, ...,
        // the vast majority of the UI) resolve through the "-rgb"
        // triplet CSS variables declared in globals.css's `:root,
        // [data-theme="terminal"]` block, NOT a compiled-in constant.
        // `<alpha-value>` is Tailwind's placeholder token — it lets
        // opacity modifiers (text-fg/90, border-lab-orange/30, bg-
        // panel/85, ...; ~40+ call sites across the app) keep working
        // by substituting the modifier's alpha into the rgb() alpha
        // slot at build time; Tailwind statically detects this exact
        // `rgb(var(--x) / <alpha-value>)` shape to enable that.
        // lib/theme/apply.ts's applyTheme() setProperty's BOTH the hex
        // and the "-rgb" variable for every token in one pass (see
        // that file), so switching themes recolors every Tailwind
        // utility class in the app, not just hand-written CSS
        // selectors that happen to reference the hex variable
        // directly. The hex value in each comment below is for
        // readability only — it plays no role in what actually
        // compiles; the real source of truth is globals.css's "-rgb"
        // declarations, which this file's values point at by name.
        ink: "rgb(var(--ink-rgb) / <alpha-value>)", // #0A0A0A — page canvas (pure neutral black)
        panel: "rgb(var(--panel-rgb) / <alpha-value>)", // #121212 — primary panels
        panel2: "rgb(var(--panel2-rgb) / <alpha-value>)", // #1A1A1A — raised: dialogs, popovers, chips
        panel3: "rgb(var(--panel3-rgb) / <alpha-value>)", // #202020 — hover/active surface step
        edge: "rgb(var(--edge-rgb) / <alpha-value>)", // #262626 — default hairline
        edge2: "rgb(var(--edge2-rgb) / <alpha-value>)", // #333333 — strong hairline (major zone dividers)
        // Text hierarchy (3 levels)
        fg: "rgb(var(--fg-rgb) / <alpha-value>)", // #EDEDED
        mut: "rgb(var(--mut-rgb) / <alpha-value>)", // #9A9A9A
        // v0.2.1 contrast fix: raised from #5C5C5C (2.8:1, failing AA)
        // to #8C8C8C (>=4.5:1 against every panel level) — see
        // globals.css's --mut2 comment and lib/theme/themes.ts.
        mut2: "rgb(var(--mut2-rgb) / <alpha-value>)", // #8C8C8C
        // Label colors (v3.1) — the ONLY source of non-neutral hue,
        // confined to ≤24px elements (tags/underlines/status dots/glyphs).
        "lab-red": "rgb(var(--lab-red-rgb) / <alpha-value>)", // #FF5F56 — 俚语/危险/错误
        "lab-orange": "rgb(var(--lab-orange-rgb) / <alpha-value>)", // #FFAA44 — 习语；表达高亮下划线
        "lab-yellow": "rgb(var(--lab-yellow-rgb) / <alpha-value>)", // #F7D51D — 委婉/警示
        "lab-green": "rgb(var(--lab-green-rgb) / <alpha-value>)", // #4ADE80 — 聆听态/成功/diff-flash
        "lab-purple": "rgb(var(--lab-purple-rgb) / <alpha-value>)", // #C084FC — 隐喻
        "lab-cyan": "rgb(var(--lab-cyan-rgb) / <alpha-value>)", // #22D3EE — 术语；术语高亮下划线
        act: "rgb(var(--act-rgb) / <alpha-value>)", // #FFFFFF — sole accent: primary button, white-bg/black-text
        // warn *text* tier (docs/DESIGN.md v3.1 rule 3): fills use
        // lab-red on small elements only; warn-colored text uses this
        // AA-safe softer red. (Migration-era acc/acc2/gold/warn aliases
        // are retired — no component references remain.)
        "warn-soft": "rgb(var(--warn-soft-rgb) / <alpha-value>)", // #FF8A80
      },
      fontFamily: {
        // v0.5.1 appearance sprint (D5 fonts): both families are now a
        // SINGLE CSS var reference, not a compiled-in array — the
        // literal stacks below live in globals.css's `:root` as
        // `--font-ui`/`--font-mono-user` (still the exact same values
        // as before this landed, so a "default" pick renders byte-
        // identically to the pre-v0.5.1 build). lib/theme/fonts.ts's
        // resolveFontStack + store.ts's updateSettings side effect
        // setProperty/removeProperty those two vars for a non-default
        // uiFont/monoFont choice, which is what actually re-fonts every
        // Tailwind font-sans/font-mono utility across the app in one
        // step — this file itself never changes again for a font swap.
        sans: ["var(--font-ui)"],
        // Monospace is the brand identity in v3 (docs/DESIGN.md v3.2):
        // JetBrains Mono, self-hosted via next/font in layout.tsx as
        // --font-mono-brand, falling back to native monospace stacks —
        // --font-mono-user wraps that chain (see globals.css) so a
        // user's own monoFont choice can still override it.
        mono: ["var(--font-mono-user)"],
        // v2's serif display face (Cinzel/Songti SC) is retired in v3 —
        // no font-display utility exists anymore. The one legitimate
        // serif survivor (CornellNote's frozen parchment artifact) pins
        // its Songti stack inline.
      },
    },
  },
  plugins: [],
} satisfies Config;
