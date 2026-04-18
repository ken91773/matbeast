/**
 * Renderer-side mirror of `electron/matbeast-variant.js`.
 *
 * The preload script exposes the build variant to the renderer as
 * `window.matBeastDesktop.variant`. This module is a thin wrapper
 * so React components (a) get a typed value, (b) keep working in
 * SSR/Node by returning "production" when `window` is undefined,
 * and (c) degrade to "production" when running under a future web
 * build that doesn't ship the desktop bridge at all.
 *
 * Call this sparingly. It's sync and cheap but returning different
 * values across branches can cause React hydration mismatches if a
 * server-rendered component trees on variant. We have no SSR for
 * the dashboard (it's a full client component) so the risk is
 * contained, but keep non-desktop fallbacks consistent with
 * production behaviour.
 */

export type MatbeastVariant = "production" | "demo";

export function getMatbeastVariant(): MatbeastVariant {
  if (typeof window === "undefined") return "production";
  const desk = (window as unknown as { matBeastDesktop?: { variant?: string } })
    .matBeastDesktop;
  return desk?.variant === "demo" ? "demo" : "production";
}

export function isMatbeastDemo(): boolean {
  return getMatbeastVariant() === "demo";
}
