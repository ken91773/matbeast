"use client";

import { useEventWorkspace } from "@/components/EventWorkspaceProvider";
import {
  hasUnsavedAmongOpenTabs,
  isTournamentDirty,
  subscribeDocumentDirty,
} from "@/lib/matbeast-document-dirty";
import {
  matbeastSaveTabById,
  writeOfflineBackupForTournament,
} from "@/lib/matbeast-dashboard-file-actions";
import {
  getPendingSyncCount,
  retrySyncNow,
  subscribePendingSync,
} from "@/lib/matbeast-sync-coordinator";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

declare global {
  interface Window {
    __MATBEAST_HAS_UNSAVED_CHANGES__?: boolean;
    __MATBEAST_SAVE_BEFORE_QUIT__?: () => Promise<boolean>;
    /** Count of cloud-linked events with local edits not yet on the cloud. */
    __MATBEAST_PENDING_SYNC_COUNT__?: number;
    /**
     * Close-time flush used by the main process "Wait for sync" option:
     * pushes every dirty open tab (incl. first-time auto-link uploads),
     * then drains the durable pending queue. Resolves with whether
     * everything synced and how many events remain pending.
     */
    __MATBEAST_FLUSH_PENDING_SYNC__?: () => Promise<{
      synced: boolean;
      remaining: number;
    }>;
    /**
     * Close-time local backup used by the main process "Save backup & close"
     * option: writes a `.matb` backup of every dirty open tab to the default
     * Events folder. Resolves with how many backups were written and the last
     * error (if any).
     */
    __MATBEAST_BACKUP_BEFORE_QUIT__?: () => Promise<{
      ok: boolean;
      count: number;
      lastError?: string;
    }>;
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

  /**
   * Mirror the background sync coordinator's pending count onto a window
   * global so the Electron main process can read it synchronously when
   * deciding whether to warn on quit.
   */
  useEffect(() => {
    window.__MATBEAST_PENDING_SYNC_COUNT__ = getPendingSyncCount();
    const unsub = subscribePendingSync((n) => {
      window.__MATBEAST_PENDING_SYNC_COUNT__ = n;
    });
    return () => {
      unsub();
      delete window.__MATBEAST_PENDING_SYNC_COUNT__;
    };
  }, []);

  useEffect(() => {
    window.__MATBEAST_FLUSH_PENDING_SYNC__ = async () => {
      // 1. Push every dirty open tab — this also performs first-time
      //    auto-link uploads for events that were never on the cloud.
      let savedAll = true;
      try {
        savedAll = window.__MATBEAST_SAVE_BEFORE_QUIT__
          ? await window.__MATBEAST_SAVE_BEFORE_QUIT__()
          : true;
      } catch {
        savedAll = false;
      }
      // 2. Drain the durable pending queue (linked events that may be
      //    closed or in the background), probing the cloud first.
      try {
        await retrySyncNow();
      } catch {
        /* retrySyncNow never throws, but stay defensive */
      }
      const remaining = getPendingSyncCount();
      return { synced: savedAll && remaining === 0, remaining };
    };
    return () => {
      delete window.__MATBEAST_FLUSH_PENDING_SYNC__;
    };
  }, []);

  useEffect(() => {
    window.__MATBEAST_BACKUP_BEFORE_QUIT__ = async () => {
      const targets = openTabsRef.current.filter((t) =>
        isTournamentDirty(t.id),
      );
      if (targets.length === 0) return { ok: true, count: 0 };
      let count = 0;
      let lastError: string | undefined;
      for (const t of targets) {
        try {
          const res = await writeOfflineBackupForTournament(
            t.id,
            t.name ?? "Untitled event",
          );
          if (res.ok) count += 1;
          else lastError = res.error ?? "backup failed";
        } catch (e) {
          lastError = e instanceof Error ? e.message : "backup failed";
        }
      }
      return { ok: count === targets.length, count, lastError };
    };
    return () => {
      delete window.__MATBEAST_BACKUP_BEFORE_QUIT__;
    };
  }, []);

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
