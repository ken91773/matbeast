"use client";

const HEADER_TOURNAMENT = "x-matbeast-tournament-id";
const STORAGE_KEY = "matbeast-active-tournament-id";
const HEADER_SKIP_UNDO = "x-matbeast-skip-undo";
const HEADER_INTERNAL = "x-matbeast-undo-internal";
const STACK_EVENT = "matbeast-undo-stack-changed";
const MAX_STACK = 30;

type TeamPlayerSnapshot = {
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
};

type TeamSnapshot = {
  seedOrder: number;
  name: string;
  players: TeamPlayerSnapshot[];
};

type BracketMatchSnapshot = {
  round: string;
  bracketIndex: number;
  winnerTeamId: string | null;
};

type BoardSnapshot = {
  leftPlayerId: string | null;
  rightPlayerId: string | null;
  customLeftName: string | null;
  customLeftTeamName: string | null;
  customRightName: string | null;
  customRightTeamName: string | null;
  currentRosterFileName: string;
  roundLabel: string;
  finalSaved: boolean;
  finalResultType: string | null;
  finalWinnerName: string | null;
  secondsRemaining: number;
  timerRunning: boolean;
  timerPhase: "REGULATION" | "OVERTIME";
  /** Includes `-1` rest / `-2` OT count-up when captured from the live board API. */
  overtimeIndex: number;
  overtimeWinsLeft: number;
  overtimeWinsRight: number;
  leftEliminatedCount: number;
  rightEliminatedCount: number;
};

type UndoSnapshot = {
  tournamentId: string;
  takenAt: number;
  teams: TeamSnapshot[];
  bracket: BracketMatchSnapshot[];
  board: BoardSnapshot;
};

const stack: UndoSnapshot[] = [];
const redoStack: UndoSnapshot[] = [];
let captureInFlight = false;
let undoInFlight = false;

function getActiveTournamentId() {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function emitStackChanged() {
  window.dispatchEvent(new CustomEvent(STACK_EVENT));
}

async function fetchJson<T>(path: string, tournamentId: string): Promise<T> {
  const res = await fetch(path, {
    headers: {
      [HEADER_TOURNAMENT]: tournamentId,
      [HEADER_INTERNAL]: "1",
    },
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `Failed GET ${path}`);
  }
  return (await res.json()) as T;
}

function toRosterDocument(teams: TeamSnapshot[]) {
  return {
    version: 1 as const,
    app: "Mat Beast Score" as const,
    eventKind: "BLUE_BELT" as const,
    savedAt: new Date().toISOString(),
    teams: teams
      .slice()
      .sort((a, b) => a.seedOrder - b.seedOrder)
      .map((t) => ({
        seedOrder: t.seedOrder,
        name: t.name,
        players: t.players
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
            beltRank: p.beltRank,
            profilePhotoUrl: p.profilePhotoUrl,
            headShotUrl: p.headShotUrl,
            lineupOrder: p.lineupOrder,
            lineupConfirmed: p.lineupConfirmed,
            weighedConfirmed: p.weighedConfirmed,
          })),
      })),
  };
}

function normalizePlayerFromApi(p: Record<string, unknown>): TeamPlayerSnapshot {
  const lo = p.lineupOrder;
  const lineupOrder =
    typeof lo === "number" && Number.isFinite(lo)
      ? Math.trunc(lo)
      : 999;
  return {
    firstName: String(p.firstName ?? ""),
    lastName: String(p.lastName ?? ""),
    nickname: (p.nickname as string | null | undefined) ?? null,
    academyName: (p.academyName as string | null | undefined) ?? null,
    unofficialWeight:
      typeof p.unofficialWeight === "number" && Number.isFinite(p.unofficialWeight)
        ? p.unofficialWeight
        : null,
    officialWeight:
      typeof p.officialWeight === "number" && Number.isFinite(p.officialWeight)
        ? p.officialWeight
        : null,
    heightFeet:
      typeof p.heightFeet === "number" && Number.isFinite(p.heightFeet)
        ? Math.trunc(p.heightFeet)
        : null,
    heightInches:
      typeof p.heightInches === "number" && Number.isFinite(p.heightInches)
        ? Math.trunc(p.heightInches)
        : null,
    age:
      typeof p.age === "number" && Number.isFinite(p.age) ? Math.trunc(p.age) : null,
    beltRank: String(p.beltRank ?? "WHITE"),
    profilePhotoUrl: (p.profilePhotoUrl as string | null | undefined) ?? null,
    headShotUrl: (p.headShotUrl as string | null | undefined) ?? null,
    lineupOrder,
    lineupConfirmed: Boolean(p.lineupConfirmed),
    weighedConfirmed: Boolean(p.weighedConfirmed),
  };
}

function normalizeTeamsFromApi(raw: unknown): TeamSnapshot[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => {
    const tr = t as Record<string, unknown>;
    const playersRaw = Array.isArray(tr.players) ? tr.players : [];
    return {
      seedOrder:
        typeof tr.seedOrder === "number" && Number.isFinite(tr.seedOrder)
          ? Math.trunc(tr.seedOrder)
          : 0,
      name: String(tr.name ?? ""),
      players: playersRaw.map((p) => normalizePlayerFromApi(p as Record<string, unknown>)),
    };
  });
}

export function getDashboardUndoDepth() {
  return stack.length;
}

export function getDashboardRedoDepth() {
  return redoStack.length;
}

export function onDashboardUndoStackChanged(listener: () => void) {
  const fn = () => listener();
  window.addEventListener(STACK_EVENT, fn);
  return () => window.removeEventListener(STACK_EVENT, fn);
}

export function shouldCaptureUndo(input: RequestInfo | URL, init?: RequestInit) {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const headers = new Headers(init?.headers);
  if (headers.get(HEADER_SKIP_UNDO) === "1") return false;
  if (headers.get(HEADER_INTERNAL) === "1") return false;
  const url = String(input);
  if (!url.startsWith("/api/")) return false;
  if (url.startsWith("/api/tournaments")) return false;
  return true;
}

async function collectSnapshot(tournamentId: string): Promise<UndoSnapshot> {
  const [teamsJson, boardJson, bracketJson] = await Promise.all([
    fetchJson<{ teams: unknown[] }>("/api/teams", tournamentId),
    fetchJson<BoardSnapshot>("/api/board", tournamentId),
    fetchJson<{
      quarterFinals: Array<{
        round: string;
        bracketIndex: number;
        winnerTeamId: string | null;
      }>;
      semiFinals: Array<{
        round: string;
        bracketIndex: number;
        winnerTeamId: string | null;
      }>;
      grandFinal: {
        round: string;
        bracketIndex: number;
        winnerTeamId: string | null;
      } | null;
    }>("/api/bracket", tournamentId),
  ]);

  const bracket: BracketMatchSnapshot[] = [
    ...bracketJson.quarterFinals,
    ...bracketJson.semiFinals,
    ...(bracketJson.grandFinal ? [bracketJson.grandFinal] : []),
  ].map((m) => ({
    round: m.round,
    bracketIndex: m.bracketIndex,
    winnerTeamId: m.winnerTeamId ?? null,
  }));

  const teams = normalizeTeamsFromApi(teamsJson.teams ?? []);

  return {
    tournamentId,
    takenAt: Date.now(),
    teams,
    board: boardJson,
    bracket,
  };
}

async function applySnapshot(tournamentId: string, snap: UndoSnapshot) {
  const commonHeaders = {
    [HEADER_TOURNAMENT]: tournamentId,
    [HEADER_INTERNAL]: "1",
    "Content-Type": "application/json",
  };

  const rosterDoc = toRosterDocument(snap.teams);
  const imp = await fetch("/api/tournament/import-roster", {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({ document: rosterDoc }),
  });
  if (!imp.ok) {
    const j = (await imp.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? "Restore import failed");
  }

  if (snap.bracket.length > 0) {
    await fetch("/api/bracket/generate", {
      method: "POST",
      headers: {
        [HEADER_TOURNAMENT]: tournamentId,
        [HEADER_INTERNAL]: "1",
      },
    });
    const current = await fetchJson<{
      quarterFinals: Array<{
        id: string;
        round: string;
        bracketIndex: number;
      }>;
      semiFinals: Array<{
        id: string;
        round: string;
        bracketIndex: number;
      }>;
      grandFinal: { id: string; round: string; bracketIndex: number } | null;
    }>("/api/bracket", tournamentId);
    const allCurrent = [
      ...current.quarterFinals,
      ...current.semiFinals,
      ...(current.grandFinal ? [current.grandFinal] : []),
    ];
    for (const snapshot of snap.bracket) {
      const match = allCurrent.find(
        (m) => m.round === snapshot.round && m.bracketIndex === snapshot.bracketIndex,
      );
      if (!match) continue;
      await fetch(`/api/bracket/matches/${match.id}`, {
        method: "PATCH",
        headers: commonHeaders,
        body: JSON.stringify({ winnerTeamId: snapshot.winnerTeamId }),
      });
    }
  }

  const boardRestore = await fetch("/api/board/restore", {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify(snap.board),
  });
  if (!boardRestore.ok) {
    const j = (await boardRestore.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? "Restore board failed");
  }
}

export async function captureDashboardUndoSnapshot() {
  const tournamentId = getActiveTournamentId();
  if (!tournamentId || captureInFlight || undoInFlight) return;
  captureInFlight = true;
  try {
    const snap = await collectSnapshot(tournamentId);
    redoStack.length = 0;
    stack.push(snap);
    if (stack.length > MAX_STACK) {
      stack.splice(0, stack.length - MAX_STACK);
    }
    emitStackChanged();
  } catch {
    /* ignore */
  } finally {
    captureInFlight = false;
  }
}

export async function undoDashboardLastAction() {
  const tournamentId = getActiveTournamentId();
  if (!tournamentId || undoInFlight) return false;
  const back = stack[stack.length - 1];
  if (!back || back.tournamentId !== tournamentId) return false;
  undoInFlight = true;
  try {
    const forward = await collectSnapshot(tournamentId);
    await applySnapshot(tournamentId, back);
    stack.pop();
    redoStack.push(forward);
    if (redoStack.length > MAX_STACK) {
      redoStack.splice(0, redoStack.length - MAX_STACK);
    }
    emitStackChanged();
    window.dispatchEvent(
      new CustomEvent("matbeast-tournament-changed", { detail: { id: tournamentId } }),
    );
    return true;
  } finally {
    undoInFlight = false;
  }
}

export async function redoDashboardLastAction() {
  const tournamentId = getActiveTournamentId();
  if (!tournamentId || undoInFlight) return false;
  const forward = redoStack[redoStack.length - 1];
  if (!forward || forward.tournamentId !== tournamentId) return false;
  undoInFlight = true;
  try {
    const leaving = await collectSnapshot(tournamentId);
    await applySnapshot(tournamentId, forward);
    redoStack.pop();
    stack.push(leaving);
    if (stack.length > MAX_STACK) {
      stack.splice(0, stack.length - MAX_STACK);
    }
    emitStackChanged();
    window.dispatchEvent(
      new CustomEvent("matbeast-tournament-changed", { detail: { id: tournamentId } }),
    );
    return true;
  } finally {
    undoInFlight = false;
  }
}
