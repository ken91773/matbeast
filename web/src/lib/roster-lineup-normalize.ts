import type {
  RosterFileDocument,
  RosterFilePlayer,
  RosterFileTeam,
} from "@/lib/roster-file-types";

/**
 * Next free integer ≥ 8 for bench / overflow (never consumes quintet 1–7).
 * Some deployed SQLite DBs still enforce NOT NULL on `lineupOrder`; using 8+
 * matches `team-lineup.ts` patterns and avoids null inserts.
 */
function takeOverflowSlot(used: Set<number>): number {
  for (let s = 8; ; s++) {
    if (!used.has(s)) {
      used.add(s);
      return s;
    }
  }
}

/** Prefer 1–7, then 8+ (for duplicate resolution when quintet is full). */
function takeQuintetOrOverflowSlot(used: Set<number>): number {
  for (let s = 1; s <= 7; s++) {
    if (!used.has(s)) {
      used.add(s);
      return s;
    }
  }
  return takeOverflowSlot(used);
}

/**
 * Coerce names for import/apply (empty strings allowed).
 * Per team, file order wins. Duplicates take the next free slot in 1–7, then 8+.
 * Explicit bench (`lineupOrder` null) uses 8+ only — never steals 1–7.
 * Never emits `null` for `lineupOrder` so legacy NOT NULL columns still import.
 */
export function normalizeRosterDocumentLineups(
  doc: RosterFileDocument,
): RosterFileDocument {
  return {
    ...doc,
    teams: doc.teams.map(normalizeTeamLineups),
  };
}

function normalizeTeamLineups(team: RosterFileTeam): RosterFileTeam {
  const used = new Set<number>();
  const players: RosterFilePlayer[] = team.players.map((p) => {
    const firstName = typeof p.firstName === "string" ? p.firstName : "";
    const lastName = typeof p.lastName === "string" ? p.lastName : "";
    let lo = p.lineupOrder;
    if (lo != null && (!Number.isInteger(lo) || lo < 1 || lo > 7)) {
      lo = null;
    }

    let lineupOrder: number;
    if (lo == null) {
      lineupOrder = takeOverflowSlot(used);
    } else if (!used.has(lo)) {
      used.add(lo);
      lineupOrder = lo;
    } else {
      lineupOrder = takeQuintetOrOverflowSlot(used);
    }
    return {
      ...p,
      firstName,
      lastName,
      lineupOrder,
    };
  });
  return { ...team, players };
}
