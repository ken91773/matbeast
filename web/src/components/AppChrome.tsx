"use client";

import { useEventWorkspace } from "@/components/EventWorkspaceProvider";
import {
  matbeastOpenEventOrShowPicker,
  matbeastSaveTabById,
} from "@/lib/matbeast-dashboard-file-actions";
import {
  forgetTournamentDocumentState,
  isTournamentDirty,
  subscribeDocumentDirty,
} from "@/lib/matbeast-document-dirty";
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

  const [closePromptForTabId, setClosePromptForTabId] = useState<string | null>(null);
  const [renameState, setRenameState] = useState<{ tabId: string; draft: string } | null>(
    null,
  );
  const [audioOutputPickerOpen, setAudioOutputPickerOpen] = useState(false);
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
      if (d.action !== "audio-output") return;
      setAudioOutputSelected(getSelectedAudioOutputId());
      void refreshAudioOutputs();
      setAudioOutputPickerOpen(true);
    };
    window.addEventListener("matbeast-native-options", onOptionsMenu);
    return () => window.removeEventListener("matbeast-native-options", onOptionsMenu);
  }, [refreshAudioOutputs]);

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

  useEffect(() => {
    if (!renameState) return;
    const id = window.requestAnimationFrame(() => {
      const el = renameInputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    });
    return () => window.cancelAnimationFrame(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- open dialog only; full renameState would re-select on each keystroke
  }, [renameState?.tabId]);

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

  const saveRenamedTab = useCallback(async () => {
    if (!renameState) return;
    const next = renameState.draft.trim();
    if (!next) return;
    const res = await fetch(`/api/tournaments/${renameState.tabId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: next }),
    });
    if (res.ok) {
      await refreshTournaments();
      updateTabName(renameState.tabId, next);
      setRenameState(null);
    }
  }, [renameState, refreshTournaments, updateTabName]);

  const requestCloseTab = useCallback(
    (tabId: string) => {
      if (!isTournamentDirty(tabId)) {
        closeTab(tabId);
        return;
      }
      setClosePromptForTabId(tabId);
    },
    [closeTab],
  );

  const handleCloseDecision = useCallback(
    async (choice: "save" | "discard" | "cancel") => {
      const tabId = closePromptForTabId;
      setClosePromptForTabId(null);
      if (!tabId || choice === "cancel") return;
      if (choice === "save") {
        try {
          const ok = await matbeastSaveTabById(
            queryClient,
            selectTab,
            () => openTabsRef.current,
            tabId,
          );
          if (!ok) return;
        } catch (e) {
          window.alert(e instanceof Error ? e.message : "Save failed");
          return;
        }
      } else if (choice === "discard") {
        forgetTournamentDocumentState(tabId);
      }
      closeTab(tabId);
    },
    [closePromptForTabId, queryClient, selectTab, closeTab],
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
              return (
                <div
                  key={tab.id}
                  className={[
                    "flex min-h-0 min-w-0 flex-1 items-stretch rounded-t border border-b-0 text-[10px]",
                    active
                      ? "border-teal-700/60 bg-[#1a1a1a] text-teal-100"
                      : "border-transparent bg-transparent text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-200",
                  ].join(" ")}
                >
                  <button
                    type="button"
                    className="min-h-0 min-w-0 shrink truncate px-2 py-1 text-left font-medium"
                    onClick={() => selectTab(tab.id)}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setRenameState({ tabId: tab.id, draft: tab.name });
                    }}
                    title={`${tab.name} — double-click to rename`}
                  >
                    {tab.name || "Untitled"}
                  </button>
                  {active ? (
                    <div className="flex min-w-0 shrink items-center gap-0.5 border-l border-teal-800/50 pl-1 pr-0.5">
                      <span
                        className="max-w-[min(12rem,28vw)] truncate text-[10px] font-medium text-zinc-300"
                        title={`Saved file: ${currentFileName}`}
                      >
                        {currentFileName}
                      </span>
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

      {closePromptForTabId ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Close event"
        >
          <div className="w-full max-w-sm rounded-lg border border-zinc-600 bg-[#2d2d2d] p-4 shadow-2xl">
            <p className="text-[12px] font-medium text-white">Save changes before closing?</p>
            <p className="mt-1 text-[10px] text-zinc-500">
              Choose an option for this event tab.
            </p>
            <div className="mt-4 grid gap-2">
              <button
                type="button"
                className="w-full rounded border border-teal-800/50 bg-teal-900/30 py-2 text-[11px] font-medium text-teal-100 hover:bg-teal-900/45"
                onClick={() => void handleCloseDecision("save")}
              >
                Save and close
              </button>
              <button
                type="button"
                className="w-full rounded border border-zinc-500/50 py-2 text-[11px] text-zinc-200 hover:bg-white/10"
                onClick={() => void handleCloseDecision("discard")}
              >
                Close without saving
              </button>
              <button
                type="button"
                className="w-full rounded py-2 text-[11px] text-zinc-400 hover:bg-white/10"
                onClick={() => void handleCloseDecision("cancel")}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {renameState ? (
        <div
          className="fixed inset-0 z-[600] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Rename event"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-zinc-600 bg-[#2d2d2d] p-4 shadow-2xl"
            data-matbeast-rename-dialog
          >
            <h2 className="text-xs font-semibold text-white">Event name</h2>
            <input
              ref={renameInputRef}
              className="mt-2 w-full rounded border border-zinc-600 bg-[#1e1e1e] px-2 py-1.5 text-[11px] text-white outline-none focus:border-[#1473e6]"
              value={renameState.draft}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) =>
                setRenameState((s) => (s ? { ...s, draft: e.target.value } : s))
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
