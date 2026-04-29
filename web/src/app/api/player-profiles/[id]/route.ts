import { Prisma, type BeltRank } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureMasterPlayerProfileTable } from "@/lib/master-player-profile-table";
import { migrateMastersSplitIfNeeded } from "@/lib/migrate-masters-split";
import {
  debugMasterProfileWrite,
  resolveUseTrainingMastersForProfileRequest,
} from "@/lib/masters-training-mode";
import { drainOutbox, queueOutboxOp } from "@/lib/cloud-sync";
import { jsonProfilePayload } from "@/lib/player-profile-master-response";

function isMissingMasterProfileTable(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== "P2021") return false;
  const table =
    typeof error.meta?.table === "string" ? error.meta.table.toLowerCase() : "";
  return table.includes("masterplayerprofile") || table.includes("trainingmasterplayerprofile");
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
      return NextResponse.json({ error: "firstName and lastName are required" }, { status: 400 });
    }

    if (training) {
      const row = await prisma.trainingMasterPlayerProfile.update({
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
      debugMasterProfileWrite({
        http: "PATCH 200",
        route: "/api/player-profiles/[id]",
        table: "TrainingMasterPlayerProfile",
        action: "update",
        id: row.id,
        firstName: row.firstName,
        lastName: row.lastName,
      });
      return jsonProfilePayload(row, true);
    }

    await ensureMasterPlayerProfileTable();
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
    debugMasterProfileWrite({
      http: "PATCH 200",
      route: "/api/player-profiles/[id]",
      table: "MasterPlayerProfile",
      action: "update",
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
    });
    return jsonProfilePayload(row, false);
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

export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params;
  if (!id?.trim()) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
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
      await prisma.trainingMasterPlayerProfile.delete({ where: { id } });
      debugMasterProfileWrite({
        http: "DELETE 200",
        route: "/api/player-profiles/[id]",
        table: "TrainingMasterPlayerProfile",
        action: "delete",
        id,
      });
      return jsonProfilePayload({ ok: true }, true);
    }

    await ensureMasterPlayerProfileTable();
    const existing = await prisma.masterPlayerProfile.findUnique({
      where: { id },
      select: { firstName: true, lastName: true, cloudId: true },
    });
    await prisma.masterPlayerProfile.delete({ where: { id } });
    if (existing) {
      await queueOutboxOp("profile.delete", {
        firstName: existing.firstName,
        lastName: existing.lastName,
        cloudId: existing.cloudId,
      }).catch(() => {});
      await drainOutbox().catch(() => {});
    }
    debugMasterProfileWrite({
      http: "DELETE 200",
      route: "/api/player-profiles/[id]",
      table: "MasterPlayerProfile",
      action: "delete",
      id,
      firstName: existing?.firstName ?? null,
      lastName: existing?.lastName ?? null,
    });
    return jsonProfilePayload({ ok: true }, false);
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
