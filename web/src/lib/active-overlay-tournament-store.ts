import fs from "fs";
import path from "path";

/**
 * Server-side record of which tournament the operator is currently driving,
 * so a **constant** overlay URL (no `?tournamentId=`) can follow the live
 * event across event re-opens, app crashes, and relaunches.
 *
 * Why this exists: opening an event *file* imports it into the DB as a brand
 * new tournament row with a brand new cuid every time, so a `tournamentId`
 * baked into the OBS URL is never stable. Instead the dashboard publishes the
 * active id here whenever the focused event tab changes, and the overlay polls
 * it. Backed by an in-process cache plus a tiny JSON file next to the SQLite
 * DB so the value survives a server restart (the dashboard also re-publishes
 * on mount, so the file is a fast-path, not the source of truth).
 */

let cached: string | null | undefined;

function storeFilePath(): string | null {
  const url = String(process.env.DATABASE_URL ?? "").trim();
  if (!url) return null;
  const filePart = url.replace(/^file:/i, "").trim();
  if (!filePart) return null;
  try {
    return path.join(path.dirname(filePart), "active-overlay-tournament.json");
  } catch {
    return null;
  }
}

export function getActiveOverlayTournamentId(): string | null {
  if (cached !== undefined) return cached;
  const p = storeFilePath();
  if (p) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as {
        tournamentId?: string | null;
      };
      cached = parsed?.tournamentId?.trim() || null;
      return cached;
    } catch {
      /* file missing / unreadable — treat as unset */
    }
  }
  cached = null;
  return cached;
}

export function setActiveOverlayTournamentId(id: string | null): void {
  cached = id && id.trim() ? id.trim() : null;
  const p = storeFilePath();
  if (!p) return;
  try {
    fs.writeFileSync(
      p,
      JSON.stringify({ tournamentId: cached, updatedAt: new Date().toISOString() }),
    );
  } catch {
    /* best-effort persistence; in-process cache still serves reads */
  }
}
