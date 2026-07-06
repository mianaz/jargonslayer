import type { Metadata, Viewport } from "next";
import { Cinzel } from "next/font/google";
import "./globals.css";

// Brand-position-only display face (v2.2): self-hosted at build time,
// no runtime external request. Applied via font-display in Tailwind —
// never on body/buttons/forms.
const cinzel = Cinzel({
  weight: ["600", "700"],
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "JargonSlayer · 英文会议实时理解助手",
  description:
    "英文会议实时转录，即时解释商务俚语、隐喻和专有名词，帮你听懂每一句。",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "JargonSlayer",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#07090E",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className={cinzel.variable}>
      <body className="font-sans">{children}</body>
    </html>
  );
}
