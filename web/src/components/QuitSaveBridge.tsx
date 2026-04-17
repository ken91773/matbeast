"use client";

import { useEventWorkspace } from "@/components/EventWorkspaceProvider";
import {
  hasUnsavedAmongOpenTabs,
  isTournamentDirty,
  subscribeDocumentDirty,
} from "@/lib/matbeast-document-dirty";
import { matbeastSaveTabById } from "@/lib/matbeast-dashboard-file-actions";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

declare global {
  interface Window {
    __MATBEAST_HAS_UNSAVED_CHANGES__?: boolean;
    __MATBEAST_SAVE_BEFORE_QUIT__?: () => Promise<boolean>;
  }
}

/**
 * Exposes quit/save probes for the Electron main window (`executeJavaScript`) and
 * keeps `__MATBEAST_HAS_UNSAVED_CHANGES__` in sync with open tabs + dirty set.
 */
export function QuitSaveBridge() {
  const queryClient = useQueryClient();
  const { openTabs, selectTab } = useEventWorkspace();
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;

  useEffect(() => {
    const syncFlag = () => {
      const ids = openTabsRef.current.map((t) => t.id);
      window.__MATBEAST_HAS_UNSAVED_CHANGES__ = hasUnsavedAmongOpenTabs(ids);
    };

    syncFlag();
    return subscribeDocumentDirty(syncFlag);
  }, [openTabs]);

  useEffect(() => {
    window.__MATBEAST_SAVE_BEFORE_QUIT__ = async () => {
      const tabs = openTabsRef.current;
      const dirtyTabs = tabs.filter((t) => isTournamentDirty(t.id));
      if (dirtyTabs.length === 0) return true;
      for (const t of dirtyTabs) {
        selectTab(t.id);
        const ok = await matbeastSaveTabById(
          queryClient,
          selectTab,
          () => openTabsRef.current,
          t.id,
        );
        if (!ok) return false;
      }
      return true;
    };
    return () => {
      delete window.__MATBEAST_SAVE_BEFORE_QUIT__;
      delete window.__MATBEAST_HAS_UNSAVED_CHANGES__;
    };
  }, [queryClient, selectTab]);

  return null;
}
