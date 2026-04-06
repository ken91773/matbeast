import "@fontsource/bebas-neue/400.css";
import type { ReactNode } from "react";

/** Self-hosted font avoids next/font Google fetch failures (common cause of overlay 500s). */
export default function OverlayLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="min-h-screen"
      style={{ fontFamily: '"Bebas Neue", system-ui, sans-serif' }}
    >
      {children}
    </div>
  );
}
