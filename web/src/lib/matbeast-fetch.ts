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

/** Fetch with active tournament header (for API routes that scope by event file). */
export function matbeastFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return (async () => {
    if (shouldCaptureUndo(input, init)) {
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
    return fetch(input, { ...init, headers });
  })();
}
