/** Shared API shape for GET/PATCH /api/board (safe for client import) */

export type BoardPlayerPayload = {
  displayName: string;
  teamName: string;
};

export type FinalResultType = "LEFT" | "RIGHT" | "DRAW" | "NO_CONTEST";

export type ResultLogEntry = {
  id: string;
  rosterFileName: string;
  roundLabel: string;
  leftName: string;
  rightName: string;
  resultType: FinalResultType;
  winnerName: string | null;
  createdAt: string;
};

export type BoardPayload = {
  leftPlayerId: string | null;
  rightPlayerId: string | null;
  left: BoardPlayerPayload | null;
  right: BoardPlayerPayload | null;
  customLeftName: string | null;
  customLeftTeamName: string | null;
  customRightName: string | null;
  customRightTeamName: string | null;
  currentRosterFileName: string;
  roundLabel: string;
  finalSaved: boolean;
  finalResultType: FinalResultType | null;
  finalWinnerName: string | null;
  resultsLog: ResultLogEntry[];
  secondsRemaining: number;
  timerRunning: boolean;
  timerPhase: "REGULATION" | "OVERTIME";
  overtimeIndex: number;
  overtimeWinsLeft: number;
  overtimeWinsRight: number;
  leftEliminatedCount: number;
  rightEliminatedCount: number;
  leftCrossedSilhouettes: number[];
  rightCrossedSilhouettes: number[];
  updatedAt: string;
};
