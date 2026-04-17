"use client";

import {
  captureDashboardUndoSnapshot,
  shouldCaptureUndo,
} from "@/lib/dashboard-undo";
import { markTournamentDirty } from "@/lib/matbeast-document-dirty";

/** Sent on API requests so board/players/etc. scope to the active event tab. */
export const MATBEAST_TOURNAMENT_HEADER = "x-matbeast-tournament-id";
const HEADER = MATBEAST_TOURNAMENT_HEADER;
const STORAGE_KEY = "matbeast-active-tournament-id";

let inMemoryTournamentId: string | null = null;

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
    return fetch(input, { ...init, headers });
  })();
}
