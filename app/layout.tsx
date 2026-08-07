import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";

import "./globals.css";

/*
 * Fonts are fetched at build time by `next/font` and served from this origin,
 * so the running page makes no third-party request — which is also why the
 * Content-Security-Policy in `next.config.ts` can keep `font-src` at 'self'.
 */
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], display: "swap", variable: "--font-jbmono" });
const grotesk = Space_Grotesk({ subsets: ["latin"], display: "swap", variable: "--font-grotesk" });

export const metadata: Metadata = {
  title: "Ryntra Guard for Arc — Decision & Settlement Evidence",
  description:
    "Preflight programmable-money intents, preserve human authorization, reconcile Arc Testnet settlement and produce a structured Execution Receipt.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} ${grotesk.variable}`}>
      <body>{children}</body>
    </html>
  );
}
