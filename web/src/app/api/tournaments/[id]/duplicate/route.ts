import { NextResponse } from "next/server";
import { duplicateTournament } from "@/lib/tournament";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json()) as { name?: string };
    const name = typeof body.name === "string" ? body.name : "Copy";
    const t = await duplicateTournament(id, name);
    return NextResponse.json(t);
  } catch (e) {
    console.error("[POST duplicate]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Duplicate failed" },
      { status: 400 },
    );
  }
}
