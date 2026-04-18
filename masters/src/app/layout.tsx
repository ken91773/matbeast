import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";

export const metadata: Metadata = {
  title: "Mat Beast Masters",
  description:
    "Shared cloud service for Mat Beast Scoreboard: master player profiles, team names, and event files.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body
          style={{
            margin: 0,
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            backgroundColor: "#0f172a",
            color: "#e2e8f0",
            minHeight: "100vh",
          }}
        >
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
