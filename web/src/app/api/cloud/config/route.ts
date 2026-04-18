import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getCloudConfig,
  updateCloudConfig,
  isCloudConfigured,
} from "@/lib/cloud-config";

export const dynamic = "force-dynamic";

/**
 * GET /api/cloud/config
 *
 * Returns the desktop's cloud sync settings + a small "status" snapshot
 * for the Cloud settings UI: token preview, last-sync times, error,
 * pending outbox count.
 *
 * The plaintext token is NEVER returned in full — we only echo the last
 * 4 characters so the UI can show "set / not set" without exposing the
 * secret on screen if someone is shoulder-surfing.
 */
export async function GET() {
  const cfg = await getCloudConfig();
  const outboxCount = await prisma.masterCloudOutbox.count();
  const tok = cfg.desktopToken.trim();
  return NextResponse.json({
    cloudBaseUrl: cfg.cloudBaseUrl,
    syncEnabled: cfg.syncEnabled,
    liveMastersPullFromCloud: cfg.liveMastersPullFromCloud,
    tokenSet: tok.length > 0,
    tokenPreview: tok.length >= 4 ? tok.slice(-4) : "",
    configured: isCloudConfigured(cfg),
    lastProfilesPullAt: cfg.lastProfilesPullAt,
    lastTeamNamesPullAt: cfg.lastTeamNamesPullAt,
    lastSyncError: cfg.lastSyncError,
    outboxCount,
    updatedAt: cfg.updatedAt,
  });
}

/**
 * PATCH /api/cloud/config  body: { desktopToken?, cloudBaseUrl?, syncEnabled? }
 *
 * Used by the Cloud settings UI to paste a fresh token, change the
 * service base URL (rare; for testing against a non-prod deployment),
 * or temporarily disable sync entirely.
 */
export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  const update: Parameters<typeof updateCloudConfig>[0] = {};

  if (b.desktopToken !== undefined) {
    if (typeof b.desktopToken !== "string") {
      return NextResponse.json(
        { error: "desktopToken must be a string" },
        { status: 400 },
      );
    }
    update.desktopToken = b.desktopToken.trim();
  }

  if (b.cloudBaseUrl !== undefined) {
    if (typeof b.cloudBaseUrl !== "string" || b.cloudBaseUrl.trim().length === 0) {
      return NextResponse.json(
        { error: "cloudBaseUrl must be non-empty string" },
        { status: 400 },
      );
    }
    update.cloudBaseUrl = b.cloudBaseUrl.trim().replace(/\/+$/, "");
  }

  if (b.syncEnabled !== undefined) {
    if (typeof b.syncEnabled !== "boolean") {
      return NextResponse.json(
        { error: "syncEnabled must be boolean" },
        { status: 400 },
      );
    }
    update.syncEnabled = b.syncEnabled;
  }

  if (b.liveMastersPullFromCloud !== undefined) {
    if (typeof b.liveMastersPullFromCloud !== "boolean") {
      return NextResponse.json(
        { error: "liveMastersPullFromCloud must be boolean" },
        { status: 400 },
      );
    }
    update.liveMastersPullFromCloud = b.liveMastersPullFromCloud;
  }

  const cfg = await updateCloudConfig(update);
  const tok = cfg.desktopToken.trim();
  return NextResponse.json({
    ok: true,
    tokenSet: tok.length > 0,
    tokenPreview: tok.length >= 4 ? tok.slice(-4) : "",
    cloudBaseUrl: cfg.cloudBaseUrl,
    syncEnabled: cfg.syncEnabled,
    liveMastersPullFromCloud: cfg.liveMastersPullFromCloud,
    configured: isCloudConfigured(cfg),
  });
}

/**
 * DELETE /api/cloud/config
 *
 * Clears the desktop token (effectively unlinking from cloud). Does NOT
 * touch the outbox or last-sync timestamps so we can show "you had X
 * pending changes when you unlinked" diagnostics.
 */
export async function DELETE() {
  await updateCloudConfig({ desktopToken: "" });
  return NextResponse.json({ ok: true });
}
