/**
 * Scoreboard + bracket output: two windows (Electron) or two popups (browser dev).
 * Dashboard preview uses `/overlay?preview=1` only — not these URLs.
 */
const BROWSER_SB_NAME = "MATBEAST_OVERLAY_SCOREBOARD";
const BROWSER_BR_NAME = "MATBEAST_OVERLAY_BRACKET";

let browserScoreboardRef: Window | null = null;
let browserBracketRef: Window | null = null;

/** @returns true if overlay output was requested (Electron) or popups opened (browser). */
export function openScoreboardOverlayWindow(): boolean {
  if (typeof window === "undefined") return false;

  const desktop = window.matBeastDesktop;
  if (desktop?.openScoreboardOverlayWindow) {
    void desktop.openScoreboardOverlayWindow();
    return true;
  }

  const opts = "popup=yes,width=1920,height=1080";
  if (!browserScoreboardRef || browserScoreboardRef.closed) {
    browserScoreboardRef = window.open(
      "/overlay?outputScene=scoreboard",
      BROWSER_SB_NAME,
      opts,
    );
  } else {
    try {
      browserScoreboardRef.focus();
    } catch {
      browserScoreboardRef = null;
    }
  }
  if (!browserBracketRef || browserBracketRef.closed) {
    browserBracketRef = window.open(
      "/overlay?outputScene=bracket",
      BROWSER_BR_NAME,
      opts,
    );
  } else {
    try {
      browserBracketRef.focus();
    } catch {
      browserBracketRef = null;
    }
  }
  return Boolean(browserScoreboardRef || browserBracketRef);
}
