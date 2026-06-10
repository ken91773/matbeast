"use client";

/**
 * Tracks, per open event tab, whether there are edits since the event was
 * last written to its LOCAL backup file (`.matb` on disk) and the path of
 * that file when one is known.
 *
 * This is deliberately separate from the cloud-oriented document-dirty set
 * (`matbeast-document-dirty.ts`): the cloud autosave clears *that* flag
 * frequently, but the on-disk backup can still be stale. The close-time
 * "save changes to the local file / back up to a file" prompt keys off the
 * flag here so it only appears when the disk copy is actually out of date.
 *
 * Session-only (like the open-file registry): cleared on full reload and per
 * tournament on tab close. On a fresh launch an event re-registers its path
 * the moment it's opened from a file or saved.
 */

const dirty = new Set<string>();
const filePathByTid = new Map<string, string>();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* listeners must not throw */
    }
  }
}

/** Note an edit that hasn't been written to the event's local file yet. */
export function markLocalBackupDirty(tournamentId: string | null | undefined) {
  const tid = tournamentId?.trim() || null;
  if (!tid) return;
  if (dirty.has(tid)) return;
  dirty.add(tid);
  emit();
}

/** The event's local file now matches memory (just saved / just opened). */
export function markLocalBackupClean(tournamentId: string) {
  if (!dirty.has(tournamentId)) return;
  dirty.delete(tournamentId);
  emit();
}

export function isLocalBackupDirty(tournamentId: string): boolean {
  return dirty.has(tournamentId);
}

export function hasLocalBackupDirtyAmong(tournamentIds: string[]): boolean {
  return tournamentIds.some((id) => dirty.has(id));
}

/** Remember which on-disk file an event is bound to (original-cased path). */
export function setLocalBackupFilePath(tournamentId: string, filePath: string) {
  const tid = tournamentId?.trim();
  const fp = filePath?.trim();
  if (!tid || !fp) return;
  filePathByTid.set(tid, fp);
}

export function getLocalBackupFilePath(tournamentId: string): string | null {
  return filePathByTid.get(tournamentId) ?? null;
}

/** Tab closed — drop all local-backup tracking for that id. */
export function forgetLocalBackup(tournamentId: string) {
  const had = dirty.delete(tournamentId);
  filePathByTid.delete(tournamentId);
  if (had) emit();
}

export function subscribeLocalBackup(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
