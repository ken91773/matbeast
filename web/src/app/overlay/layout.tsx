import "@fontsource/bebas-neue/400.css";
/** Oswald 400 = player names (non-bold), Oswald 700 = team-list team label.
 *  The team-list graphic switched from Bebas Neue to Oswald so both fields on
 *  the same line share the same typeface, differentiated only by weight. Bebas
 *  Neue is still loaded above because it remains the display face for the
 *  scoreboard graphic (timer, scores, seats, bracket callouts, etc.). */
import "@fontsource/oswald/400.css";
import "@fontsource/oswald/700.css";
import type { ReactNode } from "react";

/** Self-hosted font avoids next/font Google fetch failures (common cause of overlay 500s). */
export const dynamic = "force-dynamic";

export default function OverlayLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="min-h-screen bg-transparent"
      style={{
        fontFamily: '"Bebas Neue", system-ui, sans-serif',
        minHeight: "100vh",
        width: "100%",
        backgroundColor: "transparent",
      }}
    >
      {children}
    </div>
  );
}
