import { NextResponse } from "next/server";
import { syncProfiles, syncTeamNames, drainOutbox } from "@/lib/cloud-sync";

export const dynamic = "force-dynamic";

/**
 * POST /api/cloud/sync  body: { kind: "profiles" | "team-names" | "all" | "drain" }
 *
 * Manually trigger a sync. The same syncProfiles() / syncTeamNames()
 * helpers run automatically before any read of the master lists, so
 * this endpoint is mostly for the Cloud settings UI's "Sync now" button
 * and for "Retry sync" after the outbox has stalled.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const kind =
    typeof (body as { kind?: unknown })?.kind === "string"
      ? (body as { kind: string }).kind
      : "all";

  switch (kind) {
    case "profiles": {
      const r = await syncProfiles();
      return NextResponse.json(r);
    }
    case "team-names": {
      const r = await syncTeamNames();
      return NextResponse.json(r);
    }
    case "drain": {
      const r = await drainOutbox();
      return NextResponse.json(r);
    }
    case "all":
    default: {
      const teams = await syncTeamNames();
      const profiles = await syncProfiles();
      return NextResponse.json({ teams, profiles });
    }
  }
}
