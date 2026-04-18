import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

const VALID_BELTS = ["WHITE", "BLUE", "PURPLE", "BROWN", "BLACK"] as const;
type Belt = (typeof VALID_BELTS)[number];

function isBelt(v: unknown): v is Belt {
  return typeof v === "string" && (VALID_BELTS as readonly string[]).includes(v);
}

function optStr(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function optNum(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v;
}

function optInt(v: unknown): number | null | undefined {
  const n = optNum(v);
  if (n === undefined || n === null) return n;
  return Math.trunc(n);
}

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const a = await requireUserId();
  if ("response" in a) return a.response;
  const { id } = await ctx.params;
  const profile = await prisma.masterPlayerProfile.findUnique({ where: { id } });
  if (!profile) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ profile });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const a = await requireUserId();
  if ("response" in a) return a.response;
  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const data: Prisma.MasterPlayerProfileUpdateInput = {
    updatedByUserId: a.userId,
  };

  if (body.firstName !== undefined) {
    if (typeof body.firstName !== "string" || body.firstName.trim().length === 0) {
      return NextResponse.json({ error: "firstName must be non-empty string" }, { status: 400 });
    }
    data.firstName = body.firstName.trim().toUpperCase();
  }
  if (body.lastName !== undefined) {
    if (typeof body.lastName !== "string" || body.lastName.trim().length === 0) {
      return NextResponse.json({ error: "lastName must be non-empty string" }, { status: 400 });
    }
    data.lastName = body.lastName.trim().toUpperCase();
  }
  if (body.beltRank !== undefined) {
    if (!isBelt(body.beltRank)) {
      return NextResponse.json(
        { error: `beltRank must be one of ${VALID_BELTS.join(", ")}` },
        { status: 400 },
      );
    }
    data.beltRank = body.beltRank;
  }
  if ("nickname" in body) data.nickname = optStr(body.nickname);
  if ("academyName" in body) data.academyName = optStr(body.academyName);
  if ("unofficialWeight" in body) data.unofficialWeight = optNum(body.unofficialWeight);
  if ("heightFeet" in body) data.heightFeet = optInt(body.heightFeet);
  if ("heightInches" in body) data.heightInches = optInt(body.heightInches);
  if ("age" in body) data.age = optInt(body.age);
  if ("profilePhotoUrl" in body) data.profilePhotoUrl = optStr(body.profilePhotoUrl);
  if ("headShotUrl" in body) data.headShotUrl = optStr(body.headShotUrl);

  try {
    const profile = await prisma.masterPlayerProfile.update({ where: { id }, data });
    return NextResponse.json({ profile });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.includes("Record to update not found")) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const a = await requireUserId();
  if ("response" in a) return a.response;
  const { id } = await ctx.params;
  try {
    await prisma.masterPlayerProfile.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.includes("Record to delete does not exist")) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
