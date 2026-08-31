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
  title: "AutoTube Studio · Autopilot — Script to Finished Video",
  description:
    "Paste a script and the autopilot agent does everything else: rewrite, voiceover, Flow-Studio image prompts, batch image generation and full video editing — zero API keys.",
  keywords: [
    "video automation",
    "faceless video",
    "YouTube automation",
    "AI video editor",
    "text to video",
    "autotube"
  ],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "AutoTube Studio · Autopilot — Script to Finished Video",
    description:
      "One script in, one finished MP4 out. Fully automated pipeline: rewrite → voiceover → Flow-Studio prompts → images → video.",
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
