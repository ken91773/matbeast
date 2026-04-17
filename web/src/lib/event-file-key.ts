/**
 * Canonical key for event file identity: saved JSON / board `currentRosterFileName`.
 * Used for dashboard layout persistence and remembering disk save paths — not the DB cuid.
 * Preserves user casing (empty or UNTITLED sentinel → null so callers fall back to tournament id).
 */
export function normalizeEventFileKey(
  raw: string | null | undefined,
): string | null {
  const t = raw?.trim() ?? "";
  if (!t || t.toUpperCase() === "UNTITLED") return null;
  return t;
}
