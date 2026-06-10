import type { BoardPayload } from "@/types/board";
import { otRoundLabelParts } from "@/lib/ot-round-label";

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
 * Broadcast scoreboard match-clock text color. The clock number behaves
 * identically in OT and regulation: it stays white whether the timer is
 * running OR stopped, so the audience never sees a red "stopped" indicator and
 * the overlay can halt on a white time (stop-freeze guard). REST keeps its
 * amber, which takes precedence. The operator's Control Panel has its own
 * red/white stopped indicator (inline in ControlPanel.tsx) so the operator
 * still knows the clock has stopped. (The OT "OT PERIOD" sub-label keeps its
 * red identity via `scoreboardOtRedTimerStyle` — that is a static label, not
 * the clock's running/stopped color behavior.)
 */
export function scoreboardTimerColorHex(
  board: Pick<BoardPayload, "timerRunning" | "timerRestMode"> | undefined,
): string {
  if (board?.timerRestMode) return "#fcd34d";
  return "#e5e7eb";
}
