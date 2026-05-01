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

/**
 * Single IPC call to the main process to nudge `webContents.focus()`.
 * Wrapped in try/catch + logging so a transient IPC hiccup never throws
 * out of the recovery handlers.
 */
function fireRestoreWebKeyboardFocus(source: string): void {
  try {
    const restore = window.matBeastDesktop?.restoreWebKeyboardFocus;
    if (typeof restore !== "function") return;
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
  } catch {
    /* ignore */
  }
}

/**
 * Coalesce per-tick to avoid hammering the main process with IPCs from
 * the burst of `mousedown` + `pointerdown` + `focusin` that a single
 * click on an input fires. Then issue THREE IPCs at growing delays:
 * one in the next microtask (after the click's default focus action
 * has taken effect), one at 80 ms (catches the Chromium "focus
 * applied but keyboard routing not yet wired" race after a child
 * window or modal closes), and one at 320 ms (last-resort retry for
 * the rare cases the user fixes by alt-tabbing).
 *
 * Background: `restoreWebKeyboardFocus` calls
 * `BrowserWindow.webContents.focus()`. On Windows the OS HWND can be
 * foreground while Chromium hasn't reattached its IME/keyboard route
 * to the renderer view; a single `focus()` call sometimes lands too
 * early (before the underlying ViewHost is ready) and the next typed
 * key still goes nowhere. Repeating the call at increasing delays
 * costs almost nothing — each call is a single IPC + one Win32 call —
 * but reliably catches the late-binding case the user keeps hitting
 * sporadically.
 */
function nudgeElectronWebContentsKeyboardRouting(source: string): void {
  if (typeof window === "undefined") return;
  if (typeof window.matBeastDesktop?.restoreWebKeyboardFocus !== "function") {
    return;
  }
  if (electronKeyboardNudgeQueued) {
    matbeastFocusLog("keyboard-nudge coalesced (same tick)", { source });
    return;
  }
  electronKeyboardNudgeQueued = true;
  matbeastFocusLog("keyboard-nudge scheduled", { source });
  queueMicrotask(() => {
    electronKeyboardNudgeQueued = false;
    fireRestoreWebKeyboardFocus(`${source}:tick0`);
  });
  window.setTimeout(() => {
    fireRestoreWebKeyboardFocus(`${source}:tick80`);
  }, 80);
  window.setTimeout(() => {
    fireRestoreWebKeyboardFocus(`${source}:tick320`);
  }, 320);
}

function isLikelyEditableInteractionTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.closest("[data-matbeast-rename-dialog]")) return true;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  return false;
}

function isTextEditableElement(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type.toLowerCase();
    return (
      type === "" ||
      type === "text" ||
      type === "search" ||
      type === "url" ||
      type === "email" ||
      type === "tel" ||
      type === "password" ||
      type === "number"
    );
  }
  return el.isContentEditable;
}

/**
 * v1.2.5 dead-key recovery.
 *
 * Background: even with `restoreWebKeyboardFocus` firing on pointerdown,
 * users still occasionally hit the "I clicked the input, it visually
 * focused, but my keystrokes go nowhere until I Alt-Tab" bug. The user
 * report from v1.2.4 confirmed it's NOT just child-window/modal close
 * paths — it also happens after a normal sequence of native `<select>`
 * dropdown + button clicks, before clicking an input. Two changes:
 *
 *   1. Track the most recent editable element the user actually
 *      clicked. When a printable keystroke later fires on document /
 *      body / a non-editable element (the smoking gun for "Chromium
 *      lost the input"), refocus that element AND nudge keyboard
 *      routing. This is the actual rescue path so the user does not
 *      have to Alt-Tab.
 *   2. Nudge on EVERY `pointerdown`, not just on editable targets.
 *      Native `<select>` interactions and button presses can leave
 *      Windows keyboard routing in a half-bound state where the next
 *      input click visually focuses but the keys never arrive; firing
 *      a `webContents.focus()` after each interaction prevents the
 *      half-bound state from accumulating.
 */
let lastClickedEditable: WeakRef<HTMLElement> | null = null;

function rememberClickedEditable(target: EventTarget | null): void {
  if (!(target instanceof HTMLElement)) return;
  const editable = target.closest("input, textarea, [contenteditable=''], [contenteditable='true']");
  if (editable instanceof HTMLElement && isTextEditableElement(editable)) {
    lastClickedEditable = new WeakRef(editable);
  }
}

function rescueDeadKeyboardKeystroke(e: KeyboardEvent): void {
  // Only rescue printable single-character keys (the user is trying to type).
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key.length !== 1) return;
  if (isTextEditableElement(document.activeElement)) return;
  const target = lastClickedEditable?.deref();
  if (!target || !target.isConnected) return;
  matbeastFocusLog("dead-keystroke detected", {
    key: e.key,
    activeElement: activeElementHint(),
    rescuingTarget: `${target.tagName}${target.id ? `#${target.id}` : ""}`,
  });
  try {
    target.focus();
  } catch {
    /* ignore */
  }
  nudgeElectronWebContentsKeyboardRouting("dead-keystroke");
}

let installed = false;

export function installMatbeastPanelPointerRecovery(): void {
  if (typeof document === "undefined" || installed) return;
  installed = true;

  const recover = () => {
    releaseSeparatorPointerCaptures();
  };

  /**
   * Always nudge on pointerdown regardless of target. Three IPCs
   * (microtask + 80 ms + 320 ms) per click is cheap and keeps Windows
   * keyboard routing fresh after every interaction. Editable targets
   * additionally remember themselves for the dead-keystroke rescue.
   */
  const onPointerDown = (e: Event) => {
    recover();
    rememberClickedEditable(e.target);
    nudgeElectronWebContentsKeyboardRouting(e.type);
  };

  document.addEventListener("mousedown", onPointerDown, true);
  document.addEventListener("touchstart", onPointerDown, true);
  document.addEventListener("pointerdown", onPointerDown, true);

  /**
   * Native `<select>` dropdowns on Windows show an OS-level popup that
   * temporarily steals keyboard routing from Chromium. After the user
   * picks an item the popup closes and `change` fires. Nudge so the
   * next input click does not land in the half-bound state.
   */
  document.addEventListener(
    "change",
    (e) => {
      if (e.target instanceof HTMLSelectElement) {
        nudgeElectronWebContentsKeyboardRouting("select-change");
      }
    },
    true,
  );

  /**
   * Last-resort rescue: a printable key reached document / body
   * instead of a focused input. Refocus the most recently clicked
   * editable and nudge so the user does not have to Alt-Tab.
   */
  document.addEventListener("keydown", rescueDeadKeyboardKeystroke, true);

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
  document.addEventListener(
    "focusin",
    (e) => {
      if (!isLikelyEditableInteractionTarget(e.target)) return;
      recover();
      rememberClickedEditable(e.target);
      nudgeElectronWebContentsKeyboardRouting(e.type);
    },
    true,
  );
}
