"use client";

import { useEffect } from "react";

/**
 * Catches errors thrown in the root layout (above route segments). Without
 * this, layout-level throws fall through to Next's generic
 * "Application error: a client-side exception has occurred" shell with no
 * actionable detail. We surface the real `error.message` and POST a
 * structured report to /api/diagnostics/client-error so it lands in
 * bundled-server.log alongside the rest of the app's diagnostics.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    try {
      void fetch("/api/diagnostics/client-error", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "global-error",
          message: error?.message ?? String(error),
          stack: error?.stack ?? null,
          digest: error?.digest ?? null,
          href:
            typeof window !== "undefined" ? window.location.href : null,
          ua: typeof navigator !== "undefined" ? navigator.userAgent : null,
          when: new Date().toISOString(),
        }),
        keepalive: true,
      });
    } catch {
      /* ignore — best-effort report */
    }
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          backgroundColor: "#0a0a0a",
          color: "#f4f4f5",
          margin: 0,
          minHeight: "100vh",
          fontFamily: "system-ui, sans-serif",
          padding: "2rem",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.75rem",
          textAlign: "center",
        }}
      >
        <p
          style={{
            fontSize: 12,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "#fde68a",
            margin: 0,
          }}
        >
          Application error
        </p>
        <pre
          style={{
            maxHeight: "40vh",
            maxWidth: "100%",
            overflow: "auto",
            border: "1px solid #3f3f46",
            borderRadius: 4,
            backgroundColor: "rgba(24,24,27,0.85)",
            padding: 12,
            fontSize: 12,
            color: "#fecaca",
            textAlign: "left",
            whiteSpace: "pre-wrap",
          }}
        >
          {error?.message ?? "(no message)"}
        </pre>
        {error?.digest ? (
          <p style={{ fontSize: 10, color: "#71717a", margin: 0 }}>
            Digest: {error.digest}
          </p>
        ) : null}
        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: 8,
            padding: "0.4rem 0.9rem",
            border: "1px solid #52525b",
            borderRadius: 4,
            backgroundColor: "transparent",
            color: "#e4e4e7",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
