"use client";

import dynamic from "next/dynamic";

const OverlayClient = dynamic(() => import("./overlay-client"), {
  ssr: false,
  loading: () => (
    <div
      className="fixed inset-0 flex items-center justify-center bg-zinc-900"
      aria-busy
      aria-label="Loading overlay"
    />
  ),
});

export function OverlayEntry() {
  return <OverlayClient />;
}
