import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Lightweight server-side sink for client-side errors caught by
 * `app/global-error.tsx` and the inline overlay error boundary. Writes to
 * the standard bundled-server log so renderer crashes are reproducible
 * post-mortem from %APPDATA%/matbeastscore/bundled-server.log.
 *
 * Intentionally minimal: no DB, no auth, capped body size, swallow on
 * malformed input. The point is to never make a logging call ITSELF be a
 * source of crashes.
 */
export const dynamic = "force-dynamic";

const MAX_BYTES = 16 * 1024;

export async function POST(req: NextRequest) {
  try {
    const text = await req.text();
    const truncated = text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) + "…" : text;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(truncated) as Record<string, unknown>;
    } catch {
      parsed = { raw: truncated };
    }
    const stamp = new Date().toISOString();
    const oneLine = JSON.stringify(parsed).replace(/\s+/g, " ");
    process.stderr.write(`${stamp}  client-error  ${oneLine}\n`);
  } catch {
    /* ignore */
  }
  return NextResponse.json({ ok: true });
}
