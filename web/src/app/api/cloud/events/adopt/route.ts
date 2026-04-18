import { NextResponse } from "next/server";
import {
  getCloudEventMeta,
  pushCloudEventBlob,
  sha256Hex,
  upsertCloudEventLink,
} from "@/lib/cloud-events";
import { prisma } from "@/lib/prisma";
import { ensureCloudTables } from "@/lib/cloud-config-table";

export const dynamic = "force-dynamic";

/**
 * POST /api/cloud/events/adopt
 *
 * Adopts an existing cloud event as the canonical cloud copy for a
 * local tournament. Used by the save pipeline's auto-link path when
 * `/upload` returns 409 (duplicate filename):
 *
 *   - A cloud event with this filename already exists (probably
 *     created on this same install in a previous session, then
 *     orphaned by a DB reset or a lost SQLite migration).
 *   - We don't want to keep 409-looping every autosave.
 *   - The local bytes are what the user just edited and wants to
 *     save; the cloud bytes are stale.
 *
 * Flow:
 *   1. Fetch the cloud event's current version (so we have the meta
 *      available for the response).
 *   2. Force-push the local envelope with `X-Expected-Version: *`.
 *   3. Create the local `CloudEventLink` row pointing at the
 *      adopted cloud event, with the post-push version/sha/bytes
 *      so future pushes follow the normal fast path.
 *
 * Body: { tournamentId, cloudEventId, envelope }
 *
 * Returns `{ event: { id, name, currentVersion } }` on success,
 * otherwise `{ error, stage }` with a non-2xx status code. Every
 * failure path is logged to `bundled-server.log` so a tester
 * seeing the red "save failed" toolbar text has an exact breadcrumb.
 */
export async function POST(req: Request) {
  let body: {
    tournamentId?: string;
    cloudEventId?: string;
    envelope?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const tournamentId = body.tournamentId?.trim();
  const cloudEventId = body.cloudEventId?.trim();
  const envelope = body.envelope;
  if (!tournamentId || !cloudEventId || typeof envelope !== "string") {
    return NextResponse.json(
      { error: "tournamentId, cloudEventId, envelope required" },
      { status: 400 },
    );
  }

  /**
   * Stage-based try/catch. A bug anywhere in the adopt pipeline was
   * surfacing as a bare Next.js 500 with no diagnostics, which meant
   * the tester saw "Adopt-existing failed: HTTP 500" without knowing
   * whether it was the meta probe, the force-push, or the local DB
   * upsert. We tag each step so the server log + the response body
   * both name the failing stage.
   */
  let stage: "meta" | "push" | "link" = "meta";
  try {
    const meta = await getCloudEventMeta(cloudEventId);
    if (!meta) {
      // eslint-disable-next-line no-console
      console.warn(
        "[cloud-adopt] target event not found",
        JSON.stringify({ tournamentId, cloudEventId }),
      );
      return NextResponse.json(
        { error: "target cloud event not found", stage },
        { status: 404 },
      );
    }

    stage = "push";
    const bytes = Buffer.from(envelope, "utf8");
    const push = await pushCloudEventBlob(cloudEventId, bytes, "*");
    if (push.kind !== "ok") {
      // eslint-disable-next-line no-console
      console.warn(
        "[cloud-adopt] force-push failed",
        JSON.stringify({
          tournamentId,
          cloudEventId,
          kind: push.kind,
          status: "status" in push ? push.status : null,
          message: "message" in push ? push.message : null,
        }),
      );
      return NextResponse.json(
        {
          error: "message" in push ? push.message : `push ${push.kind}`,
          status: "status" in push ? push.status : 0,
          stage,
        },
        { status: 502 },
      );
    }

    stage = "link";
    const sha = sha256Hex(bytes);

    /**
     * Sweep any orphaned `CloudEventLink` rows that still claim
     * this `cloudEventId` under a different `tournamentId`. These
     * are the fingerprints of a previous session (or an abandoned
     * import tab) that was bound to the same cloud event but is
     * no longer in use. The cloudEventId column is `@unique` so
     * without this cleanup the upsert below hits
     * `PrismaClientKnownRequestError: Unique constraint failed on
     * the fields: (cloudEventId)` and the adopt flow 500s.
     *
     * Safe because: (a) the new tournament we're re-binding to is
     * the one the user is actively editing right now, and (b) the
     * orphan rows are pure metadata — deleting them does not
     * touch the cloud event or the orphan's Tournament row.
     */
    await ensureCloudTables();
    const orphans = await prisma.cloudEventLink.findMany({
      where: { cloudEventId, NOT: { tournamentId } },
      select: { tournamentId: true },
    });
    if (orphans.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        "[cloud-adopt] clearing orphan links",
        JSON.stringify({
          cloudEventId,
          newTournamentId: tournamentId,
          orphanTournamentIds: orphans.map((o) => o.tournamentId),
        }),
      );
      await prisma.cloudEventLink.deleteMany({
        where: { cloudEventId, NOT: { tournamentId } },
      });
    }

    await upsertCloudEventLink(tournamentId, {
      cloudEventId,
      baseVersion: push.version,
      lastSyncedSha: push.sha256,
      currentLocalSha: sha,
      lastSyncedBytes: push.sizeBytes,
      lastPushedAt: new Date(),
      pendingPushAt: null,
      lastError: null,
    });

    return NextResponse.json({
      event: {
        id: cloudEventId,
        name: meta.name,
        currentVersion: push.version,
      },
    });
  } catch (e) {
    const message =
      e instanceof Error
        ? `${e.name}: ${e.message}`
        : typeof e === "string"
          ? e
          : "unknown error";
    // eslint-disable-next-line no-console
    console.error(
      "[cloud-adopt] threw",
      JSON.stringify({
        tournamentId,
        cloudEventId,
        stage,
        message,
        stack: e instanceof Error ? e.stack?.split("\n").slice(0, 6) : null,
      }),
    );
    return NextResponse.json(
      { error: `adopt ${stage} error: ${message.slice(0, 200)}`, stage },
      { status: 500 },
    );
  }
}
