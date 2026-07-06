import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0A0D13",
        panel: "#10141D",
        panel2: "#161B27",
        edge: "#232B3A",
        fg: "#E8ECF4",
        mut: "#8B95A9",
        acc: "#5B9DFF",
        acc2: "#3ED598",
        gold: "#E5B455",
        warn: "#E06C75",
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
      },
    },
  },
  plugins: [],
} satisfies Config;
