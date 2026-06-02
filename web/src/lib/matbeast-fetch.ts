"use client";

import {
  captureDashboardUndoSnapshot,
  shouldCaptureUndo,
} from "@/lib/dashboard-undo";
import { markTournamentDirty } from "@/lib/matbeast-document-dirty";

/** Sent on API requests so board/players/etc. scope to the active event tab. */
export const MATBEAST_TOURNAMENT_HEADER = "x-matbeast-tournament-id";
/**
 * Active tab's training flag (from workspace), mirrored to localStorage so
 * overlay windows and `matbeastFetch` send the same master-list scope as the
 * dashboard even when `Tournament.trainingMode` in SQLite lags the open file.
 */
export const MATBEAST_CLIENT_USE_TRAINING_MASTERS_HEADER =
  "x-matbeast-client-use-training-masters";
export const MATBEAST_CLIENT_USE_TRAINING_MASTERS_STORAGE_KEY =
  "matbeast-client-use-training-masters";
const HEADER = MATBEAST_TOURNAMENT_HEADER;
const STORAGE_KEY = "matbeast-active-tournament-id";

let inMemoryTournamentId: string | null = null;
/** Mirrors active tab training flag for the same renderer tick as `matbeastFetch` (LS is for overlays). */
let inMemoryClientTrainingMasters: "0" | "1" | null = null;

/**
 * In-flight mutation tracker.
 *
 * v1.2.1 fix: when the user clicks the close-tab "x" right after pressing the
 * roster card's Save icon, the silent close-tab save races with the still in
 * flight `POST /api/players`. Because SQLite (WAL) readers only see committed
 * data, the silent save's `/api/teams` read can return the snapshot from
 * BEFORE the player commit, upload an envelope missing the just-saved
 * player, and on reopen the cloud blob (now the source of truth) drops it.
 *
 * The symptom the user reported is exactly this race: only the LAST player
 * saved on the most-recently-focused team disappears on reopen. Switching
 * `SHOW TEAM` between save and close happens to fix it because the dropdown
 * click gives the POST enough time to commit before close fires.
 *
 * The fix is for `matbeastSaveTabById` (and any other "build envelope from
 * server state" path) to await {@link awaitPendingMatbeastMutations} before
 * reading `/api/teams`, so the snapshot reflects every committed write.
 */
let inFlightMatbeastMutations = 0;
const mutationDrainListeners = new Set<() => void>();

function isMutationMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

/**
 * Resolves once every matbeast-tracked mutation that was in flight at call
 * time has either resolved or rejected. New mutations started AFTER this is
 * called are not waited for — the close-tab save only needs to make sure it
 * does not race with the user's most recent click.
 */
export function awaitPendingMatbeastMutations(): Promise<void> {
  if (inFlightMatbeastMutations === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const fn = () => {
      if (inFlightMatbeastMutations === 0) {
        mutationDrainListeners.delete(fn);
        resolve();
      }
    };
    mutationDrainListeners.add(fn);
  });
}

function notifyMutationDrainListeners(): void {
  if (inFlightMatbeastMutations !== 0) return;
  for (const fn of mutationDrainListeners) fn();
}

export function setMatBeastTournamentId(id: string | null) {
  inMemoryTournamentId = id;
  if (typeof window === "undefined") return;
  try {
    if (id) {
      window.localStorage.setItem(STORAGE_KEY, id);
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

export function getMatBeastTournamentId(): string | null {
  if (inMemoryTournamentId) return inMemoryTournamentId;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Keeps active tournament id and optional client training flag in sync for
 * fetch headers (see {@link MATBEAST_CLIENT_USE_TRAINING_MASTERS_HEADER}).
 */
export function syncMatBeastActiveTabContextToClientStorage(
  activeId: string | null,
  tabs: ReadonlyArray<{ id: string; trainingMode?: boolean }>,
): void {
  inMemoryTournamentId = activeId;
  if (typeof window === "undefined") return;
  try {
    if (!activeId) {
      inMemoryClientTrainingMasters = null;
      window.localStorage.removeItem(MATBEAST_CLIENT_USE_TRAINING_MASTERS_STORAGE_KEY);
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const tab = tabs.find((t) => t.id === activeId);
    /**
     * Missing `trainingMode` on a tab (legacy stored tabs) means "not training" —
     * default production masters so SQLite rows that still have `trainingMode: 1`
     * do not force Training* writes while a normal event tab is active.
     */
    const useTraining = tab ? Boolean(tab.trainingMode) : false;
    inMemoryClientTrainingMasters = useTraining ? "1" : "0";
    window.localStorage.setItem(
      MATBEAST_CLIENT_USE_TRAINING_MASTERS_STORAGE_KEY,
      inMemoryClientTrainingMasters,
    );
    window.localStorage.setItem(STORAGE_KEY, activeId);
  } catch {
    /* ignore */
  }
}

/**
 * Secondary windows (overlay / extra Electron renderers) do not run
 * `syncMatBeastActiveTabContextToClientStorage` when the main window switches
 * tabs — only localStorage updates. Refresh in-memory state from LS before each
 * fetch so `x-matbeast-client-use-training-masters` matches the active tab.
 */
function hydrateClientTrainingMastersFromLocalStorage(): void {
  if (typeof window === "undefined") return;
  try {
    const v = window.localStorage
      .getItem(MATBEAST_CLIENT_USE_TRAINING_MASTERS_STORAGE_KEY)
      ?.trim();
    if (v === "0" || v === "1") {
      inMemoryClientTrainingMasters = v;
    }
  } catch {
    /* ignore */
  }
}

function appendClientTrainingMastersHeader(headers: Headers): void {
  if (
    (inMemoryClientTrainingMasters === "0" || inMemoryClientTrainingMasters === "1") &&
    !headers.has(MATBEAST_CLIENT_USE_TRAINING_MASTERS_HEADER)
  ) {
    headers.set(MATBEAST_CLIENT_USE_TRAINING_MASTERS_HEADER, inMemoryClientTrainingMasters);
    return;
  }
  if (typeof window === "undefined") return;
  try {
    const v = window.localStorage
      .getItem(MATBEAST_CLIENT_USE_TRAINING_MASTERS_STORAGE_KEY)
      ?.trim();
    if ((v === "0" || v === "1") && !headers.has(MATBEAST_CLIENT_USE_TRAINING_MASTERS_HEADER)) {
      headers.set(MATBEAST_CLIENT_USE_TRAINING_MASTERS_HEADER, v);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Board (`/api/board`) command types that change *persisted* event data —
 * i.e. the final, recorded match results that live in the saved file.
 * Every other board mutation (timer, scoring, overlay toggles, sound
 * cues, OT controls, round label, etc.) is a LIVE broadcast control that
 * must NOT be saved or synced. Keeping these live actions out of the
 * dirty set means they never trigger the (now always-on) cloud autosync,
 * so the scoreboard controls stay latency-free.
 */
const PERSISTENT_BOARD_COMMAND_TYPES = new Set<string>([
  "final_save",
  "final_unsave",
  "result_log_manual_add",
  "result_log_delete",
]);

/**
 * True when a `/api/board` mutation is a live broadcast control (anything
 * other than recording/editing a final result). Live controls are
 * deliberately excluded from dirty-marking so they don't fire an autosave.
 * Any board mutation we can't classify is treated as live (fail-safe: a
 * live control firing an extra sync is the bug we're avoiding).
 */
function isLiveOnlyBoardRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): boolean {
  const url = String(input);
  if (!url.startsWith("/api/board")) return false;
  try {
    const body = init?.body;
    if (typeof body !== "string") return true;
    const parsed = JSON.parse(body) as { command?: { type?: unknown } };
    const type = parsed?.command?.type;
    if (typeof type === "string" && PERSISTENT_BOARD_COMMAND_TYPES.has(type)) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

/** Fetch with active tournament header (for API routes that scope by event file). */
export function matbeastFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return (async () => {
    // Live scoreboard controls (timer/scoring/overlay/sound/OT/round
    // label) take a fast path: they skip both the undo snapshot (3
    // blocking GETs) and dirty-marking, so they fire immediately and
    // never trigger the always-on cloud autosync. Only persistent roster
    // and recorded-result changes capture undo + sync.
    if (shouldCaptureUndo(input, init) && !isLiveOnlyBoardRequest(input, init)) {
      await captureDashboardUndoSnapshot();
      const tid = getMatBeastTournamentId();
      if (tid) markTournamentDirty(tid);
    }
    const id = getMatBeastTournamentId();
    const headers = new Headers(init?.headers);
    if (id && !headers.has(HEADER)) {
      headers.set(HEADER, id);
    }
    if (!headers.has(MATBEAST_CLIENT_USE_TRAINING_MASTERS_HEADER)) {
      hydrateClientTrainingMastersFromLocalStorage();
    }
    appendClientTrainingMastersHeader(headers);
    /**
     * Track mutations so the close-tab silent save can wait for an in-flight
     * `POST /api/players` (etc.) to commit before reading `/api/teams`. See
     * the long comment above {@link awaitPendingMatbeastMutations}.
     */
    const tracksMutation = isMutationMethod(init?.method ?? "GET");
    if (tracksMutation) inFlightMatbeastMutations += 1;
    try {
      return await fetch(input, { ...init, headers });
    } finally {
      if (tracksMutation) {
        inFlightMatbeastMutations = Math.max(0, inFlightMatbeastMutations - 1);
        notifyMutationDrainListeners();
      }
    }
  })();
}
