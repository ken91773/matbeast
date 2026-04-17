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
  playerProfiles: () => [...matbeastKeys.all, "player-profiles"] as const,
  masterTeamNames: () => [...matbeastKeys.all, "master-team-names"] as const,
};
