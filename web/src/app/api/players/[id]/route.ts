import { NextResponse } from "next/server";
import type { BeltRank, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { profileUpper } from "@/lib/profile-text";
import { insertPlayerIntoTeamLineup, normalizeTeamLineup } from "@/lib/team-lineup";

const ALL_BELTS: BeltRank[] = ["WHITE", "BLUE", "PURPLE", "BROWN", "BLACK"];

function parseHeightFeet(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "number" && Number.isInteger(v) && v >= 3 && v <= 8) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 3 && n <= 8) return n;
  }
  return undefined;
}

function parseHeightInches(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 11) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0 && n <= 11) return n;
  }
  return undefined;
}

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const b = (await req.json()) as Record<string, unknown>;

  const existing = await prisma.player.findUnique({
    where: { id },
    include: { team: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const newLineup =
    typeof b.lineupOrder === "number" &&
    Number.isFinite(b.lineupOrder) &&
    b.lineupOrder >= 1 &&
    Number.isInteger(b.lineupOrder)
      ? b.lineupOrder
      : undefined;

  const data: Prisma.PlayerUpdateInput = {};

  if (typeof b.firstName === "string") data.firstName = profileUpper(b.firstName);
  if (typeof b.lastName === "string") data.lastName = profileUpper(b.lastName);
  if (b.nickname !== undefined) {
    data.nickname = typeof b.nickname === "string" ? profileUpper(b.nickname) || null : null;
  }
  if (b.academyName !== undefined) {
    data.academyName =
      typeof b.academyName === "string" ? profileUpper(b.academyName) || null : null;
  }
  if (typeof b.unofficialWeight === "number") data.unofficialWeight = b.unofficialWeight;
  if (b.officialWeight !== undefined) {
    if (b.officialWeight === null) {
      data.officialWeight = null;
    } else if (typeof b.officialWeight === "number" && Number.isFinite(b.officialWeight)) {
      data.officialWeight = b.officialWeight;
    }
  }

  const hf = parseHeightFeet(b.heightFeet);
  if (hf !== undefined) data.heightFeet = hf;
  const hi = parseHeightInches(b.heightInches);
  if (hi !== undefined) data.heightInches = hi;

  if (typeof b.age === "number" && Number.isFinite(b.age)) data.age = b.age;
  if (typeof b.beltRank === "string" && ALL_BELTS.includes(b.beltRank as BeltRank)) {
    data.beltRank = b.beltRank as BeltRank;
  }
  if (b.profilePhotoUrl !== undefined) {
    data.profilePhotoUrl =
      typeof b.profilePhotoUrl === "string" ? b.profilePhotoUrl.trim() || null : null;
  }
  if (b.headShotUrl !== undefined) {
    data.headShotUrl = typeof b.headShotUrl === "string" ? b.headShotUrl.trim() || null : null;
  }
  if (typeof b.lineupConfirmed === "boolean") data.lineupConfirmed = b.lineupConfirmed;
  if (typeof b.weighedConfirmed === "boolean") data.weighedConfirmed = b.weighedConfirmed;

  if (b.teamId !== undefined && typeof b.teamId === "string" && b.teamId) {
    const dest = await prisma.team.findUnique({
      where: { id: b.teamId },
    });
    if (!dest) {
      return NextResponse.json({ error: "Team not found" }, { status: 400 });
    }
    data.team = { connect: { id: b.teamId } };
  }

  const teamChanged = typeof b.teamId === "string" && b.teamId && b.teamId !== existing.teamId;
  const lineupMoveRequested = newLineup !== undefined && newLineup !== existing.lineupOrder;

  const hasFieldUpdates = Object.keys(data).length > 0;

  if (!hasFieldUpdates && !lineupMoveRequested) {
    const player = await prisma.player.findUnique({
      where: { id },
      include: { team: true },
    });
    return NextResponse.json(player);
  }

  try {
    const player = await prisma.$transaction(async (tx) => {
      let effectiveTeamId = existing.teamId;
      if (hasFieldUpdates) {
        const updated = await tx.player.update({
          where: { id },
          data,
          include: { team: true },
        });
        effectiveTeamId = updated.teamId;
      }
      if (teamChanged) {
        await normalizeTeamLineup(tx, existing.teamId);
        await normalizeTeamLineup(tx, effectiveTeamId);
      } else if (lineupMoveRequested && newLineup !== undefined) {
        await insertPlayerIntoTeamLineup(tx, effectiveTeamId, id, newLineup);
      }
      return tx.player.findUnique({
        where: { id },
        include: { team: true },
      });
    });
    return NextResponse.json(player);
  } catch (e) {
    console.error("[PATCH /api/players]", id, e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Update failed" },
      { status: 400 },
    );
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.player.findUnique({ where: { id } });
      if (!existing) throw new Error("Not found");
      await tx.player.delete({ where: { id } });
      await normalizeTeamLineup(tx, existing.teamId);
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

