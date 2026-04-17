import type { BeltRank } from "@prisma/client";
import type {
  MatBeastEventEnvelope,
  RosterFileDocument,
  RosterEventKind,
} from "@/lib/roster-file-types";

const ALL_BELT_OPTIONS: readonly BeltRank[] = [
  "WHITE",
  "BLUE",
  "PURPLE",
  "BROWN",
  "BLACK",
];

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Normalize a raw team color value from a roster file.
 * - `undefined` (key absent) → `undefined` so importer skips the field
 * - explicit `null` or empty string → `null` so importer clears the color
 * - valid `#RGB` / `#RRGGBB` → the trimmed value
 * - anything else → `null` (defensive)
 */
function parseTeamOverlayColor(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return HEX_COLOR_RE.test(trimmed) ? trimmed : null;
}

export function parseRosterDocument(raw: unknown): RosterFileDocument {
  const obj = raw as Partial<RosterFileDocument>;
  if (!obj || obj.version !== 1 || obj.app !== "Mat Beast Score") {
    throw new Error("Invalid roster file format");
  }
  if (
    obj.eventKind != null &&
    obj.eventKind !== "BLUE_BELT" &&
    obj.eventKind !== "PURPLE_BROWN"
  ) {
    throw new Error("Roster file event kind is invalid");
  }
  if (!Array.isArray(obj.teams)) {
    throw new Error("Roster file teams are invalid");
  }
  const defaultBelt: BeltRank = "WHITE";
  return {
    version: 1,
    app: "Mat Beast Score",
    eventKind:
      obj.eventKind === "BLUE_BELT" || obj.eventKind === "PURPLE_BROWN"
        ? (obj.eventKind as RosterEventKind)
        : "BLUE_BELT",
    savedAt:
      typeof obj.savedAt === "string" ? obj.savedAt : new Date().toISOString(),
    teams: obj.teams.map((team) => {
      const t = team as Partial<RosterFileDocument["teams"][number]>;
      if (typeof t.seedOrder !== "number" || !Number.isInteger(t.seedOrder)) {
        throw new Error("A team seed in the roster file is invalid");
      }
      if (!Array.isArray(t.players)) {
        throw new Error("A team player list in the roster file is invalid");
      }
      const parsedOverlayColor = parseTeamOverlayColor(
        (t as { overlayColor?: unknown }).overlayColor,
      );
      return {
        seedOrder: t.seedOrder,
        name: typeof t.name === "string" ? t.name : "TBD",
        ...(parsedOverlayColor !== undefined
          ? { overlayColor: parsedOverlayColor }
          : {}),
        players: t.players.map((player) => {
          const p = player as Partial<RosterFileDocument["teams"][number]["players"][number]>;
          const belt =
            typeof p.beltRank === "string" &&
            ALL_BELT_OPTIONS.includes(p.beltRank as BeltRank)
              ? (p.beltRank as BeltRank)
              : defaultBelt;
          const lineup =
            typeof p.lineupOrder === "number" &&
            Number.isInteger(p.lineupOrder) &&
            p.lineupOrder >= 1 &&
            p.lineupOrder <= 7
              ? p.lineupOrder
              : 1;
          return {
            firstName: typeof p.firstName === "string" ? p.firstName : "",
            lastName: typeof p.lastName === "string" ? p.lastName : "",
            nickname: typeof p.nickname === "string" ? p.nickname : null,
            academyName:
              typeof p.academyName === "string" ? p.academyName : null,
            unofficialWeight:
              typeof p.unofficialWeight === "number" ? p.unofficialWeight : null,
            officialWeight:
              typeof p.officialWeight === "number" ? p.officialWeight : null,
            heightFeet: typeof p.heightFeet === "number" ? p.heightFeet : null,
            heightInches:
              typeof p.heightInches === "number" ? p.heightInches : null,
            age: typeof p.age === "number" ? p.age : null,
            beltRank: belt,
            profilePhotoUrl:
              typeof p.profilePhotoUrl === "string" ? p.profilePhotoUrl : null,
            headShotUrl:
              typeof p.headShotUrl === "string" ? p.headShotUrl : null,
            lineupOrder: lineup,
            lineupConfirmed:
              typeof p.lineupConfirmed === "boolean" ? p.lineupConfirmed : false,
            weighedConfirmed:
              typeof p.weighedConfirmed === "boolean" ? p.weighedConfirmed : false,
          };
        }),
      };
    }),
  };
}

/** Parse event file JSON (`.matb`, legacy `.mat`, or `.json`): wrapped matbeast-event or roster-only document. */
export function parseMatBeastEventFileJson(
  raw: unknown,
  fallbackEventName: string,
): {
  eventName: string;
  document: RosterFileDocument;
  bracket?: {
    version: 1;
    matches: Array<{
      round: "QUARTER_FINAL" | "SEMI_FINAL" | "GRAND_FINAL";
      bracketIndex: number;
      homeSeedOrder: number;
      awaySeedOrder: number;
      winnerSeedOrder: number | null;
    }>;
  };
  audioVolumePercent?: number;
} {
  const obj = raw as Partial<MatBeastEventEnvelope> & Record<string, unknown>;
  if (obj && obj.kind === "matbeast-event" && obj.version === 1 && obj.roster) {
    const name =
      typeof obj.eventName === "string" && obj.eventName.trim()
        ? obj.eventName.trim()
        : fallbackEventName;
    const bracketRaw = obj.bracket as
      | {
          version?: unknown;
          matches?: unknown;
        }
      | undefined;
    const bracket =
      bracketRaw &&
      bracketRaw.version === 1 &&
      Array.isArray(bracketRaw.matches)
        ? {
            version: 1 as const,
            matches: bracketRaw.matches
              .map((m) => m as Record<string, unknown>)
              .filter(
                (m) =>
                  (m.round === "QUARTER_FINAL" ||
                    m.round === "SEMI_FINAL" ||
                    m.round === "GRAND_FINAL") &&
                  typeof m.bracketIndex === "number" &&
                  typeof m.homeSeedOrder === "number" &&
                  typeof m.awaySeedOrder === "number" &&
                  (m.winnerSeedOrder === null ||
                    typeof m.winnerSeedOrder === "number"),
              )
              .map((m) => ({
                round: m.round as "QUARTER_FINAL" | "SEMI_FINAL" | "GRAND_FINAL",
                bracketIndex: Math.trunc(m.bracketIndex as number),
                homeSeedOrder: Math.trunc(m.homeSeedOrder as number),
                awaySeedOrder: Math.trunc(m.awaySeedOrder as number),
                winnerSeedOrder:
                  m.winnerSeedOrder === null
                    ? null
                    : Math.trunc(m.winnerSeedOrder as number),
              })),
          }
        : undefined;
    const rawVol = Number(obj.audioVolumePercent);
    const audioVolumePercent = Number.isFinite(rawVol)
      ? Math.max(0, Math.min(100, Math.round(rawVol)))
      : undefined;
    return {
      eventName: name,
      document: parseRosterDocument(obj.roster),
      bracket,
      audioVolumePercent,
    };
  }
  return {
    eventName: fallbackEventName,
    document: parseRosterDocument(raw),
  };
}
