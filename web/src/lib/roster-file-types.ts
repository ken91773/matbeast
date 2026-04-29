import type { BeltRank } from "@prisma/client";

export type RosterEventKind = "BLUE_BELT" | "PURPLE_BROWN";

export type RosterFilePlayer = {
  firstName: string;
  lastName: string;
  nickname: string | null;
  academyName: string | null;
  unofficialWeight: number | null;
  officialWeight: number | null;
  heightFeet: number | null;
  heightInches: number | null;
  age: number | null;
  beltRank: BeltRank;
  profilePhotoUrl: string | null;
  headShotUrl: string | null;
  /** `null` = not in the 1–7 quintet lineup (bench, etc.). */
  lineupOrder: number | null;
  lineupConfirmed: boolean;
  weighedConfirmed: boolean;
};

export type RosterFileTeam = {
  seedOrder: number;
  name: string;
  /**
   * Optional CSS color (`#RGB` or `#RRGGBB`) for bracket overlay slot
   * backgrounds. Absent/undefined ⇒ importer leaves the current value
   * alone (backward compatibility for pre-color save files). Explicit
   * `null` ⇒ importer clears the color.
   */
  overlayColor?: string | null;
  players: RosterFilePlayer[];
};

export type RosterFileDocument = {
  version: 1;
  app: "Mat Beast Score";
  eventKind: RosterEventKind;
  savedAt: string;
  teams: RosterFileTeam[];
};

export type MatBeastEventEnvelope = {
  kind: "matbeast-event";
  version: 1;
  /** Display / file title */
  eventName: string;
  /** Normalized key (trimmed; case preserved) matching saved file identity; same as board `currentRosterFileName`. */
  eventFileKey?: string;
  savedAt: string;
  /** Full quintet roster for this event file */
  roster: RosterFileDocument;
  /** Optional bracket snapshot (seed-based) for save/restore compatibility. */
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
  /** Optional persisted local audio volume (0-100). */
  audioVolumePercent?: number;
  /** When true, this file was created as a training event (separate master lists). */
  trainingMode?: boolean;
};
