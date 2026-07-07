import type { Metadata, Viewport } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { withBase } from "@/lib/basePath";
import { buildFoucScript } from "@/lib/theme/displayStorage";
import { BUILTIN_THEMES } from "@/lib/theme/themes";

// v3 主题基座:暗黑科技 · 会议 REPL (docs/DESIGN.md v3.2) — monospace is
// the brand identity: JetBrains Mono, self-hosted at build time (no
// runtime external request) as --font-mono-brand. Retires v2's
// brand-position-only Cinzel serif; the Cornell parchment artifact
// pins its own Songti serif stack inline.
const jetbrainsMono = JetBrains_Mono({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-mono-brand",
  display: "swap",
});

export const metadata: Metadata = {
  title: "JargonSlayer · 英文会议实时理解助手",
  description:
    "英文会议实时转录，即时解释商务俚语、隐喻和专有名词，帮你听懂每一句。",
  manifest: withBase("/manifest.webmanifest"),
  appleWebApp: {
    capable: true,
    title: "JargonSlayer",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#0A0A0A",
  width: "device-width",
  initialScale: 1,
};

// v0.2.1 anti-FOUC: theme/data-fs are set synchronously (before first
// paint) by the inline <head> script below, reading the localStorage
// mirror lib/theme/displayStorage.ts's store.ts hook keeps up to date
// — next-themes-style pattern, hand-rolled (no third-party theme
// library; the mechanism is this one small script + apply.ts's
// setProperty calls, not worth a dependency). Built at module scope
// (not per-request) since BUILTIN_THEMES is a static compile-time
// registry.
const foucScript = buildFoucScript(BUILTIN_THEMES);

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning: the inline script below sets
    // data-theme/data-fs (and possibly inline --token style overrides)
    // before React hydrates, so the server-rendered attributes
    // legitimately differ from the client's first paint — this is the
    // same tradeoff next-themes documents for its own suppressHydrationWarning.
    <html
      lang="zh-CN"
      data-theme="terminal"
      data-scheme="dark"
      className={jetbrainsMono.variable}
      suppressHydrationWarning
    >
      <head>
        {/* Must run synchronously before paint — deferring would defeat
            the anti-FOUC purpose. */}
        <script dangerouslySetInnerHTML={{ __html: foucScript }} />
      </head>
      <body className="font-sans">{children}</body>
    </html>
  );
}
