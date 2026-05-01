import { normalizeEventFileKey } from "@/lib/event-file-key";
import type {
  RosterEventKind,
  RosterFileDocument,
  RosterFileResultLog,
} from "@/lib/roster-file-types";

type TeamRow = {
  name: string;
  seedOrder: number;
  overlayColor?: string | null;
  players: Array<{
    firstName: string;
    lastName: string;
    nickname: string | null;
    academyName: string | null;
    unofficialWeight: number | null;
    officialWeight: number | null;
    heightFeet: number | null;
    heightInches: number | null;
    age: number | null;
    beltRank: string;
    profilePhotoUrl: string | null;
    headShotUrl: string | null;
    lineupOrder: number;
    lineupConfirmed: boolean;
    weighedConfirmed: boolean;
  }>;
};

export type TeamsApiForExport = {
  eventKind: string;
  teams: TeamRow[];
};

/** Build roster JSON from GET /api/teams payload. */
export function buildRosterDocumentFromTeamsApi(data: TeamsApiForExport): RosterFileDocument {
  const eventKind: RosterEventKind =
    data.eventKind === "PURPLE_BROWN" ? "PURPLE_BROWN" : "BLUE_BELT";
  return {
    version: 1,
    app: "Mat Beast Score",
    eventKind,
    savedAt: new Date().toISOString(),
    teams: data.teams.map((team) => ({
      seedOrder: team.seedOrder,
      name: team.name,
      overlayColor: team.overlayColor ?? null,
      players: team.players
        .slice()
        .sort((a, b) => a.lineupOrder - b.lineupOrder)
        .map((p) => ({
          firstName: p.firstName,
          lastName: p.lastName,
          nickname: p.nickname,
          academyName: p.academyName,
          unofficialWeight: p.unofficialWeight,
          officialWeight: p.officialWeight,
          heightFeet: p.heightFeet,
          heightInches: p.heightInches,
          age: p.age,
          beltRank: p.beltRank as RosterFileDocument["teams"][number]["players"][number]["beltRank"],
          profilePhotoUrl: p.profilePhotoUrl,
          headShotUrl: p.headShotUrl,
          lineupOrder: p.lineupOrder,
          lineupConfirmed: p.lineupConfirmed ?? false,
          weighedConfirmed: p.weighedConfirmed ?? false,
        })),
    })),
  };
}

export function wrapMatBeastEventFile(
  eventName: string,
  roster: RosterFileDocument,
  bracket?: {
    version: 1;
    matches: Array<{
      round: "QUARTER_FINAL" | "SEMI_FINAL" | "GRAND_FINAL";
      bracketIndex: number;
      homeSeedOrder: number;
      awaySeedOrder: number;
      winnerSeedOrder: number | null;
    }>;
  },
  audioVolumePercent?: number,
  /** Board / on-disk file label; when set, `eventFileKey` in JSON follows this, not `eventName`. */
  eventFileKeySource?: string | null,
  trainingMode?: boolean,
  /** v1.2.8: Results card rows; persisted in the envelope so they survive reopen. */
  resultLogs?: RosterFileResultLog[] | null,
) {
  const key = normalizeEventFileKey(eventFileKeySource ?? eventName);
  return {
    kind: "matbeast-event" as const,
    version: 1 as const,
    eventName,
    ...(key ? { eventFileKey: key } : {}),
    savedAt: new Date().toISOString(),
    roster,
    ...(bracket ? { bracket } : {}),
    ...(typeof audioVolumePercent === "number" ? { audioVolumePercent } : {}),
    /** Always present so .matb files clearly state live vs training (home list also uses DB merge). */
    trainingMode: Boolean(trainingMode),
    ...(Array.isArray(resultLogs) && resultLogs.length > 0
      ? { resultLogs }
      : {}),
  };
}
