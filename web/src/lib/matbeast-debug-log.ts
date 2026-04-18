/**
 * Temporary debug logging for Electron + browser.
 *
 * Enable in the dashboard window DevTools console, then reload:
 *   localStorage.setItem("matbeastDebug", "1")
 * Disable:
 *   localStorage.removeItem("matbeastDebug")
 *
 * Focus / keyboard routing (separate flag, same reload pattern):
 *   localStorage.setItem("matbeastFocusDebug", "1")
 *   localStorage.removeItem("matbeastFocusDebug")
 *
 * Main-process logs (file menu injection, etc.) use env when launching:
 *   MATBEAST_DEBUG=1
 * (PowerShell: `$env:MATBEAST_DEBUG="1"; npm run desktop` or your start command.)
 */

const STORAGE_KEY = "matbeastDebug";

export function isMatbeastDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function matbeastDebugLog(scope: string, ...args: unknown[]): void {
  if (!isMatbeastDebugEnabled()) return;
  console.debug(`[matbeast] [${scope}]`, ...args);
}
