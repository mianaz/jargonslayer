import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "JargonSlayer · 英文会议实时理解助手",
  description:
    "实时转录英文会议，即时解释商务俚语、隐喻和专有名词，为非母语者设计。",
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
    <html lang="zh-CN">
      <body className="font-sans">{children}</body>
    </html>
  );
}
