import type { BoardPayload, FinalResultType } from "@/types/board";
import { finalWinnerIsLeft, finalWinnerIsRight } from "@/lib/board-final-display";

function splitFirstLast(displayName: string): { first: string; last: string } {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0]!, last: "" };
  return { first: parts[0]!, last: parts.slice(1).join(" ") };
}

function methodSuffix(rt: FinalResultType): "SUB" | "ESC" | "DQ" | "WIN" | null {
  if (rt.startsWith("SUBMISSION_")) return "SUB";
  if (rt.startsWith("ESCAPE_")) return "ESC";
  if (rt.startsWith("DQ_")) return "DQ";
  if (rt === "LEFT" || rt === "RIGHT") return "WIN";
  return null;
}

/**
 * Single-line summary for Control card header after a final is saved.
 * Examples: FINAL: JANE DOE ACME JIU-JITSU BY SUB, FINAL: DRAW, FINAL: NO CONTEST
 */
export function formatControlCardFinalHeader(board: BoardPayload): string | null {
  if (!board.finalSaved || !board.finalResultType) return null;
  const rt = board.finalResultType;
  if (rt === "DRAW") return "FINAL: DRAW";
  if (rt === "NO_CONTEST") return "FINAL: NO CONTEST";
  if (rt === "MANUAL") return "FINAL: MANUAL";

  const winLeft = finalWinnerIsLeft(rt);
  const winRight = finalWinnerIsRight(rt);
  if (!winLeft && !winRight) return null;

  const method = methodSuffix(rt);
  if (!method) {
    return board.finalWinnerName
      ? `FINAL: ${board.finalWinnerName}`.replace(/\s+/g, " ").trim().toUpperCase()
      : null;
  }

  const slot = winLeft ? board.left : board.right;
  const team = (slot?.teamName ?? "").trim() || "—";

  if (!slot?.displayName?.trim()) {
    const fallback = board.finalWinnerName?.trim();
    return fallback
      ? `FINAL: ${fallback} BY ${method}`.replace(/\s+/g, " ").trim().toUpperCase()
      : `FINAL: BY ${method}`.replace(/\s+/g, " ").trim().toUpperCase();
  }

  const { first, last } = splitFirstLast(slot.displayName);
  const namePart = [first, last].filter(Boolean).join(" ").trim() || slot.displayName.trim();
  const core = [namePart, team].filter(Boolean).join(" ");
  return `FINAL: ${core} BY ${method}`.replace(/\s+/g, " ").trim().toUpperCase();
}
