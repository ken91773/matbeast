/** Normalize for comparisons (uppercase, collapse spaces). */
export function normalizeDisplayTeamName(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, " ");
}

/** Names that must not appear as a user-chosen custom team / master entry. */
export function isForbiddenCustomTeamName(raw: string): boolean {
  const n = normalizeDisplayTeamName(raw);
  if (!n) return false;
  const compact = n.replace(/ /g, "");
  if (n === "UNAFFILIATED") return true;
  if (n === "NOT LISTED") return true;
  if (n === "NOT AFFILIATED") return true;
  if (compact === "NOTAFFILIATED") return true;
  return false;
}

/** Includes **TBD** — blocked for new team names from NOT LISTED / master POST (slot sentinel is separate). */
export function isForbiddenUserChosenTeamName(raw: string): boolean {
  return (
    normalizeDisplayTeamName(raw) === "TBD" || isForbiddenCustomTeamName(raw)
  );
}

export function forbiddenUserChosenTeamNameMessage(): string {
  return "That name is reserved (TBD, UNAFFILIATED, NOT LISTED, NOT AFFILIATED) and cannot be used.";
}
