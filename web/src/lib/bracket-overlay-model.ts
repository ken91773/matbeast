import {
  type BracketMatchJson,
  type BracketPayload,
  type BracketTeamRef,
  buildBracketProjection,
  namedTeamCount,
  teamLabel,
} from "@/lib/bracket-display";

export type BracketOverlaySlot = {
  text: string;
  teamId: string | null;
  backgroundColor: string | null;
  color: string;
  /** Bracket match id for overlay highlight (current match). */
  matchId: string | null;
};

function stripSeedPrefix(label: string) {
  const t = label.trim();
  const m = t.match(/^#\d+\s+(.*)$/);
  return (m?.[1] ?? t).trim();
}

/** Match row may carry TBD/empty names; roster is source of truth for the same team id. */
function resolveOverlayTeam(team: BracketTeamRef, teamById: Map<string, BracketTeamRef>): BracketTeamRef {
  const roster = teamById.get(team.id);
  const matchName = (team.name || "").trim();
  const isTbdLike = !matchName || matchName.toUpperCase() === "TBD";
  if (!isTbdLike) return team;
  if (!roster) return team;
  const rosterName = (roster.name || "").trim();
  if (!rosterName || rosterName.toUpperCase() === "TBD") return team;
  return {
    id: team.id,
    name: roster.name,
    seedOrder: roster.seedOrder,
  };
}

/**
 * Broadcast overlay: never use `teamLabel(..., true)` — it blanks TBD + seedOrder 0,
 * which is exactly what projected / placeholder bracket rows use before scores exist.
 */
function overlayTextFromTeamRef(team: BracketTeamRef, teamById: Map<string, BracketTeamRef>) {
  const t = resolveOverlayTeam(team, teamById);
  const label = stripSeedPrefix(teamLabel(t, true)).toUpperCase();
  return label === "BYE" ? "" : label;
}

function overlayTextFromMatchSide(
  m: BracketMatchJson,
  side: "home" | "away",
  teamById: Map<string, BracketTeamRef>,
) {
  const team = side === "home" ? m.homeTeam : m.awayTeam;
  return overlayTextFromTeamRef(team, teamById);
}

function relativeLuminance(hex: string) {
  const h = hex.trim().replace("#", "");
  if (!(h.length === 6 || h.length === 3)) return 0;
  const expand = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = Number.parseInt(expand.slice(0, 2), 16) / 255;
  const g = Number.parseInt(expand.slice(2, 4), 16) / 255;
  const b = Number.parseInt(expand.slice(4, 6), 16) / 255;
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG AA body-text threshold. Swatches below this are considered unreadable. */
export const READABLE_TEXT_MIN_CONTRAST = 4.5;
const READABLE_TEXT_BLACK = "#111111";
const READABLE_TEXT_WHITE = "#ffffff";

/** WCAG contrast ratio between two hex colors. Returns 0 on bad input. */
export function contrastRatio(a: string, b: string) {
  try {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const light = Math.max(la, lb);
    const dark = Math.min(la, lb);
    return (light + 0.05) / (dark + 0.05);
  } catch {
    return 0;
  }
}

/**
 * True if the better of black/white text clears AA body contrast against `bg`.
 * Used to filter the Teams color palette so users can't pick an unreadable swatch.
 */
export function hasReadableTextContrast(
  bg: string,
  min: number = READABLE_TEXT_MIN_CONTRAST,
) {
  const best = Math.max(
    contrastRatio(bg, READABLE_TEXT_WHITE),
    contrastRatio(bg, READABLE_TEXT_BLACK),
  );
  return best >= min;
}

/**
 * Pick readable text color for any swatch. Compares WCAG contrast ratios of
 * white vs. near-black against the given bg and returns whichever wins.
 * Null/invalid bg falls back to the overlay's default zinc tint so uncolored
 * teams keep their existing look.
 */
export function pickTextOnBackground(bg: string | null | undefined) {
  if (!bg) return "#d9d9d9";
  try {
    const contrastWhite = contrastRatio(bg, READABLE_TEXT_WHITE);
    const contrastBlack = contrastRatio(bg, READABLE_TEXT_BLACK);
    return contrastBlack >= contrastWhite ? READABLE_TEXT_BLACK : READABLE_TEXT_WHITE;
  } catch {
    return READABLE_TEXT_WHITE;
  }
}

function colorForTeamId(teamId: string | null, teamColorById: Map<string, string | null | undefined>) {
  if (!teamId) return null;
  const c = teamColorById.get(teamId);
  if (!c) return null;
  const t = c.trim();
  return t.length ? t : null;
}

export function buildBracketOverlaySlots(args: {
  bracket: BracketPayload | null | undefined;
  teams: Array<BracketTeamRef & { overlayColor?: string | null }>;
}): {
  mode: 4 | 8;
  fourTeamSlots: BracketOverlaySlot[];
  quarterSlots: BracketOverlaySlot[];
  semiSlots: BracketOverlaySlot[];
  grandSlots: [BracketOverlaySlot, BracketOverlaySlot];
} {
  const teamOptions: BracketTeamRef[] = (args.teams ?? [])
    .slice()
    .sort((a, b) => a.seedOrder - b.seedOrder)
    .map((t) => ({ id: t.id, name: t.name, seedOrder: t.seedOrder }));

  const teamColorById = new Map<string, string | null | undefined>();
  const teamById = new Map<string, BracketTeamRef>();
  for (const t of args.teams ?? []) {
    teamColorById.set(t.id, t.overlayColor);
    teamById.set(t.id, { id: t.id, name: t.name, seedOrder: t.seedOrder });
  }

  const projection = buildBracketProjection(args.bracket, teamOptions);
  const mode: 4 | 8 = namedTeamCount(teamOptions) > 4 ? 8 : 4;

  const slotFromTeam = (team: BracketTeamRef, matchId: string | null): BracketOverlaySlot => {
    const resolved = resolveOverlayTeam(team, teamById);
    const bg = colorForTeamId(resolved.id, teamColorById);
    return {
      text: overlayTextFromTeamRef(team, teamById),
      teamId: resolved.id,
      backgroundColor: bg,
      color: pickTextOnBackground(bg),
      matchId,
    };
  };

  const semiTop = projection.semiSlots[0]!;
  const semiBot = projection.semiSlots[1]!;
  const gfSlot = projection.grandFinalSlot;

  let fourTeamSlots: BracketOverlaySlot[] = [
    slotFromTeam(semiTop.homeTeam, semiTop.id),
    slotFromTeam(semiTop.awayTeam, semiTop.id),
    slotFromTeam(semiBot.homeTeam, semiBot.id),
    slotFromTeam(semiBot.awayTeam, semiBot.id),
    slotFromTeam(gfSlot.homeTeam, gfSlot.id),
    slotFromTeam(gfSlot.awayTeam, gfSlot.id),
  ];

  /** No DB bracket yet (or all placeholders): still show 1v4 / 2v3 from seeds for small fields. */
  const namedN = namedTeamCount(teamOptions);
  if (
    mode === 4 &&
    namedN >= 2 &&
    namedN <= 4 &&
    fourTeamSlots.every((s) => !s.text.trim())
  ) {
    const named = teamOptions
      .filter((t) => {
        const n = (t.name || "").trim().toUpperCase();
        return n.length > 0 && n !== "TBD" && n !== "BYE";
      })
      .slice()
      .sort((a, b) => a.seedOrder - b.seedOrder);
    const seeds = [...named];
    while (seeds.length < 4) {
      seeds.push({ id: `overlay-bye-${seeds.length}`, name: "BYE", seedOrder: 99 });
    }
    const s = seeds.slice(0, 4);
    const dash: BracketOverlaySlot = {
      text: "—",
      teamId: null,
      backgroundColor: null,
      color: "#d9d9d9",
      matchId: null,
    };
    fourTeamSlots = [
      slotFromTeam(s[0]!, null),
      slotFromTeam(s[3]!, null),
      slotFromTeam(s[1]!, null),
      slotFromTeam(s[2]!, null),
      dash,
      dash,
    ];
  }

  // 8-team QF renders both teams (home + away) per match → 8 slots total.
  // Order matches `quarterFinals` boxes in overlay-client: M0 home, M0 away, M1 home, M1 away, …
  const quarterSlots: BracketOverlaySlot[] = projection.quarterSlots.flatMap((m) => {
    const homeBg = colorForTeamId(m.homeTeam.id, teamColorById);
    const awayBg = colorForTeamId(m.awayTeam.id, teamColorById);
    return [
      {
        text: overlayTextFromMatchSide(m, "home", teamById),
        teamId: m.homeTeam.id,
        backgroundColor: homeBg,
        color: pickTextOnBackground(homeBg),
        matchId: m.id,
      },
      {
        text: overlayTextFromMatchSide(m, "away", teamById),
        teamId: m.awayTeam.id,
        backgroundColor: awayBg,
        color: pickTextOnBackground(awayBg),
        matchId: m.id,
      },
    ];
  });

  const semiSlots: BracketOverlaySlot[] = projection.semiSlots.flatMap((m) => {
    return [
      {
        text: overlayTextFromMatchSide(m, "home", teamById),
        teamId: m.homeTeam.id,
        backgroundColor: colorForTeamId(m.homeTeam.id, teamColorById),
        color: pickTextOnBackground(colorForTeamId(m.homeTeam.id, teamColorById)),
        matchId: m.id,
      },
      {
        text: overlayTextFromMatchSide(m, "away", teamById),
        teamId: m.awayTeam.id,
        backgroundColor: colorForTeamId(m.awayTeam.id, teamColorById),
        color: pickTextOnBackground(colorForTeamId(m.awayTeam.id, teamColorById)),
        matchId: m.id,
      },
    ];
  });

  const gf = projection.grandFinalSlot;
  const grandSlots: [BracketOverlaySlot, BracketOverlaySlot] = [
    {
      text: overlayTextFromMatchSide(gf, "home", teamById),
      teamId: gf.homeTeam.id,
      backgroundColor: colorForTeamId(gf.homeTeam.id, teamColorById),
      color: pickTextOnBackground(colorForTeamId(gf.homeTeam.id, teamColorById)),
      matchId: gf.id,
    },
    {
      text: overlayTextFromMatchSide(gf, "away", teamById),
      teamId: gf.awayTeam.id,
      backgroundColor: colorForTeamId(gf.awayTeam.id, teamColorById),
      color: pickTextOnBackground(colorForTeamId(gf.awayTeam.id, teamColorById)),
      matchId: gf.id,
    },
  ];

  return { mode, fourTeamSlots, quarterSlots, semiSlots, grandSlots };
}
