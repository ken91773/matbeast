/**
 * `react-resizable-panels` grabs pointer capture on panel separators while dragging.
 * If the drag ends over an in-app `<iframe>` (e.g. overlay preview), the parent
 * document often never receives `pointerup`, so capture stays on the separator
 * and **clicks never reach inputs** until the app restarts.
 *
 * Release capture on separators before editable controls receive `mousedown`,
 * and again when the window regains activation so a stuck drag cannot strand
 * the operator.
 *
 * **Electron / Windows:** the HWND can be foreground while Chromium never routes
 * keyboard events (every `<input>` looks focused but keys are dead until Alt+Tab).
 * After releasing separator capture, defer `restoreWebKeyboardFocus` (main-process
 * `webContents.focus()` without the `focusMainWindow` race on pointerdown).
 */

import { matbeastFocusLog } from "@/lib/matbeast-focus-debug";

const SEPARATOR_SELECTOR =
  '[role="separator"][data-separator]:not([data-separator="disabled"])';

function releaseSeparatorPointerCaptures() {
  for (const el of document.querySelectorAll(SEPARATOR_SELECTOR)) {
    if (!(el instanceof HTMLElement)) continue;
    for (let id = 0; id <= 32; id++) {
      try {
        if (el.hasPointerCapture?.(id)) {
          el.releasePointerCapture(id);
        }
      } catch {
        /* hasPointerCapture / releasePointerCapture may throw */
      }
    }
  }
}

let electronKeyboardNudgeQueued = false;

function activeElementHint(): string {
  const ae = document.activeElement;
  if (!(ae instanceof HTMLElement)) return String(ae);
  const id = ae.id ? `#${ae.id}` : "";
  return `${ae.tagName}${id}`;
}

/** Coalesce to one IPC per tick; run after browser default focus into the field. */
function nudgeElectronWebContentsKeyboardRouting(source: string): void {
  if (typeof window === "undefined") return;
  try {
    const restore = window.matBeastDesktop?.restoreWebKeyboardFocus;
    if (typeof restore !== "function") return;
    if (electronKeyboardNudgeQueued) {
      matbeastFocusLog("keyboard-nudge coalesced (same tick)", { source });
      return;
    }
    electronKeyboardNudgeQueued = true;
    matbeastFocusLog("keyboard-nudge scheduled", { source });
    queueMicrotask(() => {
      electronKeyboardNudgeQueued = false;
      matbeastFocusLog("keyboard-nudge → restoreWebKeyboardFocus()", {
        source,
        activeElement: activeElementHint(),
      });
      void restore()
        .then(() => {
          matbeastFocusLog("keyboard-nudge restoreWebKeyboardFocus settled", {
            source,
          });
        })
        .catch((err: unknown) => {
          matbeastFocusLog("keyboard-nudge restoreWebKeyboardFocus rejected", {
            source,
            err: err instanceof Error ? err.message : String(err),
          });
        });
    });
  } catch {
    electronKeyboardNudgeQueued = false;
  }
}

function isLikelyEditableInteractionTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.closest("[data-matbeast-rename-dialog]")) return true;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  return false;
}

let installed = false;

export function installMatbeastPanelPointerRecovery(): void {
  if (typeof document === "undefined" || installed) return;
  installed = true;

  const recover = () => {
    releaseSeparatorPointerCaptures();
  };

  const recoverAndNudgeKeyboard = (e: Event) => {
    if (!isLikelyEditableInteractionTarget(e.target)) return;
    recover();
    nudgeElectronWebContentsKeyboardRouting(e.type);
  };

  /** Run before default actions so a captured separator cannot swallow the click. */
  document.addEventListener("mousedown", recoverAndNudgeKeyboard, true);

  document.addEventListener("touchstart", recoverAndNudgeKeyboard, true);

  document.addEventListener("pointerdown", recoverAndNudgeKeyboard, true);

  window.addEventListener("focus", () => {
    recover();
    nudgeElectronWebContentsKeyboardRouting("window-focus");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      recover();
      nudgeElectronWebContentsKeyboardRouting("visibility-visible");
    }
  });

  /** Tab navigation into a field should not lose the first keypress to a stuck separator. */
  document.addEventListener("focusin", recoverAndNudgeKeyboard, true);
}
