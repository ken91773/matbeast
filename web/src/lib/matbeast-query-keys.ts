/** Stable query keys for TanStack Query (tournament-scoped where applicable). */
export const matbeastKeys = {
  all: ["matbeast"] as const,
  tournaments: () => [...matbeastKeys.all, "tournaments"] as const,
  board: (tournamentId: string | null) =>
    [...matbeastKeys.all, "board", tournamentId ?? "none"] as const,
  players: (tournamentId: string | null) =>
    [...matbeastKeys.all, "players", tournamentId ?? "none"] as const,
  bracket: (tournamentId: string | null) =>
    [...matbeastKeys.all, "bracket", tournamentId ?? "none"] as const,
  teams: (tournamentId: string | null) =>
    [...matbeastKeys.all, "teams", tournamentId ?? "none"] as const,
  /** Scoped by active tournament + training tab so live vs training caches never mix. */
  playerProfiles: (
    tournamentId: string | null,
    teamHintId?: string | null,
    useTrainingMasters?: boolean,
  ) =>
    [
      ...matbeastKeys.all,
      "player-profiles",
      tournamentId ?? "none",
      teamHintId?.trim() ? teamHintId.trim() : "none",
      useTrainingMasters === true ? "training" : "live",
    ] as const,
  masterTeamNames: (tournamentId: string | null, useTrainingMasters?: boolean) =>
    [
      ...matbeastKeys.all,
      "master-team-names",
      tournamentId ?? "none",
      useTrainingMasters === true ? "training" : "live",
    ] as const,
};
