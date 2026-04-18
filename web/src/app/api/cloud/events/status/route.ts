import { NextRequest, NextResponse } from "next/server";
import {
  computeStatus,
  getCloudEventLink,
  getCloudEventMeta,
} from "@/lib/cloud-events";
import { getCloudConfig, isCloudConfigured } from "@/lib/cloud-config";

export const dynamic = "force-dynamic";

/**
 * Outcome of the optional cloud-metadata probe. The renderer's
 * connectivity tracker (matbeast-cloud-online) uses this to decide
 * whether to flip the global CONNECTION LOST / NO CLOUD badge —
 * previously it had to infer from `cloudMeta === null`, but that
 * conflates "cloud unreachable" with "cloud event 404'd" and
 * produced spurious CONNECTION LOST toasts while the cloud was
 * actually healthy.
 *
 *   - "ok"              → masters returned event metadata.
 *   - "not-found"       → masters returned 404 (event deleted from
 *                          another machine). Cloud itself is
 *                          reachable; the badge does NOT flip to
 *                          CONNECTION LOST.
 *   - "unreachable"     → probe threw (timeout, 5xx, network error).
 *   - "not-configured"  → user has no cloud credentials configured.
 *   - "skipped"         → checkCloud=0 or tournament isn't linked.
 */
type CloudProbe =
  | "ok"
  | "not-found"
  | "unreachable"
  | "not-configured"
  | "skipped";

/**
 * GET /api/cloud/events/status?tournamentId=X[&checkCloud=1]
 *
 * Returns the badge state for a tournament. If `checkCloud=1`, we also
 * hit the cloud's metadata endpoint to detect CONFLICT (cloud has moved
 * ahead since our last push/pull). Without the flag, we derive status
 * from local state only — this is the cheap poll path used by the header
 * badge, typically every few seconds.
 *
 * Response: {
 *   link: CloudEventLink | null,
 *   cloudMeta: CloudEventMeta | null,  // null unless checkCloud=1
 *   cloudProbe: CloudProbe,            // outcome of the optional probe
 *   status: SyncStatus,
 * }
 */
export async function GET(req: NextRequest) {
  const tournamentId = req.nextUrl.searchParams.get("tournamentId")?.trim();
  if (!tournamentId) {
    return NextResponse.json(
      { error: "tournamentId required" },
      { status: 400 },
    );
  }
  const checkCloud = req.nextUrl.searchParams.get("checkCloud") === "1";

  const link = await getCloudEventLink(tournamentId);
  let cloudMeta = null;
  let cloudProbe: CloudProbe = "skipped";
  if (checkCloud && link) {
    const cfg = await getCloudConfig();
    if (!isCloudConfigured(cfg)) {
      cloudProbe = "not-configured";
    } else {
      try {
        cloudMeta = await getCloudEventMeta(link.cloudEventId);
        cloudProbe = cloudMeta ? "ok" : "not-found";
      } catch {
        // Offline / auth error. computeStatus() falls through to local
        // state; the lastError field will still flag OFFLINE if the last
        // push attempt failed. Reported back as `unreachable` so the
        // global badge can differentiate from a successful-but-empty
        // probe.
        cloudProbe = "unreachable";
      }
    }
  }
  const status = computeStatus(link, cloudMeta);
  return NextResponse.json({ link, cloudMeta, cloudProbe, status });
}
