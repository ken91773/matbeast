import { NextResponse } from "next/server";
import {
  getCloudEventLink,
  patchCloudEvent,
  pushCloudEventBlob,
  sha256Hex,
  upsertCloudEventLink,
} from "@/lib/cloud-events";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * POST /api/cloud/events/push
 *
 * Called by the renderer after a successful save-to-disk. Behavior:
 *
 *   1. ALWAYS update `CloudEventLink.currentLocalSha` to the hash of the
 *      envelope bytes. This is what drives the NOT SYNCED vs SYNCED
 *      badge state, so we need it even when the subsequent cloud push
 *      fails.
 *   2. If the tournament is not linked to the cloud, stop — return
 *      `{ kind: "no-link" }`. The renderer treats this as success.
 *   3. If the new hash matches `lastSyncedSha`, nothing changed since
 *      the last successful push — return `{ kind: "no-op" }` WITHOUT
 *      hitting the cloud at all. This makes repeated "Save" cheap.
 *   4. Otherwise PUT the blob with `X-Expected-Version: <baseVersion>`.
 *      Outcomes:
 *        ok       -> update baseVersion, lastSyncedSha, lastPushedAt;
 *                    clear pendingPushAt + lastError.
 *        conflict -> set pendingPushAt so the badge flips to NOT_SYNCED;
 *                    return the cloud version so the UI can prompt.
 *        error    -> set pendingPushAt + lastError (badge flips to
 *                    OFFLINE-ish); DO NOT touch baseVersion / lastSyncedSha.
 *
 *  Body: { tournamentId, envelope, force? }
 *    force=true bypasses 409 by sending X-Expected-Version: *. Used by
 *    the conflict prompt's "Overwrite cloud" option.
 */
export async function POST(req: Request) {
  let body: {
    tournamentId?: string;
    envelope?: string;
    force?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const tournamentId = body.tournamentId?.trim();
  const envelope = body.envelope;
  if (!tournamentId || typeof envelope !== "string") {
    return NextResponse.json(
      { error: "tournamentId + envelope required" },
      { status: 400 },
    );
  }

  const bytes = Buffer.from(envelope, "utf8");
  const localSha = sha256Hex(bytes);

  const link = await getCloudEventLink(tournamentId);
  if (!link) {
    return NextResponse.json({ kind: "no-link" as const });
  }

  // Step 1: reflect local dirty state even if the push fails.
  await upsertCloudEventLink(tournamentId, {
    cloudEventId: link.cloudEventId,
    currentLocalSha: localSha,
  });

  if (link.lastSyncedSha && link.lastSyncedSha === localSha && !body.force) {
    return NextResponse.json({
      kind: "no-op" as const,
      version: link.baseVersion,
      sha256: localSha,
    });
  }

  // Optimistically mark pending so the badge reads SYNCING while we wait.
  await upsertCloudEventLink(tournamentId, {
    cloudEventId: link.cloudEventId,
    pendingPushAt: new Date(),
  });

  const expected = body.force ? ("*" as const) : link.baseVersion;
  const result = await pushCloudEventBlob(link.cloudEventId, bytes, expected);

  if (result.kind === "ok") {
    await upsertCloudEventLink(tournamentId, {
      cloudEventId: link.cloudEventId,
      baseVersion: result.version,
      lastSyncedSha: result.sha256,
      lastSyncedBytes: result.sizeBytes,
      lastPushedAt: new Date(),
      pendingPushAt: null,
      lastError: null,
    });
    // Best-effort: keep the cloud catalog's `eventName` (tournament
    // display title) aligned with whatever the local tournament is
    // named right now. Silently ignore failures — the next push will
    // retry, and the catalog can always fall back to `name`.
    try {
      const t = await prisma.tournament.findUnique({
        where: { id: tournamentId },
        select: { name: true, trainingMode: true },
      });
      const nextEventName = t?.name?.trim() || null;
      const patch: { eventName?: string | null; trainingMode: boolean } = {
        trainingMode: Boolean(t?.trainingMode),
      };
      if (nextEventName) patch.eventName = nextEventName;
      await patchCloudEvent(link.cloudEventId, patch);
    } catch {
      /* ignore */
    }
    return NextResponse.json({
      kind: "ok" as const,
      version: result.version,
      sha256: result.sha256,
      sizeBytes: result.sizeBytes,
    });
  }

  if (result.kind === "conflict") {
    await upsertCloudEventLink(tournamentId, {
      cloudEventId: link.cloudEventId,
      lastError: `conflict: cloud at v${result.currentVersion}`,
      // Keep pendingPushAt set so the badge reflects unsynced state.
    });
    return NextResponse.json(
      {
        kind: "conflict" as const,
        localVersion: link.baseVersion,
        cloudVersion: result.currentVersion,
      },
      { status: 409 },
    );
  }

  // Transient error (offline, timeout, 5xx, revoked token 401).
  // Log to bundled-server.log so a user seeing "save failed" in the
  // toolbar can send us a snippet that tells us whether it's a
  // network blip, an auth reject, or a masters-side crash.
  // eslint-disable-next-line no-console
  console.warn(
    "[cloud-push] blob push failed",
    JSON.stringify({
      tournamentId,
      cloudEventId: link.cloudEventId,
      baseVersion: link.baseVersion,
      status: result.status,
      message: result.message,
    }),
  );
  await upsertCloudEventLink(tournamentId, {
    cloudEventId: link.cloudEventId,
    lastError: result.message,
  });
  return NextResponse.json(
    {
      kind: "error" as const,
      status: result.status,
      message: result.message,
    },
    { status: 502 },
  );
}
