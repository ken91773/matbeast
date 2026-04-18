import { Prisma, type BeltRank } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureMasterPlayerProfileTable } from "@/lib/master-player-profile-table";
import { drainOutbox, queueOutboxOp, syncProfiles } from "@/lib/cloud-sync";

const BELTS: readonly BeltRank[] = [
  "WHITE",
  "BLUE",
  "PURPLE",
  "BROWN",
  "BLACK",
];

function parseBelt(v: unknown): BeltRank {
  return typeof v === "string" && BELTS.includes(v as BeltRank)
    ? (v as BeltRank)
    : "WHITE";
}

function isMissingMasterProfileTable(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== "P2021") return false;
  const table =
    typeof error.meta?.table === "string" ? error.meta.table.toLowerCase() : "";
  return table.includes("masterplayerprofile");
}

/** Push a fully-shaped profile.upsert op to the cloud outbox + drain. */
async function queueProfileUpsertOp(row: {
  firstName: string;
  lastName: string;
  nickname: string | null;
  academyName: string | null;
  unofficialWeight: number | null;
  heightFeet: number | null;
  heightInches: number | null;
  age: number | null;
  beltRank: BeltRank;
  profilePhotoUrl: string | null;
  headShotUrl: string | null;
}): Promise<void> {
  await queueOutboxOp("profile.upsert", {
    firstName: row.firstName,
    lastName: row.lastName,
    nickname: row.nickname,
    academyName: row.academyName,
    unofficialWeight: row.unofficialWeight,
    heightFeet: row.heightFeet,
    heightInches: row.heightInches,
    age: row.age,
    beltRank: row.beltRank,
    profilePhotoUrl: row.profilePhotoUrl,
    headShotUrl: row.headShotUrl,
  }).catch(() => {});
  await drainOutbox().catch(() => {});
}

/** Global master list (not scoped by tournament). */
export async function GET() {
  try {
    await ensureMasterPlayerProfileTable();
    // On-demand cloud sync: pull cloud rows + drain pending pushes.
    // Failures are swallowed so we always serve cached local data.
    await syncProfiles().catch(() => {
      /* offline / cloud error - fall back to local cache */
    });
    const profiles = await prisma.masterPlayerProfile.findMany({
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    });
    return NextResponse.json({ profiles });
  } catch (e) {
    if (isMissingMasterProfileTable(e)) {
      return NextResponse.json({ profiles: [] });
    }
    console.error("[GET /api/player-profiles]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "List failed" },
      { status: 500 },
    );
  }
}

/** Upsert by uppercase first + last name (historical master DB). */
export async function POST(req: Request) {
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
      return NextResponse.json(
        { error: "firstName and lastName are required" },
        { status: 400 },
      );
    }

    const existing = await prisma.masterPlayerProfile.findUnique({
      where: { firstName_lastName: { firstName, lastName } },
    });

    if (existing) {
      const merged = {
        nickname:
          "nickname" in body
            ? typeof body.nickname === "string"
              ? body.nickname.trim() || null
              : (body.nickname ?? null)
            : existing.nickname,
        academyName:
          "academyName" in body
            ? typeof body.academyName === "string"
              ? body.academyName.trim() || null
              : (body.academyName ?? null)
            : existing.academyName,
        unofficialWeight:
          "unofficialWeight" in body
            ? body.unofficialWeight ?? null
            : existing.unofficialWeight,
        heightFeet:
          "heightFeet" in body ? body.heightFeet ?? null : existing.heightFeet,
        heightInches:
          "heightInches" in body ? body.heightInches ?? null : existing.heightInches,
        age: "age" in body ? body.age ?? null : existing.age,
        beltRank: "beltRank" in body ? parseBelt(body.beltRank) : existing.beltRank,
        profilePhotoUrl:
          "profilePhotoUrl" in body
            ? typeof body.profilePhotoUrl === "string"
              ? body.profilePhotoUrl.trim() || null
              : (body.profilePhotoUrl ?? null)
            : existing.profilePhotoUrl,
        headShotUrl:
          "headShotUrl" in body
            ? typeof body.headShotUrl === "string"
              ? body.headShotUrl.trim() || null
              : (body.headShotUrl ?? null)
            : existing.headShotUrl,
      };
      const row = await prisma.masterPlayerProfile.update({
        where: { id: existing.id },
        data: merged,
      });
      await queueProfileUpsertOp(row);
      return NextResponse.json(row);
    }

    const row = await prisma.masterPlayerProfile.create({
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

    await queueProfileUpsertOp(row);
    return NextResponse.json(row);
  } catch (e) {
    if (isMissingMasterProfileTable(e)) {
      return NextResponse.json({ error: "Master profiles unavailable" }, { status: 503 });
    }
    console.error("[POST /api/player-profiles]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Upsert failed" },
      { status: 400 },
    );
  }
}
