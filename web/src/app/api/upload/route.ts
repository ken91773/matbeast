import { randomUUID } from "crypto";
import { writeFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";

const ALLOWED = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob) || file.size === 0) {
      return NextResponse.json({ error: "Missing file" }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "File too large (max 8MB)" }, { status: 400 });
    }
    const type = file.type;
    if (!ALLOWED.has(type)) {
      return NextResponse.json(
        { error: "Use JPEG, PNG, WebP, or GIF" },
        { status: 400 },
      );
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const orig =
      file instanceof File && file.name
        ? path.extname(file.name).toLowerCase()
        : "";
    const ext =
      orig && orig.length <= 5
        ? orig
        : type === "image/png"
          ? ".png"
          : type === "image/webp"
            ? ".webp"
            : type === "image/gif"
              ? ".gif"
              : ".jpg";
    const name = `${randomUUID()}${ext}`;
    const rel = `uploads/${name}`;
    const full = path.join(process.cwd(), "public", rel);
    await writeFile(full, buf);
    return NextResponse.json({ url: `/${rel}` });
  } catch (e) {
    console.error("[POST /api/upload]", e);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}

export const runtime = "nodejs";
