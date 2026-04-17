/** Shared API shape for GET/PATCH /api/board (safe for client import) */

export type BoardPlayerPayload = {
  displayName: string;
  teamName: string;
  /** Raw player last name when a roster athlete is selected (null for custom entry). */
  lastName?: string | null;
};

export type FinalResultType =
  | "LEFT"
  | "RIGHT"
  | "DRAW"
  | "NO_CONTEST"
  | "SUBMISSION_LEFT"
  | "SUBMISSION_RIGHT"
  | "ESCAPE_LEFT"
  | "ESCAPE_RIGHT"
  | "DQ_LEFT"
  | "DQ_RIGHT"
  | "MANUAL";

export type ResultLogEntry = {
  id: string;
  rosterFileName: string;
  roundLabel: string;
  leftName: string;
  rightName: string;
  leftTeamName: string | null;
  rightTeamName: string | null;
  resultType: FinalResultType;
  winnerName: string | null;
  createdAt: string;
  isManual: boolean;
  manualDate: string | null;
  manualTime: string | null;
  /** Set when a final is saved from Control; older rows may omit. */
  finalSummaryLine?: string | null;
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
  sound10Enabled: boolean;
  sound0Enabled: boolean;
  sound10PlayNonce: number;
  sound0PlayNonce: number;
  timerRestMode: boolean;
  leftCrossedSilhouettes: number[];
  rightCrossedSilhouettes: number[];
  updatedAt: string;
};
