import { Prisma, type BeltRank } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureMasterPlayerProfileTable } from "@/lib/master-player-profile-table";
import { migrateMastersSplitIfNeeded } from "@/lib/migrate-masters-split";
import {
  debugMasterProfileWrite,
  resolveUseTrainingMastersForProfileRequest,
} from "@/lib/masters-training-mode";
import { queueProfileUpsertForCloud } from "@/lib/master-profile-outbox";
import { jsonProfilePayload } from "@/lib/player-profile-master-response";
import { syncProfiles } from "@/lib/cloud-sync";

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
  return table.includes("masterplayerprofile") || table.includes("trainingmasterplayerprofile");
}

/** Global master list (not scoped by tournament). */
export async function GET(req: Request) {
  try {
    await migrateMastersSplitIfNeeded();
    const url = new URL(req.url);
    const teamIdHint = url.searchParams.get("teamId");
    const tournamentIdHint = url.searchParams.get("tournamentId");
    const umRaw = url.searchParams.get("useTrainingMasters")?.trim().toLowerCase();
    let useTrainingHint: boolean | undefined;
    if (umRaw === "0" || umRaw === "false") useTrainingHint = false;
    else if (umRaw === "1" || umRaw === "true") useTrainingHint = true;
    const training = await resolveUseTrainingMastersForProfileRequest(req, {
      teamId: teamIdHint,
      tournamentId: tournamentIdHint,
      ...(useTrainingHint !== undefined ? { useTrainingMasters: useTrainingHint } : {}),
    });
    if (training) {
      const profiles = await prisma.trainingMasterPlayerProfile.findMany({
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      });
      return jsonProfilePayload({ profiles }, true);
    }

    await ensureMasterPlayerProfileTable();
    await syncProfiles().catch(() => {
      /* offline / cloud error - fall back to local cache */
    });
    const profiles = await prisma.masterPlayerProfile.findMany({
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    });
    return jsonProfilePayload({ profiles }, false);
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
    await migrateMastersSplitIfNeeded();
    const body = (await req.json()) as {
      tournamentId?: string;
      teamId?: string;
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
      useTrainingMasters?: unknown;
    };
    const tid =
      typeof body.tournamentId === "string" ? body.tournamentId.trim() : "";
    const training = await resolveUseTrainingMastersForProfileRequest(req, {
      tournamentId: tid || null,
      teamId: typeof body.teamId === "string" ? body.teamId.trim() || null : null,
      ...("useTrainingMasters" in body
        ? { useTrainingMasters: body.useTrainingMasters }
        : {}),
    });
    const firstName = body.firstName?.trim().toUpperCase() ?? "";
    const lastName = body.lastName?.trim().toUpperCase() ?? "";
    if (!firstName || !lastName) {
      return NextResponse.json(
        { error: "firstName and lastName are required" },
        { status: 400 },
      );
    }

    if (training) {
      const existing = await prisma.trainingMasterPlayerProfile.findUnique({
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
        const row = await prisma.trainingMasterPlayerProfile.update({
          where: { id: existing.id },
          data: merged,
        });
        debugMasterProfileWrite({
          http: "POST 200",
          route: "/api/player-profiles",
          table: "TrainingMasterPlayerProfile",
          action: "update",
          id: row.id,
          firstName: row.firstName,
          lastName: row.lastName,
        });
        return jsonProfilePayload(row, true);
      }

      const row = await prisma.trainingMasterPlayerProfile.create({
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
      debugMasterProfileWrite({
        http: "POST 200",
        route: "/api/player-profiles",
        table: "TrainingMasterPlayerProfile",
        action: "create",
        id: row.id,
        firstName: row.firstName,
        lastName: row.lastName,
      });
      return jsonProfilePayload(row, true);
    }

    await ensureMasterPlayerProfileTable();
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
      await queueProfileUpsertForCloud(row);
      debugMasterProfileWrite({
        http: "POST 200",
        route: "/api/player-profiles",
        table: "MasterPlayerProfile",
        action: "update",
        id: row.id,
        firstName: row.firstName,
        lastName: row.lastName,
      });
      return jsonProfilePayload(row, false);
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

    await queueProfileUpsertForCloud(row);
    debugMasterProfileWrite({
      http: "POST 200",
      route: "/api/player-profiles",
      table: "MasterPlayerProfile",
      action: "create",
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
    });
    return jsonProfilePayload(row, false);
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
