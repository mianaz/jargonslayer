import type { Metadata, Viewport } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { withBase } from "@/lib/basePath";

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

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" data-theme="terminal" className={jetbrainsMono.variable}>
      <body className="font-sans">{children}</body>
    </html>
  );
}
