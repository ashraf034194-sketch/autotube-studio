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
  title: "Flow Prompt Studio — Google Flow Image Generation Console",
  description:
    "Structure, validate and orchestrate image-generation prompts for Google Flow. Intelligent prompt analysis with strict fidelity — no API keys, no separate credits.",
  keywords: [
    "Google Flow",
    "prompt engineering",
    "image generation",
    "prompt structuring",
    "AI filmmaking",
    "Flow prompt studio"
  ],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Flow Prompt Studio — Google Flow Image Generation Console",
    description:
      "Intelligent prompt analysis + structuring for Google Flow image generation. Zero API keys, compliant by design.",
    siteName: "Flow Prompt Studio",
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
