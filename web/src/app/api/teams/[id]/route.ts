import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  upsertMasterTeamName,
  upsertTrainingMasterTeamName,
} from "@/lib/master-team-names";
import { ensureMasterTeamNameTable } from "@/lib/master-team-name-table";
import {
  forbiddenUserChosenTeamNameMessage,
  isForbiddenCustomTeamName,
} from "@/lib/reserved-team-names";

type Params = { params: Promise<{ id: string }> };

function normalizeCssColor(input: unknown): { ok: true; value: string | null } | { ok: false } {
  if (input === undefined) return { ok: false };
  if (input === null) return { ok: true, value: null };
  if (typeof input !== "string") return { ok: false };
  const raw = input.trim();
  if (!raw) return { ok: true, value: null };
  const hex = raw.startsWith("#") ? raw : `#${raw}`;
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) {
    return { ok: false };
  }
  return { ok: true, value: hex.toLowerCase() };
}

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const body = (await req.json()) as {
    name?: string;
    seedOrder?: number;
    overlayColor?: string | null;
    /** When clearing a slot (name → TBD), remove this team’s prior name from the global master list instead of keeping it. */
    removeFromMasterTeamNames?: boolean;
  };

  try {
    const existing = await prisma.team.findUnique({
      where: { id },
      include: { event: { include: { tournament: true } } },
    });
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const trainingMasters = existing.event.tournament.trainingMode;

    if (
      body.seedOrder !== undefined &&
      body.seedOrder !== existing.seedOrder &&
      body.seedOrder >= 1 &&
      body.seedOrder <= 8
    ) {
      const conflict = await prisma.team.findFirst({
        where: {
          eventId: existing.eventId,
          seedOrder: body.seedOrder,
          NOT: { id },
        },
      });
      if (conflict) {
        await prisma.$transaction([
          prisma.team.update({
            where: { id: conflict.id },
            data: { seedOrder: existing.seedOrder },
          }),
          prisma.team.update({
            where: { id },
            data: { seedOrder: body.seedOrder },
          }),
        ]);
      } else {
        await prisma.team.update({
          where: { id },
          data: { seedOrder: body.seedOrder },
        });
      }
    }

    const nameUpdate =
      body.name !== undefined
        ? body.name.trim().length > 0
          ? body.name.trim()
          : "TBD"
        : undefined;

    const isClearToSentinel =
      body.name !== undefined && body.name.trim().length === 0;
    const explicitUserTbd =
      body.name !== undefined &&
      body.name.trim().length > 0 &&
      body.name.trim().toUpperCase() === "TBD";

    if (nameUpdate !== undefined) {
      if (nameUpdate === "TBD") {
        if (!isClearToSentinel && !explicitUserTbd) {
          return NextResponse.json({ error: "Invalid team name" }, { status: 400 });
        }
      } else if (isForbiddenCustomTeamName(nameUpdate)) {
        return NextResponse.json(
          { error: forbiddenUserChosenTeamNameMessage() },
          { status: 400 },
        );
      }

      const prevUpper = existing.name.trim().toUpperCase();
      const upsertMaster = trainingMasters
        ? upsertTrainingMasterTeamName
        : upsertMasterTeamName;
      if (nameUpdate === "TBD" && prevUpper && prevUpper !== "TBD") {
        if (body.removeFromMasterTeamNames) {
          if (trainingMasters) {
            await prisma.trainingMasterTeamName.deleteMany({
              where: { name: prevUpper },
            });
          } else {
            await ensureMasterTeamNameTable();
            await prisma.masterTeamName.deleteMany({ where: { name: prevUpper } });
          }
        } else {
          await upsertMaster(existing.name);
        }
      }

      await prisma.team.update({
        where: { id },
        data: { name: nameUpdate },
      });
      if (nameUpdate !== "TBD") {
        await upsertMaster(nameUpdate);
      } else if (explicitUserTbd) {
        await upsertMaster("TBD", { allowReservedTbd: true });
      }
    }

    if (body.overlayColor !== undefined) {
      const normalized = normalizeCssColor(body.overlayColor);
      if (!normalized.ok) {
        return NextResponse.json(
          { error: "Invalid overlayColor (use #RGB or #RRGGBB)" },
          { status: 400 },
        );
      }
      await prisma.team.update({
        where: { id },
        data: { overlayColor: normalized.value },
      });
    }

    const team = await prisma.team.findUnique({
      where: { id },
      include: {
        players: { orderBy: { lineupOrder: "asc" } },
      },
    });
    return NextResponse.json(team);
  } catch (e) {
    console.error("[PATCH team]", e);
    return NextResponse.json({ error: "Update failed" }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    await prisma.team.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
