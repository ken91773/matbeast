import { NextResponse } from "next/server";
import {
  createTournamentWithName,
  listTournaments,
} from "@/lib/tournament";

export async function GET() {
  try {
    const tournaments = await listTournaments();
    return NextResponse.json({ tournaments });
  } catch (e) {
    console.error("[GET /api/tournaments]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "List failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { name?: string; trainingMode?: boolean };
    const name = typeof body.name === "string" ? body.name : "Untitled event";
    const t = await createTournamentWithName(name, {
      trainingMode: Boolean(body.trainingMode),
    });
    return NextResponse.json(t);
  } catch (e) {
    console.error("[POST /api/tournaments]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Create failed" },
      { status: 400 },
    );
  }
}
