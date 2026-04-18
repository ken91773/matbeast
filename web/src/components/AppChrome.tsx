"use client";

import { useEventWorkspace } from "@/components/EventWorkspaceProvider";
import {
  matbeastBackupTabByIdToDisk,
  matbeastCreateNewEventTab,
  matbeastOpenEventOrShowPicker,
  matbeastSaveTabById,
} from "@/lib/matbeast-dashboard-file-actions";
import NewEventDialog from "@/components/NewEventDialog";
import {
  getCloudOnlineState,
  subscribeCloudOnline,
  type CloudOnlineState,
} from "@/lib/matbeast-cloud-online";
import {
  isTournamentDirty,
  subscribeDocumentDirty,
} from "@/lib/matbeast-document-dirty";
import { matbeastDebugLog } from "@/lib/matbeast-debug-log";
import { MATBEAST_TOURNAMENT_HEADER } from "@/lib/matbeast-fetch";
import { matbeastKeys } from "@/lib/matbeast-query-keys";
import { matbeastJson } from "@/lib/matbeast-query";
import {
  getDashboardRedoDepth,
  getDashboardUndoDepth,
  onDashboardUndoStackChanged,
  redoDashboardLastAction,
  undoDashboardLastAction,
} from "@/lib/dashboard-undo";
import {
  getSelectedAudioOutputId,
  setSelectedAudioOutputId,
} from "@/lib/audio-output";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardPayload } from "@/types/board";
import packageJson from "../../package.json";
import CloudSettingsModal from "@/components/CloudSettingsModal";
import CloudSyncBadge from "@/components/CloudSyncBadge";

const APP_VERSION = packageJson.version;

export default function AppChrome() {
  const queryClient = useQueryClient();
  const {
    tournamentId,
    ready,
    openTabs,
    tournaments,
    refreshTournaments,
    openEventInTab,
    selectTab,
    closeTab,
    updateTabName,
  } = useEventWorkspace();

  const openTabsRef = useRef(openTabs);
  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  const [openPicker, setOpenPicker] = useState(false);
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
  const [undoBusy, setUndoBusy] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * When the user closes a tab with unsynced changes while the cloud
   * is unreachable, we show a dialog offering to back the tab up to
   * disk before the tab is destroyed. `tabId` identifies the pending
   * close; `tabName` is cached so the dialog can render a helpful
   * title even after the tab is gone. `working` blocks double-submit
   * while the disk write is in flight.
   */
  const [offlineCloseState, setOfflineCloseState] = useState<
    | {
        tabId: string;
        tabName: string;
        working: boolean;
      }
    | null
  >(null);

  /**
   * "Create new event" dialog state. Opened by both the File ▸ New
   * event menu item (via `matbeast-open-new-event-dialog`) and the
   * homepage "Create new event" button. Keeping the dialog here
   * rather than inside each caller means we have a single place that
   * owns the create call and its dependencies (queryClient, the
   * `openEventInTab`/`refreshTournaments` context, etc.).
   */
  const [newEventDialogOpen, setNewEventDialogOpen] = useState(false);
  const [creatingNewEvent, setCreatingNewEvent] = useState(false);

  // Keep a live copy of the global online signal so `requestCloseTab`
  // can make its decision synchronously.
  const cloudOnlineRef = useRef<CloudOnlineState>(getCloudOnlineState());
  useEffect(() => {
    return subscribeCloudOnline((s) => {
      cloudOnlineRef.current = s;
    });
  }, []);

  /**
   * Close-tab flow no longer shows a save-before-close modal. The
   * cloud is authoritative, so we just fire a silent cloud save
   * before tearing down the tab (same envelope as an autosave).
   */
  /**
   * Unified rename dialog state. Holds separate drafts for the human
   * event title (shown as the tab label) and the filename (shown to
   * the right of the tab label + used as the cloud catalog filename).
   * `focusField` tells the dialog which input to autofocus so the
   * user lands directly in whichever field they double-clicked.
   */
  const [renameState, setRenameState] = useState<
    | {
        tabId: string;
        eventNameDraft: string;
        filenameDraft: string;
        initialEventName: string;
        initialFilename: string;
        focusField: "eventName" | "filename";
      }
    | null
  >(null);
  const [audioOutputPickerOpen, setAudioOutputPickerOpen] = useState(false);
  const [cloudSettingsOpen, setCloudSettingsOpen] = useState(false);
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputSelected, setAudioOutputSelected] = useState("default");
  const [autoSaveEvery5Minutes, setAutoSaveEvery5Minutes] = useState(false);
  const [saveFeedbackText, setSaveFeedbackText] = useState<string | null>(null);
  const [saveFeedbackTone, setSaveFeedbackTone] = useState<"saving" | "saved" | "error">(
    "saving",
  );
  const saveFeedbackTimeoutRef = useRef<number | null>(null);
  const [updateStatus, setUpdateStatus] = useState<{
    status: string;
    message: string;
    downloadedVersion: string | null;
  } | null>(null);
  const [updateInstallBusy, setUpdateInstallBusy] = useState(false);
  const [updatePromptDismissed, setUpdatePromptDismissed] = useState(false);
  const updateUpToDateTimeoutRef = useRef<number | null>(null);

  const desktopApi = typeof window !== "undefined" ? window.matBeastDesktop : undefined;

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = `Mat Beast Scoreboard v${APP_VERSION}`;
  }, []);

  useEffect(() => {
    setAudioOutputSelected(getSelectedAudioOutputId());
  }, []);

  const refreshAudioOutputs = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      setAudioOutputDevices([]);
      return;
    }
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setAudioOutputDevices(all.filter((d) => d.kind === "audiooutput"));
    } catch {
      setAudioOutputDevices([]);
    }
  }, []);

  /** Web: native menu asks the chrome layer to show the server event picker. */
  useEffect(() => {
    const onPicker = () => setOpenPicker(true);
    window.addEventListener("matbeast-open-picker-request", onPicker);
    return () => window.removeEventListener("matbeast-open-picker-request", onPicker);
  }, []);

  useEffect(() => {
    const onOptionsMenu = (e: Event) => {
      const d = (e as CustomEvent<{ source?: string; action?: string; enabled?: boolean }>).detail;
      if (!d || d.source !== "menu") return;
      if (d.action === "autosave-5m") {
        setAutoSaveEvery5Minutes(Boolean(d.enabled));
        return;
      }
      if (d.action === "cloud") {
        setCloudSettingsOpen(true);
        return;
      }
      if (d.action !== "audio-output") return;
      setAudioOutputSelected(getSelectedAudioOutputId());
      void refreshAudioOutputs();
      setAudioOutputPickerOpen(true);
    };
    window.addEventListener("matbeast-native-options", onOptionsMenu);
    return () => window.removeEventListener("matbeast-native-options", onOptionsMenu);
  }, [refreshAudioOutputs]);

  /**
   * Force-sync entry point used by the conflict-resolution dialog
   * and the reconnect-retry path in CloudSyncBadge. Runs the
   * existing save pipeline for the target tab which in turn
   * triggers `pushToCloudAfterSave`.
   */
  useEffect(() => {
    const onRequestSave = (e: Event) => {
      const d = (e as CustomEvent<{ tabId?: string; silent?: boolean }>).detail;
      const tid = d?.tabId?.trim();
      if (!tid) return;
      void matbeastSaveTabById(
        queryClient,
        selectTab,
        () => openTabsRef.current,
        tid,
        { silent: Boolean(d?.silent), allowPrompt: !d?.silent },
      );
    };
    window.addEventListener("matbeast-request-save", onRequestSave);
    return () =>
      window.removeEventListener("matbeast-request-save", onRequestSave);
  }, [queryClient, selectTab]);

  /**
   * Pull the persisted auto-save preference on mount. The main process
   * also pushes this value via a menu event on `did-finish-load`, but that
   * push can arrive before the React listener above is registered — causing
   * the renderer to silently stay at the default (false) even when the
   * native menu checkbox is ticked. Pulling here closes that race.
   */
  useEffect(() => {
    let cancelled = false;
    const api = typeof window !== "undefined" ? window.matBeastDesktop : undefined;
    if (!api?.getDesktopPreferences) return;
    void api
      .getDesktopPreferences()
      .then((prefs) => {
        if (cancelled) return;
        setAutoSaveEvery5Minutes(Boolean(prefs?.autoSaveEvery5Minutes));
      })
      .catch(() => {
        /* best-effort pull; menu push remains the fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const clearSaveFeedbackTimer = () => {
      if (saveFeedbackTimeoutRef.current) {
        window.clearTimeout(saveFeedbackTimeoutRef.current);
        saveFeedbackTimeoutRef.current = null;
      }
    };
    const onSaveStatus = (
      e: Event,
    ) => {
      const d = (
        e as CustomEvent<{
          source?: string;
          kind?: "start" | "success" | "error";
          tabId?: string;
          message?: string;
          silent?: boolean;
        }>
      ).detail;
      if (!d || d.source !== "save" || !d.tabId || !tournamentId || d.tabId !== tournamentId) {
        return;
      }
      /**
       * Dynamic (change-driven) autosave can fire every couple of seconds
       * while the user is typing. Showing "Saving..." then "File saved"
       * on every pass produces a flickering header. Suppress the "start"
       * indicator for silent runs and only surface terminal states:
       *   - success → brief "Saved" flash (so the operator knows work is
       *               being preserved) with a shorter hold than user-
       *               initiated saves.
       *   - error   → always shown so failures never go unnoticed.
       */
      const silent = Boolean(d.silent);
      if (d.kind === "start") {
        if (silent) return;
        clearSaveFeedbackTimer();
        setSaveFeedbackTone("saving");
        setSaveFeedbackText("Saving...");
        return;
      }
      clearSaveFeedbackTimer();
      if (d.kind === "success") {
        setSaveFeedbackTone("saved");
        setSaveFeedbackText(silent ? "Saved" : d.message?.trim() || "File saved");
      } else {
        setSaveFeedbackTone("error");
        setSaveFeedbackText(d.message?.trim() || "Save failed");
      }
      saveFeedbackTimeoutRef.current = window.setTimeout(
        () => {
          setSaveFeedbackText(null);
          saveFeedbackTimeoutRef.current = null;
        },
        silent && d.kind === "success" ? 1200 : 2800,
      );
    };
    window.addEventListener("matbeast-save-status", onSaveStatus);
    return () => {
      window.removeEventListener("matbeast-save-status", onSaveStatus);
      clearSaveFeedbackTimer();
    };
  }, [tournamentId]);

  /**
   * Wire the app-update lifecycle to the header status line:
   *   - subscribe to update-state pushes from the Electron main process
   *   - pull the current state once on mount (closes render-vs-push races)
   *   - auto-trigger a single check shortly after launch so operators get a
   *     silent heads-up in the header if a new version is waiting
   *   - react to Help > Check for Updates… without opening any dialog
   */
  useEffect(() => {
    const api = typeof window !== "undefined" ? window.matBeastDesktop : undefined;
    if (!api?.isDesktopApp) return;

    let cancelled = false;
    const unsub = api.onUpdateStateChange?.((next) => {
      if (cancelled) return;
      setUpdateStatus(next);
      if (next.status !== "downloaded") {
        setUpdatePromptDismissed(false);
      }
    });
    void api
      .getUpdateState?.()
      .then((s) => {
        if (!cancelled && s) setUpdateStatus(s);
      })
      .catch(() => {
        /* best-effort */
      });

    const helpUnsub = api.onHelpMenu?.((action) => {
      if (action !== "check-updates") return;
      setUpdatePromptDismissed(false);
      void api.checkForUpdates?.();
    });

    const autoCheckTimer = window.setTimeout(() => {
      void api.checkForUpdates?.();
    }, 1500);

    return () => {
      cancelled = true;
      unsub?.();
      helpUnsub?.();
      window.clearTimeout(autoCheckTimer);
    };
  }, []);

  /** Hide the transient "You are on the latest version" message after a short beat. */
  useEffect(() => {
    if (!updateStatus) return;
    if (updateStatus.status !== "up-to-date") {
      if (updateUpToDateTimeoutRef.current) {
        window.clearTimeout(updateUpToDateTimeoutRef.current);
        updateUpToDateTimeoutRef.current = null;
      }
      return;
    }
    if (updateUpToDateTimeoutRef.current) {
      window.clearTimeout(updateUpToDateTimeoutRef.current);
    }
    updateUpToDateTimeoutRef.current = window.setTimeout(() => {
      setUpdateStatus((prev) =>
        prev && prev.status === "up-to-date"
          ? { ...prev, status: "idle", message: "" }
          : prev,
      );
      updateUpToDateTimeoutRef.current = null;
    }, 4500);
    return () => {
      if (updateUpToDateTimeoutRef.current) {
        window.clearTimeout(updateUpToDateTimeoutRef.current);
        updateUpToDateTimeoutRef.current = null;
      }
    };
  }, [updateStatus]);

  /**
   * Change-driven ("dynamic") autosave for the active tab.
   *
   * No timer functions are involved: saves are driven exclusively by the
   * `matbeast-document-dirty` pub/sub (fired on every real mutation in
   * `matbeast-fetch.ts`) and coalesced through an in-flight lock. Rapid
   * bursts of mutations that arrive while a save is running are merged
   * into a single follow-up save, so we never pile writes on top of one
   * another, but we also never wait on a wall-clock delay to flush.
   *
   * Silent saves reuse `matbeastSaveTabById({ silent: true, allowPrompt: false })`
   * so they do not interrupt the UI or pop dialogs.
   */
  useEffect(() => {
    if (!autoSaveEvery5Minutes || !ready || !tournamentId) return;

    let inflight = false;
    let pendingAfterInflight = false;
    let cancelled = false;

    const runSave = async () => {
      if (cancelled) return;
      if (!isTournamentDirty(tournamentId)) return;
      if (inflight) {
        pendingAfterInflight = true;
        return;
      }
      inflight = true;
      try {
        await matbeastSaveTabById(
          queryClient,
          selectTab,
          () => openTabsRef.current,
          tournamentId,
          { silent: true, allowPrompt: false },
        );
      } finally {
        inflight = false;
        const replay =
          !cancelled && pendingAfterInflight && isTournamentDirty(tournamentId);
        pendingAfterInflight = false;
        if (replay) void runSave();
      }
    };

    const unsubscribe = subscribeDocumentDirty(() => {
      if (cancelled) return;
      if (isTournamentDirty(tournamentId)) void runSave();
    });

    if (isTournamentDirty(tournamentId)) void runSave();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [autoSaveEvery5Minutes, ready, tournamentId, queryClient, selectTab]);

  useEffect(() => {
    return () => {
      if (saveFeedbackTimeoutRef.current) {
        window.clearTimeout(saveFeedbackTimeoutRef.current);
      }
    };
  }, []);

  const { data: board } = useQuery({
    queryKey: matbeastKeys.board(tournamentId),
    queryFn: () =>
      matbeastJson<BoardPayload>("/api/board", {
        headers: { [MATBEAST_TOURNAMENT_HEADER]: tournamentId! },
      }),
    enabled: ready && !!tournamentId,
  });
  const currentFileName = board?.currentRosterFileName?.trim() || "UNTITLED";

  useEffect(() => {
    const sync = () => {
      setUndoDepth(getDashboardUndoDepth());
      setRedoDepth(getDashboardRedoDepth());
    };
    sync();
    return onDashboardUndoStackChanged(sync);
  }, []);

  /* Initial focus is handled via `autoFocus` on the target input to
     avoid the Electron focus-stealer race that made the old rAF +
     manual focus flow occasionally land the caret outside the input
     (user-visible symptom: dialog opens but keystrokes do nothing).
     Only a rename-state change (tabId + focus field) re-runs this
     effect, which now just moves the caret to the end of the prefilled
     value so users can edit without first selecting. */
  useEffect(() => {
    if (!renameState) return;
    const id = window.requestAnimationFrame(() => {
      const el = renameInputRef.current;
      if (!el) return;
      try {
        const len = el.value.length;
        el.setSelectionRange(len, len);
      } catch {
        /* Some input types don't support setSelectionRange; ignore. */
      }
    });
    return () => window.cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-focus on dialog open/target change
  }, [renameState?.tabId, renameState?.focusField]);

  const runUndo = useCallback(async () => {
    if (!tournamentId || undoBusy || undoDepth < 1) return;
    setUndoBusy(true);
    try {
      const ok = await undoDashboardLastAction();
      if (!ok) {
        throw new Error("Nothing to undo");
      }
      await refreshTournaments();
      void queryClient.invalidateQueries({ queryKey: matbeastKeys.all });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Undo failed");
    } finally {
      setUndoBusy(false);
    }
  }, [tournamentId, undoBusy, undoDepth, refreshTournaments, queryClient]);

  const runRedo = useCallback(async () => {
    if (!tournamentId || undoBusy || redoDepth < 1) return;
    setUndoBusy(true);
    try {
      const ok = await redoDashboardLastAction();
      if (!ok) {
        throw new Error("Nothing to redo");
      }
      await refreshTournaments();
      void queryClient.invalidateQueries({ queryKey: matbeastKeys.all });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Redo failed");
    } finally {
      setUndoBusy(false);
    }
  }, [tournamentId, undoBusy, redoDepth, refreshTournaments, queryClient]);

  useEffect(() => {
    const onEditMenu = (e: Event) => {
      const d = (e as CustomEvent<{ source?: string; action?: string }>).detail;
      if (!d || d.source !== "menu") return;
      if (d.action === "undo") void runUndo();
      if (d.action === "redo") void runRedo();
    };
    window.addEventListener("matbeast-native-edit", onEditMenu);
    return () => window.removeEventListener("matbeast-native-edit", onEditMenu);
  }, [runUndo, runRedo]);

  useEffect(() => {
    const isEditableTarget = (t: EventTarget | null) => {
      if (!(t instanceof HTMLElement)) return false;
      if (t.closest("[data-matbeast-rename-dialog]")) return true;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      return t.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (isEditableTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        void runUndo();
        return;
      }
      if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        void runRedo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runUndo, runRedo]);

  const runOpenFile = useCallback(async () => {
    await matbeastOpenEventOrShowPicker({
      queryClient,
      openEventInTab,
      refreshTournaments,
    });
  }, [openEventInTab, queryClient, refreshTournaments]);

  /**
   * Open the rename dialog for a specific tab and prefill both fields
   * with their current values. `focus` picks which input gets
   * autofocused — this is how the tab label and the filename indicator
   * route into the same modal without losing context.
   */
  const openRenameDialog = useCallback(
    (tabId: string, focus: "eventName" | "filename") => {
      const tab = openTabsRef.current.find((t) => t.id === tabId);
      const initialEventName = (tab?.name ?? "").trim();
      const initialFilename = currentFileName;
      setRenameState({
        tabId,
        eventNameDraft: initialEventName,
        filenameDraft: initialFilename,
        initialEventName,
        initialFilename,
        focusField: focus,
      });
    },
    [currentFileName],
  );

  const saveRenamedTab = useCallback(async () => {
    if (!renameState) return;
    const nextEventName = renameState.eventNameDraft.trim();
    const nextFilename = renameState.filenameDraft.trim();
    if (!nextEventName && !nextFilename) return;

    const eventNameChanged =
      nextEventName.length > 0 && nextEventName !== renameState.initialEventName;
    const filenameChanged =
      nextFilename.length > 0 && nextFilename !== renameState.initialFilename;
    if (!eventNameChanged && !filenameChanged) {
      setRenameState(null);
      return;
    }

    // 1) Tournament display title (tab label). Local write first so
    //    the UI reflects the change even if cloud is offline.
    if (eventNameChanged) {
      const res = await fetch(
        `/api/tournaments/${encodeURIComponent(renameState.tabId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: nextEventName }),
        },
      );
      if (!res.ok) return;
      updateTabName(renameState.tabId, nextEventName);
      await refreshTournaments();
    }

    /**
     * If the filename changed, pre-check the cloud catalog for
     * collisions before we touch the local board row. The server is
     * still authoritative — the check below also handles the 409
     * path when two users rename simultaneously — but doing a quick
     * client-side check keeps the dashboard header consistent with
     * the cloud (no half-applied rename where the local filename
     * diverges from the cloud).
     */
    if (filenameChanged) {
      let catalog: Array<{ id: string; name: string; eventName?: string | null }> = [];
      try {
        const r = await fetch("/api/cloud/events", { cache: "no-store" });
        if (r.ok) {
          const data = (await r.json()) as {
            events?: Array<{ id: string; name: string; eventName?: string | null }>;
          };
          catalog = data.events ?? [];
        }
      } catch {
        /* offline — proceed; the desktop proxy will return 502 */
      }
      const lc = nextFilename.toLowerCase();
      const clash = catalog.find((ev) => {
        if (ev.id === renameState.tabId) return false;
        return (ev.name ?? "").trim().toLowerCase() === lc;
      });
      if (clash) {
        const label = clash.eventName?.trim()
          ? `${clash.name} (${clash.eventName})`
          : clash.name;
        window.alert(
          `That filename is already used by "${label}". ` +
            `Pick a different filename for this event.`,
        );
        return;
      }
    }

    // 2) Filename (currentRosterFileName). Lives on the board row.
    if (filenameChanged) {
      await fetch("/api/board", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          [MATBEAST_TOURNAMENT_HEADER]: renameState.tabId,
          "x-matbeast-skip-undo": "1",
        },
        body: JSON.stringify({ currentRosterFileName: nextFilename }),
      });
      void queryClient.invalidateQueries({ queryKey: matbeastKeys.all });
    }

    // 3) Mirror both to the cloud catalog. Safe to skip for
    //    local-only tournaments: the server returns `linked: false`.
    //    A 409 here means the cloud acquired a colliding row in the
    //    window between our pre-check and the PATCH; we surface it
    //    to the user and leave the rename dialog open so they can
    //    pick a new name. The local board row will be reconciled by
    //    the next save/autosave pushing the corrected filename.
    if (eventNameChanged || filenameChanged) {
      const payload: {
        tournamentId: string;
        name?: string;
        eventName?: string | null;
      } = { tournamentId: renameState.tabId };
      if (filenameChanged) payload.name = nextFilename;
      if (eventNameChanged) payload.eventName = nextEventName;
      try {
        const res = await fetch("/api/cloud/events/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.status === 409) {
          window.alert(
            `That filename was just claimed by another event. ` +
              `Pick a different filename and try again.`,
          );
          return;
        }
        window.dispatchEvent(
          new CustomEvent("matbeast-cloud-sync-changed", {
            detail: { tournamentId: renameState.tabId },
          }),
        );
      } catch {
        /* offline — cloud catalog catches up on next successful save */
      }
    }
    setRenameState(null);
  }, [renameState, refreshTournaments, updateTabName, queryClient]);

  /**
   * Closing a tab normally fires a silent cloud save first. If the
   * cloud is unreachable *and* the tab has unsynced edits, we
   * instead open a modal asking the user whether to back the tab up
   * to disk before closing — the cloud path can't preserve those
   * edits right now, and silently discarding them would be
   * surprising. Clean tabs (or dirty tabs with a live cloud) keep
   * the v0.8.9 no-prompt behavior.
   */
  const requestCloseTab = useCallback(
    (tabId: string) => {
      if (!isTournamentDirty(tabId)) {
        closeTab(tabId);
        return;
      }
      const onlineNow = cloudOnlineRef.current.online;
      if (!onlineNow) {
        const meta = openTabsRef.current.find((t) => t.id === tabId);
        setOfflineCloseState({
          tabId,
          tabName: meta?.name ?? "this event",
          working: false,
        });
        return;
      }
      void (async () => {
        try {
          await matbeastSaveTabById(
            queryClient,
            selectTab,
            () => openTabsRef.current,
            tabId,
            { silent: true },
          );
        } catch (e) {
          matbeastDebugLog(
            "close-tab",
            "silent save threw",
            e instanceof Error ? e.message : String(e),
          );
        } finally {
          closeTab(tabId);
        }
      })();
    },
    [closeTab, queryClient, selectTab],
  );

  const handleOfflineCloseBackup = useCallback(async () => {
    const st = offlineCloseState;
    if (!st || st.working) return;
    setOfflineCloseState({ ...st, working: true });
    try {
      const wrote = await matbeastBackupTabByIdToDisk({
        queryClient,
        selectTab,
        getOpenTabs: () => openTabsRef.current,
        tabId: st.tabId,
      });
      if (!wrote) {
        // User cancelled the file picker or the write failed —
        // leave the dialog open so they can try again or pick
        // another option.
        setOfflineCloseState({ ...st, working: false });
        return;
      }
      setOfflineCloseState(null);
      closeTab(st.tabId);
    } catch (e) {
      matbeastDebugLog(
        "close-tab",
        "backup-to-disk threw",
        e instanceof Error ? e.message : String(e),
      );
      setOfflineCloseState({ ...st, working: false });
    }
  }, [offlineCloseState, queryClient, selectTab, closeTab]);

  const handleOfflineCloseDiscard = useCallback(() => {
    const st = offlineCloseState;
    if (!st || st.working) return;
    setOfflineCloseState(null);
    closeTab(st.tabId);
  }, [offlineCloseState, closeTab]);

  const handleOfflineCloseCancel = useCallback(() => {
    const st = offlineCloseState;
    if (!st || st.working) return;
    setOfflineCloseState(null);
  }, [offlineCloseState]);

  // Open the new-event dialog whenever the File menu or the
  // homepage dispatches the global request. A second request while
  // the dialog is already open is a no-op.
  useEffect(() => {
    const onOpen = () => setNewEventDialogOpen(true);
    window.addEventListener("matbeast-open-new-event-dialog", onOpen);
    return () =>
      window.removeEventListener("matbeast-open-new-event-dialog", onOpen);
  }, []);

  const handleNewEventSubmit = useCallback(
    async (result: { eventName: string; filename: string }) => {
      if (creatingNewEvent) return;
      setCreatingNewEvent(true);
      try {
        const created = await matbeastCreateNewEventTab({
          queryClient,
          openEventInTab,
          refreshTournaments,
          updateTabName,
          eventName: result.eventName,
          filename: result.filename,
        });
        if (created && "duplicate" in created && created.duplicate) {
          // A race produced a collision between opening the dialog
          // and clicking Create. Close the half-created local tab
          // (the backing tournament has already been deleted on the
          // server) and leave the dialog open so the user can pick a
          // different filename without retyping the title.
          if (created.tournamentId) {
            try {
              closeTab(created.tournamentId);
            } catch {
              /* swallow — tab may already be gone */
            }
          }
          // Tell the still-open dialog to refresh its cached
          // catalog so the collision warning shows for the typed
          // filename.
          window.dispatchEvent(
            new CustomEvent("matbeast-new-event-catalog-stale"),
          );
          window.alert(
            `That filename was just claimed by another event. ` +
              `Pick a different filename and try again.`,
          );
          return;
        }
        setNewEventDialogOpen(false);
      } catch (e) {
        window.alert(
          e instanceof Error ? e.message : "Could not create event",
        );
      } finally {
        setCreatingNewEvent(false);
      }
    },
    [
      creatingNewEvent,
      queryClient,
      openEventInTab,
      refreshTournaments,
      updateTabName,
    ],
  );

  if (typeof window !== "undefined" && window.location.pathname === "/overlay") {
    return null;
  }

  /**
   * Map the Electron update-state machine into a single header indicator so
   * operators get continuous feedback during an update check (menu-driven or
   * auto-on-launch) without any modal dialog. `null` means "nothing to show".
   */
  const updateStatusLine: {
    text: string;
    tone: "info" | "warning" | "error" | "success";
  } | null = (() => {
    const s = updateStatus;
    if (!s) return null;
    switch (s.status) {
      case "checking":
        return { text: "Checking for updates…", tone: "info" };
      case "downloading":
        return {
          text: s.message || "Downloading update…",
          tone: "info",
        };
      case "downloaded":
        return {
          text: s.downloadedVersion
            ? `Update v${s.downloadedVersion} is ready to install.`
            : s.message || "Update ready to install.",
          tone: "success",
        };
      case "up-to-date":
        return { text: s.message || "You are on the latest version.", tone: "success" };
      case "offline":
        return {
          text: s.message || "No internet — update check canceled.",
          tone: "warning",
        };
      case "error":
        return { text: s.message || "Update error.", tone: "error" };
      default:
        return null;
    }
  })();
  const showInstallPrompt =
    updateStatus?.status === "downloaded" && !updatePromptDismissed;
  const statusLineToneClass =
    updateStatusLine?.tone === "warning"
      ? "text-amber-300"
      : updateStatusLine?.tone === "error"
        ? "text-red-300"
        : updateStatusLine?.tone === "success"
          ? "text-emerald-300"
          : "text-sky-300";

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-black/40 bg-[#2a2a2a] text-[11px] leading-tight text-zinc-200 shadow-md">
        <div className="flex h-8 w-full min-w-0 items-stretch pr-1">
          <div className="flex min-h-0 min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto rounded-tl pl-1">
            {openTabs.length === 0 ? (
              <div className="flex flex-1 items-center justify-center px-2 text-[10px] text-zinc-500">
                Open or create new event
              </div>
            ) : null}
            {openTabs.map((tab) => {
              const active = tab.id === tournamentId;
              /**
               * Every tab gets an equal share of the header width
               * (`basis-0 flex-1` → one tab: 100%, two: 50/50,
               * three: 33/33/33, …). The outer tab div is itself
               * clickable so the whole tab area switches to its
               * tournament, not just the event-title button. Inner
               * interactive elements (close, undo/redo, filename
               * rename) stop propagation so their clicks don't
               * double-dispatch as a tab switch.
               */
              return (
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected={active}
                  tabIndex={0}
                  onClick={() => selectTab(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectTab(tab.id);
                    }
                  }}
                  className={[
                    "flex min-h-0 min-w-0 basis-0 flex-1 cursor-pointer items-stretch rounded-t border border-b-0 text-[10px]",
                    active
                      ? "border-teal-700/60 bg-[#1a1a1a] text-teal-100"
                      : "border-transparent bg-transparent text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-200",
                  ].join(" ")}
                >
                  <button
                    type="button"
                    className="min-h-0 min-w-0 shrink truncate px-2 py-1 text-left font-medium"
                    onClick={(e) => {
                      // Outer div already handles the switch; stop
                      // here so double-click-to-rename still works
                      // without the first click firing two different
                      // selectTab paths.
                      e.stopPropagation();
                      selectTab(tab.id);
                    }}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openRenameDialog(tab.id, "eventName");
                    }}
                    title={`${tab.name} — double-click to rename event`}
                  >
                    {tab.name || "Untitled"}
                  </button>
                  {active ? (
                    <div className="flex min-w-0 flex-1 items-center gap-1 border-l border-teal-800/50 pl-2 pr-1">
                      <button
                        type="button"
                        className="min-w-0 max-w-[min(24rem,40vw)] flex-1 truncate rounded px-1 py-0.5 text-left text-[10px] font-medium text-zinc-300 hover:bg-white/5"
                        title={`Filename: ${currentFileName} — double-click to rename file`}
                        onDoubleClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          openRenameDialog(tab.id, "filename");
                        }}
                      >
                        {currentFileName}
                      </button>
                      {saveFeedbackText ? (
                        <span
                          className={[
                            "shrink-0 text-[9px]",
                            saveFeedbackTone === "saving"
                              ? "text-amber-300"
                              : saveFeedbackTone === "error"
                                ? "text-red-300"
                                : "text-emerald-300",
                          ].join(" ")}
                        >
                          {saveFeedbackText}
                        </span>
                      ) : null}
                      <CloudSyncBadge tournamentId={tournamentId} />
                      <button
                        type="button"
                        title="Undo (Ctrl+Z)"
                        disabled={undoDepth < 1 || undoBusy || !tournamentId}
                        onClick={() => void runUndo()}
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-teal-900/40 text-teal-100/90 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
                          <path d="M12 5a7 7 0 1 1-6.93 8h2.06A5 5 0 1 0 8.5 8.5H12v-2H5v7h2V10.6A6.98 6.98 0 0 1 12 5Z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        title="Redo (Ctrl+Y)"
                        disabled={redoDepth < 1 || undoBusy || !tournamentId}
                        onClick={() => void runRedo()}
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-teal-900/40 text-teal-100/90 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
                          <path d="M12 5h7v7h-2V8.5A5 5 0 1 0 15.5 15v2.06A7 7 0 1 1 12 5Z" />
                        </svg>
                      </button>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="shrink-0 px-1 py-1 text-zinc-500 hover:text-white"
                    aria-label={`Close ${tab.name}`}
                    title="Close tab"
                    onClick={(e) => {
                      e.stopPropagation();
                      requestCloseTab(tab.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          {updateStatusLine ? (
            <div
              className="flex shrink-0 items-center gap-2 self-center pl-2 pr-1"
              aria-live="polite"
            >
              {updateStatus?.status === "checking" ||
              updateStatus?.status === "downloading" ? (
                <span
                  className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-sky-400"
                  aria-hidden
                />
              ) : null}
              <span
                className={["text-[10px] font-medium", statusLineToneClass].join(" ")}
                title={updateStatus?.message || undefined}
              >
                {updateStatusLine.text}
              </span>
              {showInstallPrompt ? (
                <>
                  <button
                    type="button"
                    disabled={updateInstallBusy}
                    onClick={async () => {
                      const api =
                        typeof window !== "undefined"
                          ? window.matBeastDesktop
                          : undefined;
                      if (!api?.installDownloadedUpdate) return;
                      setUpdateInstallBusy(true);
                      try {
                        await api.installDownloadedUpdate();
                      } finally {
                        setUpdateInstallBusy(false);
                      }
                    }}
                    className="rounded border border-teal-600/60 bg-teal-700/40 px-2 py-0.5 text-[10px] font-semibold text-teal-50 hover:bg-teal-600/60 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {updateInstallBusy ? "Installing…" : "Install & restart"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setUpdatePromptDismissed(true)}
                    className="rounded border border-zinc-600 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-white/10"
                  >
                    Later
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      {renameState ? (
        <div
          className="fixed inset-0 z-[600] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Rename event"
        >
          <div
            className="w-full max-w-sm rounded-lg border border-zinc-600 bg-[#2d2d2d] p-4 shadow-2xl"
            data-matbeast-rename-dialog
          >
            <h2 className="text-xs font-semibold text-white">
              Rename event &amp; file
            </h2>
            <p className="mt-1 text-[10px] text-zinc-400">
              The event name is shown on the tab and in the homepage catalog
              list. The filename is what the event file is saved as.
            </p>

            <label className="mt-3 block text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
              Event name
            </label>
            <input
              ref={renameState.focusField === "eventName" ? renameInputRef : null}
              autoFocus={renameState.focusField === "eventName"}
              className="mt-1 w-full rounded border border-zinc-600 bg-[#1e1e1e] px-2 py-1.5 text-[11px] text-white outline-none focus:border-[#1473e6]"
              value={renameState.eventNameDraft}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) =>
                setRenameState((s) =>
                  s ? { ...s, eventNameDraft: e.target.value } : s,
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveRenamedTab();
                if (e.key === "Escape") setRenameState(null);
              }}
            />

            <label className="mt-3 block text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
              Filename
            </label>
            <input
              ref={renameState.focusField === "filename" ? renameInputRef : null}
              autoFocus={renameState.focusField === "filename"}
              className="mt-1 w-full rounded border border-zinc-600 bg-[#1e1e1e] px-2 py-1.5 text-[11px] text-white outline-none focus:border-[#1473e6]"
              value={renameState.filenameDraft}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) =>
                setRenameState((s) =>
                  s ? { ...s, filenameDraft: e.target.value } : s,
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveRenamedTab();
                if (e.key === "Escape") setRenameState(null);
              }}
            />

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded px-3 py-1 text-[11px] text-zinc-400 hover:bg-white/10"
                onClick={() => setRenameState(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded bg-[#1473e6] px-3 py-1 text-[11px] font-medium text-white hover:bg-[#0d5fbd]"
                onClick={() => void saveRenamedTab()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <NewEventDialog
        open={newEventDialogOpen}
        onClose={() => {
          if (creatingNewEvent) return;
          setNewEventDialogOpen(false);
        }}
        onSubmit={(result) => void handleNewEventSubmit(result)}
      />

      {offlineCloseState ? (
        <div
          className="fixed inset-0 z-[600] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Not synced"
        >
          <div className="w-full max-w-md overflow-hidden rounded-lg border border-amber-700/60 bg-[#2d2d2d] shadow-2xl">
            <div className="border-b border-zinc-600 px-4 py-2.5">
              <h2 className="text-sm font-semibold text-amber-100">
                Not synced
              </h2>
            </div>
            <div className="px-4 py-3 text-[12px] leading-relaxed text-zinc-200">
              <p>
                <span className="font-semibold">
                  {offlineCloseState.tabName}
                </span>{" "}
                has unsynced changes and the cloud server is currently
                unreachable.
              </p>
              <p className="mt-2 text-zinc-400">
                Back up a copy to disk before closing? You can restore the
                backup later from File ▸ Restore copy from disk once the
                connection returns.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-600 px-3 py-2">
              <button
                type="button"
                className="rounded px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={handleOfflineCloseCancel}
                disabled={offlineCloseState.working}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded border border-red-800/50 px-2 py-1 text-[11px] text-red-200 hover:bg-red-900/30 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={handleOfflineCloseDiscard}
                disabled={offlineCloseState.working}
                title="Close the tab and discard local unsynced edits"
              >
                Close without backup
              </button>
              <button
                type="button"
                className="rounded bg-amber-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void handleOfflineCloseBackup()}
                disabled={offlineCloseState.working}
              >
                {offlineCloseState.working ? "Saving…" : "Backup to disk"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {openPicker ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Open event"
        >
          <div className="max-h-[70vh] w-full max-w-md overflow-hidden rounded-lg border border-zinc-600 bg-[#2d2d2d] shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-600 px-3 py-2">
              <h2 className="text-xs font-semibold text-white">Open event</h2>
              <button
                type="button"
                className="rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-white/10 hover:text-white"
                onClick={() => setOpenPicker(false)}
              >
                Close
              </button>
            </div>
            <p className="border-b border-zinc-700/80 px-3 py-1.5 text-[10px] text-zinc-500">
              Pick a server event below, or browse for a .matb file (.mat / .json also open; desktop
              app).
            </p>
            {desktopApi?.showOpenEventDialog ? (
              <div className="border-b border-zinc-700/80 px-3 py-2">
                <button
                  type="button"
                  className="w-full rounded border border-teal-800/50 bg-[#1a2220] px-2 py-1.5 text-[11px] font-medium text-teal-100/90 hover:bg-[#1f2a28]"
                  onClick={() => {
                    setOpenPicker(false);
                    void runOpenFile();
                  }}
                >
                  Browse for file…
                </button>
              </div>
            ) : null}
            <ul className="max-h-[50vh] overflow-auto p-1.5">
              {tournaments.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="w-full rounded px-2 py-1.5 text-left text-[11px] text-zinc-200 hover:bg-[#1473e6]/25"
                    onClick={() => {
                      openEventInTab(t.id, t.name);
                      setOpenPicker(false);
                    }}
                  >
                    {t.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <CloudSettingsModal
        open={cloudSettingsOpen}
        onClose={() => setCloudSettingsOpen(false)}
      />

      {audioOutputPickerOpen ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Audio output"
        >
          <div className="w-full max-w-md overflow-hidden rounded-lg border border-zinc-600 bg-[#2d2d2d] shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-600 px-3 py-2">
              <h2 className="text-xs font-semibold text-white">Audio output</h2>
              <button
                type="button"
                className="rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-white/10 hover:text-white"
                onClick={() => setAudioOutputPickerOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="px-3 py-2 text-[10px] text-zinc-500">
              Select where timer sounds are played.
            </div>
            <div className="max-h-[45vh] overflow-auto border-t border-zinc-700/80 p-2">
              <label className="mb-1 flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[11px] text-zinc-200 hover:bg-[#1473e6]/25">
                <input
                  type="radio"
                  name="matbeast-audio-output"
                  checked={audioOutputSelected === "default"}
                  onChange={() => {
                    setAudioOutputSelected("default");
                    setSelectedAudioOutputId("default");
                  }}
                />
                <span>System default</span>
              </label>
              {audioOutputDevices.map((d, idx) => (
                <label
                  key={`${d.deviceId}-${idx}`}
                  className="mb-1 flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[11px] text-zinc-200 hover:bg-[#1473e6]/25"
                >
                  <input
                    type="radio"
                    name="matbeast-audio-output"
                    checked={audioOutputSelected === d.deviceId}
                    onChange={() => {
                      setAudioOutputSelected(d.deviceId);
                      setSelectedAudioOutputId(d.deviceId);
                    }}
                  />
                  <span>{d.label || `Audio device ${idx + 1}`}</span>
                </label>
              ))}
              {audioOutputDevices.length === 0 ? (
                <p className="px-2 py-1 text-[10px] text-zinc-500">
                  No explicit output devices listed. Using system default.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
