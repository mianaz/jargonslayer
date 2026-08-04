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
// UI polish train: widened from [400, 700] — 300 is for large numerals
// (globals.css's .stat-numeral), 800 is for StatusLine's mode block
// (owned by another lane; this just makes the weight AVAILABLE).
const jetbrainsMono = JetBrains_Mono({
  weight: ["300", "400", "500", "700", "800"],
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

// iOS-cloud round (固定顶部/底部 shell): the iOS build pins the visual
// viewport shut — pinch/double-tap zoom pans the WHOLE page (header and
// status bar drift off-screen), the single most webby gesture the shell
// can exhibit. App-provided display scale (data-fs) is the zoom story
// there instead, same as any native app. viewportFit "cover" is what
// makes env(safe-area-inset-bottom) report the real home-indicator
// inset (page.tsx's iOS spacer under StatusLine consumes it) — the
// webview is already full-bleed to the screen's bottom edge; without
// cover, env() just reads 0 and the bar sits under the indicator.
// Web/desktop keep the exact pre-round viewport (zoom stays a browser
// affordance there; NEXT_PUBLIC_IOS is read directly rather than via
// lib/platform/ios because this is a server component and that module
// is client-marked).
const IS_IOS_BUILD = process.env.NEXT_PUBLIC_IOS === "1";

export const viewport: Viewport = {
  themeColor: "#0A0A0A",
  width: "device-width",
  initialScale: 1,
  ...(IS_IOS_BUILD
    ? { maximumScale: 1, userScalable: false, viewportFit: "cover" as const }
    : {}),
};

// v0.2.1 anti-FOUC: theme/data-fs are set synchronously (before first
// paint) by the inline <head> script below, reading the localStorage
// mirror lib/theme/displayStorage.ts's store.ts hook keeps up to date
// — next-themes-style pattern, hand-rolled (no third-party theme
// library; the mechanism is this one small script + apply.ts's
// setProperty calls, not worth a dependency). Built at module scope
// (not per-request) since BUILTIN_THEMES is a static compile-time
// registry.
// iOS-cloud fix round (Opus F6b): the ios-shell class (globals.css's
// gesture/overscroll lock block) used to be stamped only by
// bootstrapIos(), which runs from page.tsx's mount effect — a cold load
// or WebKit process-recovery reload on /review (reachable from the iOS
// menu) ran with the whole gesture lock off. Stamping here rides the
// same pre-first-paint inline script as the theme, on EVERY route;
// bootstrapIos()'s own add stays as an idempotent belt.
const foucScript =
  buildFoucScript(BUILTIN_THEMES) +
  (IS_IOS_BUILD ? 'document.documentElement.classList.add("ios-shell");' : "");

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
