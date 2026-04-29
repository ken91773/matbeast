import { prisma } from "@/lib/prisma";

const HEADER = "x-matbeast-tournament-id";
const CLIENT_TM_HEADER = "x-matbeast-client-use-training-masters";

/** Same env as {@link debugMasterProfileWrite} — master list resolution + successful writes. */
export function isMatbeastDebugMasterScopeEnabled(): boolean {
  return (
    process.env.MATBEAST_DEBUG_MASTER_SCOPE === "1" ||
    process.env.MATBEAST_DEBUG_MASTER_SCOPE === "true"
  );
}

/** Set `MATBEAST_DEBUG_MASTER_SCOPE=1` (server env) to log how each request picks Training vs production masters. */
function debugMasterScope(payload: Record<string, unknown>): void {
  if (!isMatbeastDebugMasterScopeEnabled()) return;
  console.debug("[MatBeast master-scope]", payload);
}

/**
 * When `MATBEAST_DEBUG_MASTER_SCOPE=1`, logs each successful master profile DB write
 * (table, id, names) — the same facts you would read from an HTTP 200 response body.
 */
export function debugMasterProfileWrite(payload: Record<string, unknown>): void {
  if (!isMatbeastDebugMasterScopeEnabled()) return;
  console.debug("[MatBeast master-profile-write]", payload);
}

/**
 * JSON bodies sometimes carry `"false"` / `"0"` (or FormData-like shapes).
 * Treat those like booleans so production master writes are not routed to
 * Training* when the strict `typeof === "boolean"` check was skipped.
 */
export function coalesceUseTrainingMastersBodyFlag(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "number" && (v === 0 || v === 1)) return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
  }
  return undefined;
}

/**
 * When the active tournament (header) is a training-mode event, master list
 * APIs use TrainingMaster* tables instead of live Master* (cloud-synced).
 */
export async function resolveUseTrainingMasters(req: Request): Promise<boolean> {
  const raw = req.headers.get(HEADER)?.trim();
  if (!raw) return false;
  const t = await prisma.tournament.findUnique({
    where: { id: raw },
    select: { trainingMode: true },
  });
  return Boolean(t?.trainingMode);
}

/**
 * Live vs Training master tables for `/api/player-profiles` and roster master sync:
 * 1. **`useTrainingMasters` in JSON** (dashboard `EventWorkspace`) — strongest signal;
 *    cannot be lost to header stripping and overrides team-linked DB tournaments.
 * 2. `x-matbeast-client-use-training-masters` + scoped tournament id (body or header).
 * 3. `Tournament.trainingMode` in SQLite for that id.
 * 4. Else infer from roster `teamId` → team's tournament (legacy / no tab context).
 */
export async function resolveUseTrainingMastersForProfileRequest(
  req: Request,
  opts?: {
    teamId?: string | null;
    tournamentId?: string | null;
    /** When set, wins over headers and Prisma for this request only. */
    useTrainingMasters?: unknown;
  },
): Promise<boolean> {
  const bodyTm = coalesceUseTrainingMastersBodyFlag(opts?.useTrainingMasters);
  if (typeof bodyTm === "boolean") {
    debugMasterScope({
      branch: "body_useTrainingMasters",
      useTrainingMasters: bodyTm,
      tournamentIdHint: opts?.tournamentId ?? null,
    });
    return bodyTm;
  }
  const bodyTid =
    typeof opts?.tournamentId === "string" ? opts.tournamentId.trim() : "";
  const headerTid = req.headers.get(HEADER)?.trim() ?? "";
  const explicitTid = bodyTid || headerTid;
  const clientTm = req.headers.get(CLIENT_TM_HEADER)?.trim();
  const useClientTm = clientTm === "0" || clientTm === "1";
  /**
   * When the UI has an explicit tournament scope (body or header id), prefer
   * the dashboard tab's training flag over SQLite when the client sends it.
   * That fixes master writes going to Training* while a production tab is open
   * if the DB row is stale vs the opened `.matb` envelope.
   */
  if (explicitTid && useClientTm) {
    const training = clientTm === "1";
    debugMasterScope({
      branch: "client_header_with_tournament_id",
      useTrainingMasters: training,
      explicitTournamentId: explicitTid,
      clientTrainingHeader: clientTm,
      tournamentIdFromBody: bodyTid || null,
      tournamentIdFromHeader: headerTid || null,
    });
    return training;
  }
  if (explicitTid) {
    const t = await prisma.tournament.findUnique({
      where: { id: explicitTid },
      select: { trainingMode: true },
    });
    const training = Boolean(t?.trainingMode);
    debugMasterScope({
      branch: "sqlite_tournament_row",
      useTrainingMasters: training,
      explicitTournamentId: explicitTid,
      clientTrainingHeader: clientTm || null,
      note: "no x-matbeast-client-use-training-masters; fell back to DB",
    });
    return training;
  }
  const teamId = typeof opts?.teamId === "string" ? opts.teamId.trim() : "";
  if (!teamId) {
    debugMasterScope({
      branch: "default_no_scope",
      useTrainingMasters: false,
      teamId: null,
    });
    return false;
  }
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { event: { include: { tournament: { select: { trainingMode: true } } } } },
  });
  const training = Boolean(team?.event?.tournament?.trainingMode);
  debugMasterScope({
    branch: "team_linked_tournament",
    useTrainingMasters: training,
    teamId,
  });
  return training;
}

export async function tournamentUsesTrainingMasters(
  tournamentId: string,
): Promise<boolean> {
  const t = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { trainingMode: true },
  });
  return Boolean(t?.trainingMode);
}
