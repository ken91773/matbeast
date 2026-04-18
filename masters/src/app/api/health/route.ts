import { NextResponse } from "next/server";

/**
 * Simple health-check endpoint.
 *
 * Used by:
 *  - Deployment monitors (Vercel, uptime pingers)
 *  - The desktop app's "is the cloud reachable?" check
 *
 * Intentionally does NOT touch the database or auth - staying cheap means
 * a flapping DB won't make the whole service look down.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "matbeast-masters",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
  });
}
