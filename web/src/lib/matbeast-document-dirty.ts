"use client";

const dirtyTournamentIds = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/** True if any of the given tab ids has unsaved-in-memory work (not yet written to the event file). */
export function hasUnsavedAmongOpenTabs(openTabIds: string[]): boolean {
  return openTabIds.some((id) => dirtyTournamentIds.has(id));
}

export function markTournamentDirty(tournamentId: string | null | undefined) {
  const tid = tournamentId?.trim() || null;
  if (!tid) return;
  dirtyTournamentIds.add(tid);
  emit();
}

export function markTournamentClean(tournamentId: string) {
  dirtyTournamentIds.delete(tournamentId);
  emit();
}

/** User closed a tab without saving — drop dirty tracking for that id. */
export function forgetTournamentDocumentState(tournamentId: string) {
  dirtyTournamentIds.delete(tournamentId);
  emit();
}

export function subscribeDocumentDirty(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isTournamentDirty(tournamentId: string): boolean {
  return dirtyTournamentIds.has(tournamentId);
}
