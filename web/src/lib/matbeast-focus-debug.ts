/**
 * Lightweight focus / keyboard routing diagnostics.
 *
 * Enable in DevTools, then reload:
 *   localStorage.setItem("matbeastFocusDebug", "1")
 * Disable:
 *   localStorage.removeItem("matbeastFocusDebug")
 *
 * Logs: window focus/blur, document visibility, capture-phase focusin
 * (target tag), suspicious keydown (key + activeElement) when the
 * focused node is not a typical text field, and **keyboard-nudge** lines
 * whenever the app asks Electron to `restoreWebKeyboardFocus` (see
 * `matbeast-panel-pointer-recovery.ts`) — use timestamps to correlate
 * with moments typing felt dead until Alt+Tab.
 */

const STORAGE_KEY = "matbeastFocusDebug";

export function isMatbeastFocusDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function matbeastFocusLog(...args: unknown[]): void {
  if (!isMatbeastFocusDebugEnabled()) return;
  console.debug("[matbeast-focus]", ...args);
}

function isTypicalTextField(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type?.toLowerCase() ?? "text";
    return (
      type === "text" ||
      type === "search" ||
      type === "url" ||
      type === "email" ||
      type === "password" ||
      type === "tel" ||
      type === "number" ||
      type === ""
    );
  }
  return tag === "TEXTAREA" || el.isContentEditable;
}

/**
 * One-time listeners for the lifetime of the dashboard shell. Safe to call
 * on every mount; guards against duplicate installs.
 */
let installed = false;

export function installMatbeastFocusDebugListeners(): void {
  if (typeof window === "undefined" || installed) return;
  installed = true;

  window.addEventListener(
    "focus",
    () => {
      matbeastFocusLog("window focus");
    },
    false,
  );
  window.addEventListener(
    "blur",
    () => {
      matbeastFocusLog("window blur");
    },
    false,
  );
  document.addEventListener(
    "visibilitychange",
    () => {
      matbeastFocusLog("visibility", document.visibilityState);
    },
    false,
  );
  document.addEventListener(
    "focusin",
    (e) => {
      if (!isMatbeastFocusDebugEnabled()) return;
      const t = e.target;
      let hint = String(t);
      if (t instanceof HTMLElement) {
        hint = t.id ? `${t.tagName}#${t.id}` : t.tagName;
      }
      matbeastFocusLog("focusin →", hint);
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (!isMatbeastFocusDebugEnabled()) return;
      const ae = document.activeElement;
      if (isTypicalTextField(ae)) return;
      const hint =
        ae instanceof HTMLElement
          ? `${ae.tagName}${ae.id ? `#${ae.id}` : ""}`
          : String(ae);
      matbeastFocusLog("keydown (non-text field?)", e.key, "activeElement:", hint);
    },
    true,
  );
}
