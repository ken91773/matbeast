"use client";

import { installMatbeastFocusDebugListeners } from "@/lib/matbeast-focus-debug";
import { useEffect } from "react";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type?.toLowerCase() ?? "text";
    if (
      type === "button" ||
      type === "submit" ||
      type === "reset" ||
      type === "checkbox" ||
      type === "radio" ||
      type === "file" ||
      type === "color" ||
      type === "range" ||
      type === "image"
    ) {
      return false;
    }
    return true;
  }
  return target.isContentEditable;
}

/**
 * Desktop: ensure the main BrowserWindow receives OS focus when the user
 * points at a text field so keystrokes route to Chromium reliably after
 * switching apps or opening overlay windows.
 *
 * Also installs optional focus debug listeners (localStorage matbeastFocusDebug).
 */
export function MatBeastFocusAndInputBridge() {
  useEffect(() => {
    installMatbeastFocusDebugListeners();
  }, []);

  useEffect(() => {
    const desk = typeof window !== "undefined" ? window.matBeastDesktop : undefined;
    if (!desk?.focusMainWindow) return;

    const onPointerDown = (e: PointerEvent) => {
      if (!isEditableTarget(e.target)) return;
      void desk.focusMainWindow?.();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  return null;
}
