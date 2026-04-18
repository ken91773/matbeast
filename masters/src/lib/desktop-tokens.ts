import { createHash, randomBytes } from "node:crypto";

const TOKEN_PREFIX = "mbk_";

/**
 * Generate a fresh plaintext desktop token + its sha256 hash + a 4-char preview.
 *
 * The plaintext is shown to the user once at mint time; only the hash and
 * preview live in the database.
 */
export function mintToken(): {
  plaintext: string;
  hash: string;
  preview: string;
} {
  // 32 bytes -> ~43 base64url chars => total length ~47 with the prefix.
  // Plenty of entropy, and the wire format is unambiguous.
  const raw = randomBytes(32).toString("base64url");
  const plaintext = `${TOKEN_PREFIX}${raw}`;
  const hash = hashToken(plaintext);
  const preview = plaintext.slice(-4);
  return { plaintext, hash, preview };
}

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Pull `Authorization: Bearer mbk_xxxxx` out of a Headers object.
 * Returns the plaintext token (without the "Bearer " prefix) or null.
 */
export function extractBearerToken(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(\S+)/i.exec(auth);
  if (!m) return null;
  const tok = m[1].trim();
  if (!tok.startsWith(TOKEN_PREFIX)) return null;
  return tok;
}
