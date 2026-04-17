import { NextResponse } from "next/server";
import { resolveTournamentIdFromRequest } from "@/lib/active-tournament-server";
import { importRosterDocumentForTournament } from "@/lib/import-roster-server";
import { parseRosterDocument } from "@/lib/roster-file-parse";

export async function POST(req: Request) {
  try {
    const tournamentId = await resolveTournamentIdFromRequest(req);
    const body = (await req.json()) as {
      document?: unknown;
      bracket?: {
        version?: unknown;
        matches?: unknown;
      };
    };
    if (!body || body.document === undefined) {
      return NextResponse.json({ error: "document is required" }, { status: 400 });
    }
    const document = parseRosterDocument(body.document);
    const bracket =
      body.bracket &&
      body.bracket.version === 1 &&
      Array.isArray(body.bracket.matches)
        ? {
            version: 1 as const,
            matches: body.bracket.matches
              .map((m) => m as Record<string, unknown>)
              .filter(
                (m) =>
                  (m.round === "QUARTER_FINAL" ||
                    m.round === "SEMI_FINAL" ||
                    m.round === "GRAND_FINAL") &&
                  typeof m.bracketIndex === "number" &&
                  typeof m.homeSeedOrder === "number" &&
                  typeof m.awaySeedOrder === "number" &&
                  (m.winnerSeedOrder === null ||
                    typeof m.winnerSeedOrder === "number"),
              )
              .map((m) => ({
                round: m.round as "QUARTER_FINAL" | "SEMI_FINAL" | "GRAND_FINAL",
                bracketIndex: Math.trunc(m.bracketIndex as number),
                homeSeedOrder: Math.trunc(m.homeSeedOrder as number),
                awaySeedOrder: Math.trunc(m.awaySeedOrder as number),
                winnerSeedOrder:
                  m.winnerSeedOrder === null
                    ? null
                    : Math.trunc(m.winnerSeedOrder as number),
              })),
          }
        : undefined;
    await importRosterDocumentForTournament(tournamentId, document, bracket);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[POST /api/tournament/import-roster]", e);
    const message = e instanceof Error ? e.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
