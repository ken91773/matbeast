"use client";

import { useEventWorkspace } from "@/components/EventWorkspaceProvider";
import { matbeastFetch } from "@/lib/matbeast-fetch";
import { matbeastKeys } from "@/lib/matbeast-query-keys";
import { matbeastJson } from "@/lib/matbeast-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SkullCrossbonesIcon } from "@/components/icons/SkullCrossbonesIcon";
import {
  forbiddenUserChosenTeamNameMessage,
  isForbiddenCustomTeamName,
  isForbiddenUserChosenTeamName,
} from "@/lib/reserved-team-names";
import { hasReadableTextContrast } from "@/lib/bracket-overlay-model";

const TEAM_ADD_NOT_LISTED = "__NOT_LISTED__";

const CARD_FRAME =
  "flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-zinc-800/90 bg-[#161616] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]";

type TeamRow = {
  id: string;
  name: string;
  seedOrder: number;
  overlayColor?: string | null;
};

type TeamsPayload = {
  teams: TeamRow[];
};

function isSlotEmpty(name: string) {
  const t = name.trim();
  return t.length === 0 || t === "TBD";
}

function displayName(name: string) {
  return isSlotEmpty(name) ? "" : name;
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
    </svg>
  );
}

/**
 * Sports-team-inspired fills. Mix of dark (white text) and bright (black text)
 * — overlay chooses the readable text color automatically via pickTextOnBackground.
 * Rows are grouped visually: darks on top, brights below.
 *
 * Any entry that can't clear AA body contrast (4.5:1) with the better of
 * black/white is filtered out below, so every picker swatch is guaranteed
 * readable.
 */
const RAW_OVERLAY_SWATCHES = [
  // Row 1 — deep/classic (white text)
  "#0a0a0a", // black
  "#1f2937", // charcoal
  "#041e42", // navy (Patriots)
  "#0c2340", // deep navy (Yankees)
  "#1d428a", // royal navy
  "#800000", // maroon (Aggies)
  "#5c0a0a", // dark maroon
  "#14532d", // forest green (Packers)
  "#00471b", // hunter green (Bucks)
  "#3c1361", // deep purple (Ravens)
  // Row 2 — bold/vibrant (black or white text; chosen automatically)
  "#c8102e", // scarlet (Reds, Ohio State)
  "#fb4934", // bright red
  "#ff6b35", // burnt orange (Broncos)
  "#ff8200", // volunteer orange (Tennessee)
  "#ffd100", // gold (Bruins, Packers)
  "#fde047", // bright yellow
  "#0057b7", // royal blue (Chelsea, Blues)
  "#4b9cd3", // carolina blue
  "#00b5a0", // teal (Jaguars, Marlins)
  "#16a34a", // kelly green (Celtics)
  // Row 3 — accent/variety
  "#6f263d", // wine (Avalanche, Cavaliers)
  "#a6192e", // crimson (Alabama)
  "#f59e0b", // amber
  "#fbbf24", // sun yellow
  "#4b0082", // indigo
  "#a855f7", // bright purple
  "#ec4899", // hot pink
  "#06b6d4", // cyan
  "#22c55e", // emerald
  "#ffffff", // white (Spurs, Clippers alt)
] as const;

const OVERLAY_SWATCHES = RAW_OVERLAY_SWATCHES.filter((c) =>
  hasReadableTextContrast(c),
);

function TeamOverlayColorDialog({
  open,
  initial,
  busy,
  onCancel,
  onClear,
  onSave,
}: {
  open: boolean;
  initial: string | null;
  busy: boolean;
  onCancel: () => void;
  onClear: () => void;
  onSave: (color: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(initial);

  useEffect(() => {
    if (!open) return;
    setDraft(initial);
  }, [open, initial]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60 p-3"
      role="dialog"
      aria-modal="true"
      aria-label="Team overlay color"
    >
      <div className="w-full max-w-sm rounded-md border border-zinc-700/80 bg-[#141414] p-3 shadow-xl">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-200">
          Overlay color
        </div>
        <div className="mb-3 grid grid-cols-6 gap-2 sm:grid-cols-10">
          {OVERLAY_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              disabled={busy}
              title={c}
              onClick={() => setDraft(c)}
              className={[
                "h-7 w-7 rounded-full border transition",
                draft === c
                  ? "border-amber-300 ring-2 ring-amber-400/40"
                  : "border-zinc-700 hover:border-zinc-500",
              ].join(" ")}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClear}
            className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-900/70 disabled:opacity-40"
          >
            Clear
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-900/70 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !draft}
            onClick={() => {
              if (!draft) return;
              onSave(draft);
            }}
            className="rounded border border-teal-700/60 bg-teal-900/35 px-2 py-1 text-[11px] font-semibold text-teal-100 hover:bg-teal-900/55 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SaveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14V7l-2-4Zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm3-10H5V5h10v4Z" />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17 8h-1V6a4 4 0 1 0-8 0v2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2Zm-6 0V6a2 2 0 1 1 4 0v2h-4Z" />
    </svg>
  );
}

function UnlockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17 8h-6V6a2 2 0 1 1 4 0h2a4 4 0 1 0-8 0v2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2Z" />
    </svg>
  );
}

export function DashboardTeamsPanel() {
  const { tournamentId, ready, tournamentTrainingMode } = useEventWorkspace();
  const queryClient = useQueryClient();
  const [selectedMasterTeam, setSelectedMasterTeam] = useState("");
  const [newTeamDialogOpen, setNewTeamDialogOpen] = useState(false);
  const [newTeamNameDraft, setNewTeamNameDraft] = useState("");
  const [removeSelectedTeamDialogOpen, setRemoveSelectedTeamDialogOpen] =
    useState(false);
  const [removeSelectedBusy, setRemoveSelectedBusy] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimeoutRef = useRef<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragLocked, setDragLocked] = useState(false);
  const [overlayColorTeamId, setOverlayColorTeamId] = useState<string | null>(null);
  const newTeamNameInputRef = useRef<HTMLInputElement>(null);
  const addTeamSelectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (!newTeamDialogOpen) return;
    /**
     * Opening the dialog from a native `<select>` often leaves OS/Electron focus
     * on the closed dropdown so the modal `<input>` ignores keys until refocus.
     * Defer `focus()` past the close event + layout (double rAF).
     */
    let cancelled = false;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (cancelled) return;
        newTeamNameInputRef.current?.focus({ preventScroll: true });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [newTeamDialogOpen]);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  const flashToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimeoutRef.current = null;
    }, 3200);
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: matbeastKeys.teams(tournamentId),
    queryFn: () => matbeastJson<TeamsPayload>("/api/teams"),
    enabled: ready && !!tournamentId,
  });

  const teamsSorted = useMemo(() => {
    const list = data?.teams ?? [];
    return [...list].sort((a, b) => a.seedOrder - b.seedOrder);
  }, [data?.teams]);

  const { data: masterTeamPayload, refetch: refetchMasterTeamNames } = useQuery({
    queryKey: matbeastKeys.masterTeamNames(tournamentId, tournamentTrainingMode),
    queryFn: () =>
      matbeastJson<{ names: string[] }>(
        `/api/master-team-names?tournamentId=${encodeURIComponent(tournamentId!)}&useTrainingMasters=${tournamentTrainingMode ? "1" : "0"}`,
      ),
    enabled: ready && !!tournamentId,
  });
  const masterTeamNames = useMemo<string[]>(
    () => masterTeamPayload?.names ?? [],
    [masterTeamPayload?.names],
  );

  const mergedPickList = useMemo(() => {
    const s = new Set(masterTeamNames.map((n) => n.trim().toUpperCase()).filter(Boolean));
    for (const t of teamsSorted) {
      const n = t.name.trim().toUpperCase();
      if (n && n !== "TBD") s.add(n);
    }
    return [...s]
      .filter((n) => n !== "TBD" && !isForbiddenCustomTeamName(n))
      .sort((a, b) => a.localeCompare(b));
  }, [masterTeamNames, teamsSorted]);

  const invalidateTeams = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: matbeastKeys.teams(tournamentId) });
    void queryClient.invalidateQueries({ queryKey: matbeastKeys.all });
  }, [queryClient, tournamentId]);

  const invalidateMasterTeams = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: matbeastKeys.masterTeamNames(tournamentId, tournamentTrainingMode),
    });
    void refetchMasterTeamNames();
  }, [queryClient, refetchMasterTeamNames, tournamentId, tournamentTrainingMode]);

  const patchTeam = useMutation({
    mutationFn: async ({
      id,
      name,
      overlayColor,
      removeFromMasterTeamNames,
    }: {
      id: string;
      name?: string;
      overlayColor?: string | null;
      removeFromMasterTeamNames?: boolean;
    }) => {
      const res = await matbeastFetch(`/api/teams/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          overlayColor,
          removeFromMasterTeamNames,
          tournamentId: tournamentId ?? undefined,
          useTrainingMasters: tournamentTrainingMode,
        }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? "Update failed");
      }
    },
    onSuccess: () => {
      invalidateTeams();
      invalidateMasterTeams();
    },
  });

  const reorderTeams = useMutation({
    mutationFn: async (teamIds: string[]) => {
      const res = await matbeastFetch("/api/tournament/reorder-teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamIds }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? "Reorder failed");
      }
    },
    onSuccess: () => invalidateTeams(),
  });

  const namedCount = useMemo(
    () => teamsSorted.filter((t) => !isSlotEmpty(t.name)).length,
    [teamsSorted],
  );

  const onAddTeam = useCallback(() => {
    if (selectedMasterTeam === TEAM_ADD_NOT_LISTED) {
      addTeamSelectRef.current?.blur();
      setNewTeamNameDraft("");
      setNewTeamDialogOpen(true);
      return;
    }
    const name = selectedMasterTeam.trim().toUpperCase();
    if (!name || !tournamentId) return;
    if (namedCount >= 8) {
      window.alert("Maximum of 8 teams.");
      return;
    }
    const nextSlot = teamsSorted.find((t) => isSlotEmpty(t.name));
    if (!nextSlot) {
      window.alert("Maximum of 8 teams.");
      return;
    }
    patchTeam.mutate(
      { id: nextSlot.id, name },
      {
        onSuccess: () => setSelectedMasterTeam(""),
        onError: (e) => window.alert(e instanceof Error ? e.message : "Save failed"),
      },
    );
  }, [selectedMasterTeam, namedCount, patchTeam, teamsSorted, tournamentId]);

  const confirmNewTeamFromDialog = useCallback(async () => {
    const name = newTeamNameDraft.trim().toUpperCase();
    if (!name || !tournamentId) return;
    if (isForbiddenUserChosenTeamName(name)) {
      window.alert(forbiddenUserChosenTeamNameMessage());
      return;
    }
    const nextSlot = teamsSorted.find((t) => isSlotEmpty(t.name));
    const eventFull = namedCount >= 8 || !nextSlot;
    try {
      const res = await matbeastFetch("/api/master-team-names", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          tournamentId,
          useTrainingMasters: tournamentTrainingMode,
        }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? "Master list save failed");
      }
      if (eventFull) {
        invalidateMasterTeams();
        setNewTeamDialogOpen(false);
        setNewTeamNameDraft("");
        setSelectedMasterTeam("");
        flashToast("Team name saved to file only");
        return;
      }
      patchTeam.mutate(
        { id: nextSlot!.id, name },
        {
          onSuccess: () => {
            setNewTeamDialogOpen(false);
            setNewTeamNameDraft("");
            setSelectedMasterTeam("");
          },
          onError: (e) => window.alert(e instanceof Error ? e.message : "Save failed"),
        },
      );
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Save failed");
    }
  }, [
    flashToast,
    invalidateMasterTeams,
    namedCount,
    newTeamNameDraft,
    patchTeam,
    teamsSorted,
    tournamentId,
    tournamentTrainingMode,
  ]);

  const onClearFromEventOnly = useCallback(
    (id: string) => {
      patchTeam.mutate(
        { id, name: "" },
        {
          onError: (e) => window.alert(e instanceof Error ? e.message : "Delete failed"),
        },
      );
    },
    [patchTeam],
  );

  const confirmRemoveDropdownSelection = useCallback(async () => {
    const name = selectedMasterTeam.trim().toUpperCase();
    if (!name) return;
    const eventTeam = teamsSorted.find(
      (t) => !isSlotEmpty(t.name) && t.name.trim().toUpperCase() === name,
    );
    setRemoveSelectedBusy(true);
    try {
      if (eventTeam) {
        await patchTeam.mutateAsync({
          id: eventTeam.id,
          name: "",
          removeFromMasterTeamNames: true,
        });
      } else {
        const res = await matbeastFetch("/api/master-team-names", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            tournamentId,
            useTrainingMasters: tournamentTrainingMode,
          }),
        });
        if (!res.ok) {
          const j = (await res.json()) as { error?: string };
          throw new Error(j.error ?? "Remove from master list failed");
        }
        invalidateMasterTeams();
      }
      setSelectedMasterTeam("");
      setRemoveSelectedTeamDialogOpen(false);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setRemoveSelectedBusy(false);
    }
  }, [
    invalidateMasterTeams,
    patchTeam,
    selectedMasterTeam,
    teamsSorted,
    tournamentId,
    tournamentTrainingMode,
  ]);

  const onDragStart = (index: number) => {
    setDragIndex(index);
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const onDrop = (dropIndex: number) => {
    if (dragIndex === null || dragIndex === dropIndex) {
      setDragIndex(null);
      return;
    }
    const next = [...teamsSorted];
    const [removed] = next.splice(dragIndex, 1);
    next.splice(dropIndex, 0, removed);
    setDragIndex(null);
    reorderTeams.mutate(
      next.map((t) => t.id),
      {
        onError: (e) => window.alert(e instanceof Error ? e.message : "Reorder failed"),
      },
    );
  };

  if (!ready || !tournamentId) {
    return (
      <div className={`${CARD_FRAME} items-center justify-center p-4 text-[11px] text-zinc-500`}>
        Select or create an event.
      </div>
    );
  }

  return (
    <div className={CARD_FRAME}>
      {newTeamDialogOpen ? (
        <div
          className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dash-new-team-title"
        >
          <div className="w-full max-w-sm rounded-lg border border-zinc-600 bg-[#2d2d2d] p-4 shadow-xl">
            <h2 id="dash-new-team-title" className="text-[12px] font-semibold text-zinc-100">
              New team name
            </h2>
            <p className="mt-1 text-[11px] text-zinc-400">
              Saves to the master team list. If this event has an open seed, that seed is filled;
              if the event already has 8 named teams, only the master list is updated.
            </p>
            <input
              ref={newTeamNameInputRef}
              type="text"
              value={newTeamNameDraft}
              onChange={(e) => setNewTeamNameDraft(e.target.value.toUpperCase())}
              className="mt-3 w-full rounded border border-zinc-600 bg-black/30 px-2 py-1.5 text-[12px] uppercase text-zinc-100 outline-none focus:border-teal-700/60"
              maxLength={120}
              autoCapitalize="characters"
            />
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="rounded border border-zinc-500/60 px-3 py-1.5 text-[11px] text-zinc-200 hover:bg-white/10"
                onClick={() => {
                  setNewTeamDialogOpen(false);
                  setNewTeamNameDraft("");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded border border-teal-800/60 bg-teal-950/50 px-3 py-1.5 text-[11px] font-semibold text-teal-100 hover:bg-teal-900/45"
                onClick={() => void confirmNewTeamFromDialog()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {removeSelectedTeamDialogOpen ? (
        <div
          className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dash-remove-selected-team-title"
        >
          <div className="w-full max-w-sm rounded-lg border border-zinc-600 bg-[#2d2d2d] p-4 shadow-xl">
            <p
              id="dash-remove-selected-team-title"
              className="text-[12px] leading-snug text-zinc-200"
            >
              Confirm remove team name from the master list file?
            </p>
            <p className="mt-2 text-[11px] font-medium uppercase text-amber-200/90">
              {selectedMasterTeam.trim().toUpperCase()}
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={removeSelectedBusy}
                className="rounded border border-zinc-500/60 px-3 py-1.5 text-[11px] text-zinc-200 hover:bg-white/10 disabled:opacity-50"
                onClick={() => {
                  if (!removeSelectedBusy) setRemoveSelectedTeamDialogOpen(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={removeSelectedBusy}
                className="rounded border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-[11px] font-semibold text-red-100 hover:bg-red-900/45 disabled:opacity-50"
                onClick={() => void confirmRemoveDropdownSelection()}
              >
                {removeSelectedBusy ? "…" : "Remove"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <header className="shrink-0 border-b border-teal-950/40 bg-[#111] px-2 py-1.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-teal-100/90">
          Teams
        </h2>
      </header>

      {toastMessage ? (
        <div className="shrink-0 border-b border-teal-900/40 bg-teal-950/35 px-2 py-1 text-center text-[11px] font-medium text-teal-100">
          {toastMessage}
        </div>
      ) : null}

      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain p-1.5 text-[11px] leading-tight">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-zinc-500">
            <span className="block">Add team to event</span>
            <select
              ref={addTeamSelectRef}
              value={selectedMasterTeam}
              onChange={(e) => {
                const v = e.target.value;
                if (v === TEAM_ADD_NOT_LISTED) {
                  (e.target as HTMLSelectElement).blur();
                  setNewTeamNameDraft("");
                  setNewTeamDialogOpen(true);
                  setSelectedMasterTeam("");
                  return;
                }
                setSelectedMasterTeam(v);
              }}
              className="mt-0.5 max-w-[14rem] rounded border border-zinc-700 bg-[#1a1a1a] px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-100 outline-none focus:border-teal-700/60"
            >
              <option value="">Select team…</option>
              {mergedPickList.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              <option value={TEAM_ADD_NOT_LISTED}>ADD TEAM</option>
            </select>
          </label>
          <button
            type="button"
            disabled={
              patchTeam.isPending ||
              !selectedMasterTeam ||
              (namedCount >= 8 && selectedMasterTeam !== TEAM_ADD_NOT_LISTED) ||
              isLoading
            }
            onClick={() => onAddTeam()}
            className="rounded border border-teal-800/50 bg-teal-950/40 px-2 py-0.5 text-[11px] font-medium text-teal-100/90 hover:bg-teal-900/50 disabled:cursor-not-allowed disabled:opacity-40"
            title="Add team to event"
          >
            <SaveIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={
              patchTeam.isPending ||
              removeSelectedBusy ||
              !selectedMasterTeam.trim() ||
              isLoading
            }
            onClick={() => setRemoveSelectedTeamDialogOpen(true)}
            className="rounded border border-red-900/45 bg-red-950/30 px-2 py-0.5 text-[11px] text-red-200/90 hover:bg-red-950/50 disabled:cursor-not-allowed disabled:opacity-40"
            title="Remove from event (if assigned) and master team list file"
          >
            <SkullCrossbonesIcon className="h-3.5 w-3.5" />
          </button>
          <span className="text-[10px] text-zinc-500">Drag to set seed order</span>
          <button
            type="button"
            title={dragLocked ? "Unlock team drag" : "Lock team drag"}
            onClick={() => setDragLocked((v) => !v)}
            className={`inline-flex items-center justify-center rounded border p-0.5 ${
              dragLocked
                ? "border-amber-500/55 bg-amber-950/35 text-amber-400 shadow-[inset_0_0_0_1px_rgba(251,191,36,0.12)] hover:border-amber-400/70 hover:bg-amber-950/50 hover:text-amber-300"
                : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {dragLocked ? (
              <LockIcon className="h-3.5 w-3.5 text-amber-400" />
            ) : (
              <UnlockIcon className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto rounded border border-zinc-800/80">
          {isLoading ? (
            <p className="p-2 text-[11px] text-zinc-500">Loading teams…</p>
          ) : teamsSorted.length === 0 ? (
            <p className="p-2 text-[11px] text-zinc-500">No team slots yet.</p>
          ) : (
            <ul className="grid grid-cols-1 divide-y divide-zinc-800/90 min-[700px]:grid-cols-2 min-[700px]:divide-y-0 min-[700px]:divide-x">
              {teamsSorted.map((team, index) => (
                <li
                  key={team.id}
                  draggable={!dragLocked}
                  onDragStart={() => !dragLocked && onDragStart(index)}
                  onDragEnd={() => setDragIndex(null)}
                  onDragOver={(e) => !dragLocked && onDragOver(e)}
                  onDrop={() => !dragLocked && onDrop(index)}
                  className="flex items-center gap-1 bg-[#141414] px-2 py-0.5 hover:bg-[#181818] border-b border-zinc-800/90 min-[700px]:border-b-0"
                >
                  <span
                    className={`${dragLocked ? "cursor-default" : "cursor-grab active:cursor-grabbing"} select-none text-zinc-600`}
                    title={dragLocked ? "Drag locked" : "Drag to reorder"}
                    aria-hidden
                  >
                    ⋮⋮
                  </span>
                  <span className="w-5 shrink-0 text-center font-bold text-teal-600/90">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 font-medium text-zinc-200">
                    {displayName(team.name) || (
                      <span className="text-zinc-600">&nbsp;</span>
                    )}
                  </span>
                  <button
                    type="button"
                    disabled={patchTeam.isPending}
                    onClick={() => setOverlayColorTeamId(team.id)}
                    title="Set overlay color"
                    className="shrink-0 rounded p-0.5 text-zinc-500 hover:text-zinc-200 disabled:opacity-40"
                  >
                    <span
                      className="inline-block h-3.5 w-3.5 rounded-full border border-zinc-600"
                      style={
                        team.overlayColor
                          ? { backgroundColor: team.overlayColor, borderColor: "rgba(255,255,255,0.35)" }
                          : undefined
                      }
                    />
                  </button>
                  <span
                    className={`inline-flex shrink-0 items-center ${
                      isSlotEmpty(team.name) ? "invisible pointer-events-none" : ""
                    }`}
                  >
                    <button
                      type="button"
                      disabled={patchTeam.isPending}
                      onClick={() => onClearFromEventOnly(team.id)}
                      title="Remove from event only (keep in master list)"
                      className="rounded p-0.5 text-zinc-500 hover:text-amber-300/90"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {overlayColorTeamId ? (
        <TeamOverlayColorDialog
          open
          initial={(teamsSorted.find((t) => t.id === overlayColorTeamId)?.overlayColor ?? null) as string | null}
          busy={patchTeam.isPending}
          onCancel={() => setOverlayColorTeamId(null)}
          onClear={async () => {
            try {
              await patchTeam.mutateAsync({ id: overlayColorTeamId, overlayColor: null });
              setOverlayColorTeamId(null);
            } catch (e) {
              window.alert(e instanceof Error ? e.message : "Could not clear color");
            }
          }}
          onSave={async (color) => {
            try {
              await patchTeam.mutateAsync({ id: overlayColorTeamId, overlayColor: color });
              setOverlayColorTeamId(null);
            } catch (e) {
              window.alert(e instanceof Error ? e.message : "Could not save color");
            }
          }}
        />
      ) : null}
    </div>
  );
}
