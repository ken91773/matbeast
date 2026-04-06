import type {
  LiveScoreboardState,
  Player,
  ResultLog,
  Team,
} from "@prisma/client";
import type { BoardPayload } from "@/types/board";
import { prisma } from "./prisma";

const LIVE_ID = "live";

/** 0-based silhouette index from left → right; cross order: center, then outward */
export const INNER_FIRST_SILHOUETTE_INDEX = [2, 1, 3, 0, 4] as const;

export type { BoardPayload };

const playerInclude = { team: true };

type PlayerWithTeam = Player & { team: Team };

function displayName(p: PlayerWithTeam) {
  if (p.nickname?.trim()) return p.nickname.trim();
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

export function toBoardPayload(
  state: LiveScoreboardState,
  leftP: PlayerWithTeam | null,
  rightP: PlayerWithTeam | null,
  resultsLog: ResultLog[] = [],
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
      ? { displayName: leftDisplay, teamName: leftTeam }
      : null,
    right: rightDisplay
      ? { displayName: rightDisplay, teamName: rightTeam }
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
      resultType: r.resultType,
      winnerName: r.winnerName,
      createdAt: r.createdAt.toISOString(),
    })),
    secondsRemaining: effectiveSeconds(state),
    timerRunning: state.timerRunning,
    timerPhase: state.timerPhase,
    overtimeIndex: state.overtimeIndex,
    overtimeWinsLeft: state.overtimeWinsLeft,
    overtimeWinsRight: state.overtimeWinsRight,
    leftEliminatedCount: state.leftEliminatedCount,
    rightEliminatedCount: state.rightEliminatedCount,
    leftCrossedSilhouettes: crossedFromCount(state.leftEliminatedCount),
    rightCrossedSilhouettes: crossedFromCount(state.rightEliminatedCount),
    updatedAt: state.updatedAt.toISOString(),
  };
}

export async function ensureLiveScoreboardState() {
  let state = await prisma.liveScoreboardState.findUnique({
    where: { id: LIVE_ID },
  });
  if (!state) {
    state = await prisma.liveScoreboardState.create({
      data: { id: LIVE_ID },
    });
  }
  return state;
}

export async function getBoardPayload(): Promise<BoardPayload> {
  const state = await ensureLiveScoreboardState();
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
  const logs = await prisma.resultLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 25,
  });
  return toBoardPayload(state, leftP, rightP, logs);
}
