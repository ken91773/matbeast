import { NextResponse } from "next/server";
import { resolveTournamentIdFromRequest } from "@/lib/active-tournament-server";
import { importRosterDocumentForTournament } from "@/lib/import-roster-server";
import { parseRosterDocument } from "@/lib/roster-file-parse";
import type { RosterFileResultLog } from "@/lib/roster-file-types";

const RESULT_TYPES = new Set([
  "LEFT",
  "RIGHT",
  "DRAW",
  "NO_CONTEST",
  "SUBMISSION_LEFT",
  "SUBMISSION_RIGHT",
  "ESCAPE_LEFT",
  "ESCAPE_RIGHT",
  "DQ_LEFT",
  "DQ_RIGHT",
  "MANUAL",
]);

export async function POST(req: Request) {
  try {
    const tournamentId = await resolveTournamentIdFromRequest(req);
    const body = (await req.json()) as {
      document?: unknown;
      bracket?: {
        version?: unknown;
        matches?: unknown;
      };
      resultLogs?: unknown;
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
    /**
     * v1.2.8: results card rows. Optional + lenient: pre-v1.2.8
     * envelopes omit the field entirely (so live results stay
     * intact); newer envelopes include the array (which causes
     * `importRosterDocumentForTournament` to wipe + reinsert).
     */
    const resultLogs: RosterFileResultLog[] | undefined = Array.isArray(
      body.resultLogs,
    )
      ? (body.resultLogs as Array<Record<string, unknown>>)
          .filter(
            (r) =>
              r &&
              typeof r === "object" &&
              typeof r.createdAt === "string" &&
              typeof r.resultType === "string" &&
              RESULT_TYPES.has(r.resultType as string),
          )
          .map((r) => ({
            rosterFileName:
              typeof r.rosterFileName === "string" && (r.rosterFileName as string).trim()
                ? (r.rosterFileName as string)
                : "UNTITLED",
            roundLabel: typeof r.roundLabel === "string" ? (r.roundLabel as string) : "",
            leftName: typeof r.leftName === "string" ? (r.leftName as string) : "",
            rightName: typeof r.rightName === "string" ? (r.rightName as string) : "",
            leftTeamName:
              typeof r.leftTeamName === "string" ? (r.leftTeamName as string) : null,
            rightTeamName:
              typeof r.rightTeamName === "string" ? (r.rightTeamName as string) : null,
            resultType: r.resultType as RosterFileResultLog["resultType"],
            winnerName:
              typeof r.winnerName === "string" ? (r.winnerName as string) : null,
            createdAt: r.createdAt as string,
            isManual: Boolean(r.isManual),
            manualDate:
              typeof r.manualDate === "string" ? (r.manualDate as string) : null,
            manualTime:
              typeof r.manualTime === "string" ? (r.manualTime as string) : null,
            finalSummaryLine:
              typeof r.finalSummaryLine === "string"
                ? (r.finalSummaryLine as string)
                : null,
          }))
      : undefined;
    await importRosterDocumentForTournament(tournamentId, document, bracket, resultLogs);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[POST /api/tournament/import-roster]", e);
    const message = e instanceof Error ? e.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
