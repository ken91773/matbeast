import { ensureDefaultTournament } from "./tournament";

const HEADER = "x-matbeast-tournament-id";

/** Resolve active tournament id from API request header, else default tournament. */
export async function resolveTournamentIdFromRequest(req: Request): Promise<string> {
  const raw = req.headers.get(HEADER)?.trim();
  if (raw) {
    return raw;
  }
  const t = await ensureDefaultTournament();
  return t.id;
}
