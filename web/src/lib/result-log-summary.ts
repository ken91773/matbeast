import type { FinalResultType } from "@/types/board";
import { isOtRoundLabelFromDropdown } from "@/lib/ot-round-label";

export type FighterSummary = {
  team: string;
  first: string;
  last: string;
};

function pad2(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

function fmtClockTotalSec(totalSec: number) {
  const s = Math.max(0, Math.trunc(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${pad2(r)}`;
}

function effectiveTimerRemainSeconds(
  timerRunning: boolean,
  timerEndsAt: Date | null,
  timerSeconds: number,
): number {
  if (!timerRunning || !timerEndsAt) return Math.max(0, timerSeconds);
  const ms = timerEndsAt.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 1000));
}

/** Round text stored on final result rows when the scoreboard subclock shows OT/REST. */
export function resultRoundLabelForResultLog(params: {
  overtimeIndex: number;
  roundLabel: string;
}): string {
  const oi = params.overtimeIndex;
  if (isOtRoundLabelFromDropdown(params.roundLabel)) {
    return params.roundLabel.trim();
  }
  if (oi === -1) return "REST PERIOD";
  if (oi === -2 || oi === -3 || oi === -4) return "OT PERIOD";
  const r = params.roundLabel.trim();
  return r || "Quarter Finals";
}

/** Match clock as recorded on final save (count-down, or OT count-up 0:00–1:00 as `OT M:SS`). */
export function formatMatchClockForResultSummary(
  overtimeIndex: number,
  timerRunning: boolean,
  timerEndsAt: Date | null,
  timerSeconds: number,
  opts?: { otRoundElapsedSeconds?: number | null },
): string {
  if (opts?.otRoundElapsedSeconds != null) {
    return fmtClockTotalSec(opts.otRoundElapsedSeconds);
  }
  const sec = effectiveTimerRemainSeconds(timerRunning, timerEndsAt, timerSeconds);
  if (overtimeIndex === -2) {
    const elapsed = Math.min(60, Math.max(0, 60 - sec));
    return `OT ${fmtClockTotalSec(elapsed)}`;
  }
  if (overtimeIndex === -3 || overtimeIndex === -4) {
    return `OT ${fmtClockTotalSec(sec)}`;
  }
  return fmtClockTotalSec(sec);
}

/** US-style date and 24h time as in "1/1/2026 14:28" */
export function formatFinalSavedAt(d: Date): { dateStr: string; timeStr: string } {
  return {
    dateStr: `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`,
    timeStr: `${d.getHours()}:${pad2(d.getMinutes())}`,
  };
}

/** 12-hour clock, e.g. "3:07 PM" */
export function formatTime12h(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const suffix = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${pad2(m)} ${suffix}`;
}

export function winnerLoserFromResultType(
  resultType: FinalResultType,
  left: FighterSummary,
  right: FighterSummary,
): { winner: FighterSummary; loser: FighterSummary } | null {
  switch (resultType) {
    case "LEFT":
    case "SUBMISSION_LEFT":
    case "ESCAPE_LEFT":
      return { winner: left, loser: right };
    case "RIGHT":
    case "SUBMISSION_RIGHT":
    case "ESCAPE_RIGHT":
      return { winner: right, loser: left };
    case "DQ_LEFT":
      return { winner: right, loser: left };
    case "DQ_RIGHT":
      return { winner: left, loser: right };
    case "DRAW":
    case "NO_CONTEST":
    case "MANUAL":
      return null;
    default:
      return null;
  }
}

function fighterDisplayForSummary(f: FighterSummary): string {
  const nm = `${f.first} ${f.last}`.trim().toUpperCase() || "—";
  const team = f.team.trim().toUpperCase();
  if (!team || team === "TBD") return nm;
  return `${nm} (${team})`;
}

function outcomeAbbrevForSummary(
  resultType: FinalResultType,
): "SUB" | "ESC" | "DQ" | null {
  if (resultType.startsWith("SUBMISSION_")) return "SUB";
  if (resultType.startsWith("ESCAPE_")) return "ESC";
  if (resultType.startsWith("DQ_")) return "DQ";
  return null;
}

export function buildFinalSummaryLine(
  savedAt: Date,
  resultType: FinalResultType,
  left: FighterSummary,
  right: FighterSummary,
  roundLabel?: string | null,
  matchClock?: string | null,
  matchClockVerb: "clock" | "elapsed" = "clock",
): string | null {
  const wl = winnerLoserFromResultType(resultType, left, right);
  if (!wl) return null;
  const timeStr = formatTime12h(savedAt);
  const w = fighterDisplayForSummary(wl.winner);
  const l = fighterDisplayForSummary(wl.loser);
  const method = outcomeAbbrevForSummary(resultType);
  const by = method ? ` by ${method}` : "";
  const round = roundLabel?.trim() ?? "";
  const roundSuffix = round ? ` — ${round.toUpperCase()}` : "";
  const clockSuffix = matchClock?.trim()
    ? matchClockVerb === "elapsed"
      ? ` | Elapsed: ${matchClock.trim()}`
      : ` | clock ${matchClock.trim()}`
    : "";
  return `${timeStr} ${w} def ${l}${by}${roundSuffix}${clockSuffix}`;
}

export function fighterSummaryFromPlayerOrCustom(
  customName: string | null | undefined,
  customTeam: string | null | undefined,
  player: { firstName: string; lastName: string; team: { name: string } } | null,
): FighterSummary {
  const team = (customTeam?.trim() || player?.team.name || "").trim();
  if (player && !customName?.trim()) {
    return {
      team,
      first: player.firstName.trim(),
      last: player.lastName.trim(),
    };
  }
  const s = (customName?.trim() || "").trim();
  const idx = s.indexOf(" ");
  if (idx === -1) {
    return { team, first: s, last: "" };
  }
  return {
    team,
    first: s.slice(0, idx).trim(),
    last: s.slice(idx + 1).trim(),
  };
}

function splitNameFirstRest(combined: string): { first: string; last: string } {
  const s = combined.trim();
  const idx = s.indexOf(" ");
  if (idx === -1) return { first: s, last: "" };
  return { first: s.slice(0, idx).trim(), last: s.slice(idx + 1).trim() };
}

/** Single-line finals text for log UI; manual rows return null. */
export function getResultLogOneLine(r: {
  finalSummaryLine?: string | null;
  isManual: boolean;
  roundLabel?: string | null;
  resultType: FinalResultType;
  leftName: string;
  rightName: string;
  leftTeamName: string | null;
  rightTeamName: string | null;
  createdAt: string;
}): string | null {
  if (r.isManual) return null;
  const round = r.roundLabel?.trim() ?? "";
  const withRound = (line: string) =>
    round && !line.toUpperCase().includes(`— ${round.toUpperCase()}`)
      ? `${line} — ${round.toUpperCase()}`
      : line;
  const savedLine = r.finalSummaryLine?.trim() ?? "";
  if (savedLine) {
    const hasTeamInSavedLine = /\([^)]+\)/.test(savedLine);
    const hasTeamFields =
      Boolean(r.leftTeamName?.trim()) || Boolean(r.rightTeamName?.trim());
    // Keep existing stored line when it already includes team text, or when there
    // is no structured team data to rebuild from on this row.
    if (hasTeamInSavedLine || !hasTeamFields) {
      return withRound(savedLine);
    }
  }
  const lf = splitNameFirstRest(r.leftName);
  const rf = splitNameFirstRest(r.rightName);
  const left: FighterSummary = {
    team: (r.leftTeamName ?? "").trim(),
    first: lf.first,
    last: lf.last,
  };
  const right: FighterSummary = {
    team: (r.rightTeamName ?? "").trim(),
    first: rf.first,
    last: rf.last,
  };
  return buildFinalSummaryLine(
    new Date(r.createdAt),
    r.resultType,
    left,
    right,
    r.roundLabel,
    null,
  );
}
