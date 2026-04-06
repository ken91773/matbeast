import type { Metadata } from "next";
import "./globals.css";
import DesktopTabMenu from "@/components/DesktopTabMenu";

export const metadata: Metadata = {
  title: "Mat Beast Scoreboard",
  description: "Jiu-jitsu Quintet scoreboard and tournament control",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <DesktopTabMenu />
        {children}
      </body>
    </html>
  );
}
