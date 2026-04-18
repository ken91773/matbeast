/**
 * Tracks which on-disk (or synthetic cloud) path is bound to which open
 * tournament so "Open" / "Open recent" / cloud catalog can focus an
 * already-open tab instead of importing a duplicate.
 *
 * Session-only — cleared on full reload. Cleared per tournament on tab close.
 */

const pathToTournamentId = new Map<string, string>();
const tournamentIdToPath = new Map<string, string>();

export function normalizePathForLookup(filePath: string): string {
  const t = filePath.trim();
  if (!t) return "";
  const unified = t.replace(/\//g, "\\");
  if (typeof navigator !== "undefined" && /win/i.test(navigator.platform)) {
    return unified.toLowerCase();
  }
  return unified;
}

export function registerOpenEventFilePath(
  tournamentId: string,
  filePath: string,
): void {
  const key = normalizePathForLookup(filePath);
  if (!key) return;

  const oldKey = tournamentIdToPath.get(tournamentId);
  if (oldKey && oldKey !== key) {
    pathToTournamentId.delete(oldKey);
  }

  const prevTidAtPath = pathToTournamentId.get(key);
  if (prevTidAtPath && prevTidAtPath !== tournamentId) {
    tournamentIdToPath.delete(prevTidAtPath);
  }

  pathToTournamentId.set(key, tournamentId);
  tournamentIdToPath.set(tournamentId, key);
}

export function unregisterOpenEventFilePath(tournamentId: string): void {
  const key = tournamentIdToPath.get(tournamentId);
  if (!key) return;
  tournamentIdToPath.delete(tournamentId);
  pathToTournamentId.delete(key);
}

export function findTournamentIdForFilePath(filePath: string): string | null {
  const key = normalizePathForLookup(filePath);
  if (!key) return null;
  return pathToTournamentId.get(key) ?? null;
}
