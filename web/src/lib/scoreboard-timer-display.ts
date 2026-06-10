import type { BoardPayload } from "@/types/board";
import { otRoundLabelParts } from "@/lib/ot-round-label";
import { SCOREBOARD_OT_MAIN_HEX } from "@/lib/scoreboard-ot-colors";

/** Wall-clock seconds shown on scoreboard (count-down except OT count-up minute). */
export function scoreboardDisplayedWallSeconds(
  board: Pick<
    BoardPayload,
    "timerOtCountUpMode" | "timerOtArmedMode" | "otPlayDirection"
  >,
  secondsRemaining: number,
): number {
  const sec = secondsRemaining;
  if (board.timerOtCountUpMode) {
    return Math.min(60, Math.max(0, 60 - sec));
  }
  if (board.timerOtArmedMode) {
    return Math.min(60, Math.max(0, sec));
  }
  return sec;
}

export function formatWallMss(totalSec: number) {
  const sec = Math.max(0, Math.trunc(totalSec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function scoreboardTimerLineFromRemaining(
  board: Pick<
    BoardPayload,
    | "timerOtCountUpMode"
    | "timerOtArmedMode"
    | "otPlayDirection"
  >,
  secondsRemaining: number,
): string {
  const t = formatWallMss(
    scoreboardDisplayedWallSeconds(board, secondsRemaining),
  );
  if (board.timerOtCountUpMode) return `+${t}`;
  if (board.timerOtArmedMode && board.otPlayDirection !== -1) {
    return `+${t}`;
  }
  return t;
}

export function scoreboardTimerLineFromBoard(
  board:
    | Pick<
        BoardPayload,
        | "secondsRemaining"
        | "timerOtCountUpMode"
        | "timerOtArmedMode"
        | "otPlayDirection"
      >
    | undefined,
): string {
  if (!board) return "—:—";
  return scoreboardTimerLineFromRemaining(board, board.secondsRemaining);
}

/** Second line under the match clock (matches overlay Control semantics). */
export function scoreboardSubclockRoundLabelFromBoard(
  board:
    | Pick<
        BoardPayload,
        | "timerRestMode"
        | "timerOtCountUpMode"
        | "timerOtArmedMode"
        | "timerOtCountdownMode"
        | "timerOtRoundMode"
        | "roundLabel"
      >
    | undefined,
): string {
  if (!board) return "";
  if (board.timerRestMode) return "REST PERIOD";
  if (board.timerOtRoundMode) {
    return otRoundLabelParts(board.roundLabel)?.baseLabel ?? board.roundLabel ?? "";
  }
  if (
    board.timerOtCountUpMode ||
    board.timerOtArmedMode ||
    board.timerOtCountdownMode
  ) {
    return "OT PERIOD";
  }
  return board.roundLabel ?? "";
}

/** Red OT styling on control + scoreboard (armed, count-up, or OT count-down minute). */
export function scoreboardOtRedTimerStyle(
  board:
    | Pick<
        BoardPayload,
        | "timerOtCountUpMode"
        | "timerOtArmedMode"
        | "timerOtCountdownMode"
        | "timerOtRoundMode"
      >
    | undefined,
): boolean {
  if (board?.timerOtRoundMode) return false;
  return Boolean(
    board?.timerOtCountUpMode ||
      board?.timerOtArmedMode ||
      board?.timerOtCountdownMode,
  );
}

/**
 * Match-clock text color. White only while the timer is actively counting
 * down; red whenever it is paused/stopped (not moving). REST keeps its amber
 * and OT keeps its dedicated red, both of which take precedence.
 */
export function scoreboardTimerColorHex(
  board:
    | Pick<
        BoardPayload,
        | "timerRunning"
        | "timerRestMode"
        | "timerOtCountUpMode"
        | "timerOtArmedMode"
        | "timerOtCountdownMode"
        | "timerOtRoundMode"
      >
    | undefined,
): string {
  if (board?.timerRestMode) return "#fcd34d";
  if (scoreboardOtRedTimerStyle(board)) return SCOREBOARD_OT_MAIN_HEX;
  return board?.timerRunning ? "#e5e7eb" : SCOREBOARD_OT_MAIN_HEX;
}
