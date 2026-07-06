import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // v3 主题基座:暗黑科技 · 会议 REPL (docs/DESIGN.md v3.1) — pure
        // neutral-black surface ladder, R=G=B outside of the lab-*
        // label tokens. Mirrors the CSS variables in globals.css
        // `:root, [data-theme="terminal"]` 1:1, so a future JS-driven
        // theme switch stays in sync without touching this file.
        ink: "#0A0A0A", // page canvas (pure neutral black)
        panel: "#121212", // primary panels
        panel2: "#1A1A1A", // raised: dialogs, popovers, chips
        panel3: "#202020", // hover/active surface step
        edge: "#262626", // default hairline
        edge2: "#333333", // strong hairline (major zone dividers)
        // Text hierarchy (3 levels)
        fg: "#EDEDED",
        mut: "#9A9A9A",
        mut2: "#5C5C5C", // decorative/numeric micro-elements only — never carries Chinese (v3.1)
        // Label colors (v3.1) — the ONLY source of non-neutral hue,
        // confined to ≤24px elements (tags/underlines/status dots/glyphs).
        "lab-red": "#FF5F56", // 俚语/危险/错误
        "lab-orange": "#FFAA44", // 习语；表达高亮下划线
        "lab-yellow": "#F7D51D", // 委婉/警示
        "lab-green": "#4ADE80", // 聆听态/成功/diff-flash
        "lab-purple": "#C084FC", // 隐喻
        "lab-cyan": "#22D3EE", // 术语；术语高亮下划线
        act: "#FFFFFF", // sole accent: primary button, white-bg/black-text
        // warn *text* tier (docs/DESIGN.md v3.1 rule 3): fills use
        // lab-red on small elements only; warn-colored text uses this
        // AA-safe softer red. (Migration-era acc/acc2/gold/warn aliases
        // are retired — no component references remain.)
        "warn-soft": "#FF8A80",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        // Monospace is the brand identity in v3 (docs/DESIGN.md v3.2):
        // JetBrains Mono, self-hosted via next/font in layout.tsx as
        // --font-mono-brand, falling back to native monospace stacks.
        mono: ["var(--font-mono-brand)", "SF Mono", "Menlo", "monospace"],
        // v2's serif display face (Cinzel/Songti SC) is retired in v3 —
        // no font-display utility exists anymore. The one legitimate
        // serif survivor (CornellNote's frozen parchment artifact) pins
        // its Songti stack inline.
      },
    },
  },
  plugins: [],
} satisfies Config;
