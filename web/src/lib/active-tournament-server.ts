import { ensureDefaultTournament } from "./tournament";
import { getActiveOverlayTournamentId } from "./active-overlay-tournament-store";

const HEADER = "x-matbeast-tournament-id";

/**
 * Resolve active tournament id from the API request header; if absent (e.g. a
 * constant id-less overlay URL), fall back to the operator's currently-driven
 * event published via `/api/active-tournament`, and only then to the default
 * tournament.
 */
export async function resolveTournamentIdFromRequest(req: Request): Promise<string> {
  const raw = req.headers.get(HEADER)?.trim();
  if (raw) {
    return raw;
  }
  const active = getActiveOverlayTournamentId();
  if (active) {
    return active;
  }
  const t = await ensureDefaultTournament();
  return t.id;
}
