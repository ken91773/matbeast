import type { Metadata } from "next";
import "./globals.css";
import { EventWorkspaceProvider } from "@/components/EventWorkspaceProvider";
import { MatBeastQueryProvider } from "@/components/MatBeastQueryProvider";
import RouteChromeShell from "@/components/RouteChromeShell";

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
    <html lang="en" style={{ colorScheme: "dark" }}>
      <body className="m-0 h-[100dvh] overflow-hidden antialiased">
        <MatBeastQueryProvider>
          <EventWorkspaceProvider>
            <RouteChromeShell>{children}</RouteChromeShell>
          </EventWorkspaceProvider>
        </MatBeastQueryProvider>
      </body>
    </html>
  );
}
