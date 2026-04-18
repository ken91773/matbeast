"use client";

/**
 * Native OS menu (Electron) dispatches `matbeast-native-file` on `window`.
 * This component mounts once in the root layout so File actions work on every
 * route and window (dashboard, control full-page, overlay route, etc.), even
 * when {@link AppChrome} renders no visible header.
 */
import { useEventWorkspace } from "@/components/EventWorkspaceProvider";
import {
  matbeastBackupTabByIdToDisk,
  matbeastImportOpenedEventFile,
  matbeastOpenEventOrShowPicker,
  matbeastRestoreFromDiskToCloud,
  matbeastSaveActiveTab,
  matbeastSaveActiveTabAs,
} from "@/lib/matbeast-dashboard-file-actions";
import { matbeastDebugLog } from "@/lib/matbeast-debug-log";
import { getMatBeastTournamentId } from "@/lib/matbeast-fetch";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

export function NativeFileMenuBridge() {
  const queryClient = useQueryClient();
  const {
    openEventInTab,
    refreshTournaments,
    selectTab,
    openTabs,
    ready,
    setShowHome,
  } = useEventWorkspace();
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const ctxRef = useRef({
    runNew: async () => {},
    runOpen: async () => {},
    runOpenRecent: async (filePath: string) => {
      void filePath;
    },
    runSave: async () => {},
    runSaveAs: async () => {},
  });

  ctxRef.current = {
    runNew: async () => {
      if (!ready) {
        window.alert("Workspace is still loading. Try again in a moment.");
        return;
      }
      // The actual create call now lives in AppChrome, wrapped in a
      // dialog that collects the event title + filename up front.
      // Dispatch the open request and let AppChrome take it from
      // there.
      window.dispatchEvent(new CustomEvent("matbeast-open-new-event-dialog"));
    },
    runOpen: async () => {
      if (!ready) {
        window.alert("Workspace is still loading. Try again in a moment.");
        return;
      }
      try {
        await matbeastOpenEventOrShowPicker({
          queryClient,
          openEventInTab,
          refreshTournaments,
          openTabs,
          selectTab,
          setShowHome,
        });
      } catch (e) {
        window.alert(e instanceof Error ? e.message : "Could not open event");
      }
    },
    runOpenRecent: async (filePath: string) => {
      if (!ready) {
        window.alert("Workspace is still loading. Try again in a moment.");
        return;
      }
      const desk = typeof window !== "undefined" ? window.matBeastDesktop : undefined;
      if (!desk?.readTextFile) {
        window.alert("Open Recent is only available in the desktop app.");
        return;
      }
      const read = await desk.readTextFile(filePath);
      if (!read.ok) {
        window.alert(read.error ?? "Could not open recent file");
        return;
      }
      await matbeastImportOpenedEventFile({
        filePath,
        text: read.text,
        queryClient,
        openEventInTab,
        refreshTournaments,
        openTabs,
        selectTab,
        setShowHome,
      });
    },
    runSave: async () => {
      if (!ready) return;
      await matbeastSaveActiveTab({
        queryClient,
        selectTab,
        getOpenTabs: () => openTabsRef.current,
      });
    },
    runSaveAs: async () => {
      if (!ready) return;
      await matbeastSaveActiveTabAs({
        queryClient,
        selectTab,
        getOpenTabs: () => openTabsRef.current,
      });
    },
  };

  useEffect(() => {
    const fn = (e: Event) => {
      const d = (e as CustomEvent<{ source?: string; action?: string; filePath?: string }>)
        .detail;
      if (!d || d.source !== "menu" || typeof d.action !== "string") return;
      matbeastDebugLog("native-file-menu", "event", d.action, {
        ready: readyRef.current,
        tabCount: openTabsRef.current.length,
      });
      const h = ctxRef.current;
      if (d.action === "new") void h.runNew();
      else if (d.action === "open" || d.action === "load") void h.runOpen();
      else if (d.action === "openRecent" && typeof d.filePath === "string") {
        void h.runOpenRecent(d.filePath);
      }
      else if (d.action === "save") void h.runSave();
      else if (d.action === "saveAs") {
        void h.runSaveAs();
      } else if (d.action === "backupToDisk") {
        void (async () => {
          if (!readyRef.current) {
            window.alert("Workspace is still loading. Try again in a moment.");
            return;
          }
          const tid = getMatBeastTournamentId();
          if (!tid) {
            window.alert("Open or create an event before backing up.");
            return;
          }
          const wrote = await matbeastBackupTabByIdToDisk({
            queryClient,
            selectTab,
            getOpenTabs: () => openTabsRef.current,
            tabId: tid,
          });
          if (wrote) {
            matbeastDebugLog("native-file-menu", "backupToDisk", "ok", tid);
          }
        })();
      } else if (d.action === "openCloud") {
        window.dispatchEvent(new CustomEvent("matbeast-cloud-open-dialog"));
      } else if (d.action === "uploadCloud") {
        window.dispatchEvent(new CustomEvent("matbeast-cloud-upload-dialog"));
      } else if (d.action === "home") {
        // Show the cloud catalog without closing any open tabs.
        setShowHome(true);
      } else if (d.action === "dashboard") {
        // Return to the last-active event tab.
        setShowHome(false);
      } else if (d.action === "restoreFromDisk") {
        void (async () => {
          if (!readyRef.current) {
            window.alert("Workspace is still loading. Try again in a moment.");
            return;
          }
          try {
            await matbeastRestoreFromDiskToCloud({
              queryClient,
              openEventInTab,
              refreshTournaments,
            });
          } catch (e) {
            window.alert(e instanceof Error ? e.message : "Restore failed");
          }
        })();
      }
    };
    window.addEventListener("matbeast-native-file", fn);
    return () => window.removeEventListener("matbeast-native-file", fn);
  }, []);

  return null;
}
