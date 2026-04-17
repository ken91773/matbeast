import type { FinalResultType } from "@/types/board";

/** Overlay / UI: left corner is the recorded winner */
export function finalWinnerIsLeft(type: FinalResultType | null): boolean {
  if (!type) return false;
  if (type === "LEFT" || type === "SUBMISSION_LEFT" || type === "ESCAPE_LEFT")
    return true;
  if (type === "DQ_RIGHT") return true;
  return false;
}

/** Overlay / UI: right corner is the recorded winner */
export function finalWinnerIsRight(type: FinalResultType | null): boolean {
  if (!type) return false;
  if (type === "RIGHT" || type === "SUBMISSION_RIGHT" || type === "ESCAPE_RIGHT")
    return true;
  if (type === "DQ_LEFT") return true;
  return false;
}

export function formatFinalResultLabel(type: FinalResultType): string {
  switch (type) {
    case "LEFT":
      return "WIN";
    case "RIGHT":
      return "WIN";
    case "DRAW":
      return "DRAW";
    case "NO_CONTEST":
      return "NO CONTEST";
    case "SUBMISSION_LEFT":
      return "SUBMISSION";
    case "SUBMISSION_RIGHT":
      return "SUBMISSION";
    case "ESCAPE_LEFT":
      return "ESCAPE";
    case "ESCAPE_RIGHT":
      return "ESCAPE";
    case "DQ_LEFT":
      return "DQ";
    case "DQ_RIGHT":
      return "DQ";
    case "MANUAL":
      return "MANUAL";
    default:
      return String(type).replaceAll("_", " ");
  }
}
