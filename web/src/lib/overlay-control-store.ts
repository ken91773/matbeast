/**
 * Server-side mirror of the overlay output "show control" state (v2.0.3).
 *
 * The dashboard normally drives output windows over `BroadcastChannel`
 * (`overlay-output-broadcast.ts`), but that channel is same-origin AND
 * same-machine only — a remote OBS / browser source on another PC never
 * receives it. To let a remote Browser Source replicate the live show
 * (OVERLAY LIVE / barn doors, SHOW TEAMS swaps + fades, the current bracket
 * match highlight), the dashboard also POSTs each control change here and the
 * overlay polls `/api/overlay-control`.
 *
 * State is intentionally ephemeral (in-memory, single bundled-server process).
 * It is NOT persisted: a cold app start resets the show to "scoreboard,
 * stopped" exactly like the BroadcastChannel path. A module-level singleton on
 * `globalThis` survives Next.js dev HMR.
 */
import type { OverlayOutputBroadcast } from "@/lib/overlay-output-broadcast";

export type OverlayControlState = {
  /** OVERLAY LIVE — drives the barn-door open/close on every overlay surface. */
  live: boolean;
  /** Locked-scene windows ignore this, but it mirrors the dashboard scene toggle. */
  scene: "scoreboard" | "bracket";
  /** Scoreboard-window content: graphic / team list / blank. */
  scoreboardMode: "scoreboard" | "teams" | "blank";
  teamAId: string | null;
  teamBId: string | null;
  /** Event the team/mode selection belongs to (null = unscoped). */
  modeTournamentId: string | null;
  highlight: { team: "A" | "B"; playerIndex: number } | null;
  highlightTournamentId: string | null;
  bracketMatchId: string | null;
  bracketTournamentId: string | null;
  /** Monotonic — lets the overlay skip re-applying unchanged state. */
  rev: number;
  updatedAt: string;
};

type Holder = { state: OverlayControlState };

const GLOBAL_KEY = "__matbeastOverlayControlStore" as const;

function defaultState(): OverlayControlState {
  return {
    live: false,
    scene: "scoreboard",
    scoreboardMode: "scoreboard",
    teamAId: null,
    teamBId: null,
    modeTournamentId: null,
    highlight: null,
    highlightTournamentId: null,
    bracketMatchId: null,
    bracketTournamentId: null,
    rev: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

function holder(): Holder {
  const g = globalThis as unknown as Record<string, Holder | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { state: defaultState() };
  }
  return g[GLOBAL_KEY]!;
}

export function getOverlayControlState(): OverlayControlState {
  return holder().state;
}

/**
 * Merge one dashboard control broadcast into the mirrored state. Returns the
 * updated state (with a bumped `rev`/`updatedAt`) only when something actually
 * changed, so an idle dashboard doesn't churn the revision.
 */
export function applyOverlayControlMessage(
  msg: OverlayOutputBroadcast,
): OverlayControlState {
  const h = holder();
  const prev = h.state;
  let next: OverlayControlState | null = null;

  const start = (): OverlayControlState => next ?? { ...prev };

  switch (msg.kind) {
    case "live":
      if (prev.live !== msg.live) next = { ...start(), live: msg.live };
      break;
    case "scene":
      if (prev.scene !== msg.scene) next = { ...start(), scene: msg.scene };
      break;
    case "scoreboard-mode":
      if (
        prev.scoreboardMode !== msg.mode ||
        prev.teamAId !== msg.teamAId ||
        prev.teamBId !== msg.teamBId ||
        prev.modeTournamentId !== (msg.tournamentId ?? null)
      ) {
        next = {
          ...start(),
          scoreboardMode: msg.mode,
          teamAId: msg.teamAId,
          teamBId: msg.teamBId,
          modeTournamentId: msg.tournamentId ?? null,
        };
      }
      break;
    case "team-list-highlight": {
      const a = JSON.stringify(prev.highlight);
      const b = JSON.stringify(msg.highlight ?? null);
      if (a !== b || prev.highlightTournamentId !== (msg.tournamentId ?? null)) {
        next = {
          ...start(),
          highlight: msg.highlight ?? null,
          highlightTournamentId: msg.tournamentId ?? null,
        };
      }
      break;
    }
    case "bracket-current-match":
      if (
        prev.bracketMatchId !== (msg.matchId ?? null) ||
        prev.bracketTournamentId !== (msg.tournamentId ?? null)
      ) {
        next = {
          ...start(),
          bracketMatchId: msg.matchId ?? null,
          bracketTournamentId: msg.tournamentId ?? null,
        };
      }
      break;
    default:
      break;
  }

  if (next) {
    next.rev = prev.rev + 1;
    next.updatedAt = new Date().toISOString();
    h.state = next;
  }
  return h.state;
}
