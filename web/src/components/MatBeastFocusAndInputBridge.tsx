"use client";

import { installMatbeastFocusDebugListeners } from "@/lib/matbeast-focus-debug";
import { installMatbeastPanelPointerRecovery } from "@/lib/matbeast-panel-pointer-recovery";
import { useEffect } from "react";

/**
 * Desktop: optional focus debug (localStorage matbeastFocusDebug).
 *
 * Windows keyboard routing (foreground window but dead keys) is handled in
 * {@link installMatbeastPanelPointerRecovery}: deferred `restoreWebKeyboardFocus`
 * on editable `pointerdown`/`mousedown`/`focusin` and on `window` `focus`, instead
 * of `focusMainWindow` on pointerdown which raced with Chromium's field focus.
 *
 * Panel pointer recovery also clears `react-resizable-panels` separator pointer capture
 * when it would otherwise strand after a drag ends over the overlay preview iframe.
 */
export function MatBeastFocusAndInputBridge() {
  useEffect(() => {
    installMatbeastFocusDebugListeners();
    installMatbeastPanelPointerRecovery();
  }, []);

  return null;
}
