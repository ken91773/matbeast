import type { Prisma } from "@prisma/client";
import { formatFinalSavedAt } from "@/lib/result-log-summary";
import { prisma } from "./prisma";
import { getPrimaryEventIdOrThrow } from "./events";

/** Distinct from mat `Grand Final` / control saves — bracket-only GF result rows. */
const BRACKET_GF_RESULT_ROUND = "Bracket — Grand Final";

async function tryAppendBracketGrandFinalResultLog(
  tournamentId: string,
  match: {
    round: string;
    winnerTeamId: string | null;
    homeTeam: { id: string; name: string };
    awayTeam: { id: string; name: string };
    winnerTeam: { name: string } | null;
  },
) {
  if (match.round !== "GRAND_FINAL" || !match.winnerTeamId || !match.winnerTeam) {
    return;
  }
  const home = match.homeTeam;
  const away = match.awayTeam;
  const w = match.winnerTeam;
  const loser = match.winnerTeamId === home.id ? away : home;
  const savedAt = new Date();
  const { dateStr, timeStr } = formatFinalSavedAt(savedAt);
  const winName = (w.name || "").trim() || "—";
  const loseName = (loser.name || "").trim() || "—";
  const finalSummaryLine = `${dateStr} ${timeStr} Grand Final: ${winName} def. ${loseName}`;

  let rosterFileName = "UNTITLED";
  try {
    const ls = await prisma.liveScoreboardState.findUnique({
      where: { tournamentId },
      select: { currentRosterFileName: true },
    });
    if (ls?.currentRosterFileName?.trim()) {
      rosterFileName = ls.currentRosterFileName.trim();
    }
  } catch {
    /* ignore */
  }

  const baseData = {
    tournamentId,
    rosterFileName,
    roundLabel: BRACKET_GF_RESULT_ROUND,
    leftName: home.name,
    rightName: away.name,
    leftTeamName: home.name,
    rightTeamName: away.name,
    resultType:
      match.winnerTeamId === home.id
        ? ("LEFT" as const)
        : ("RIGHT" as const),
    winnerName: winName,
    isManual: false,
    manualDate: null,
    manualTime: null,
  };

  try {
    await prisma.resultLog.deleteMany({
      where: {
        tournamentId,
        roundLabel: BRACKET_GF_RESULT_ROUND,
        isManual: false,
      },
    });
    try {
      await prisma.resultLog.create({
        data: { ...baseData, finalSummaryLine },
      });
    } catch {
      try {
        await prisma.resultLog.create({ data: baseData });
      } catch (e2) {
        console.warn("[bracket-engine] ResultLog create (no summary column):", e2);
      }
    }
  } catch (e) {
    console.warn("[bracket-engine] Grand Final ResultLog:", e);
  }
}

async function syncBracketGrandFinalResultLog(
  tournamentId: string,
  full: {
    round: string;
    winnerTeamId: string | null;
    homeTeam: { id: string; name: string };
    awayTeam: { id: string; name: string };
    winnerTeam: { name: string } | null;
  } | null,
) {
  if (!full || full.round !== "GRAND_FINAL") return;
  if (!full.winnerTeamId) {
    try {
      await prisma.resultLog.deleteMany({
        where: {
          tournamentId,
          roundLabel: BRACKET_GF_RESULT_ROUND,
          isManual: false,
        },
      });
    } catch (e) {
      console.warn("[bracket-engine] clear GF ResultLog:", e);
    }
    return;
  }
  await tryAppendBracketGrandFinalResultLog(tournamentId, full);
}

/** 1v8, 4v5, 3v6, 2v7 — standard single-elimination for seeds 1–8 */
const QF_PAIR_SEED_INDICES: [number, number][] = [
  [0, 7],
  [3, 4],
  [2, 5],
  [1, 6],
];

function isByeName(name: string) {
  const t = name.trim().toUpperCase();
  return t === "" || t === "TBD" || t === "BYE";
}

/** Non-bye side wins immediately when the opponent is a bye/TBD placeholder. */
async function byeWalkoverWinnerId(
  tx: Prisma.TransactionClient,
  homeTeamId: string,
  awayTeamId: string,
): Promise<string | null> {
  const teams = await tx.team.findMany({
    where: { id: { in: [homeTeamId, awayTeamId] } },
    select: { id: true, name: true },
  });
  const home = teams.find((t) => t.id === homeTeamId);
  const away = teams.find((t) => t.id === awayTeamId);
  if (!home || !away) return null;
  const hBye = isByeName(home.name);
  const aBye = isByeName(away.name);
  if (hBye && !aBye) return away.id;
  if (aBye && !hBye) return home.id;
  return null;
}

/** Fill `winnerTeamId` for matches where one side is a bye and no winner yet. */
async function applyByeWalkoversToRound(
  tx: Prisma.TransactionClient,
  eventId: string,
  round: "QUARTER_FINAL" | "SEMI_FINAL" | "GRAND_FINAL",
) {
  const matches = await tx.bracketMatch.findMany({ where: { eventId, round } });
  for (const m of matches) {
    if (m.winnerTeamId) continue;
    const win = await byeWalkoverWinnerId(tx, m.homeTeamId, m.awayTeamId);
    if (win) {
      await tx.bracketMatch.update({
        where: { id: m.id },
        data: { winnerTeamId: win },
      });
    }
  }
}

const matchInclude = {
  homeTeam: true,
  awayTeam: true,
  winnerTeam: true,
} as const;

export type BracketMatchDTO = Prisma.BracketMatchGetPayload<{
  include: typeof matchInclude;
}>;

export async function loadBracketForTournament(
  tournamentId: string,
): Promise<{ eventId: string; matches: BracketMatchDTO[] }> {
  const eventId = await getPrimaryEventIdOrThrow(tournamentId);
  const matches = await prisma.bracketMatch.findMany({
    where: { eventId },
    include: matchInclude,
    orderBy: [{ round: "asc" }, { bracketIndex: "asc" }],
  });
  return { eventId, matches };
}

export async function generateBracketFromSeeds(tournamentId: string) {
  const eventId = await getPrimaryEventIdOrThrow(tournamentId);
  const teams = await prisma.team.findMany({
    where: { eventId },
    orderBy: { seedOrder: "asc" },
  });
  if (teams.length === 0) {
    throw new Error("No teams found.");
  }
  const seeds = teams.map((t) => t.seedOrder);
  const bad = seeds.some((s) => s < 1 || s > 8) || new Set(seeds).size !== 8;
  if (bad) {
    throw new Error("Teams must have unique seeds 1 through 8.");
  }
  const teamsBySeed = [...teams].sort((a, b) => a.seedOrder - b.seedOrder);
  const namedTeams = teamsBySeed.filter((t) => !isByeName(t.name));
  const byeTeams = teamsBySeed.filter((t) => isByeName(t.name));

  await prisma.$transaction(async (tx) => {
    await tx.bracketMatch.deleteMany({ where: { eventId } });
    if (namedTeams.length <= 4 && byeTeams.length > 0) {
      for (let i = 0; i < 4; i++) {
        const a = byeTeams[i % byeTeams.length];
        const b = byeTeams[(i + 1) % byeTeams.length];
        await tx.bracketMatch.create({
          data: {
            eventId,
            round: "QUARTER_FINAL",
            bracketIndex: i,
            homeTeamId: a.id,
            awayTeamId: b.id,
          },
        });
      }
      const semiTeams = [...namedTeams];
      while (semiTeams.length < 4 && byeTeams.length > 0) {
        semiTeams.push(byeTeams[semiTeams.length % byeTeams.length]);
      }
      if (semiTeams.length >= 4) {
        await tx.bracketMatch.create({
          data: {
            eventId,
            round: "SEMI_FINAL",
            bracketIndex: 0,
            homeTeamId: semiTeams[0].id,
            awayTeamId: semiTeams[3].id,
          },
        });
        await tx.bracketMatch.create({
          data: {
            eventId,
            round: "SEMI_FINAL",
            bracketIndex: 1,
            homeTeamId: semiTeams[1].id,
            awayTeamId: semiTeams[2].id,
          },
        });
      }
      await syncDownstreamRounds(tx, eventId);
      return;
    }
    /**
     * v1.2.4 diagnostic: log per-QF auto-winner decision so when a
     * user reports "team paired with BYE didn't auto-advance", we can
     * read `bundled-server.log` and confirm whether the team name was
     * actually classified as a BYE by `isByeName`. If a user names a
     * team something like "BYE 1" or "Bye-A" instead of literal "BYE"
     * / "TBD" / "" the auto-advance never fires — the log will show
     * `homeIsBye=false, awayIsBye=false, autoWinner=null` for that
     * pairing, pointing the fix at name normalization rather than the
     * generation logic.
     */
    const autoAdvanceLog: Array<{
      bracketIndex: number;
      home: string;
      away: string;
      homeIsBye: boolean;
      awayIsBye: boolean;
      autoWinner: "home" | "away" | null;
    }> = [];
    for (let i = 0; i < 4; i++) {
      const [ia, ib] = QF_PAIR_SEED_INDICES[i];
      const home = teamsBySeed[ia];
      const away = teamsBySeed[ib];
      const homeIsBye = isByeName(home.name);
      const awayIsBye = isByeName(away.name);
      const autoWinner =
        homeIsBye && !awayIsBye
          ? away.id
          : awayIsBye && !homeIsBye
            ? home.id
            : null;
      autoAdvanceLog.push({
        bracketIndex: i,
        home: home.name,
        away: away.name,
        homeIsBye,
        awayIsBye,
        autoWinner: autoWinner === home.id ? "home" : autoWinner === away.id ? "away" : null,
      });
      await tx.bracketMatch.create({
        data: {
          eventId,
          round: "QUARTER_FINAL",
          bracketIndex: i,
          homeTeamId: home.id,
          awayTeamId: away.id,
          winnerTeamId: autoWinner,
        },
      });
    }
    await applyByeWalkoversToRound(tx, eventId, "QUARTER_FINAL");
    await syncDownstreamRounds(tx, eventId);
    try {
      console.log(
        "[generateBracketFromSeeds][v1.2.4] QF auto-advance",
        JSON.stringify({ tournamentId, autoAdvance: autoAdvanceLog }),
      );
    } catch {
      /* logging only */
    }
  });

  return loadBracketForTournament(tournamentId);
}

export async function syncDownstreamRounds(
  tx: Prisma.TransactionClient,
  eventId: string,
) {
  const eventTeams = await tx.team.findMany({
    where: { eventId },
    select: { id: true, name: true },
  });
  const byeIds = new Set(
    eventTeams.filter((t) => isByeName(t.name)).map((t) => t.id),
  );
  const qf = await tx.bracketMatch.findMany({
    where: { eventId, round: "QUARTER_FINAL" },
    orderBy: { bracketIndex: "asc" },
  });
  if (qf.length !== 4) {
    await tx.bracketMatch.deleteMany({
      where: { eventId, round: { in: ["SEMI_FINAL", "GRAND_FINAL"] } },
    });
    return;
  }
  const w = qf.map((m) => m.winnerTeamId);
  const presetSemis =
    qf.every((m) => byeIds.has(m.homeTeamId) && byeIds.has(m.awayTeamId)) &&
    (await tx.bracketMatch.count({ where: { eventId, round: "SEMI_FINAL" } })) > 0;

  async function ensureSemi(bracketIndex: 0 | 1, i: number, j: number) {
    if (!w[i] || !w[j]) {
      await tx.bracketMatch.deleteMany({
        where: { eventId, round: "SEMI_FINAL", bracketIndex },
      });
      return;
    }
    const home = w[i]!;
    const away = w[j]!;
    const byeWinner = await byeWalkoverWinnerId(tx, home, away);
    const existing = await tx.bracketMatch.findFirst({
      where: { eventId, round: "SEMI_FINAL", bracketIndex },
    });
    if (!existing) {
      await tx.bracketMatch.create({
        data: {
          eventId,
          round: "SEMI_FINAL",
          bracketIndex,
          homeTeamId: home,
          awayTeamId: away,
          winnerTeamId: byeWinner,
        },
      });
    } else if (existing.homeTeamId !== home || existing.awayTeamId !== away) {
      await tx.bracketMatch.update({
        where: { id: existing.id },
        data: {
          homeTeamId: home,
          awayTeamId: away,
          winnerTeamId: byeWinner,
        },
      });
    } else if (byeWinner && !existing.winnerTeamId) {
      await tx.bracketMatch.update({
        where: { id: existing.id },
        data: { winnerTeamId: byeWinner },
      });
    }
  }

  if (!presetSemis) {
    await ensureSemi(0, 0, 1);
    await ensureSemi(1, 2, 3);
  }
  await applyByeWalkoversToRound(tx, eventId, "SEMI_FINAL");

  const sf = await tx.bracketMatch.findMany({
    where: { eventId, round: "SEMI_FINAL" },
    orderBy: { bracketIndex: "asc" },
  });
  if (sf.length < 2 || !sf[0].winnerTeamId || !sf[1].winnerTeamId) {
    await tx.bracketMatch.deleteMany({
      where: { eventId, round: "GRAND_FINAL" },
    });
    return;
  }
  const gHome = sf[0].winnerTeamId;
  const gAway = sf[1].winnerTeamId;
  const gByeWinner = await byeWalkoverWinnerId(tx, gHome, gAway);
  const gf = await tx.bracketMatch.findFirst({
    where: { eventId, round: "GRAND_FINAL", bracketIndex: 0 },
  });
  if (!gf) {
    await tx.bracketMatch.create({
      data: {
        eventId,
        round: "GRAND_FINAL",
        bracketIndex: 0,
        homeTeamId: gHome,
        awayTeamId: gAway,
        winnerTeamId: gByeWinner,
      },
    });
  } else if (gf.homeTeamId !== gHome || gf.awayTeamId !== gAway) {
    await tx.bracketMatch.update({
      where: { id: gf.id },
      data: {
        homeTeamId: gHome,
        awayTeamId: gAway,
        winnerTeamId: gByeWinner,
      },
    });
  } else if (gByeWinner && !gf.winnerTeamId) {
    await tx.bracketMatch.update({
      where: { id: gf.id },
      data: { winnerTeamId: gByeWinner },
    });
  }
  await applyByeWalkoversToRound(tx, eventId, "GRAND_FINAL");
}

export async function setBracketMatchWinner(
  matchId: string,
  winnerTeamId: string | null,
): Promise<{ eventId: string; matches: BracketMatchDTO[] }> {
  const match = await prisma.bracketMatch.findUnique({
    where: { id: matchId },
  });
  if (!match) {
    throw new Error("Match not found");
  }

  if (winnerTeamId !== null) {
    if (
      winnerTeamId !== match.homeTeamId &&
      winnerTeamId !== match.awayTeamId
    ) {
      throw new Error("Winner must be the home or away team for this match.");
    }
  }

  const eventId = match.eventId;

  await prisma.$transaction(async (tx) => {
    await tx.bracketMatch.update({
      where: { id: matchId },
      data: { winnerTeamId },
    });
    await syncDownstreamRounds(tx, eventId);
  });

  const ev = await prisma.event.findUnique({
    where: { id: eventId },
    select: { tournamentId: true },
  });
  if (!ev) {
    throw new Error("Event not found");
  }

  const full = await prisma.bracketMatch.findUnique({
    where: { id: matchId },
    include: matchInclude,
  });
  await syncBracketGrandFinalResultLog(ev.tournamentId, full);

  return loadBracketForTournament(ev.tournamentId);
}

export async function setBracketMatchTeams(
  matchId: string,
  homeTeamId: string,
  awayTeamId: string,
): Promise<{ eventId: string; matches: BracketMatchDTO[] }> {
  const match = await prisma.bracketMatch.findUnique({ where: { id: matchId } });
  if (!match) {
    throw new Error("Match not found");
  }
  if (homeTeamId === awayTeamId) {
    throw new Error("Home and away teams must be different.");
  }
  const teams = await prisma.team.findMany({
    where: { id: { in: [homeTeamId, awayTeamId] } },
    select: { id: true, eventId: true, name: true },
  });
  if (teams.length !== 2 || teams.some((t) => t.eventId !== match.eventId)) {
    throw new Error("Invalid team selection for this bracket.");
  }
  const homeTeam = teams.find((t) => t.id === homeTeamId)!;
  const awayTeam = teams.find((t) => t.id === awayTeamId)!;
  const homeIsBye = isByeName(homeTeam.name);
  const awayIsBye = isByeName(awayTeam.name);
  const autoWinnerTeamId =
    homeIsBye && !awayIsBye
      ? awayTeamId
      : awayIsBye && !homeIsBye
        ? homeTeamId
        : null;
  await prisma.$transaction(async (tx) => {
    await tx.bracketMatch.update({
      where: { id: matchId },
      data: { homeTeamId, awayTeamId, winnerTeamId: autoWinnerTeamId },
    });
    await syncDownstreamRounds(tx, match.eventId);
  });
  const ev = await prisma.event.findUnique({
    where: { id: match.eventId },
    select: { tournamentId: true },
  });
  if (!ev) throw new Error("Event not found");
  return loadBracketForTournament(ev.tournamentId);
}

export function groupMatchesByRound(matches: BracketMatchDTO[]) {
  const qf = matches.filter((m) => m.round === "QUARTER_FINAL");
  const sf = matches.filter((m) => m.round === "SEMI_FINAL");
  const gf = matches.filter((m) => m.round === "GRAND_FINAL");
  return {
    quarterFinals: [...qf].sort((a, b) => a.bracketIndex - b.bracketIndex),
    semiFinals: [...sf].sort((a, b) => a.bracketIndex - b.bracketIndex),
    grandFinal: gf.sort((a, b) => a.bracketIndex - b.bracketIndex)[0] ?? null,
  };
}

