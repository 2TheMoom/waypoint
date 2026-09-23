import type { Metadata, Viewport } from "next";
import { Fjalla_One, Source_Serif_4, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const fjallaOne = Fjalla_One({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-head",
  display: "swap",
});

const sourceSerif4 = Source_Serif_4({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Waypoint",
  description: "A verified milestone escrow on GenLayer - GenVM validators independently confirm a deliverable before funds release.",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: "#101a0f",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${fjallaOne.variable} ${sourceSerif4.variable} ${jetbrainsMono.variable}`} data-scroll-behavior="smooth">
      <body>
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
