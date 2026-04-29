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
  /** True when `overtimeIndex === -1` (1:00 rest). */
  timerRestMode: boolean;
  /** True when `overtimeIndex === -2` (OT minute: count up 0:00→1:00 internally as 60→0 remaining). */
  timerOtCountUpMode: boolean;
  /** True when `overtimeIndex === -3` (OT armed: 1:00 paused, pick +/− then play). */
  timerOtArmedMode: boolean;
  /** True when `overtimeIndex === -4` (OT minute count-down from current time). */
  timerOtCountdownMode: boolean;
  /** True when round label is OT ROUND1 / OT ROUND 2 / OT ROUND 3 (dual timer on control). */
  timerOtRoundMode: boolean;
  /** Elapsed seconds for OT round secondary timer (control card only). */
  otRoundElapsedSeconds: number;
  /** Green winner highlight on overlays; cleared by Reset 1:00 after an OT-round final. */
  showFinalWinnerHighlight: boolean;
  /** Increments when the control clock is jumped by preset buttons so timer sounds do not false-trigger. */
  timerCuesResetNonce: number;
  /** OT round: elapsed→main transfer is active; press arrow again (paused) to undo. */
  otRoundTransferConsumed: boolean;
  /** Meaningful when OT armed (-3): 1 = count-up, -1 = count-down after play. */
  otPlayDirection: number;
  leftCrossedSilhouettes: number[];
  rightCrossedSilhouettes: number[];
  updatedAt: string;
  /** From Tournament.trainingMode — training files use TrainingMaster* lists. */
  trainingMode?: boolean;
};
