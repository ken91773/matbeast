import type { BeltRank } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { profileUpper } from "@/lib/profile-text";

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
      typeof b.lineupOrder === "number" && b.lineupOrder >= 1 && b.lineupOrder <= 7
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
    const players = await prisma.player.findMany({
      where: teamId ? { teamId } : undefined,
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
  if (p.lineupOrder == null) {
    return NextResponse.json(
      { error: "lineupOrder 1–7 is required" },
      { status: 400 },
    );
  }

  const team = await prisma.team.findUnique({
    where: { id: p.teamId },
  });
  if (!team) {
    return NextResponse.json({ error: "Team not found" }, { status: 400 });
  }

  try {
    const player = await prisma.player.create({
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
        beltRank: p.beltRank,
        profilePhotoUrl: p.profilePhotoUrl,
        headShotUrl: p.headShotUrl,
        lineupOrder: p.lineupOrder,
        lineupConfirmed: p.lineupConfirmed ?? false,
        weighedConfirmed: p.weighedConfirmed ?? false,
      },
      include: { team: true },
    });
    return NextResponse.json(player);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Create failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
