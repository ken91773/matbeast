import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureMasterTeamNameTable } from "@/lib/master-team-name-table";
import { upsertMasterTeamName } from "@/lib/master-team-names";
import {
  forbiddenUserChosenTeamNameMessage,
  isForbiddenUserChosenTeamName,
} from "@/lib/reserved-team-names";

function isMissingMasterTeamNameTable(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== "P2021") return false;
  const table =
    typeof error.meta?.table === "string" ? error.meta.table.toLowerCase() : "";
  return table.includes("masterteamname");
}

/** Global team name list (not scoped by tournament). */
export async function GET() {
  try {
    await ensureMasterTeamNameTable();
    await prisma.masterTeamName.deleteMany({
      where: {
        name: { in: ["UNAFFILIATED", "NOT AFFILIATED"] },
      },
    });
    const names = await prisma.masterTeamName.findMany({
      orderBy: { name: "asc" },
      select: { name: true },
    });
    return NextResponse.json({ names: names.map((n) => n.name) });
  } catch (e) {
    if (isMissingMasterTeamNameTable(e)) {
      return NextResponse.json({ names: [] });
    }
    console.error("[GET /api/master-team-names]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "List failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { name?: string };
    const name = body.name?.trim().toUpperCase() ?? "";
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (isForbiddenUserChosenTeamName(name)) {
      return NextResponse.json(
        { error: forbiddenUserChosenTeamNameMessage() },
        { status: 400 },
      );
    }
    await upsertMasterTeamName(name);
    return NextResponse.json({ ok: true, name });
  } catch (e) {
    if (isMissingMasterTeamNameTable(e)) {
      return NextResponse.json({ error: "Master team names unavailable" }, { status: 503 });
    }
    console.error("[POST /api/master-team-names]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Save failed" },
      { status: 400 },
    );
  }
}

/** Remove a name from the global master list when it is not tied to an event slot update. */
export async function DELETE(req: Request) {
  try {
    const body = (await req.json()) as { name?: string };
    const name = body.name?.trim().toUpperCase() ?? "";
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    await ensureMasterTeamNameTable();
    await prisma.masterTeamName.deleteMany({ where: { name } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isMissingMasterTeamNameTable(e)) {
      return NextResponse.json({ error: "Master team names unavailable" }, { status: 503 });
    }
    console.error("[DELETE /api/master-team-names]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Delete failed" },
      { status: 400 },
    );
  }
}
