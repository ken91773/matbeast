import type { BoardPayload } from "@/types/board";

/** Wall-clock seconds shown on scoreboard (count-down except OT count-up minute). */
export function scoreboardDisplayedWallSeconds(
  board: Pick<
    BoardPayload,
    | "secondsRemaining"
    | "timerOtCountUpMode"
    | "timerOtArmedMode"
    | "otPlayDirection"
  >,
): number {
  if (board.timerOtCountUpMode) {
    return Math.min(60, Math.max(0, 60 - board.secondsRemaining));
  }
  if (board.timerOtArmedMode) {
    return Math.min(60, Math.max(0, board.secondsRemaining));
  }
  return board.secondsRemaining;
}

export function formatWallMss(totalSec: number) {
  const sec = Math.max(0, Math.trunc(totalSec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
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
  const t = formatWallMss(scoreboardDisplayedWallSeconds(board));
  if (board.timerOtCountUpMode) return `+${t}`;
  if (board.timerOtArmedMode && board.otPlayDirection !== -1) {
    return `+${t}`;
  }
  return t;
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
  if (board.timerOtRoundMode) return board.roundLabel ?? "";
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
