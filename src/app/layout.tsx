import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AutoTube Studio — YouTube Video Automation",
  description: "Rewrite any YouTube transcript into an original, copyright-safe script with AI. Voiceover, AI images and video assembly coming in later phases.",
  keywords: ["YouTube automation", "script rewriter", "transcript paraphrase", "AI video", "voiceover"],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "AutoTube Studio — YouTube Video Automation",
    description: "Rewrite any YouTube transcript into an original, copyright-safe script with AI.",
    siteName: "AutoTube Studio",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
