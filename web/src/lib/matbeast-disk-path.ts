const storageKey = (id: string) => `matbeast-disk-path::${id}`;

/**
 * Remember last on-disk path for an event file.
 * Prefer `eventFileKey` (normalized saved name); fall back to legacy DB tournament id.
 */
export function getEventDiskPath(
  eventFileKey: string,
  legacyTournamentId?: string | null,
): string | null {
  if (typeof window === "undefined") return null;
  try {
    const direct = window.localStorage.getItem(storageKey(eventFileKey));
    if (direct) return direct;
    if (
      legacyTournamentId &&
      legacyTournamentId.length > 0 &&
      legacyTournamentId !== eventFileKey
    ) {
      return window.localStorage.getItem(storageKey(legacyTournamentId));
    }
    return null;
  } catch {
    return null;
  }
}

export function setEventDiskPath(eventFileKey: string, filePath: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(eventFileKey), filePath);
  } catch {
    /* ignore */
  }
}
