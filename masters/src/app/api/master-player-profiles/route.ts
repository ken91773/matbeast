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

export async function GET() {
  const a = await requireUserId();
  if ("response" in a) return a.response;

  const profiles = await prisma.masterPlayerProfile.findMany({
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  return NextResponse.json({ profiles });
}

export async function POST(req: NextRequest) {
  const a = await requireUserId();
  if ("response" in a) return a.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const firstNameRaw = body.firstName;
  const lastNameRaw = body.lastName;
  const beltRankRaw = body.beltRank;

  if (typeof firstNameRaw !== "string" || firstNameRaw.trim().length === 0) {
    return NextResponse.json({ error: "firstName required" }, { status: 400 });
  }
  if (typeof lastNameRaw !== "string" || lastNameRaw.trim().length === 0) {
    return NextResponse.json({ error: "lastName required" }, { status: 400 });
  }
  if (!isBelt(beltRankRaw)) {
    return NextResponse.json(
      { error: `beltRank required, one of ${VALID_BELTS.join(", ")}` },
      { status: 400 },
    );
  }

  const firstName = firstNameRaw.trim().toUpperCase();
  const lastName = lastNameRaw.trim().toUpperCase();

  const data: Prisma.MasterPlayerProfileCreateInput = {
    firstName,
    lastName,
    beltRank: beltRankRaw,
    nickname: optStr(body.nickname),
    academyName: optStr(body.academyName),
    unofficialWeight: optNum(body.unofficialWeight),
    heightFeet: optInt(body.heightFeet),
    heightInches: optInt(body.heightInches),
    age: optInt(body.age),
    profilePhotoUrl: optStr(body.profilePhotoUrl),
    headShotUrl: optStr(body.headShotUrl),
    createdByUserId: a.userId,
    updatedByUserId: a.userId,
  };

  try {
    const profile = await prisma.masterPlayerProfile.create({ data });
    return NextResponse.json({ profile }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.includes("Unique constraint")) {
      const existing = await prisma.masterPlayerProfile.findUnique({
        where: { firstName_lastName: { firstName, lastName } },
      });
      return NextResponse.json(
        { profile: existing, alreadyExisted: true },
        { status: 200 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
