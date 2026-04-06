/** Normalize profile text to ALL CAPS (names, academy, etc.). */
export function profileUpper(s: string): string {
  return s.normalize("NFKC").trim().toUpperCase();
}
