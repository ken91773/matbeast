import { NextResponse } from "next/server";
import { ensureDefaultTournament } from "@/lib/tournament";

export async function GET() {
  const tournament = await ensureDefaultTournament();
  return NextResponse.json(tournament);
}
