import type { BeltRank, Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { resolveTournamentIdFromRequest } from "@/lib/active-tournament-server";
import { getPrimaryEventIdOrThrow } from "@/lib/events";
import { prisma } from "@/lib/prisma";
import { profileUpper } from "@/lib/profile-text";
import { normalizeTeamLineup } from "@/lib/team-lineup";

const ALL_BELTS: BeltRank[] = ["WHITE", "BLUE", "PURPLE", "BROWN", "BLACK"];

function parseHeightFeet(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 3 && v <= 8) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 3 && n <= 8) return n;
  }
  return null;
}

function parseHeightInches(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 11) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0 && n <= 11) return n;
  }
  return null;
}

function parseBody(raw: unknown) {
  const b = raw as Record<string, unknown>;
  const nick =
    typeof b.nickname === "string" ? profileUpper(b.nickname) : "";
  const acad =
    typeof b.academyName === "string" ? profileUpper(b.academyName) : "";
  return {
    teamId: typeof b.teamId === "string" ? b.teamId : "",
    firstName:
      typeof b.firstName === "string" ? profileUpper(b.firstName) : "",
    lastName: typeof b.lastName === "string" ? profileUpper(b.lastName) : "",
    nickname: nick.length > 0 ? nick : null,
    academyName: acad.length > 0 ? acad : null,
    unofficialWeight:
      typeof b.unofficialWeight === "number" ? b.unofficialWeight : null,
    officialWeight:
      typeof b.officialWeight === "number" ? b.officialWeight : null,
    heightFeet: parseHeightFeet(b.heightFeet),
    heightInches: parseHeightInches(b.heightInches),
    age: typeof b.age === "number" && Number.isFinite(b.age) ? b.age : null,
    beltRank: (typeof b.beltRank === "string" &&
    ALL_BELTS.includes(b.beltRank as BeltRank)
      ? b.beltRank
      : null) as BeltRank | null,
    profilePhotoUrl:
      typeof b.profilePhotoUrl === "string"
        ? b.profilePhotoUrl.trim() || null
        : null,
    headShotUrl:
      typeof b.headShotUrl === "string" ? b.headShotUrl.trim() || null : null,
    lineupOrder:
      typeof b.lineupOrder === "number" && b.lineupOrder >= 1
        ? b.lineupOrder
        : null,
    lineupConfirmed:
      typeof b.lineupConfirmed === "boolean" ? b.lineupConfirmed : undefined,
    weighedConfirmed:
      typeof b.weighedConfirmed === "boolean" ? b.weighedConfirmed : undefined,
  };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const teamId = searchParams.get("teamId");
    const tournamentParam = searchParams.get("tournamentId")?.trim();

    let where: Prisma.PlayerWhereInput;

    if (teamId) {
      where = { teamId };
    } else if (tournamentParam) {
      const eventId = await getPrimaryEventIdOrThrow(tournamentParam);
      where = { team: { eventId } };
    } else {
      const tid = await resolveTournamentIdFromRequest(req);
      const eventId = await getPrimaryEventIdOrThrow(tid);
      where = { team: { eventId } };
    }

    const players = await prisma.player.findMany({
      where,
      orderBy: [{ teamId: "asc" }, { lineupOrder: "asc" }],
      include: { team: { include: { event: true } } },
    });
    return NextResponse.json({ players });
  } catch (e) {
    console.error("[GET /api/players]", e);
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "Unknown error",
        hint: "Run: npx prisma db push",
      },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const p = parseBody(await req.json());
  if (!p.teamId) {
    return NextResponse.json({ error: "teamId is required" }, { status: 400 });
  }
  if (!p.firstName || !p.lastName) {
    return NextResponse.json(
      { error: "firstName and lastName are required" },
      { status: 400 },
    );
  }
  if (!p.beltRank) {
    return NextResponse.json({ error: "beltRank is required" }, { status: 400 });
  }
  const beltRank = p.beltRank;
  const team = await prisma.team.findUnique({
    where: { id: p.teamId },
  });
  if (!team) {
    return NextResponse.json({ error: "Team not found" }, { status: 400 });
  }

  try {
    const player = await prisma.$transaction(async (tx) => {
      const existing = await tx.player.findMany({
        where: { teamId: p.teamId },
        orderBy: [{ lineupOrder: "asc" }, { createdAt: "asc" }],
      });
      const maxLineupOrder = existing.reduce((max, player) => {
        if (
          typeof player.lineupOrder === "number" &&
          Number.isInteger(player.lineupOrder) &&
          player.lineupOrder >= 1
        ) {
          return Math.max(max, player.lineupOrder);
        }
        return max;
      }, 0);
      const assignedLineupOrder = p.lineupOrder ?? maxLineupOrder + 1;
      const created = await tx.player.create({
        data: {
          teamId: p.teamId,
          firstName: p.firstName,
          lastName: p.lastName,
          nickname: p.nickname,
          academyName: p.academyName,
          unofficialWeight: p.unofficialWeight,
          officialWeight: p.officialWeight,
          heightFeet: p.heightFeet,
          heightInches: p.heightInches,
          age: p.age,
          beltRank,
          profilePhotoUrl: p.profilePhotoUrl,
          headShotUrl: p.headShotUrl,
          lineupOrder: assignedLineupOrder,
          lineupConfirmed: p.lineupConfirmed ?? false,
          weighedConfirmed: p.weighedConfirmed ?? false,
        },
        include: { team: true },
      });
      await normalizeTeamLineup(tx, p.teamId);
      return created;
    });
    return NextResponse.json(player);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Create failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
