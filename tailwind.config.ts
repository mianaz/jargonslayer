import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Surface steps (Linear-style layering: depth via surface
        // stepping on dark UI, not shadows)
        ink: "#07090E", // page canvas (deepest)
        panel: "#10141D", // primary panels
        panel2: "#161B27", // raised: dialogs, popovers, chips
        panel3: "#1B2130", // hover/active surface step
        edge: "#232B3A", // default hairline
        edge2: "#303A4D", // strong hairline (major zone dividers)
        // Text hierarchy (3 levels)
        fg: "#E8ECF4",
        mut: "#8B95A9",
        mut2: "#667083", // faint meta (timestamps, counts)
        // Semantic accents — single responsibility each (DESIGN.md)
        acc: "#5B9DFF", // interactive only
        acchover: "#7FB2FF", // hover brightens on dark UI
        acc2: "#3ED598", // live status only
        gold: "#E5B455", // annotation signature only
        warn: "#A63D40", // stop/destructive FILLS/borders only (heraldic red, v2.3)
        "warn-soft": "#E07A7D", // warn TEXT on dark panels — passes WCAG AA (~5.7:1); #A63D40 as text is only ~3:1
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
        mono: ["SF Mono", "Menlo", "Consolas", "monospace"],
        // Brand-position-only display face (v2.2): Cinzel for EN, Songti
        // SC fallback for the CJK brand position. Never used for
        // body/buttons/forms — see docs/DESIGN.md v2.2.
        display: ["var(--font-display)", "Songti SC", "STSong", "serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
