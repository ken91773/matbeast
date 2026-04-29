import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { mintToken } from "@/lib/desktop-tokens";

export const dynamic = "force-dynamic";

/**
 * GET /api/desktop-tokens
 *
 * Lists desktop tokens for the signed-in user only. Users mint and revoke
 * their own keys; they cannot see or manage other workspace members' tokens.
 */
export async function GET() {
  const a = await requireUserId();
  if ("response" in a) return a.response;

  const tokens = await prisma.desktopToken.findMany({
    where: { userId: a.userId },
    orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      label: true,
      tokenPreview: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
      revokedByUserId: true,
    },
  });
  return NextResponse.json({ tokens });
}

/**
 * POST /api/desktop-tokens  body: { label: string }
 *
 * Mints a new token for the signed-in user and returns the plaintext
 * EXACTLY ONCE. After this call returns, only the hash + preview are
 * recoverable from the DB.
 */
export async function POST(req: NextRequest) {
  const a = await requireUserId();
  if ("response" in a) return a.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const rawLabel = (body as { label?: unknown })?.label;
  if (typeof rawLabel !== "string" || rawLabel.trim().length === 0) {
    return NextResponse.json({ error: "label required" }, { status: 400 });
  }
  const label = rawLabel.trim().slice(0, 80);

  const { plaintext, hash, preview } = mintToken();

  const row = await prisma.desktopToken.create({
    data: {
      userId: a.userId,
      label,
      tokenHash: hash,
      tokenPreview: preview,
    },
    select: {
      id: true,
      label: true,
      tokenPreview: true,
      createdAt: true,
    },
  });

  return NextResponse.json(
    {
      token: row,
      plaintext,
      warning:
        "Copy this value now. It will not be shown again. Paste it into the Mat Beast Scoreboard desktop app under Settings -> Cloud.",
    },
    { status: 201 },
  );
}
