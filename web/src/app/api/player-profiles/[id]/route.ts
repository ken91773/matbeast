import { Prisma, type BeltRank } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureMasterPlayerProfileTable } from "@/lib/master-player-profile-table";

function isMissingMasterProfileTable(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== "P2021") return false;
  const table =
    typeof error.meta?.table === "string" ? error.meta.table.toLowerCase() : "";
  return table.includes("masterplayerprofile");
}

type Params = { params: Promise<{ id: string }> };
const BELTS: readonly BeltRank[] = ["WHITE", "BLUE", "PURPLE", "BROWN", "BLACK"];

function parseBelt(v: unknown): BeltRank {
  return typeof v === "string" && BELTS.includes(v as BeltRank) ? (v as BeltRank) : "WHITE";
}

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  if (!id?.trim()) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  try {
    await ensureMasterPlayerProfileTable();
    const body = (await req.json()) as {
      firstName?: string;
      lastName?: string;
      nickname?: string | null;
      academyName?: string | null;
      unofficialWeight?: number | null;
      heightFeet?: number | null;
      heightInches?: number | null;
      age?: number | null;
      beltRank?: string;
      profilePhotoUrl?: string | null;
      headShotUrl?: string | null;
    };
    const firstName = body.firstName?.trim().toUpperCase() ?? "";
    const lastName = body.lastName?.trim().toUpperCase() ?? "";
    if (!firstName || !lastName) {
      return NextResponse.json({ error: "firstName and lastName are required" }, { status: 400 });
    }
    const row = await prisma.masterPlayerProfile.update({
      where: { id },
      data: {
        firstName,
        lastName,
        nickname: body.nickname?.trim() || null,
        academyName: body.academyName?.trim() || null,
        unofficialWeight: body.unofficialWeight ?? null,
        heightFeet: body.heightFeet ?? null,
        heightInches: body.heightInches ?? null,
        age: body.age ?? null,
        beltRank: parseBelt(body.beltRank),
        profilePhotoUrl: body.profilePhotoUrl?.trim() || null,
        headShotUrl: body.headShotUrl?.trim() || null,
      },
    });
    return NextResponse.json(row);
  } catch (e) {
    if (isMissingMasterProfileTable(e)) {
      return NextResponse.json({ error: "Master profiles not available" }, { status: 503 });
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "That first/last name already exists in master profiles" }, { status: 409 });
    }
    console.error("[PATCH /api/player-profiles/[id]]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Update failed" },
      { status: 500 },
    );
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  if (!id?.trim()) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  try {
    await ensureMasterPlayerProfileTable();
    await prisma.masterPlayerProfile.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isMissingMasterProfileTable(e)) {
      return NextResponse.json(
        { error: "Master profiles not available" },
        { status: 503 },
      );
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.error("[DELETE /api/player-profiles/[id]]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Delete failed" },
      { status: 500 },
    );
  }
}
