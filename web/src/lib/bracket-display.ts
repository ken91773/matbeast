export type BracketTeamRef = { id: string; name: string; seedOrder: number };

export type BracketMatchJson = {
  id: string;
  round: string;
  bracketIndex: number;
  winnerTeamId: string | null;
  homeTeam: BracketTeamRef;
  awayTeam: BracketTeamRef;
  winnerTeam: BracketTeamRef | null;
};

export type BracketPayload = {
  quarterFinals: BracketMatchJson[];
  semiFinals: BracketMatchJson[];
  grandFinal: BracketMatchJson | null;
  error?: string;
};

export function normalizeBracketPayload(
  j: BracketPayload & { error?: string },
): BracketPayload {
  return {
    quarterFinals: j.quarterFinals ?? [],
    semiFinals: j.semiFinals ?? [],
    grandFinal: j.grandFinal ?? null,
  };
}

export type TeamLabelOptions = {
  /**
   * With `blankWhenTbd`, bracket **placeholders** stay visually empty (unknown slot).
   * Real matches that pair bye-marker teams (`TBD`/empty from roster) should read
   * "BYE" on the dashboard card while the overlay keeps `blankWhenTbd` without this
   * flag so walkovers stay blank there.
   */
  byeWordForBlankTbdOnCard?: boolean;
};

export function teamLabel(
  t: BracketTeamRef,
  blankWhenTbd = false,
  opts?: TeamLabelOptions,
) {
  const n = (t.name || "TBD").trim() || "TBD";
  const nu = n.toUpperCase();
  /** Dashboard bracket cards: unassigned roster rows are named TBD — show empty, not the word BYE. */
  if (blankWhenTbd && (nu === "TBD" || nu === "")) {
    if (opts?.byeWordForBlankTbdOnCard) return "BYE";
    return "";
  }
  const shown = nu === "TBD" ? "BYE" : n;
  if (shown === "BYE") return "BYE";
  return `#${t.seedOrder} ${shown}`;
}

export function winnerFromMatch(m: BracketMatchJson): BracketTeamRef | null {
  if (m.winnerTeam) return m.winnerTeam;
  if (m.winnerTeamId === m.homeTeam.id) return m.homeTeam;
  if (m.winnerTeamId === m.awayTeam.id) return m.awayTeam;
  return null;
}

export function isTbdTeamRef(t: BracketTeamRef): boolean {
  const n = (t.name || "").trim().toUpperCase();
  return !n || n === "TBD";
}

export function placeholderMatch(
  id: string,
  round: string,
  bracketIndex: number,
): BracketMatchJson {
  return {
    id,
    round,
    bracketIndex,
    winnerTeamId: null,
    winnerTeam: null,
    homeTeam: { id: `${id}-home`, name: "TBD", seedOrder: 0 },
    awayTeam: { id: `${id}-away`, name: "TBD", seedOrder: 0 },
  };
}

export function namedTeamCount(teamOptions: BracketTeamRef[]) {
  return teamOptions.filter((t) => {
    const n = (t.name || "").trim().toUpperCase();
    return n.length > 0 && n !== "TBD" && n !== "BYE";
  }).length;
}

export function buildBracketProjection(data: BracketPayload | null | undefined, teamOptions: BracketTeamRef[]) {
  /**
   * Defensive array guards — the overlay iframe re-runs this on every tab
   * switch, and during the remount window the cached react-query bracket
   * payload for the new tournament can briefly arrive with
   * `quarterFinals` / `semiFinals` missing or non-array (e.g. an error
   * shape that only has `{ error }`). Calling `.find` on `undefined` in
   * that path produced the minified "C.find is not a function" crash
   * captured by the overlay error boundary. Treat any non-array as "no
   * matches recorded yet" and fall through to the placeholder branch.
   */
  const quarterFinalsList: BracketMatchJson[] = Array.isArray(data?.quarterFinals)
    ? (data!.quarterFinals as BracketMatchJson[])
    : [];
  const semiFinalsList: BracketMatchJson[] = Array.isArray(data?.semiFinals)
    ? (data!.semiFinals as BracketMatchJson[])
    : [];

  const quarterSlots: BracketMatchJson[] = [0, 1, 2, 3].map(
    (idx) =>
      quarterFinalsList.find((m) => m.bracketIndex === idx) ??
      placeholderMatch(`quarter-placeholder-${idx}`, "QUARTER_FINAL", idx),
  );

  const projectedSemiSlots: BracketMatchJson[] = [0, 1].map((idx) => {
    const existing = semiFinalsList.find((m) => m.bracketIndex === idx);
    if (existing) return existing;
    const [leftQf, rightQf] =
      idx === 0 ? [quarterSlots[0], quarterSlots[1]] : [quarterSlots[2], quarterSlots[3]];
    const projectedHome = winnerFromMatch(leftQf);
    const projectedAway = winnerFromMatch(rightQf);
    return {
      ...placeholderMatch(`semi-placeholder-${idx}`, "SEMI_FINAL", idx),
      homeTeam: projectedHome ?? { id: `semi-placeholder-${idx}-home`, name: "TBD", seedOrder: 0 },
      awayTeam: projectedAway ?? { id: `semi-placeholder-${idx}-away`, name: "TBD", seedOrder: 0 },
    };
  });

  const grandFinalSlot = (() => {
    if (data?.grandFinal) return data.grandFinal;
    const projectedHome = winnerFromMatch(projectedSemiSlots[0]!);
    const projectedAway = winnerFromMatch(projectedSemiSlots[1]!);
    return {
      ...placeholderMatch("grand-final-placeholder", "GRAND_FINAL", 0),
      homeTeam: projectedHome ?? { id: "grand-final-placeholder-home", name: "TBD", seedOrder: 0 },
      awayTeam: projectedAway ?? { id: "grand-final-placeholder-away", name: "TBD", seedOrder: 0 },
    };
  })();

  const setUpTeamCount = namedTeamCount(teamOptions);
  const showQuarterFinalsColumn = setUpTeamCount > 4;

  return {
    quarterSlots,
    semiSlots: projectedSemiSlots,
    grandFinalSlot,
    showQuarterFinalsColumn,
  };
}
