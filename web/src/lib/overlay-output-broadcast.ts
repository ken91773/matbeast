/** Same-tab-origin overlay output window ↔ dashboard sync (not used for dashboard iframe preview). */
export const OVERLAY_OUTPUT_BROADCAST = "matbeast-overlay-output";

export type OverlayScene = "scoreboard" | "bracket";

/**
 * Scoreboard-window content mode. `teams` swaps the scoreboard graphic for a
 * two-team list overlay while keeping the barn-door / OVERLAY LIVE behavior
 * unchanged. Fully ephemeral — never persisted to DB or event file; cold app
 * start, tab switch, or file open resets to `scoreboard`.
 */
export type ScoreboardOverlayMode = "scoreboard" | "teams";

/**
 * Player highlight in the team-list overlay. `team` selects which of the two
 * team lines contains the highlighted name, `playerIndex` is the 0-based
 * position within that team's lineup (after TBD / empty slots were skipped
 * upstream). `null` means no highlight.
 */
export type TeamListHighlight = {
  team: "A" | "B";
  playerIndex: number;
};

export type OverlayOutputBroadcast =
  | { kind: "live"; live: boolean }
  | { kind: "scene"; scene: OverlayScene }
  | {
      kind: "bracket-current-match";
      tournamentId: string | null;
      matchId: string | null;
    }
  | {
      /**
       * Scoreboard-window content swap (scoreboard graphic ↔ team list).
       * `tournamentId` scopes the applied team ids so a stale broadcast from
       * another tab does not drive the output window's team selection.
       */
      kind: "scoreboard-mode";
      tournamentId: string | null;
      mode: ScoreboardOverlayMode;
      teamAId: string | null;
      teamBId: string | null;
    }
  | {
      /**
       * Team-list player highlight. Sent when a name is clicked in the
       * preview or output window; all subscribers mirror the state so both
       * surfaces glow the same name. `tournamentId` scopes the broadcast so
       * stale highlights from a different event can't leak in. Null
       * highlight = clear selection.
       */
      kind: "team-list-highlight";
      tournamentId: string | null;
      highlight: TeamListHighlight | null;
    }
  | { kind: "ping" }
  | {
      kind: "pong";
      live: boolean;
      scene?: OverlayScene;
    }
  | { kind: "output-closed" };

export function openOverlayOutputChannel(): BroadcastChannel {
  return new BroadcastChannel(OVERLAY_OUTPUT_BROADCAST);
}

export function isOverlayOutputBroadcast(v: unknown): v is OverlayOutputBroadcast {
  return (
    typeof v === "object" &&
    v !== null &&
    "kind" in v &&
    typeof (v as { kind: unknown }).kind === "string"
  );
}

let senderChannel: BroadcastChannel | null = null;

function getSenderChannel(): BroadcastChannel | null {
  if (typeof window === "undefined") return null;
  if (!senderChannel) {
    senderChannel = new BroadcastChannel(OVERLAY_OUTPUT_BROADCAST);
  }
  return senderChannel;
}

export function postOverlayOutputMessage(message: OverlayOutputBroadcast) {
  getSenderChannel()?.postMessage(message);
}

export function postOverlayScene(scene: OverlayScene) {
  postOverlayOutputMessage({ kind: "scene", scene });
}

export function postOverlayLive(live: boolean) {
  postOverlayOutputMessage({ kind: "live", live });
}

export function postOverlayBracketCurrentMatch(
  tournamentId: string | null,
  matchId: string | null,
) {
  postOverlayOutputMessage({
    kind: "bracket-current-match",
    tournamentId,
    matchId,
  });
}

/** Dashboard → scoreboard-output window: apply/revert team-list mode. */
export function postScoreboardMode(
  tournamentId: string | null,
  mode: ScoreboardOverlayMode,
  teamAId: string | null,
  teamBId: string | null,
) {
  postOverlayOutputMessage({
    kind: "scoreboard-mode",
    tournamentId,
    mode,
    teamAId,
    teamBId,
  });
}

/**
 * Any overlay surface → every listener: highlight a specific player in the
 * team-list overlay (or clear the highlight when `highlight` is null). Used
 * by both the preview iframe and the real output window so clicks in either
 * propagate to the other.
 */
export function postTeamListHighlight(
  tournamentId: string | null,
  highlight: TeamListHighlight | null,
) {
  postOverlayOutputMessage({
    kind: "team-list-highlight",
    tournamentId,
    highlight,
  });
}
