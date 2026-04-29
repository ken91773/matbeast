import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { trainingModeFromMatbBytes } from "@/lib/matb-envelope-meta";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/events/:id/blob[?version=N]
 *
 * Downloads the latest blob (default) or a specific historical version.
 * Response body is raw .matb JSON bytes. Headers include:
 *   X-Event-Version:  integer version this blob is
 *   X-Event-Sha256:   hex sha256 of the blob (for client integrity check)
 *
 * No caching: the blob is an editable artifact, responses must always
 * reflect current DB state.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const a = await requireUserId();
  if ("response" in a) return a.response;

  const { id } = await ctx.params;
  const versionParam = req.nextUrl.searchParams.get("version");
  const version = versionParam ? parseInt(versionParam, 10) : null;
  if (versionParam && (!Number.isFinite(version) || (version as number) < 1)) {
    return NextResponse.json(
      { error: "version must be a positive integer" },
      { status: 400 },
    );
  }

  const ev = await prisma.cloudEvent.findFirst({
    where: { id, deletedAt: null },
    select: { currentVersion: true },
  });
  if (!ev) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const targetVersion = version ?? ev.currentVersion;
  if (targetVersion < 1) {
    return NextResponse.json(
      { error: "event has no blob yet" },
      { status: 404 },
    );
  }

  const row = await prisma.cloudEventBlob.findUnique({
    where: { eventId_version: { eventId: id, version: targetVersion } },
    select: { blob: true, sha256: true, version: true, sizeBytes: true },
  });
  if (!row) {
    return NextResponse.json({ error: "blob version not found" }, { status: 404 });
  }

  return new NextResponse(Buffer.from(row.blob), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(row.sizeBytes),
      "Cache-Control": "no-store",
      "X-Event-Version": String(row.version),
      "X-Event-Sha256": row.sha256,
    },
  });
}

/**
 * PUT /api/events/:id/blob
 *
 * Append a new blob version. Body is raw .matb JSON bytes.
 *
 * Conflict detection (v0.4.0 policy):
 *   Client sends header `X-Expected-Version: <N>`. If N !== currentVersion
 *   => 409 Conflict with the current version in the body so the desktop
 *   can prompt the user ("Overwrite / Keep cloud / Save mine as local").
 *   To bypass (force-overwrite), client sends `X-Expected-Version: *`.
 *
 * On success, returns { version, sha256 }.
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const a = await requireUserId();
  if ("response" in a) return a.response;

  const { id } = await ctx.params;
  const expected = req.headers.get("x-expected-version");
  if (!expected) {
    return NextResponse.json(
      { error: "X-Expected-Version header required (send '*' to force)" },
      { status: 400 },
    );
  }

  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.length === 0) {
    return NextResponse.json({ error: "empty body" }, { status: 400 });
  }

  const ev = await prisma.cloudEvent.findFirst({
    where: { id, deletedAt: null },
    select: { currentVersion: true },
  });
  if (!ev) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (expected !== "*") {
    const parsed = parseInt(expected, 10);
    if (!Number.isFinite(parsed) || parsed !== ev.currentVersion) {
      return NextResponse.json(
        {
          error: "version conflict",
          currentVersion: ev.currentVersion,
          expected,
        },
        { status: 409 },
      );
    }
  }

  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const nextVersion = ev.currentVersion + 1;
  const parsedTrainingMode = trainingModeFromMatbBytes(bytes);

  const saved = await prisma.$transaction(async (tx) => {
    await tx.cloudEventBlob.create({
      data: {
        eventId: id,
        version: nextVersion,
        blob: bytes,
        sha256: sha,
        sizeBytes: bytes.length,
        createdByUserId: a.userId,
        createdByTokenId: a.via === "token" ? a.tokenId : null,
      },
    });
    const updated = await tx.cloudEvent.update({
      where: { id },
      data: {
        currentVersion: nextVersion,
        currentBlobSha: sha,
        sizeBytes: bytes.length,
        updatedByUserId: a.userId,
        updatedByTokenId: a.via === "token" ? a.tokenId : null,
        ...(parsedTrainingMode !== undefined
          ? { trainingMode: parsedTrainingMode }
          : {}),
      },
      select: {
        currentVersion: true,
        currentBlobSha: true,
        sizeBytes: true,
        updatedAt: true,
      },
    });
    return updated;
  });

  return NextResponse.json({
    version: saved.currentVersion,
    sha256: saved.currentBlobSha,
    sizeBytes: saved.sizeBytes,
    updatedAt: saved.updatedAt,
  });
}
