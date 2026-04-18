import { NextResponse } from "next/server";
import { listCloudEvents } from "@/lib/cloud-events";

export const dynamic = "force-dynamic";

/**
 * GET /api/cloud/events
 *
 * Thin proxy to the masters cloud /api/events list. Kept server-side
 * so the plaintext desktop token never leaves the main process.
 *
 * Returns `{ events: [...] }` on success, `{ error }` on failure.
 */
export async function GET() {
  try {
    const events = await listCloudEvents();
    return NextResponse.json({ events });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed" },
      { status: 502 },
    );
  }
}
