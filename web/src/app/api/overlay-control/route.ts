import { NextResponse } from "next/server";
import {
  applyOverlayControlMessage,
  getOverlayControlState,
} from "@/lib/overlay-control-store";
import {
  isOverlayOutputBroadcast,
  type OverlayOutputBroadcast,
} from "@/lib/overlay-output-broadcast";

export const dynamic = "force-dynamic";

/** Control-mirror messages we accept from the dashboard (output→server). */
const MIRRORED_KINDS = new Set<OverlayOutputBroadcast["kind"]>([
  "live",
  "scene",
  "scoreboard-mode",
  "team-list-highlight",
  "bracket-current-match",
]);

/**
 * GET  → current overlay show-control state, polled by a remote Browser Source
 *        so it can replicate OVERLAY LIVE / barn doors, SHOW TEAMS, and the
 *        bracket current-match highlight without a same-machine BroadcastChannel.
 * POST → a single `OverlayOutputBroadcast` control message published by the
 *        dashboard alongside its BroadcastChannel post.
 */
export async function GET() {
  return NextResponse.json(getOverlayControlState(), {
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as unknown;
    if (!isOverlayOutputBroadcast(body) || !MIRRORED_KINDS.has(body.kind)) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }
    const state = applyOverlayControlMessage(body);
    return NextResponse.json(
      { ok: true, rev: state.rev },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
}
