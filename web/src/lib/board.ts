import type {
  LiveScoreboardState,
  Player,
  ResultLog,
  Team,
} from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { BoardPayload } from "@/types/board";
import { normalizeEventFileKey } from "@/lib/event-file-key";
import {
  effectiveOtRoundElapsedSeconds,
  foldOtRoundElapsedOrphanAnchorWhenPaused,
  isOtRoundLabelFromDropdown,
} from "@/lib/ot-round-label";
import { prisma } from "./prisma";

/**
 * 0-based silhouette slot index on each side (see scoreboard.svg g43 / g47):
 * 0 = farthest from timer, 4 = closest to timer. Cross order: inner-first, then outward.
 */
export const INNER_FIRST_SILHOUETTE_INDEX = [4, 3, 2, 1, 0] as const;

export type { BoardPayload };

const playerInclude = { team: true };

function shouldRecoverLegacyLiveScoreboardSchema(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2021") {
    const table =
      typeof error.meta?.table === "string" ? error.meta.table.toLowerCase() : "";
    return table.includes("livescoreboardstate");
  }
  if (error.code !== "P2022") return false;
  const column =
    typeof error.meta?.column === "string" ? error.meta.column.toLowerCase() : "";
  // Recover whenever any missing column references LiveScoreboardState.
  // This catches older desktop DBs that predate newly added board columns.
  return column.includes("livescoreboardstate");
}

async function recoverLegacyLiveScoreboardSchema() {
  // Legacy builds may have missing table/columns. Recreate only this table so
  // old DBs can boot without blocking the whole app.
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "LiveScoreboardState"`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "LiveScoreboardState" (
      "tournamentId" TEXT NOT NULL PRIMARY KEY,
      "leftPlayerId" TEXT,
      "rightPlayerId" TEXT,
      "roundLabel" TEXT NOT NULL DEFAULT 'Quarter Finals',
      "currentRosterFileName" TEXT NOT NULL DEFAULT 'UNTITLED',
      "customLeftName" TEXT,
      "customLeftTeamName" TEXT,
      "customRightName" TEXT,
      "customRightTeamName" TEXT,
      "finalSaved" INTEGER NOT NULL DEFAULT 0,
      "finalResultType" TEXT,
      "finalWinnerName" TEXT,
      "finalResultLogId" TEXT,
      "preFinalStateJson" TEXT,
      "timerSeconds" INTEGER NOT NULL DEFAULT 240,
      "timerRunning" INTEGER NOT NULL DEFAULT 0,
      "timerEndsAt" DATETIME,
      "timerPhase" TEXT NOT NULL DEFAULT 'REGULATION',
      "overtimeIndex" INTEGER NOT NULL DEFAULT 0,
      "overtimeWinsLeft" INTEGER NOT NULL DEFAULT 0,
      "overtimeWinsRight" INTEGER NOT NULL DEFAULT 0,
      "leftEliminatedCount" INTEGER NOT NULL DEFAULT 0,
      "rightEliminatedCount" INTEGER NOT NULL DEFAULT 0,
      "sound10Enabled" INTEGER NOT NULL DEFAULT 1,
      "sound0Enabled" INTEGER NOT NULL DEFAULT 1,
      "sound10PlayNonce" INTEGER NOT NULL DEFAULT 0,
      "sound0PlayNonce" INTEGER NOT NULL DEFAULT 0,
      "otPlayDirection" INTEGER NOT NULL DEFAULT 1,
      "otRoundElapsedBaseSeconds" INTEGER NOT NULL DEFAULT 0,
      "otRoundElapsedRunStartedAt" DATETIME,
      "showFinalWinnerHighlight" INTEGER NOT NULL DEFAULT 1,
      "timerCuesResetNonce" INTEGER NOT NULL DEFAULT 0,
      "otRoundTransferConsumed" INTEGER NOT NULL DEFAULT 0,
      "otRoundTransferUndoMainSeconds" INTEGER,
      "otRoundTransferUndoElapsedTotal" INTEGER,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "LiveScoreboardState_tournamentId_fkey"
        FOREIGN KEY ("tournamentId") REFERENCES "Tournament" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "LiveScoreboardState_leftPlayerId_fkey"
        FOREIGN KEY ("leftPlayerId") REFERENCES "Player" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
      CONSTRAINT "LiveScoreboardState_rightPlayerId_fkey"
        FOREIGN KEY ("rightPlayerId") REFERENCES "Player" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "LiveScoreboardState_leftPlayerId_key" ON "LiveScoreboardState"("leftPlayerId")`
  );
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "LiveScoreboardState_rightPlayerId_key" ON "LiveScoreboardState"("rightPlayerId")`
  );
}

type ResultLogLike = Pick<
  ResultLog,
  | "id"
  | "rosterFileName"
  | "roundLabel"
  | "leftName"
  | "rightName"
  | "leftTeamName"
  | "rightTeamName"
  | "resultType"
  | "winnerName"
  | "isManual"
  | "manualDate"
  | "manualTime"
  | "finalSummaryLine"
  | "createdAt"
>;

type PlayerWithTeam = Player & { team: Team };
type RawResultLogCompatRow = {
  id?: string;
  rosterFileName?: string | null;
  roundLabel?: string | null;
  leftName?: string | null;
  rightName?: string | null;
  leftTeamName?: string | null;
  rightTeamName?: string | null;
  resultType?: string | null;
  winnerName?: string | null;
  isManual?: number | boolean | null;
  manualDate?: string | null;
  manualTime?: string | null;
  finalSummaryLine?: string | null;
  createdAt?: string | Date | null;
};

function displayName(p: PlayerWithTeam) {
  return `${p.firstName} ${p.lastName}`.trim();
}

function effectiveSeconds(state: LiveScoreboardState): number {
  if (!state.timerRunning || !state.timerEndsAt) {
    return Math.max(0, state.timerSeconds);
  }
  const ms = state.timerEndsAt.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 1000));
}

function crossedFromCount(count: number): number[] {
  const n = Math.min(5, Math.max(0, count));
  return INNER_FIRST_SILHOUETTE_INDEX.slice(0, n);
}

async function readResultLogColumns(): Promise<Set<string>> {
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `PRAGMA table_info("ResultLog")`,
    )) as Array<{ name?: unknown }>;
    const cols = new Set<string>();
    for (const row of rows) {
      if (typeof row?.name === "string") cols.add(row.name);
    }
    return cols;
  } catch {
    return new Set<string>();
  }
}

function mapRawResultLogCompatRow(r: RawResultLogCompatRow): ResultLogLike {
  const createdAt =
    r.createdAt instanceof Date
      ? r.createdAt
      : new Date(typeof r.createdAt === "string" ? r.createdAt : Date.now());
  return {
    id:
      typeof r.id === "string" && r.id
        ? r.id
        : `legacy-${createdAt.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    rosterFileName: r.rosterFileName ?? "UNTITLED",
    roundLabel: r.roundLabel ?? "FINAL",
    leftName: r.leftName ?? "",
    rightName: r.rightName ?? "",
    leftTeamName: r.leftTeamName ?? null,
    rightTeamName: r.rightTeamName ?? null,
    resultType: (r.resultType ?? "MANUAL") as ResultLogLike["resultType"],
    winnerName: r.winnerName ?? null,
    isManual: Boolean(r.isManual),
    manualDate: r.manualDate ?? null,
    manualTime: r.manualTime ?? null,
    finalSummaryLine: r.finalSummaryLine ?? null,
    createdAt,
  };
}

function rosterFileKeyForResultLog(
  currentRosterFileName: string | null | undefined,
): string {
  return normalizeEventFileKey(currentRosterFileName) ?? "UNTITLED";
}

function resultLogMatchesRosterKey(
  row: { rosterFileName?: string | null },
  rosterKey: string,
): boolean {
  const a = rosterFileKeyForResultLog(row.rosterFileName ?? undefined).toUpperCase();
  const b = rosterKey.toUpperCase();
  return a === b;
}

async function getResultLogsCompat(
  tournamentId: string,
  rosterKey: string,
): Promise<ResultLogLike[]> {
  const cols = await readResultLogColumns();
  if (cols.size === 0) return [];
  const canFilterByTournament = cols.has("tournamentId");
  const selectCols = [
    "id",
    "rosterFileName",
    "roundLabel",
    "leftName",
    "rightName",
    "leftTeamName",
    "rightTeamName",
    "resultType",
    "winnerName",
    "isManual",
    "manualDate",
    "manualTime",
    "finalSummaryLine",
    "createdAt",
  ].filter((c) => cols.has(c));
  if (!selectCols.includes("id") || !selectCols.includes("createdAt")) return [];
  const sql =
    `SELECT ${selectCols.map((c) => `"${c}"`).join(", ")} FROM "ResultLog"` +
    (canFilterByTournament ? ` WHERE "tournamentId" = ?` : "") +
    ` ORDER BY "createdAt" DESC LIMIT 240`;
  const rows = (await prisma.$queryRawUnsafe(
    sql,
    ...(canFilterByTournament ? [tournamentId] : []),
  )) as RawResultLogCompatRow[];
  return rows
    .map(mapRawResultLogCompatRow)
    .filter((r) => resultLogMatchesRosterKey(r, rosterKey))
    .slice(0, 80);
}

export function toBoardPayload(
  state: LiveScoreboardState,
  leftP: PlayerWithTeam | null,
  rightP: PlayerWithTeam | null,
  resultsLog: readonly ResultLogLike[] = [],
): BoardPayload {
  const leftDisplay = state.customLeftName?.trim() || (leftP ? displayName(leftP) : "");
  const rightDisplay =
    state.customRightName?.trim() || (rightP ? displayName(rightP) : "");
  const leftTeam = state.customLeftTeamName?.trim() || leftP?.team.name || "";
  const rightTeam = state.customRightTeamName?.trim() || rightP?.team.name || "";
  return {
    leftPlayerId: state.leftPlayerId,
    rightPlayerId: state.rightPlayerId,
    left: leftDisplay
      ? {
          displayName: leftDisplay,
          teamName: leftTeam,
          lastName: state.customLeftName?.trim() ? null : (leftP?.lastName ?? null),
        }
      : null,
    right: rightDisplay
      ? {
          displayName: rightDisplay,
          teamName: rightTeam,
          lastName: state.customRightName?.trim() ? null : (rightP?.lastName ?? null),
        }
      : null,
    customLeftName: state.customLeftName,
    customLeftTeamName: state.customLeftTeamName,
    customRightName: state.customRightName,
    customRightTeamName: state.customRightTeamName,
    currentRosterFileName: state.currentRosterFileName,
    roundLabel: state.roundLabel,
    finalSaved: state.finalSaved,
    finalResultType: state.finalResultType,
    finalWinnerName: state.finalWinnerName,
    resultsLog: resultsLog.map((r) => ({
      id: r.id,
      rosterFileName: r.rosterFileName,
      roundLabel: r.roundLabel,
      leftName: r.leftName,
      rightName: r.rightName,
      leftTeamName: r.leftTeamName ?? null,
      rightTeamName: r.rightTeamName ?? null,
      resultType: r.resultType as BoardPayload["resultsLog"][0]["resultType"],
      winnerName: r.winnerName,
      createdAt: r.createdAt.toISOString(),
      isManual: Boolean(r.isManual),
      manualDate: r.manualDate ?? null,
      manualTime: r.manualTime ?? null,
      finalSummaryLine: r.finalSummaryLine ?? null,
    })),
    secondsRemaining: effectiveSeconds(state),
    timerRunning: state.timerRunning,
    timerPhase: state.timerPhase,
    overtimeIndex: state.overtimeIndex,
    overtimeWinsLeft: state.overtimeWinsLeft,
    overtimeWinsRight: state.overtimeWinsRight,
    leftEliminatedCount: state.leftEliminatedCount,
    rightEliminatedCount: state.rightEliminatedCount,
    sound10Enabled: state.sound10Enabled,
    sound0Enabled: state.sound0Enabled,
    sound10PlayNonce: state.sound10PlayNonce,
    sound0PlayNonce: state.sound0PlayNonce,
    timerRestMode: state.overtimeIndex === -1,
    timerOtCountUpMode: state.overtimeIndex === -2,
    timerOtArmedMode: state.overtimeIndex === -3,
    timerOtCountdownMode: state.overtimeIndex === -4,
    timerOtRoundMode: isOtRoundLabelFromDropdown(state.roundLabel),
    otRoundElapsedSeconds: isOtRoundLabelFromDropdown(state.roundLabel)
      ? effectiveOtRoundElapsedSeconds({
          otRoundElapsedBaseSeconds: state.otRoundElapsedBaseSeconds,
          otRoundElapsedRunStartedAt: state.otRoundElapsedRunStartedAt,
          timerRunning: state.timerRunning,
        })
      : 0,
    showFinalWinnerHighlight: state.showFinalWinnerHighlight,
    timerCuesResetNonce: state.timerCuesResetNonce,
    otRoundTransferConsumed: state.otRoundTransferConsumed,
    otPlayDirection: state.otPlayDirection,
    leftCrossedSilhouettes: crossedFromCount(state.leftEliminatedCount),
    rightCrossedSilhouettes: crossedFromCount(state.rightEliminatedCount),
    updatedAt: state.updatedAt.toISOString(),
  };
}

export async function ensureLiveScoreboardState(tournamentId: string) {
  try {
    let state = await prisma.liveScoreboardState.findUnique({
      where: { tournamentId },
    });
    if (!state) {
      state = await prisma.liveScoreboardState.create({
        data: { tournamentId },
      });
    }
    return state;
  } catch (error) {
    if (!shouldRecoverLegacyLiveScoreboardSchema(error)) {
      throw error;
    }
    await recoverLegacyLiveScoreboardSchema();
    let state = await prisma.liveScoreboardState.findUnique({
      where: { tournamentId },
    });
    if (!state) {
      state = await prisma.liveScoreboardState.create({
        data: { tournamentId },
      });
    }
    return state;
  }
}

export async function getBoardPayload(tournamentId: string): Promise<BoardPayload> {
  let state = await ensureLiveScoreboardState(tournamentId);
  if (
    state.timerRunning &&
    state.timerEndsAt &&
    state.timerEndsAt.getTime() <= Date.now()
  ) {
    if (
      isOtRoundLabelFromDropdown(state.roundLabel) &&
      state.otRoundElapsedRunStartedAt
    ) {
      const delta = Math.floor(
        (Date.now() - state.otRoundElapsedRunStartedAt.getTime()) / 1000,
      );
      await prisma.liveScoreboardState.update({
        where: { tournamentId },
        data: {
          timerSeconds: 0,
          timerRunning: false,
          timerEndsAt: null,
          otRoundElapsedBaseSeconds: Math.max(
            0,
            state.otRoundElapsedBaseSeconds + delta,
          ),
          otRoundElapsedRunStartedAt: null,
        },
      });
    } else {
      await prisma.liveScoreboardState.update({
        where: { tournamentId },
        data: {
          timerSeconds: 0,
          timerRunning: false,
          timerEndsAt: null,
        },
      });
    }
    state = await prisma.liveScoreboardState.findUniqueOrThrow({
      where: { tournamentId },
    });
  }
  if (
    !state.timerRunning &&
    isOtRoundLabelFromDropdown(state.roundLabel) &&
    state.otRoundElapsedRunStartedAt
  ) {
    const fix = {
      roundLabel: state.roundLabel,
      timerRunning: state.timerRunning,
      otRoundElapsedBaseSeconds: state.otRoundElapsedBaseSeconds,
      otRoundElapsedRunStartedAt: state.otRoundElapsedRunStartedAt,
    };
    foldOtRoundElapsedOrphanAnchorWhenPaused(fix);
    await prisma.liveScoreboardState.update({
      where: { tournamentId },
      data: {
        otRoundElapsedBaseSeconds: fix.otRoundElapsedBaseSeconds,
        otRoundElapsedRunStartedAt: fix.otRoundElapsedRunStartedAt,
      },
    });
    state = await prisma.liveScoreboardState.findUniqueOrThrow({
      where: { tournamentId },
    });
  }
  const [leftP, rightP] = await Promise.all([
    state.leftPlayerId
      ? prisma.player.findUnique({
          where: { id: state.leftPlayerId },
          include: playerInclude,
        })
      : Promise.resolve(null),
    state.rightPlayerId
      ? prisma.player.findUnique({
          where: { id: state.rightPlayerId },
          include: playerInclude,
        })
      : Promise.resolve(null),
  ]);
  const rosterKey = rosterFileKeyForResultLog(state.currentRosterFileName);
  let logs: ResultLogLike[] = [];
  try {
    logs = await prisma.resultLog.findMany({
      where: { tournamentId },
      orderBy: { createdAt: "desc" },
      take: 240,
    });
  } catch (error) {
    console.warn("[getBoardPayload] ResultLog query failed:", error);
    logs = await getResultLogsCompat(tournamentId, rosterKey);
  }
  logs = logs
    .filter((r) => resultLogMatchesRosterKey(r, rosterKey))
    .slice(0, 80);
  const payload = toBoardPayload(state, leftP, rightP, logs);
  const t = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { trainingMode: true },
  });
  return { ...payload, trainingMode: Boolean(t?.trainingMode) };
}
