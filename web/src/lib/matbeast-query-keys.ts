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
  /** Scoped by active tournament so live vs training caches never mix. */
  playerProfiles: (tournamentId: string | null) =>
    [...matbeastKeys.all, "player-profiles", tournamentId ?? "none"] as const,
  masterTeamNames: (tournamentId: string | null) =>
    [...matbeastKeys.all, "master-team-names", tournamentId ?? "none"] as const,
};
