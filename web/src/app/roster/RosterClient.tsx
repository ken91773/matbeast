"use client";

import type { BeltRank } from "@prisma/client";
import {
  getMatBeastTournamentId,
  matbeastFetch,
  MATBEAST_CLIENT_USE_TRAINING_MASTERS_HEADER,
  MATBEAST_TOURNAMENT_HEADER,
  setMatBeastTournamentId,
} from "@/lib/matbeast-fetch";
import { matbeastKeys } from "@/lib/matbeast-query-keys";
import { matbeastJson } from "@/lib/matbeast-query";
import { openScoreboardOverlayWindow } from "@/lib/open-scoreboard-overlay";
import { useEventWorkspace } from "@/components/EventWorkspaceProvider";
import { SkullCrossbonesIcon } from "@/components/icons/SkullCrossbonesIcon";
import {
  forbiddenUserChosenTeamNameMessage,
  isForbiddenCustomTeamName,
  isForbiddenUserChosenTeamName,
} from "@/lib/reserved-team-names";
import { normalizeRosterDocumentLineups } from "@/lib/roster-lineup-normalize";
import Link from "next/link";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type RosterEventKind = "BLUE_BELT" | "PURPLE_BROWN";

type Player = {
  id: string;
  teamId: string;
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
  lineupOrder: number | null;
  lineupConfirmed: boolean;
  weighedConfirmed: boolean;
  team: { name: string };
};

const ALL_BELT_OPTIONS: readonly BeltRank[] = [
  "WHITE",
  "BLUE",
  "PURPLE",
  "BROWN",
  "BLACK",
];

const BELT_COMPACT_ABBREV: Record<BeltRank, string> = {
  WHITE: "WHI",
  BLUE: "BLU",
  PURPLE: "PUR",
  BROWN: "BRO",
  BLACK: "BLK",
};

function sumPrimaryUnofficial(row: (Player | null)[]): {
  sum: number;
  hasAny: boolean;
} {
  let sum = 0;
  let hasAny = false;
  for (let i = 0; i < 5; i++) {
    const w = row[i]?.unofficialWeight;
    if (typeof w === "number" && Number.isFinite(w)) {
      sum += w;
      hasAny = true;
    }
  }
  return { sum, hasAny };
}

function sumPrimaryOfficial(row: (Player | null)[]): {
  sum: number;
  hasAny: boolean;
} {
  let sum = 0;
  let hasAny = false;
  for (let i = 0; i < 5; i++) {
    const w = row[i]?.officialWeight;
    if (typeof w === "number" && Number.isFinite(w)) {
      sum += w;
      hasAny = true;
    }
  }
  return { sum, hasAny };
}

function formatWeightSum(hasAny: boolean, sum: number): string {
  if (!hasAny) return "—";
  return Number.isInteger(sum) ? String(sum) : sum.toFixed(1);
}

function parseOfficialWeightInput(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function sameOfficialWeight(
  stored: number | null | undefined,
  next: number | null,
): boolean {
  const a =
    stored == null || typeof stored !== "number" || !Number.isFinite(stored)
      ? null
      : stored;
  const b = next == null || !Number.isFinite(next) ? null : next;
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a === b;
}

type Team = {
  id: string;
  name: string;
  seedOrder: number;
  players: Player[];
};

type RosterFilePlayer = {
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
  lineupOrder: number | null;
  lineupConfirmed: boolean;
  weighedConfirmed: boolean;
};

type RosterFileTeam = {
  seedOrder: number;
  name: string;
  players: RosterFilePlayer[];
};

type RosterFileDocument = {
  version: 1;
  app: "Mat Beast Score";
  eventKind: RosterEventKind;
  savedAt: string;
  teams: RosterFileTeam[];
};

function listLabel(p: Player) {
  return `${p.lastName}, ${p.firstName}`;
}

/** 7 slots (index 0–6) = lineup 1–7 */
function slotsForTeam(team: Team): (Player | null)[] {
  const row: (Player | null)[] = Array(7).fill(null);
  const players = team.players ?? [];
  for (const p of players) {
    if (typeof p.lineupOrder === "number" && p.lineupOrder >= 1 && p.lineupOrder <= 7) {
      row[p.lineupOrder - 1] = p;
    }
  }
  return row;
}

function slotCellLabel(slotIndex: number, p: Player | null) {
  if (!p) return "TBD";
  const ln = p.lastName.trim() || "TBD";
  if (slotIndex >= 5) return `ALT · ${ln}`;
  return ln;
}

const FEET_OPTS = [3, 4, 5, 6, 7, 8] as const;
const INCH_OPTS = Array.from({ length: 12 }, (_, i) => i);

type MasterPlayerProfileRow = {
  id: string;
  teamId?: string | null;
  firstName: string;
  lastName: string;
  nickname: string | null;
  academyName: string | null;
  unofficialWeight: number | null;
  heightFeet: number | null;
  heightInches: number | null;
  age: number | null;
  beltRank: string;
  profilePhotoUrl: string | null;
  headShotUrl: string | null;
};

export function RosterClient({
  title,
  subtitle,
  shellClassName,
  embed = false,
  dashboardPlayerCard = false,
  dashboardLiveTournamentId = null,
}: {
  title: string;
  subtitle: string;
  shellClassName: string;
  /** Dashboard card: drop full-page min height */
  embed?: boolean;
  /** Dashboard roster section: player profiles only (compact, master DB picker) */
  dashboardPlayerCard?: boolean;
  /** When set with dashboard player card, team list refetches when teams change */
  dashboardLiveTournamentId?: string | null;
}) {
  const rosterEventKind: RosterEventKind = "BLUE_BELT";
  const { tournamentId: wsTournamentId, tournamentTrainingMode } = useEventWorkspace();
  /**
   * JSON.stringify drops keys with value `undefined`. If `useTrainingMasters` is omitted,
   * `/api/players` master sync falls back to team→tournament DB and can write Training*
   * while the dashboard tab is production — always send an explicit boolean.
   */
  const useTrainingMastersBodyFlag = tournamentTrainingMode === true;
  const rosterScopeTournamentId = useMemo(
    () =>
      (dashboardLiveTournamentId && dashboardLiveTournamentId.trim()) ||
      (wsTournamentId && wsTournamentId.trim()) ||
      getMatBeastTournamentId()?.trim() ||
      null,
    [dashboardLiveTournamentId, wsTournamentId],
  );
  const mergeRosterMasterScopeInInit = useCallback(
    (init?: RequestInit): RequestInit => {
      if (!rosterScopeTournamentId) return init ?? {};
      const headers = new Headers(init?.headers);
      headers.set(MATBEAST_TOURNAMENT_HEADER, rosterScopeTournamentId);
      headers.set(
        MATBEAST_CLIENT_USE_TRAINING_MASTERS_HEADER,
        useTrainingMastersBodyFlag ? "1" : "0",
      );
      return { ...init, headers };
    },
    [rosterScopeTournamentId, useTrainingMastersBodyFlag],
  );
  const [teams, setTeams] = useState<Team[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fileBusy, setFileBusy] = useState(false);
  const [currentFileName, setCurrentFileName] = useState("UNTITLED");
  const [dragTeamIndex, setDragTeamIndex] = useState<number | null>(null);
  const loadInputRef = useRef<HTMLInputElement | null>(null);
  const fileHandleRef = useRef<{
    name: string;
    createWritable: () => Promise<{
      write: (data: string | Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  } | null>(null);

  const defaultBelt: BeltRank = "WHITE";

  const refresh = useCallback(async () => {
    setErr(null);
    const tRes = await matbeastFetch("/api/teams");
    const tJson = (await tRes.json()) as {
      teams?: Team[];
      error?: string;
      hint?: string;
    };
    if (!tRes.ok) {
      setErr(
        [tJson.error, tJson.hint].filter(Boolean).join(" — ") ||
          "Could not load teams",
      );
      return;
    }
    const list = tJson.teams ?? [];
    setTeams(
      list.map((t) => ({
        ...t,
        players: (Array.isArray(t.players) ? t.players : []).map((p) => ({
          ...p,
          lineupConfirmed: Boolean(
            (p as { lineupConfirmed?: boolean }).lineupConfirmed,
          ),
          weighedConfirmed: Boolean(
            (p as { weighedConfirmed?: boolean }).weighedConfirmed,
          ),
        })),
      })),
    );
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  const sortedTeams = useMemo(
    () => [...teams].sort((a, b) => a.seedOrder - b.seedOrder),
    [teams],
  );

  function normalizeFileName(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return "UNTITLED";
    return trimmed.toUpperCase() === "UNTITLED" ? "UNTITLED" : trimmed;
  }

  function toDownloadName(fileName: string): string {
    const normalized = normalizeFileName(fileName);
    return normalized.toLowerCase().endsWith(".json")
      ? normalized
      : `${normalized}.json`;
  }

  async function syncCurrentRosterFileName(fileName: string) {
    await matbeastFetch("/api/board", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentRosterFileName: normalizeFileName(fileName),
      }),
    });
  }

  function toDocument(): RosterFileDocument {
    return {
      version: 1,
      app: "Mat Beast Score",
      eventKind: rosterEventKind,
      savedAt: new Date().toISOString(),
      teams: sortedTeams.map((team) => ({
        seedOrder: team.seedOrder,
        name: team.name,
        players: (team.players ?? [])
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
            beltRank: (ALL_BELT_OPTIONS.includes(p.beltRank as BeltRank)
              ? p.beltRank
              : defaultBelt) as BeltRank,
            profilePhotoUrl: p.profilePhotoUrl,
            headShotUrl: p.headShotUrl,
            lineupOrder: p.lineupOrder,
            lineupConfirmed: p.lineupConfirmed ?? false,
            weighedConfirmed: p.weighedConfirmed ?? false,
          }))
          .sort(
            (a, b) =>
              (a.lineupOrder == null ? 999 : a.lineupOrder) -
              (b.lineupOrder == null ? 999 : b.lineupOrder),
          ),
      })),
    };
  }

  function downloadDocument(fileName: string, doc: RosterFileDocument) {
    const blob = new Blob([JSON.stringify(doc, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = toDownloadName(fileName);
    a.click();
    URL.revokeObjectURL(url);
  }

  async function saveWithFilePicker(
    doc: RosterFileDocument,
    saveAs: boolean,
  ): Promise<string | null> {
    const maybeWindow = window as Window & {
      showSaveFilePicker?: (opts?: unknown) => Promise<{
        name: string;
        createWritable: () => Promise<{
          write: (data: string | Blob) => Promise<void>;
          close: () => Promise<void>;
        }>;
      }>;
    };
    if (!maybeWindow.showSaveFilePicker) return null;

    if (saveAs || !fileHandleRef.current) {
      const handle = await maybeWindow.showSaveFilePicker({
        suggestedName: toDownloadName(currentFileName),
        types: [
          {
            description: "JSON files",
            accept: { "application/json": [".json"] },
          },
        ],
      });
      fileHandleRef.current = handle;
    }

    if (!fileHandleRef.current) return null;
    const writable = await fileHandleRef.current.createWritable();
    await writable.write(JSON.stringify(doc, null, 2));
    await writable.close();
    return normalizeFileName(fileHandleRef.current.name.replace(/\.json$/i, ""));
  }

  function parseRosterDoc(raw: unknown): RosterFileDocument {
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
    return {
      version: 1,
      app: "Mat Beast Score",
      eventKind:
        obj.eventKind === "BLUE_BELT" || obj.eventKind === "PURPLE_BROWN"
          ? obj.eventKind
          : "BLUE_BELT",
      savedAt:
        typeof obj.savedAt === "string" ? obj.savedAt : new Date().toISOString(),
      teams: obj.teams.map((team) => {
        const t = team as Partial<RosterFileTeam>;
        if (typeof t.seedOrder !== "number" || !Number.isInteger(t.seedOrder)) {
          throw new Error("A team seed in the roster file is invalid");
        }
        if (!Array.isArray(t.players)) {
          throw new Error("A team player list in the roster file is invalid");
        }
        return {
          seedOrder: t.seedOrder,
          name: typeof t.name === "string" ? t.name : "TBD",
          players: t.players.map((player) => {
            const p = player as Partial<RosterFilePlayer>;
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
                : null;
            return {
              firstName: typeof p.firstName === "string" ? p.firstName : "",
              lastName: typeof p.lastName === "string" ? p.lastName : "",
              nickname: typeof p.nickname === "string" ? p.nickname : null,
              academyName:
                typeof p.academyName === "string" ? p.academyName : null,
              unofficialWeight:
                typeof p.unofficialWeight === "number"
                  ? p.unofficialWeight
                  : null,
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
                typeof p.lineupConfirmed === "boolean"
                  ? p.lineupConfirmed
                  : false,
              weighedConfirmed:
                typeof p.weighedConfirmed === "boolean"
                  ? p.weighedConfirmed
                  : false,
            };
          }),
        };
      }),
    };
  }

  async function applyDocumentToCurrentRoster(docIn: RosterFileDocument) {
    const doc = normalizeRosterDocumentLineups(docIn);
    const seedMap = new Map<number, Team>();
    for (const team of sortedTeams) {
      seedMap.set(team.seedOrder, team);
    }
    for (const team of doc.teams) {
      if (team.seedOrder < 1 || team.seedOrder > 8) {
        throw new Error("Team seeds must be between 1 and 8");
      }
    }

    for (const team of sortedTeams) {
      for (const p of team.players) {
        const del = await matbeastFetch(
          `/api/players/${p.id}`,
          mergeRosterMasterScopeInInit({ method: "DELETE" }),
        );
        if (!del.ok) {
          throw new Error("Failed clearing existing roster players");
        }
      }
    }

    for (const docTeam of doc.teams) {
      const team = seedMap.get(docTeam.seedOrder);
      if (!team) continue;
      const rosterTidForTeams =
        (dashboardLiveTournamentId && dashboardLiveTournamentId.trim()) ||
        (wsTournamentId && wsTournamentId.trim()) ||
        "";
      const patch = await matbeastFetch(
        `/api/teams/${team.id}`,
        mergeRosterMasterScopeInInit({
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: docTeam.name,
            ...(rosterTidForTeams ? { tournamentId: rosterTidForTeams } : {}),
            useTrainingMasters: useTrainingMastersBodyFlag,
          }),
        }),
      );
      if (!patch.ok) {
        throw new Error(`Failed updating team #${docTeam.seedOrder}`);
      }

      for (const p of docTeam.players) {
        const rosterTid =
          (dashboardLiveTournamentId && dashboardLiveTournamentId.trim()) ||
          (wsTournamentId && wsTournamentId.trim()) ||
          "";
        const create = await matbeastFetch(
          "/api/players",
          mergeRosterMasterScopeInInit({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...(rosterTid ? { tournamentId: rosterTid } : {}),
              useTrainingMasters: useTrainingMastersBodyFlag,
              teamId: team.id,
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
            }),
          }),
        );
        if (!create.ok) {
          const j = (await create.json()) as { error?: string };
          throw new Error(
            j.error ?? `Failed creating player in team #${docTeam.seedOrder}`,
          );
        }
      }
    }
  }

  async function handleSave(saveAs: boolean) {
    try {
      setErr(null);
      const doc = toDocument();
      let nextName = await saveWithFilePicker(doc, saveAs);
      if (!nextName) {
        nextName = currentFileName;
        if (saveAs || normalizeFileName(currentFileName) === "UNTITLED") {
          const proposed = window.prompt(
            "Save roster as filename:",
            toDownloadName(currentFileName),
          );
          if (proposed === null) return;
          nextName = normalizeFileName(proposed.replace(/\.json$/i, ""));
        }
        downloadDocument(nextName, doc);
      }
      setCurrentFileName(nextName);
      await syncCurrentRosterFileName(nextName);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function handleNew() {
    const ok = window.confirm(
      "Start a new roster? This clears teams and players for the current event file.",
    );
    if (!ok) return;
    setFileBusy(true);
    setErr(null);
    try {
      const blankDoc: RosterFileDocument = {
        version: 1,
        app: "Mat Beast Score",
        eventKind: rosterEventKind,
        savedAt: new Date().toISOString(),
        teams: sortedTeams.map((team) => ({
          seedOrder: team.seedOrder,
          name: `TEAM${team.seedOrder}`,
          players: [],
        })),
      };
      await applyDocumentToCurrentRoster(blankDoc);
      await refresh();
      setCurrentFileName("UNTITLED");
      await syncCurrentRosterFileName("UNTITLED");
      fileHandleRef.current = null;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create new roster");
    } finally {
      setFileBusy(false);
    }
  }

  async function handleLoadFile(file: File) {
    setFileBusy(true);
    setErr(null);
    try {
      const text = await file.text();
      const parsed = parseRosterDoc(JSON.parse(text) as unknown);
      await applyDocumentToCurrentRoster(parsed);
      await refresh();
      const next = file.name.replace(/\.json$/i, "");
      setCurrentFileName(normalizeFileName(next));
      await syncCurrentRosterFileName(next);
      fileHandleRef.current = null;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
    } finally {
      setFileBusy(false);
    }
  }

  async function patchTeam(
    teamId: string,
    body: { name?: string; seedOrder?: number },
  ) {
    setErr(null);
    const rosterTid =
      (dashboardLiveTournamentId && dashboardLiveTournamentId.trim()) ||
      (wsTournamentId && wsTournamentId.trim()) ||
      "";
    const res = await matbeastFetch(
      `/api/teams/${teamId}`,
      mergeRosterMasterScopeInInit({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          ...(rosterTid ? { tournamentId: rosterTid } : {}),
          useTrainingMasters: useTrainingMastersBodyFlag,
        }),
      }),
    );
    if (!res.ok) {
      const j = (await res.json()) as { error?: string };
      setErr(j.error ?? "Team update failed");
      return;
    }
    await refresh();
  }

  async function postMoveSlot(args: {
    playerId: string;
    fromTeamId: string;
    fromSlot: number;
    toTeamId: string;
    toSlot: number;
  }) {
    setErr(null);
    const res = await matbeastFetch("/api/players/move-slot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...args }),
    });
    if (!res.ok) {
      const j = (await res.json()) as { error?: string };
      setErr(j.error ?? "Move failed");
      return;
    }
    await refresh();
  }

  async function patchPlayerFlags(
    playerId: string,
    flags: { lineupConfirmed?: boolean; weighedConfirmed?: boolean },
  ) {
    setErr(null);
    const rosterTid =
      (dashboardLiveTournamentId && dashboardLiveTournamentId.trim()) ||
      (wsTournamentId && wsTournamentId.trim()) ||
      "";
    const res = await matbeastFetch(
      `/api/players/${playerId}`,
      mergeRosterMasterScopeInInit({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...flags,
          useTrainingMasters: useTrainingMastersBodyFlag,
          ...(rosterTid ? { tournamentId: rosterTid } : {}),
        }),
      }),
    );
    if (!res.ok) {
      const j = (await res.json()) as { error?: string };
      setErr(j.error ?? "Could not update checkboxes");
      return;
    }
    await refresh();
  }

  async function postTeamReorder(orderedIds: string[]) {
    setErr(null);
    const res = await matbeastFetch("/api/tournament/reorder-teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamIds: orderedIds }),
    });
    if (!res.ok) {
      const j = (await res.json()) as { error?: string };
      setErr(j.error ?? "Reorder failed");
      return;
    }
    await refresh();
  }

  function onTeamDragStart(rowIndex: number) {
    setDragTeamIndex(rowIndex);
  }

  function onTeamDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  function onTeamDrop(targetIndex: number) {
    if (dragTeamIndex === null || dragTeamIndex === targetIndex) {
      setDragTeamIndex(null);
      return;
    }
    const next = sortedTeams.map((t) => t.id);
    const [removed] = next.splice(dragTeamIndex, 1);
    next.splice(targetIndex, 0, removed);
    setDragTeamIndex(null);
    void postTeamReorder(next);
  }

  function onPlayerDragStart(
    e: React.DragEvent,
    playerId: string,
    teamId: string,
    fromSlot: number,
  ) {
    e.dataTransfer.setData(
      "application/json",
      JSON.stringify({ playerId, teamId, fromSlot }),
    );
    e.dataTransfer.effectAllowed = "move";
  }

  function onPlayerDrop(e: React.DragEvent, teamId: string, toSlot: number) {
    e.preventDefault();
    e.stopPropagation();
    let payload: { playerId: string; teamId: string; fromSlot: number };
    try {
      payload = JSON.parse(e.dataTransfer.getData("application/json"));
    } catch {
      return;
    }
    if (payload.fromSlot === toSlot && payload.teamId === teamId) {
      return;
    }
    void postMoveSlot({
      playerId: payload.playerId,
      fromTeamId: payload.teamId,
      fromSlot: payload.fromSlot,
      toTeamId: teamId,
      toSlot,
    });
  }

  if (dashboardPlayerCard) {
    return (
      <div
        className={`min-h-0 h-full text-[11px] leading-tight text-zinc-100 ${shellClassName}`}
      >
        {err ? (
          <p className="mb-2 rounded border border-red-900 bg-red-950/50 px-2 py-1 text-red-200">
            {err}
          </p>
        ) : null}
        {loading ? (
          <p className="text-zinc-500">Loading…</p>
        ) : (
          <PlayerEntryForm
            teams={sortedTeams}
            defaultBelt={defaultBelt}
            onSaved={() => refresh()}
            compact
            showMasterProfilePicker
            liveTournamentId={dashboardLiveTournamentId}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className={`${embed ? "min-h-0 p-4" : "min-h-screen p-6"} text-zinc-100 ${shellClassName}`}
    >
      <header id="roster-workspace-top" className="mb-8 flex flex-wrap items-center gap-4">
        <div>
          {title ? <h1 className="text-2xl font-semibold">{title}</h1> : null}
          {subtitle ? <p className="mt-1 text-sm text-zinc-300">{subtitle}</p> : null}
          <p className="mt-1 text-xs text-zinc-400">
            File: <span className="font-semibold text-zinc-200">{currentFileName}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={fileBusy || loading}
            onClick={() => void handleNew()}
            className="rounded border border-zinc-500/80 px-3 py-1.5 text-xs font-semibold text-zinc-100 hover:bg-black/30 disabled:opacity-50"
          >
            NEW
          </button>
          <button
            type="button"
            disabled={fileBusy || loading}
            onClick={() => void handleSave(false)}
            className="rounded border border-zinc-500/80 px-3 py-1.5 text-xs font-semibold text-zinc-100 hover:bg-black/30 disabled:opacity-50"
          >
            SAVE
          </button>
          <button
            type="button"
            disabled={fileBusy || loading}
            onClick={() => void handleSave(true)}
            className="rounded border border-zinc-500/80 px-3 py-1.5 text-xs font-semibold text-zinc-100 hover:bg-black/30 disabled:opacity-50"
          >
            SAVE AS
          </button>
          <button
            type="button"
            disabled={fileBusy || loading}
            onClick={() => loadInputRef.current?.click()}
            className="rounded border border-zinc-500/80 px-3 py-1.5 text-xs font-semibold text-zinc-100 hover:bg-black/30 disabled:opacity-50"
          >
            LOAD
          </button>
          <input
            ref={loadInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                void handleLoadFile(file);
              }
              e.target.value = "";
            }}
          />
        </div>
        <nav className="flex gap-3 text-sm text-zinc-400">
          <Link className="hover:text-white" href="/">
            Dashboard
          </Link>
          <Link className="hover:text-white" href="/control">
            Control
          </Link>
          <button
            type="button"
            className="bg-transparent p-0 text-inherit hover:text-white"
            onClick={() => openScoreboardOverlayWindow()}
          >
            Overlay
          </button>
        </nav>
      </header>

      {err && (
        <p className="mb-4 rounded border border-red-900 bg-red-950/50 px-3 py-2 text-red-200">
          {err}
        </p>
      )}

      {loading ? (
        <p className="text-zinc-500">Loading…</p>
      ) : (
        <>
          <section id="team-input" className="mb-8 scroll-mt-24">
            <h2 className="mb-3 text-lg font-medium text-zinc-200">
              Team setup (8 teams — scoreboard names)
            </h2>
            <p className="mb-4 text-sm text-zinc-400">
              Names save on blur. Empty name becomes <strong>TBD</strong>. Seed
              1–8 swaps with another team if that seed is taken. The roster grid
              shows <strong>last names</strong> only.
            </p>
            <div className="grid max-w-4xl gap-3 sm:grid-cols-[auto_1fr]">
              {sortedTeams.map((team) => (
                <TeamNameRow
                  key={team.id}
                  team={team}
                  onSaveName={(name) => patchTeam(team.id, { name })}
                  onSaveSeed={(seedOrder) =>
                    patchTeam(team.id, { seedOrder })
                  }
                />
              ))}
            </div>
          </section>

          <section id="roster-input" className="mb-10 scroll-mt-24 overflow-x-auto">
            <h2 className="mb-3 text-lg font-medium text-zinc-200">
              Roster grid (drag team rows to re-seed; drag a player to another slot
              or team; <strong>SEED CONF</strong> / <strong>WEIGHED IN</strong> when
              confirmed). Last two columns sum S1–S5 unofficial and official
              weights.
            </h2>
            <table className="w-full min-w-[960px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-600/80 text-zinc-400">
                  <th className="p-2 pr-4">Team</th>
                  <th className="p-2">S1</th>
                  <th className="p-2">S2</th>
                  <th className="p-2">S3</th>
                  <th className="p-2">S4</th>
                  <th className="p-2">S5</th>
                  <th className="p-2">ALT</th>
                  <th className="p-2">ALT</th>
                  <th className="p-2 whitespace-nowrap">Σ UNOFF (S1–S5)</th>
                  <th className="p-2 whitespace-nowrap">Σ OFF (S1–S5)</th>
                </tr>
              </thead>
              <tbody>
                {sortedTeams.map((team, rowIndex) => {
                  const row = slotsForTeam(team);
                  const u = sumPrimaryUnofficial(row);
                  const o = sumPrimaryOfficial(row);
                  return (
                    <tr
                      key={team.id}
                      className="border-b border-zinc-700/80 hover:bg-black/20"
                      onDragOver={onTeamDragOver}
                      onDrop={() => onTeamDrop(rowIndex)}
                    >
                      <td
                        draggable
                        className="cursor-grab p-2 pr-4 font-medium active:cursor-grabbing"
                        onDragStart={() => onTeamDragStart(rowIndex)}
                        onDragEnd={() => setDragTeamIndex(null)}
                        title="Drag to reorder team seeds"
                      >
                        <span className="text-zinc-500">⋮⋮</span>{" "}
                        <span className="text-zinc-500">#{team.seedOrder}</span>{" "}
                        {team.name}
                      </td>
                      {row.map((p, slotIndex) => (
                        <td
                          key={slotIndex}
                          className="p-1 align-top"
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.stopPropagation();
                            onPlayerDrop(e, team.id, slotIndex);
                          }}
                        >
                          <div
                            className={`flex min-h-[2.75rem] items-stretch gap-1 rounded border px-1 py-1 ${
                              p
                                ? "border-zinc-500/80 bg-black/20"
                                : "border-zinc-600/50 border-dashed bg-black/10 text-zinc-500"
                            }`}
                          >
                            {p ? (
                              <div className="flex shrink-0 flex-col gap-0.5 border-r border-zinc-600/60 pr-1">
                                <label
                                  className={`flex cursor-pointer flex-col items-center justify-center rounded px-0.5 py-0.5 text-[9px] leading-tight text-zinc-300 ${
                                    p.lineupConfirmed
                                      ? "bg-emerald-600/80"
                                      : "bg-zinc-800/80"
                                  }`}
                                  title="Seed order confirmed"
                                  onMouseDown={(ev) => ev.stopPropagation()}
                                >
                                  <input
                                    type="checkbox"
                                    checked={p.lineupConfirmed}
                                    onChange={(ev) => {
                                      ev.stopPropagation();
                                      void patchPlayerFlags(p.id, {
                                        lineupConfirmed: ev.target.checked,
                                      });
                                    }}
                                    className="accent-emerald-300"
                                  />
                                  <span className="select-none">SEED CONF</span>
                                </label>
                                <label
                                  className={`flex cursor-pointer flex-col items-center justify-center rounded px-0.5 py-0.5 text-[9px] leading-tight text-zinc-300 ${
                                    p.weighedConfirmed
                                      ? "bg-emerald-600/80"
                                      : "bg-zinc-800/80"
                                  }`}
                                  title="Weigh-in confirmed"
                                  onMouseDown={(ev) => ev.stopPropagation()}
                                >
                                  <input
                                    type="checkbox"
                                    checked={p.weighedConfirmed}
                                    onChange={(ev) => {
                                      ev.stopPropagation();
                                      void patchPlayerFlags(p.id, {
                                        weighedConfirmed: ev.target.checked,
                                      });
                                    }}
                                    className="accent-emerald-300"
                                  />
                                  <span className="select-none">WEIGHED IN</span>
                                </label>
                              </div>
                            ) : null}
                            <div
                              draggable={!!p}
                              onDragStart={(e) => {
                                e.stopPropagation();
                                if (p)
                                  onPlayerDragStart(
                                    e,
                                    p.id,
                                    team.id,
                                    slotIndex,
                                  );
                              }}
                              className={`flex min-w-0 flex-1 items-center rounded border px-1 py-0.5 ${
                                p
                                  ? p.lineupConfirmed && p.weighedConfirmed
                                    ? "cursor-grab border-emerald-500/90 bg-emerald-800/50 active:cursor-grabbing"
                                    : "cursor-grab border-transparent bg-transparent active:cursor-grabbing"
                                  : ""
                              }`}
                            >
                              {slotCellLabel(slotIndex, p)}
                            </div>
                          </div>
                        </td>
                      ))}
                      <td className="p-2 align-middle font-mono text-xs text-zinc-300">
                        {formatWeightSum(u.hasAny, u.sum)}
                      </td>
                      <td className="p-2 align-middle font-mono text-xs text-zinc-300">
                        {formatWeightSum(o.hasAny, o.sum)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <div id="player-profiles" className="scroll-mt-24">
            <PlayerEntryForm
              teams={sortedTeams}
              defaultBelt={defaultBelt}
              onSaved={() => refresh()}
            />
          </div>
        </>
      )}
    </div>
  );
}

function TeamNameRow({
  team,
  onSaveName,
  onSaveSeed,
}: {
  team: Team;
  onSaveName: (name: string) => void;
  onSaveSeed: (seed: number) => void;
}) {
  const [name, setName] = useState(team.name);
  const [seed, setSeed] = useState(String(team.seedOrder));

  useEffect(() => {
    setName(team.name);
    setSeed(String(team.seedOrder));
  }, [team.name, team.seedOrder]);

  return (
    <>
      <label className="flex items-center gap-2 text-zinc-500 sm:justify-end">
        Seed
        <input
          type="number"
          min={1}
          max={8}
          className="w-16 rounded border border-zinc-600 bg-black/30 px-2 py-1.5 text-zinc-100"
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          onBlur={() => {
            const n = Number(seed);
            if (n >= 1 && n <= 8 && n !== team.seedOrder) onSaveSeed(n);
            else setSeed(String(team.seedOrder));
          }}
        />
      </label>
      <input
        className="rounded border border-zinc-600 bg-black/30 px-3 py-2"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (name !== team.name) onSaveName(name);
        }}
        placeholder="Team name (TBD if empty)"
      />
    </>
  );
}

function SaveDiskIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z" />
    </svg>
  );
}

function FormTrashIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
    </svg>
  );
}

function DragHandleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M9 5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM9 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM9 16a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z" />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 6a6 6 0 0 1 5.66 4h-2.2A4 4 0 1 0 16 12h2a6 6 0 1 1-6-6Zm6-2v5h-5l1.77-1.77A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.76-4.24L18 6Z" />
    </svg>
  );
}

function BeltFilterFunnelIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 5h16l-6.5 7v5l-3 2v-7L4 5Z" />
    </svg>
  );
}

function teamOptionLabel(name: string) {
  const t = name.trim();
  if (!t || t === "TBD") return "TBD";
  return t;
}

function digitsOnly(value: string) {
  return value.replace(/[^\d]/g, "");
}

function numericWeightOnly(value: string) {
  return value.replace(/[^\d]/g, "").slice(0, 3);
}

const TEAM_SEL_NOT_LISTED = "__NOT_LISTED__";
const TEAM_SEL_TBD = "__TEAM_TBD__";
const TEAM_SEL_PREFIX_TEAM = "team:";
const TEAM_SEL_PREFIX_NAME = "name:";
const SHOW_PREFIX_TEAM = "t:";
const SHOW_PREFIX_NAME = "n:";
const SHOW_TEAM_ALL_TBD = "__SHOW_ALL_TBD__";

function PlayerEntryForm({
  teams,
  defaultBelt,
  onSaved,
  compact = false,
  showMasterProfilePicker = false,
  liveTournamentId = null,
}: {
  teams: Team[];
  defaultBelt: BeltRank;
  onSaved: () => Promise<void>;
  compact?: boolean;
  showMasterProfilePicker?: boolean;
  liveTournamentId?: string | null;
}) {
  const queryClient = useQueryClient();
  const { tournamentId: workspaceTournamentId, tournamentTrainingMode } =
    useEventWorkspace();
  const masterScopeId =
    (liveTournamentId && liveTournamentId.trim()) ||
    (workspaceTournamentId && workspaceTournamentId.trim()) ||
    getMatBeastTournamentId()?.trim() ||
    null;
  /** Master list APIs use `x-matbeast-tournament-id` for live vs training tables — must match the scoped tab, not only localStorage. */
  const mergeMasterScopeInInit = useCallback(
    (init?: RequestInit): RequestInit => {
      if (!masterScopeId) return init ?? {};
      const headers = new Headers(init?.headers);
      headers.set(MATBEAST_TOURNAMENT_HEADER, masterScopeId);
      headers.set(
        MATBEAST_CLIENT_USE_TRAINING_MASTERS_HEADER,
        tournamentTrainingMode ? "1" : "0",
      );
      return { ...init, headers };
    },
    [masterScopeId, tournamentTrainingMode],
  );
  /** Authoritative live vs training master tables — matches dashboard tab, not team FK alone. */
  const masterListBodyFields = useMemo(
    () => ({ useTrainingMasters: tournamentTrainingMode === true }),
    [tournamentTrainingMode],
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [masterPickId, setMasterPickId] = useState("");
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const saveNoticeTimeoutRef = useRef<number | null>(null);
  const [, setAcademyManuallyEdited] = useState(false);
  const [, setLastAutoAcademyName] = useState("");
  const [form, setForm] = useState({
    teamId: "",
    firstName: "",
    lastName: "",
    nickname: "",
    academyName: "",
    unofficialWeight: "",
    heightFeet: "",
    heightInches: "",
    age: "",
    beltRank: defaultBelt,
    profilePhotoUrl: "",
    headShotUrl: "",
    lineupConfirmed: false,
    weighedConfirmed: false,
  });
  const [formErr, setFormErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [masterProfileDeleteBusy, setMasterProfileDeleteBusy] = useState(false);
  const [masterProfileDeleteDialogOpen, setMasterProfileDeleteDialogOpen] =
    useState(false);
  const [lineupMasterRemoveTarget, setLineupMasterRemoveTarget] = useState<{
    playerId: string;
    teamId: string;
    masterProfileId: string | null;
    displayName: string;
  } | null>(null);
  const [lineupMasterRemoveBusy, setLineupMasterRemoveBusy] = useState(false);
  const [officialWeightConfirm, setOfficialWeightConfirm] = useState<{
    playerId: string;
    raw: string;
  } | null>(null);
  const [flagBusyId, setFlagBusyId] = useState<string | null>(null);
  const [dragRosterPlayerId, setDragRosterPlayerId] = useState<string | null>(null);
  const [rowOfficialWeightDrafts, setRowOfficialWeightDrafts] = useState<Record<string, string>>({});
  const [showTeamId, setShowTeamId] = useState("");
  const [newTeamDialogOpen, setNewTeamDialogOpen] = useState(false);
  const [newTeamNameDraft, setNewTeamNameDraft] = useState("");
  const [masterProfileBeltFilterOpen, setMasterProfileBeltFilterOpen] =
    useState(false);
  const [masterProfileBeltFilter, setMasterProfileBeltFilter] = useState<
    Set<BeltRank>
  >(() => new Set<BeltRank>([...ALL_BELT_OPTIONS]));

  const { data: teamsLivePayload } = useQuery({
    queryKey: matbeastKeys.teams(masterScopeId),
    queryFn: () =>
      matbeastJson<{ teams: Team[] }>("/api/teams", {
        headers: { [MATBEAST_TOURNAMENT_HEADER]: masterScopeId! },
      }),
    enabled: Boolean(showMasterProfilePicker && masterScopeId),
    placeholderData: keepPreviousData,
  });

  const teamsEffective = useMemo(() => {
    if (showMasterProfilePicker && masterScopeId && teamsLivePayload?.teams) {
      return [...teamsLivePayload.teams].sort((a, b) => a.seedOrder - b.seedOrder);
    }
    return teams;
  }, [
    showMasterProfilePicker,
    masterScopeId,
    teamsLivePayload?.teams,
    teams,
  ]);

  const allPlayers = useMemo(
    () => teamsEffective.flatMap((t) => t.players),
    [teamsEffective],
  );

  const teamsSortedBySeed = useMemo(
    () => [...teamsEffective].sort((a, b) => a.seedOrder - b.seedOrder),
    [teamsEffective],
  );

  const rosterListAllTbdView =
    compact && showMasterProfilePicker && showTeamId === SHOW_TEAM_ALL_TBD;

  const firstTbdSlotTeam = useMemo(() => {
    const sorted = [...teamsEffective].sort((a, b) => a.seedOrder - b.seedOrder);
    return (
      sorted.find((t) => {
        const n = t.name.trim().toUpperCase();
        return n.length === 0 || n === "TBD";
      }) ?? null
    );
  }, [teamsEffective]);

  const { data: masterTeamPayload, refetch: refetchMasterTeamNames } = useQuery({
    queryKey: matbeastKeys.masterTeamNames(masterScopeId, tournamentTrainingMode),
    queryFn: () => {
      const p = new URLSearchParams();
      if (masterScopeId) p.set("tournamentId", masterScopeId);
      p.set("useTrainingMasters", tournamentTrainingMode ? "1" : "0");
      const qs = p.toString();
      return matbeastJson<{ names: string[] }>(
        `/api/master-team-names${qs ? `?${qs}` : ""}`,
        mergeMasterScopeInInit(),
      );
    },
    enabled: Boolean(masterScopeId),
  });
  const masterTeamNames = useMemo<string[]>(
    () => masterTeamPayload?.names ?? [],
    [masterTeamPayload?.names],
  );

  const mergedMasterTeamNames = useMemo(() => {
    const fromDb = new Set(
      masterTeamNames
        .map((n) => n.trim().toUpperCase())
        .filter(
          (n) =>
            Boolean(n) && n !== "TBD" && !isForbiddenCustomTeamName(n),
        ),
    );
    for (const t of teamsEffective) {
      const n = t.name.trim().toUpperCase();
      if (n && n !== "TBD" && !isForbiddenCustomTeamName(n)) fromDb.add(n);
    }
    return [...fromDb].sort((a, b) => a.localeCompare(b));
  }, [masterTeamNames, teamsEffective]);

  const resolvedRosterListTeamId = useMemo(() => {
    if (!(compact && showMasterProfilePicker)) return form.teamId;
    if (showTeamId === SHOW_TEAM_ALL_TBD) return "";
    if (showTeamId.startsWith(SHOW_PREFIX_TEAM)) {
      return showTeamId.slice(SHOW_PREFIX_TEAM.length);
    }
    return "";
  }, [compact, showMasterProfilePicker, showTeamId, form.teamId]);

  const playersForRosterList = useMemo(() => {
    const sortPl = (pl: Player[]) =>
      pl
        .slice()
        .sort(
          (a, b) =>
            (a.lineupOrder == null ? 999 : a.lineupOrder) -
              (b.lineupOrder == null ? 999 : b.lineupOrder) ||
            a.lastName.localeCompare(b.lastName) ||
            a.firstName.localeCompare(b.firstName),
        );

    if (rosterListAllTbdView) {
      const pl: Player[] = [];
      for (const t of teamsEffective) {
        const n = t.name.trim().toUpperCase();
        if (n.length === 0 || n === "TBD") pl.push(...t.players);
      }
      return sortPl(pl);
    }

    const t = teamsEffective.find((x) => x.id === resolvedRosterListTeamId);
    return sortPl(t?.players ?? []);
  }, [teamsEffective, resolvedRosterListTeamId, rosterListAllTbdView]);

  const lineupSlotsOneToFiveOfficialTotal = useMemo(() => {
    const accumulate = (players: Player[]) => {
      let sum = 0;
      let hasAny = false;
      for (const p of players) {
        if (
          typeof p.lineupOrder === "number" &&
          p.lineupOrder >= 1 &&
          p.lineupOrder <= 5 &&
          typeof p.officialWeight === "number" &&
          Number.isFinite(p.officialWeight)
        ) {
          sum += p.officialWeight;
          hasAny = true;
        }
      }
      return { sum, hasAny };
    };

    if (rosterListAllTbdView) {
      const pl: Player[] = [];
      for (const t of teamsEffective) {
        const n = t.name.trim().toUpperCase();
        if (n.length === 0 || n === "TBD") pl.push(...t.players);
      }
      return accumulate(pl);
    }

    const team = teamsEffective.find((x) => x.id === resolvedRosterListTeamId);
    return accumulate(team?.players ?? []);
  }, [teamsEffective, resolvedRosterListTeamId, rosterListAllTbdView]);

  const officialWeightInputDimmed = useCallback((p: Player) => {
    const draft = rowOfficialWeightDrafts[p.id];
    const savedStr =
      typeof p.officialWeight === "number" && Number.isFinite(p.officialWeight)
        ? String(p.officialWeight)
        : "";
    const eff = draft !== undefined ? draft : savedStr;
    if (!savedStr.length) return false;
    return eff === savedStr;
  }, [rowOfficialWeightDrafts]);

  const playerProfilesHintTeamId = useMemo(
    () => (form.teamId.trim() || teams[0]?.id || "").trim(),
    [form.teamId, teams],
  );

  const { data: masterPayload, refetch: refetchMasterProfiles } = useQuery({
    queryKey: matbeastKeys.playerProfiles(
      masterScopeId,
      playerProfilesHintTeamId,
      tournamentTrainingMode,
    ),
    queryFn: () => {
      const params = new URLSearchParams();
      if (playerProfilesHintTeamId) {
        params.set("teamId", playerProfilesHintTeamId);
      }
      if (masterScopeId) {
        params.set("tournamentId", masterScopeId);
      }
      params.set("useTrainingMasters", tournamentTrainingMode ? "1" : "0");
      const qs = params.toString();
      return matbeastJson<{ profiles: MasterPlayerProfileRow[] }>(
        `/api/player-profiles${qs ? `?${qs}` : ""}`,
        mergeMasterScopeInInit(),
      );
    },
    enabled: showMasterProfilePicker && Boolean(masterScopeId),
  });
  const masterProfiles = useMemo<MasterPlayerProfileRow[]>(
    () => masterPayload?.profiles ?? [],
    [masterPayload?.profiles],
  );
  const [masterProfileSortMode, setMasterProfileSortMode] = useState<
    "name" | "academy"
  >("name");
  const masterProfilesSorted = useMemo(() => {
    const copy = [...masterProfiles];
    copy.sort((a, b) => {
      if (masterProfileSortMode === "academy") {
        const ac = (a.academyName ?? "").localeCompare(b.academyName ?? "");
        if (ac !== 0) return ac;
      }
      const ln = a.lastName.localeCompare(b.lastName);
      if (ln !== 0) return ln;
      return a.firstName.localeCompare(b.firstName);
    });
    return copy;
  }, [masterProfiles, masterProfileSortMode]);

  const masterProfilesForPicker = useMemo(() => {
    if (masterProfileBeltFilter.size === 0) return masterProfilesSorted;
    return masterProfilesSorted.filter((m) => {
      const b = (m.beltRank ?? "").trim().toUpperCase();
      return (
        ALL_BELT_OPTIONS.includes(b as BeltRank) &&
        masterProfileBeltFilter.has(b as BeltRank)
      );
    });
  }, [masterProfilesSorted, masterProfileBeltFilter]);

  const toggleMasterProfileBeltFilter = useCallback((belt: BeltRank) => {
    setMasterProfileBeltFilter((prev) => {
      const next = new Set(prev);
      if (next.has(belt)) next.delete(belt);
      else next.add(belt);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!showMasterProfilePicker || !masterPickId) return;
    if (!masterProfilesForPicker.some((x) => x.id === masterPickId)) {
      setMasterPickId("");
    }
  }, [showMasterProfilePicker, masterPickId, masterProfilesForPicker]);

  const teamNameForAcademy = useCallback(
    (teamId: string) => {
      const teamName = teamsEffective.find((t) => t.id === teamId)?.name ?? "";
      return teamName.trim().toUpperCase();
    },
    [teamsEffective],
  );

  async function rememberMasterTeamName(name: string) {
    const n = name.trim().toUpperCase();
    if (!n || isForbiddenUserChosenTeamName(n)) return;
    try {
      const res = await matbeastFetch(
        "/api/master-team-names",
        mergeMasterScopeInInit({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: n,
            ...masterListBodyFields,
            ...(masterScopeId ? { tournamentId: masterScopeId } : {}),
          }),
        }),
      );
      if (!res.ok) return;
      await queryClient.invalidateQueries({
        queryKey: matbeastKeys.masterTeamNames(masterScopeId, tournamentTrainingMode),
      });
      await refetchMasterTeamNames();
    } catch {
      /* ignore */
    }
  }

  function isTeamSlotEmpty(teamName: string) {
    const n = teamName.trim().toUpperCase();
    return n.length === 0 || n === "TBD";
  }

  async function ensureEventTeamForName(name: string): Promise<string> {
    const want = name.trim().toUpperCase();
    if (!want) throw new Error("Team name is required");
    if (isForbiddenUserChosenTeamName(want)) {
      throw new Error(forbiddenUserChosenTeamNameMessage());
    }
    const existing = teamsEffective.find(
      (t) => t.name.trim().toUpperCase() === want && t.name.trim().toUpperCase() !== "TBD",
    );
    if (existing) return existing.id;

    const sorted = [...teamsEffective].sort((a, b) => a.seedOrder - b.seedOrder);
    const emptySlot = sorted.find((t) => isTeamSlotEmpty(t.name));
    if (emptySlot) {
      const res = await matbeastFetch(
        `/api/teams/${emptySlot.id}`,
        mergeMasterScopeInInit({
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: want,
            ...masterListBodyFields,
            ...(masterScopeId ? { tournamentId: masterScopeId } : {}),
          }),
        }),
      );
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? "Could not assign team name to a slot");
      }
      if (masterScopeId) {
        await queryClient.invalidateQueries({ queryKey: matbeastKeys.teams(masterScopeId) });
      }
      await onSaved();
      return emptySlot.id;
    }

    const res = await matbeastFetch(
      "/api/teams",
      mergeMasterScopeInInit({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: want,
          ...masterListBodyFields,
          ...(masterScopeId ? { tournamentId: masterScopeId } : {}),
        }),
      }),
    );
    if (!res.ok) {
      const j = (await res.json()) as { error?: string };
      const msg = j.error ?? "Could not add team to event";
      if (msg.includes("Maximum") || msg.includes("8")) {
        throw new Error(
          "All 8 team seeds already have names. Clear a slot on the Teams card, or pick an existing team.",
        );
      }
      throw new Error(msg);
    }
    const created = (await res.json()) as { id: string };
    if (masterScopeId) {
      await queryClient.invalidateQueries({ queryKey: matbeastKeys.teams(masterScopeId) });
    }
    await onSaved();
    return created.id;
  }

  const teamSelectValue = useMemo(() => {
    // Each team (including TBD/open slots) is rendered as its own
    // `team:<id>` option. Previously we collapsed any open-slot selection
    // to the synthetic TEAM_SEL_TBD sentinel, but no option with that
    // value exists in the current render, so the controlled <select>
    // would silently revert and users could not pick TBD. Always return
    // the concrete `team:<id>` so the chosen option stays selected.
    if (showMasterProfilePicker) {
      const tid = form.teamId;
      // No team chosen → show the "SELECT TEAM" placeholder option.
      if (!tid) return "";
      return `${TEAM_SEL_PREFIX_TEAM}${tid}`;
    }
    const tid = form.teamId;
    if (!tid) return "";
    return `${TEAM_SEL_PREFIX_TEAM}${tid}`;
  }, [form.teamId, showMasterProfilePicker]);

  async function applyTeamSelectValue(raw: string) {
    // Academy auto-population rule: selecting a team only fills the Academy
    // field when Academy is currently blank. A non-empty Academy value is
    // treated as user-owned content and is never overwritten by a team
    // change here (regardless of whether it was typed manually or seeded
    // from a previous team selection).
    if (raw === TEAM_SEL_TBD) {
      const id = firstTbdSlotTeam?.id ?? "";
      if (!id) {
        setFormErr(
          "No TBD (open) bracket slot is available. Clear a team name on the Teams card first.",
        );
        return;
      }
      setFormErr(null);
      setAcademyManuallyEdited(false);
      const upper = teamNameForAcademy(id);
      setLastAutoAcademyName(upper);
      setForm((f) => ({
        ...f,
        teamId: id,
        academyName: f.academyName.trim() ? f.academyName : upper || "TBD",
      }));
      return;
    }
    if (raw === TEAM_SEL_NOT_LISTED) {
      setFormErr(null);
      setNewTeamNameDraft("");
      setNewTeamDialogOpen(true);
      return;
    }
    if (raw.startsWith(TEAM_SEL_PREFIX_TEAM)) {
      const id = raw.slice(TEAM_SEL_PREFIX_TEAM.length);
      const nm = teamsEffective.find((t) => t.id === id)?.name ?? "";
      const upper = nm.trim().toUpperCase();
      setAcademyManuallyEdited(false);
      setLastAutoAcademyName(upper);
      setForm((f) => ({
        ...f,
        teamId: id,
        academyName: f.academyName.trim() ? f.academyName : upper,
      }));
      if (upper) await rememberMasterTeamName(upper);
      return;
    }
    if (raw.startsWith(TEAM_SEL_PREFIX_NAME)) {
      const name = raw.slice(TEAM_SEL_PREFIX_NAME.length);
      const match = teamsEffective.find((t) => t.name.trim().toUpperCase() === name);
      if (match) {
        setAcademyManuallyEdited(false);
        setLastAutoAcademyName(name);
        setForm((f) => ({
          ...f,
          teamId: match.id,
          academyName: f.academyName.trim() ? f.academyName : name,
        }));
      } else {
        const id = await ensureEventTeamForName(name);
        const auto = teamNameForAcademy(id);
        setAcademyManuallyEdited(false);
        setLastAutoAcademyName(auto);
        setForm((f) => ({
          ...f,
          teamId: id,
          academyName: f.academyName.trim() ? f.academyName : auto,
        }));
      }
      await rememberMasterTeamName(name);
    }
  }

  async function confirmNewTeamDialog() {
    const name = newTeamNameDraft.trim().toUpperCase();
    if (!name) {
      setFormErr("Enter a team name.");
      return;
    }
    if (isForbiddenUserChosenTeamName(name)) {
      setFormErr(forbiddenUserChosenTeamNameMessage());
      return;
    }
    setFormErr(null);
    try {
      await rememberMasterTeamName(name);
      const id = await ensureEventTeamForName(name);
      const auto = teamNameForAcademy(id);
      setAcademyManuallyEdited(false);
      setLastAutoAcademyName(auto);
      setForm((f) => ({ ...f, teamId: id, academyName: auto }));
      setNewTeamDialogOpen(false);
      setNewTeamNameDraft("");
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : "Could not save team name");
    }
  }

  const teamIdForMasterProfile = useCallback(
    (m: MasterPlayerProfileRow): string => {
      if (m.teamId && teamsEffective.some((t) => t.id === m.teamId)) return m.teamId;
      const matchingPlayers = allPlayers.filter(
        (p) =>
          p.firstName === m.firstName &&
          p.lastName === m.lastName &&
          (!m.academyName || p.academyName === m.academyName),
      );
      if (matchingPlayers.length === 1) return matchingPlayers[0].teamId;
      if (matchingPlayers.length > 1) {
        const inShownTeam = matchingPlayers.find((p) => {
          if (rosterListAllTbdView) {
            const tt = teamsEffective.find((t) => t.id === p.teamId);
            return tt != null && isTeamSlotEmpty(tt.name);
          }
          return p.teamId === resolvedRosterListTeamId;
        });
        if (inShownTeam) return inShownTeam.teamId;
      }
      return form.teamId || teamsEffective[0]?.id || "";
    },
    [
      teamsEffective,
      allPlayers,
      resolvedRosterListTeamId,
      form.teamId,
      rosterListAllTbdView,
    ],
  );

  function loadFromMasterProfile(m: MasterPlayerProfileRow) {
    const nextTeamId = teamIdForMasterProfile(m);
    setEditingId(null);
    setAcademyManuallyEdited(true);
    setLastAutoAcademyName("");
    setForm((f) => ({
      ...f,
      teamId: nextTeamId,
      firstName: m.firstName,
      lastName: m.lastName,
      nickname: m.nickname ?? "",
      academyName: m.academyName ?? "",
      unofficialWeight: m.unofficialWeight?.toString() ?? "",
      heightFeet: m.heightFeet != null ? String(m.heightFeet) : "",
      heightInches: m.heightInches != null ? String(m.heightInches) : "",
      age: m.age?.toString() ?? "",
      beltRank: (ALL_BELT_OPTIONS.includes(m.beltRank as BeltRank)
        ? m.beltRank
        : defaultBelt) as BeltRank,
      profilePhotoUrl: m.profilePhotoUrl ?? "",
      headShotUrl: m.headShotUrl ?? "",
    }));
    setFormErr(null);
  }

  function loadPlayer(p: Player) {
    setEditingId(p.id);
    setAcademyManuallyEdited(true);
    setLastAutoAcademyName("");
    setForm({
      teamId: p.teamId,
      firstName: p.firstName,
      lastName: p.lastName,
      nickname: p.nickname ?? "",
      academyName: p.academyName ?? "",
      unofficialWeight: p.unofficialWeight?.toString() ?? "",
      heightFeet:
        p.heightFeet != null ? String(p.heightFeet) : "",
      heightInches:
        p.heightInches != null ? String(p.heightInches) : "",
      age: p.age?.toString() ?? "",
      beltRank: (ALL_BELT_OPTIONS.includes(p.beltRank as BeltRank)
        ? p.beltRank
        : defaultBelt) as BeltRank,
      profilePhotoUrl: p.profilePhotoUrl ?? "",
      headShotUrl: p.headShotUrl ?? "",
      lineupConfirmed: p.lineupConfirmed ?? false,
      weighedConfirmed: p.weighedConfirmed ?? false,
    });
    setFormErr(null);
  }

  function clearForm(teamIdOverride?: string) {
    setEditingId(null);
    const nextTeamId =
      teamIdOverride ??
      (compact && showMasterProfilePicker
        ? firstTbdSlotTeam?.id ?? teamsEffective[0]?.id ?? ""
        : form.teamId || teamsEffective[0]?.id || "");
    const autoAcademy = teamNameForAcademy(nextTeamId);
    setAcademyManuallyEdited(false);
    setLastAutoAcademyName(autoAcademy);
    setForm({
      teamId: nextTeamId,
      firstName: "",
      lastName: "",
      nickname: "",
      academyName: autoAcademy,
      unofficialWeight: "",
      heightFeet: "",
      heightInches: "",
      age: "",
      beltRank: defaultBelt,
      profilePhotoUrl: "",
      headShotUrl: "",
      lineupConfirmed: false,
      weighedConfirmed: false,
    });
    setFormErr(null);
  }

  function flashSaveNotice(message: string) {
    setSaveNotice(message);
    if (saveNoticeTimeoutRef.current) {
      window.clearTimeout(saveNoticeTimeoutRef.current);
    }
    saveNoticeTimeoutRef.current = window.setTimeout(() => {
      setSaveNotice(null);
      saveNoticeTimeoutRef.current = null;
    }, 1800);
  }

  async function confirmDeleteSelectedMasterProfile() {
    if (!showMasterProfilePicker || !masterPickId) return;
    setMasterProfileDeleteBusy(true);
    setFormErr(null);
    try {
      const delParams = new URLSearchParams();
      if (playerProfilesHintTeamId) {
        delParams.set("teamId", playerProfilesHintTeamId);
      }
      if (masterScopeId) {
        delParams.set("tournamentId", masterScopeId);
      }
      delParams.set("useTrainingMasters", tournamentTrainingMode ? "1" : "0");
      const delQs = delParams.toString();
      const delUrl = `/api/player-profiles/${masterPickId}${delQs ? `?${delQs}` : ""}`;
      const res = await matbeastFetch(
        delUrl,
        mergeMasterScopeInInit({ method: "DELETE" }),
      );
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? "Delete failed");
      }
      await queryClient.invalidateQueries({
        queryKey: matbeastKeys.playerProfiles(
          masterScopeId,
          playerProfilesHintTeamId,
          tournamentTrainingMode,
        ),
      });
      await refetchMasterProfiles();
      setMasterProfileDeleteDialogOpen(false);
      setMasterPickId("");
      clearForm();
      flashSaveNotice("Removed from master list");
    } catch (er) {
      setFormErr(er instanceof Error ? er.message : "Delete failed");
    } finally {
      setMasterProfileDeleteBusy(false);
    }
  }

  async function confirmLineupMasterRemove() {
    if (!lineupMasterRemoveTarget) return;
    setLineupMasterRemoveBusy(true);
    setFormErr(null);
    const { playerId, masterProfileId } = lineupMasterRemoveTarget;
    try {
      const playerRes = await matbeastFetch(
        `/api/players/${playerId}`,
        mergeMasterScopeInInit({ method: "DELETE" }),
      );
      if (!playerRes.ok) {
        const j = (await playerRes.json()) as { error?: string };
        throw new Error(j.error ?? "Remove from roster failed");
      }
      if (editingId === playerId) {
        clearForm();
      }
      if (masterProfileId) {
        const tid = lineupMasterRemoveTarget.teamId.trim();
        const delMParams = new URLSearchParams();
        if (tid) delMParams.set("teamId", tid);
        if (masterScopeId) delMParams.set("tournamentId", masterScopeId);
        delMParams.set("useTrainingMasters", tournamentTrainingMode ? "1" : "0");
        const delMQs = delMParams.toString();
        const delMasterUrl = `/api/player-profiles/${masterProfileId}${delMQs ? `?${delMQs}` : ""}`;
        const masterRes = await matbeastFetch(
          delMasterUrl,
          mergeMasterScopeInInit({ method: "DELETE" }),
        );
        if (!masterRes.ok) {
          const j = (await masterRes.json()) as { error?: string };
          throw new Error(j.error ?? "Remove from master list failed");
        }
        if (masterPickId === masterProfileId) {
          setMasterPickId("");
        }
      }
      await queryClient.invalidateQueries({
        queryKey: matbeastKeys.playerProfiles(
          masterScopeId,
          playerProfilesHintTeamId,
          tournamentTrainingMode,
        ),
      });
      await refetchMasterProfiles();
      if (masterScopeId) {
        await queryClient.invalidateQueries({
          queryKey: matbeastKeys.teams(masterScopeId),
        });
      }
      await onSaved();
      setLineupMasterRemoveTarget(null);
      flashSaveNotice(
        masterProfileId
          ? "Removed from roster and master list"
          : "Removed from roster",
      );
    } catch (er) {
      setFormErr(er instanceof Error ? er.message : "Delete failed");
    } finally {
      setLineupMasterRemoveBusy(false);
    }
  }

  useEffect(() => {
    return () => {
      if (saveNoticeTimeoutRef.current) {
        window.clearTimeout(saveNoticeTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    // In the dashboard roster card (compact + master profile picker), leave
    // teamId empty on mount and after save so the "SELECT TEAM" placeholder
    // shows — user must explicitly pick a team for each new profile.
    if (showMasterProfilePicker) return;
    if (form.teamId || !teamsEffective[0]) return;
    const id = teamsEffective[0].id;
    const autoAcademy = teamNameForAcademy(id);
    setLastAutoAcademyName(autoAcademy);
    setAcademyManuallyEdited(false);
    setForm((f) => ({ ...f, teamId: id, academyName: autoAcademy }));
  }, [
    teamsEffective,
    form.teamId,
    teamNameForAcademy,
    showMasterProfilePicker,
  ]);

  useEffect(() => {
    // The Show Team dropdown only lists *named* teams (TBD/unnamed slots
    // are folded into a single "TBD" catch-all), so the initial and
    // fallback selections must also target a named team — or the TBD
    // catch-all if no named teams exist.
    const isNamedTeam = (t: { name: string }) => {
      const u = t.name.trim().toUpperCase();
      return u.length > 0 && u !== "TBD";
    };
    const firstNamed = teamsEffective.find(isNamedTeam);
    if (!showTeamId) {
      if (firstNamed) {
        setShowTeamId(`${SHOW_PREFIX_TEAM}${firstNamed.id}`);
      } else {
        setShowTeamId(SHOW_TEAM_ALL_TBD);
      }
      return;
    }
    if (showTeamId === SHOW_TEAM_ALL_TBD) return;
    if (showTeamId.startsWith(SHOW_PREFIX_NAME)) {
      setShowTeamId(firstNamed ? `${SHOW_PREFIX_TEAM}${firstNamed.id}` : SHOW_TEAM_ALL_TBD);
      return;
    }
    if (showTeamId.startsWith(SHOW_PREFIX_TEAM)) {
      const id = showTeamId.slice(SHOW_PREFIX_TEAM.length);
      const current = teamsEffective.find((t) => t.id === id);
      // Stale id (team removed) OR id now points at an unnamed/TBD slot
      // that we no longer render as a distinct option → migrate selection.
      if (!current || !isNamedTeam(current)) {
        setShowTeamId(firstNamed ? `${SHOW_PREFIX_TEAM}${firstNamed.id}` : SHOW_TEAM_ALL_TBD);
      }
    }
  }, [teamsEffective, showTeamId]);

  useEffect(() => {
    if (
      form.teamId &&
      !teamsEffective.some((t) => t.id === form.teamId) &&
      teamsEffective[0]
    ) {
      const autoAcademy = teamNameForAcademy(teamsEffective[0].id);
      setLastAutoAcademyName(autoAcademy);
      setAcademyManuallyEdited(false);
      setForm((f) => ({ ...f, teamId: teamsEffective[0].id, academyName: autoAcademy }));
    }
  }, [teamsEffective, form.teamId, teamNameForAcademy]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormErr(null);
    setSaving(true);

    const hf = form.heightFeet === "" ? null : Number(form.heightFeet);
    const hi = form.heightInches === "" ? null : Number(form.heightInches);
    if ((hf !== null) !== (hi !== null)) {
      setFormErr("Set both feet and inches for height, or leave both blank.");
      setSaving(false);
      return;
    }
    if (hf !== null && hi !== null) {
      if (!Number.isInteger(hf) || hf < 3 || hf > 8) {
        setFormErr("Feet must be a whole number 3–8.");
        setSaving(false);
        return;
      }
      if (!Number.isInteger(hi) || hi < 0 || hi > 11) {
        setFormErr("Inches must be a whole number 0–11.");
        setSaving(false);
        return;
      }
    }

    const teamRow = teamsEffective.find((t) => t.id === form.teamId);
    const teamNameForMaster = (teamRow?.name ?? "").trim().toUpperCase();
    if (teamNameForMaster) {
      await rememberMasterTeamName(teamNameForMaster);
    }

    const rosterTeam = teamsEffective.find((t) => t.id === form.teamId);
    const fn = form.firstName.trim();
    const ln = form.lastName.trim();
    const dupOnRoster = !editingId
      ? rosterTeam?.players.find((p) => p.firstName === fn && p.lastName === ln)
      : undefined;

    const playerRowForOfficial =
      editingId != null
        ? allPlayers.find((p) => p.id === editingId)
        : dupOnRoster;
    const officialWeightFromEvent =
      playerRowForOfficial != null &&
      typeof playerRowForOfficial.officialWeight === "number" &&
      Number.isFinite(playerRowForOfficial.officialWeight)
        ? playerRowForOfficial.officialWeight
        : null;

    const teamIdForMaster =
      (form.teamId && form.teamId.trim()) ||
      playerProfilesHintTeamId ||
      teams[0]?.id ||
      "";

    const payload = {
      ...masterListBodyFields,
      ...(masterScopeId ? { tournamentId: masterScopeId } : {}),
      teamId: form.teamId,
      firstName: fn,
      lastName: ln,
      nickname: form.nickname.trim() || null,
      academyName: form.academyName.trim() || null,
      unofficialWeight: form.unofficialWeight
        ? Number(form.unofficialWeight)
        : null,
      officialWeight:
        editingId != null || dupOnRoster ? officialWeightFromEvent : null,
      heightFeet: hf,
      heightInches: hi,
      age: form.age ? Number(form.age) : null,
      beltRank: form.beltRank,
      profilePhotoUrl: form.profilePhotoUrl.trim() || null,
      headShotUrl: form.headShotUrl.trim() || null,
      lineupConfirmed: form.lineupConfirmed,
      weighedConfirmed: form.weighedConfirmed,
    };

    try {
      if (masterScopeId) {
        setMatBeastTournamentId(masterScopeId);
      }
      if (editingId) {
        const res = await matbeastFetch(
          `/api/players/${editingId}`,
          mergeMasterScopeInInit({
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }),
        );
        if (!res.ok) {
          const j = (await res.json()) as { error?: string };
          throw new Error(j.error ?? "Save failed");
        }
      } else if (dupOnRoster) {
        const res = await matbeastFetch(
          `/api/players/${dupOnRoster.id}`,
          mergeMasterScopeInInit({
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }),
        );
        if (!res.ok) {
          const j = (await res.json()) as { error?: string };
          throw new Error(j.error ?? "Save failed");
        }
      } else {
        const res = await matbeastFetch(
          "/api/players",
          mergeMasterScopeInInit({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }),
        );
        if (!res.ok) {
          const j = (await res.json()) as { error?: string };
          throw new Error(j.error ?? "Create failed");
        }
      }

      const masterUrl = masterPickId ? `/api/player-profiles/${masterPickId}` : "/api/player-profiles";
      const masterMethod = masterPickId ? "PATCH" : "POST";
      const masterRes = await matbeastFetch(
        masterUrl,
        mergeMasterScopeInInit({
          method: masterMethod,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...masterListBodyFields,
            ...(masterScopeId ? { tournamentId: masterScopeId } : {}),
            teamId: teamIdForMaster,
            firstName: payload.firstName,
            lastName: payload.lastName,
            nickname: payload.nickname,
            academyName: payload.academyName,
            unofficialWeight: payload.unofficialWeight,
            heightFeet: payload.heightFeet,
            heightInches: payload.heightInches,
            age: payload.age,
            beltRank: payload.beltRank,
            profilePhotoUrl: payload.profilePhotoUrl,
            headShotUrl: payload.headShotUrl,
          }),
        }),
      );
      if (!masterRes.ok) {
        let msg = `Master profile list could not be updated (${masterRes.status}).`;
        try {
          const j = (await masterRes.json()) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          /* keep msg */
        }
        throw new Error(msg);
      }
      await queryClient.invalidateQueries({
        queryKey: matbeastKeys.playerProfiles(
          masterScopeId,
          playerProfilesHintTeamId,
          tournamentTrainingMode,
        ),
      });
      await refetchMasterProfiles();
      if (masterScopeId) {
        await queryClient.invalidateQueries({
          queryKey: matbeastKeys.teams(masterScopeId),
        });
      }

      await onSaved();
      flashSaveNotice("Profile saved");
      if (!editingId) {
        clearForm(form.teamId);
      }
      if (compact && showMasterProfilePicker) {
        // Reset to empty so the team dropdown falls back to the
        // "SELECT TEAM" placeholder instead of re-showing the just-saved team.
        setForm((f) => ({
          ...f,
          teamId: "",
          academyName: "",
          beltRank: defaultBelt,
        }));
        setAcademyManuallyEdited(true);
        setLastAutoAcademyName("");
      }
    } catch (er) {
      setFormErr(er instanceof Error ? er.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function requestSaveOfficialWeight(playerId: string, raw: string) {
    setFormErr(null);
    const trimmed = raw.trim();
    if (trimmed) {
      const probe = Number(trimmed);
      if (!Number.isFinite(probe)) {
        setFormErr("Invalid official weight.");
        return;
      }
    }
    const player = playersForRosterList.find((p) => p.id === playerId);
    if (!player) return;

    const next = parseOfficialWeightInput(raw);
    const prev =
      typeof player.officialWeight === "number" && Number.isFinite(player.officialWeight)
        ? player.officialWeight
        : null;

    if (sameOfficialWeight(prev, next)) return;

    if (prev == null) {
      await commitOfficialWeightSave(playerId, next);
      return;
    }

    setOfficialWeightConfirm({ playerId, raw });
  }

  async function commitOfficialWeightSave(playerId: string, next: number | null) {
    setOfficialWeightConfirm(null);
    setFlagBusyId(playerId);
    setFormErr(null);
    try {
      const res = await matbeastFetch(
        `/api/players/${playerId}`,
        mergeMasterScopeInInit({
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...masterListBodyFields,
            ...(masterScopeId ? { tournamentId: masterScopeId } : {}),
            officialWeight: next,
          }),
        }),
      );
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? "Weight update failed");
      }
      if (masterScopeId) {
        await queryClient.invalidateQueries({
          queryKey: matbeastKeys.teams(masterScopeId),
        });
      }
      await onSaved();
      setRowOfficialWeightDrafts((d) => {
        const copy = { ...d };
        delete copy[playerId];
        return copy;
      });
      flashSaveNotice("Official weight saved");
    } catch (er) {
      setFormErr(er instanceof Error ? er.message : "Weight update failed");
    } finally {
      setFlagBusyId(null);
    }
  }

  async function deleteRosterPlayer(playerId: string) {
    if (!confirm("Remove this player from the roster?")) return;
    setFlagBusyId(playerId);
    setFormErr(null);
    try {
      const res = await matbeastFetch(
        `/api/players/${playerId}`,
        mergeMasterScopeInInit({ method: "DELETE" }),
      );
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? "Delete failed");
      }
      if (editingId === playerId) {
        clearForm();
      }
      if (masterScopeId) {
        void queryClient.invalidateQueries({
          queryKey: matbeastKeys.teams(masterScopeId),
        });
      }
      await onSaved();
    } catch (er) {
      setFormErr(er instanceof Error ? er.message : "Delete failed");
    } finally {
      setFlagBusyId(null);
    }
  }

  async function moveRosterPlayerSeed(playerId: string, toLineupOrder: number) {
    const source = playersForRosterList.find((p) => p.id === playerId);
    if (!source) return;
    if (
      typeof source.lineupOrder === "number" &&
      source.lineupOrder === toLineupOrder
    ) {
      return;
    }
    setFlagBusyId(playerId);
    setFormErr(null);
    try {
      const res = await matbeastFetch(
        `/api/players/${playerId}`,
        mergeMasterScopeInInit({
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...masterListBodyFields,
            ...(masterScopeId ? { tournamentId: masterScopeId } : {}),
            lineupOrder: toLineupOrder,
          }),
        }),
      );
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? "Seed reorder failed");
      }
      if (editingId === playerId) {
        // lineup order is managed by drag/drop roster list and auto sequencing
      }
      if (masterScopeId) {
        void queryClient.invalidateQueries({
          queryKey: matbeastKeys.teams(masterScopeId),
        });
      }
      await onSaved();
    } catch (er) {
      setFormErr(er instanceof Error ? er.message : "Seed reorder failed");
    } finally {
      setFlagBusyId(null);
    }
  }

  const formGapClass = compact
    ? "grid gap-x-2 gap-y-0.5 text-[11px] grid-cols-2 sm:grid-cols-3 xl:grid-cols-4"
    : "grid gap-3 text-sm sm:grid-cols-2";
  const selClass = compact
    ? "mt-0.5 min-w-0 max-w-full flex-1 rounded border border-zinc-600 bg-black/30 px-1.5 py-0.5 text-[11px] text-zinc-100"
    : "mt-1 w-full rounded border border-zinc-600 bg-black/30 px-2 py-2 text-zinc-100";
  const selSmClass = compact
    ? "rounded border border-zinc-600 bg-black/30 px-1.5 py-0.5 text-[11px] text-zinc-100"
    : "rounded border border-zinc-600 bg-black/30 px-2 py-2 text-zinc-100";
  const heightSelectClass = compact
    ? "w-[6ch] shrink-0 rounded border border-zinc-600 bg-black/30 px-0.5 py-0.5 text-center text-[11px] tabular-nums text-zinc-100"
    : selSmClass;

  return (
    <section className={compact ? "max-w-none" : "max-w-4xl"}>
      {newTeamDialogOpen ? (
        <div
          className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="matbeast-new-team-title"
        >
          <div className="w-full max-w-sm rounded-lg border border-zinc-600 bg-[#2d2d2d] p-4 shadow-xl">
            <h2
              id="matbeast-new-team-title"
              className="text-[12px] font-semibold text-zinc-100"
            >
              New team name
            </h2>
            <p className="mt-1 text-[11px] text-zinc-400">
              Enter a team name. It will be saved to the master team list and
              added to this event if needed.
            </p>
            {formErr ? (
              <p className="mt-2 text-[11px] text-red-300/95" role="alert">
                {formErr}
              </p>
            ) : null}
            <input
              type="text"
              autoFocus
              value={newTeamNameDraft}
              onChange={(e) => setNewTeamNameDraft(e.target.value.toUpperCase())}
              className="mt-3 w-full rounded border border-zinc-600 bg-black/30 px-2 py-1.5 text-[12px] uppercase text-zinc-100 outline-none focus:border-teal-700/60"
              maxLength={120}
              autoCapitalize="characters"
            />
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="rounded border border-zinc-500/60 px-3 py-1.5 text-[11px] text-zinc-200 hover:bg-white/10"
                onClick={() => {
                  setFormErr(null);
                  setNewTeamDialogOpen(false);
                  setNewTeamNameDraft("");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded border border-teal-800/60 bg-teal-950/50 px-3 py-1.5 text-[11px] font-semibold text-teal-100 hover:bg-teal-900/45"
                onClick={() => void confirmNewTeamDialog()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {masterProfileBeltFilterOpen ? (
        <div
          className="fixed inset-0 z-[211] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="matbeast-belt-filter-title"
        >
          <div className="w-full max-w-sm rounded-lg border border-zinc-600 bg-[#2d2d2d] p-4 shadow-xl">
            <h2
              id="matbeast-belt-filter-title"
              className="text-[12px] font-semibold uppercase tracking-[0.12em] text-zinc-100"
            >
              BELT
            </h2>
            <div className="mt-3 grid grid-cols-1 gap-2">
              {ALL_BELT_OPTIONS.map((belt) => (
                <label
                  key={belt}
                  className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-200"
                >
                  <input
                    type="checkbox"
                    checked={masterProfileBeltFilter.has(belt)}
                    onChange={() => toggleMasterProfileBeltFilter(belt)}
                    className="h-3.5 w-3.5 rounded border-zinc-500 bg-black/40 text-teal-600 focus:ring-teal-700/50"
                  />
                  <span className="font-medium tracking-wide">{belt}</span>
                </label>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="rounded border border-zinc-500/60 px-3 py-1.5 text-[11px] text-zinc-200 hover:bg-white/10"
                onClick={() => setMasterProfileBeltFilterOpen(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {masterProfileDeleteDialogOpen ? (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="matbeast-master-delete-title"
        >
          <div className="w-full max-w-sm rounded-lg border border-zinc-600 bg-[#2d2d2d] p-4 shadow-xl">
            <p
              id="matbeast-master-delete-title"
              className="text-[12px] leading-snug text-zinc-200"
            >
              Confirm remove player from master profiles list?
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={masterProfileDeleteBusy}
                className="rounded border border-zinc-500/60 px-3 py-1.5 text-[11px] text-zinc-200 hover:bg-white/10 disabled:opacity-50"
                onClick={() => setMasterProfileDeleteDialogOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={masterProfileDeleteBusy}
                className="rounded border border-red-800/70 bg-red-950/50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-red-200 hover:bg-red-900/45 disabled:opacity-50"
                onClick={() => void confirmDeleteSelectedMasterProfile()}
              >
                {masterProfileDeleteBusy ? "…" : "CONFIRM"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {lineupMasterRemoveTarget ? (
        <div
          className="fixed inset-0 z-[212] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="matbeast-lineup-master-remove-title"
        >
          <div className="w-full max-w-sm rounded-lg border border-zinc-600 bg-[#2d2d2d] p-4 shadow-xl">
            <p
              id="matbeast-lineup-master-remove-title"
              className="text-[12px] leading-snug text-zinc-200"
            >
              Remove this player from the event roster
              {lineupMasterRemoveTarget.masterProfileId
                ? " and from the master profiles list?"
                : "?"}
            </p>
            <p className="mt-2 text-[11px] font-medium text-amber-100/90">
              {lineupMasterRemoveTarget.displayName}
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={lineupMasterRemoveBusy}
                className="rounded border border-zinc-500/60 px-3 py-1.5 text-[11px] text-zinc-200 hover:bg-white/10 disabled:opacity-50"
                onClick={() => setLineupMasterRemoveTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={lineupMasterRemoveBusy}
                className="rounded border border-red-800/70 bg-red-950/50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-red-200 hover:bg-red-900/45 disabled:opacity-50"
                onClick={() => void confirmLineupMasterRemove()}
              >
                {lineupMasterRemoveBusy ? "…" : "CONFIRM"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {officialWeightConfirm ? (
        <div
          className="fixed inset-0 z-[213] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="matbeast-ofcl-wt-confirm-title"
        >
          <div className="w-full max-w-sm rounded-lg border border-zinc-600 bg-[#2d2d2d] p-4 shadow-xl">
            <p
              id="matbeast-ofcl-wt-confirm-title"
              className="text-[12px] leading-snug text-zinc-200"
            >
              Confirm save changes of official weight?
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={flagBusyId === officialWeightConfirm.playerId}
                className="rounded border border-zinc-500/60 px-3 py-1.5 text-[11px] text-zinc-200 hover:bg-white/10 disabled:opacity-50"
                onClick={() => setOfficialWeightConfirm(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={flagBusyId === officialWeightConfirm.playerId}
                className="rounded border border-teal-800/60 bg-teal-950/50 px-3 py-1.5 text-[11px] font-semibold text-teal-100 hover:bg-teal-900/45 disabled:opacity-50"
                onClick={() =>
                  void commitOfficialWeightSave(
                    officialWeightConfirm.playerId,
                    parseOfficialWeightInput(officialWeightConfirm.raw),
                  )
                }
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {!compact ? (
        <>
          <h2 className="mb-3 text-lg font-medium text-zinc-200">
            Player profile
          </h2>
          <p className="mb-4 text-sm text-zinc-400">
            Text fields save as <strong>ALL CAPS</strong>. Belt may be{" "}
            <strong>WHITE, BLUE, PURPLE, BROWN, or BLACK</strong>. Seeds{" "}
            <strong>6–7</strong> are alternates (shown as <strong>ALT</strong> in
            the grid).
          </p>
        </>
      ) : null}

      {compact && showMasterProfilePicker ? (
        <div className="mb-2 space-y-1.5">
          <div className="flex min-w-0 flex-nowrap items-end gap-x-2">
            <label className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              Show team
            </label>
            <select
              aria-label="Team by bracket seed"
              className="min-w-0 w-[min(100%,9.6rem)] max-w-[9.6rem] shrink-0 rounded border border-zinc-600 bg-black/30 px-1.5 py-0.5 text-[11px] text-zinc-100"
              value={showTeamId}
              onChange={(e) => {
                const v = e.target.value;
                if (v === SHOW_TEAM_ALL_TBD) {
                  setFormErr(null);
                  setShowTeamId(SHOW_TEAM_ALL_TBD);
                  return;
                }
                setShowTeamId(v);
                if (v.startsWith(SHOW_PREFIX_TEAM)) {
                  const id = v.slice(SHOW_PREFIX_TEAM.length);
                  const nm = teamsSortedBySeed.find((t) => t.id === id)?.name ?? "";
                  const upper = nm.trim().toUpperCase();
                  setAcademyManuallyEdited(false);
                  setLastAutoAcademyName(upper);
                  setForm((f) => ({
                    ...f,
                    teamId: id,
                    // Never overwrite an existing Academy value; only fill
                    // when the field is blank.
                    academyName: f.academyName.trim() ? f.academyName : upper,
                  }));
                }
              }}
            >
              {teamsSortedBySeed
                .filter((t) => {
                  const u = t.name.trim().toUpperCase();
                  return u.length > 0 && u !== "TBD";
                })
                .map((t) => (
                  <option key={`seed-${t.id}`} value={`${SHOW_PREFIX_TEAM}${t.id}`}>
                    #{t.seedOrder} {t.name}
                  </option>
                ))}
              <option
                value={SHOW_TEAM_ALL_TBD}
                title="All players on bracket slots still marked TBD (no team name yet)"
              >
                TBD
              </option>
            </select>
            <p
              className={`mb-0.5 min-w-0 shrink whitespace-nowrap text-[10px] tabular-nums tracking-wide ${
                lineupSlotsOneToFiveOfficialTotal.hasAny &&
                lineupSlotsOneToFiveOfficialTotal.sum > 900
                  ? "font-semibold text-red-400"
                  : "text-zinc-400"
              }`}
            >
              <span className="font-semibold uppercase text-zinc-500">
                TOT OFCL WT:
              </span>{" "}
              {formatWeightSum(
                lineupSlotsOneToFiveOfficialTotal.hasAny,
                lineupSlotsOneToFiveOfficialTotal.sum,
              )}
            </p>
          </div>
          <div className="scrollbar-thin max-h-[min(200px,28vh)] overflow-auto rounded border border-zinc-800/80 bg-black/15">
            <table className="w-full border-collapse text-left text-[10px] text-zinc-300">
              <thead className="sticky top-0 bg-[#141414] text-[9px] uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="w-9 px-1 py-1 font-medium">Lineup</th>
                  <th className="min-w-[4rem] px-1 py-1 font-medium">First</th>
                  <th className="min-w-[4rem] px-1 py-1 font-medium">Last</th>
                  <th className="w-14 px-0.5 py-1 text-center font-medium">
                    Official wt
                  </th>
                  <th className="w-14 px-0.5 py-1 text-center font-medium">
                    <span className="sr-only">Roster actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {playersForRosterList.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-1.5 py-2 text-zinc-600"
                    >
                      No players for this team yet.
                    </td>
                  </tr>
                ) : (
                  playersForRosterList.map((p, idx) => {
                    const lineupMasterMatch = masterProfiles.find(
                      (m) =>
                        m.firstName === p.firstName && m.lastName === p.lastName,
                    );
                    return (
                    <tr
                      key={p.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        setDragRosterPlayerId(p.id);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const fromId = dragRosterPlayerId;
                        setDragRosterPlayerId(null);
                        if (!fromId || fromId === p.id) return;
                        const targetLineupOrder = idx + 1;
                        void moveRosterPlayerSeed(fromId, targetLineupOrder);
                      }}
                      onDragEnd={() => setDragRosterPlayerId(null)}
                      className={`cursor-pointer border-t border-zinc-800/60 hover:bg-zinc-800/40 ${
                        editingId === p.id ? "bg-teal-950/25" : ""
                      }`}
                      onClick={() => loadPlayer(p)}
                    >
                      <td className="px-1 py-0.5 tabular-nums text-zinc-200">
                        <span className="inline-flex items-center gap-1">
                          <DragHandleIcon className="h-2.5 w-2.5 text-zinc-500" />
                          <span>{idx < 7 ? idx + 1 : ""}</span>
                        </span>
                      </td>
                      <td className="max-w-[7rem] truncate px-1 py-0.5">
                        {p.firstName}
                      </td>
                      <td className="max-w-[7rem] truncate px-1 py-0.5">
                        {p.lastName}
                      </td>
                      <td
                        className="px-0.5 py-0.5 text-center"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center justify-center gap-0.5">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={rowOfficialWeightDrafts[p.id] ?? (p.officialWeight != null ? String(p.officialWeight) : "")}
                            onChange={(e) =>
                              setRowOfficialWeightDrafts((d) => ({
                                ...d,
                                [p.id]: digitsOnly(e.target.value).slice(0, 3),
                              }))
                            }
                            className={`w-10 rounded border border-zinc-700 bg-zinc-900/70 px-1 py-0.5 text-[10px] ${
                              officialWeightInputDimmed(p)
                                ? "text-zinc-500"
                                : "text-zinc-100"
                            }`}
                            aria-label={`Official weight for ${p.firstName} ${p.lastName}`}
                          />
                          <button
                            type="button"
                            title="Save official weight"
                            disabled={flagBusyId === p.id}
                            onClick={() =>
                              void requestSaveOfficialWeight(
                                p.id,
                                rowOfficialWeightDrafts[p.id] ??
                                  (p.officialWeight != null ? String(p.officialWeight) : ""),
                              )
                            }
                            className="inline-flex items-center justify-center rounded border border-zinc-700 p-0.5 text-zinc-400 hover:text-emerald-300 disabled:opacity-40"
                          >
                            <SaveDiskIcon className="h-3 w-3" />
                          </button>
                        </div>
                      </td>
                      <td
                        className="px-0.5 py-0.5 text-center"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className="inline-flex items-center justify-center gap-0.5">
                          <button
                            type="button"
                            title="Remove from roster"
                            disabled={flagBusyId === p.id}
                            className="inline-flex items-center justify-center rounded border border-zinc-700 p-0.5 text-zinc-400 hover:border-red-900/40 hover:text-red-300 disabled:opacity-40"
                            onClick={() => void deleteRosterPlayer(p.id)}
                          >
                            <FormTrashIcon className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            title={
                              lineupMasterMatch
                                ? "Remove from roster and master profiles…"
                                : "Remove from roster (no master profile row)…"
                            }
                            disabled={flagBusyId === p.id || lineupMasterRemoveBusy}
                            className="inline-flex items-center justify-center rounded border border-zinc-700 p-0.5 text-zinc-400 hover:border-red-900/40 hover:text-red-300 disabled:opacity-40"
                            onClick={() => {
                              setLineupMasterRemoveTarget({
                                playerId: p.id,
                                teamId: p.teamId,
                                masterProfileId: lineupMasterMatch?.id ?? null,
                                displayName: listLabel(p),
                              });
                            }}
                          >
                            <SkullCrossbonesIcon className="h-3 w-3" />
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : !showMasterProfilePicker ? (
        <div className="mb-4 flex flex-wrap gap-3">
          <select
            className="rounded border border-zinc-600 bg-black/30 px-3 py-2 text-sm"
            value={editingId ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) clearForm();
              else {
                const p = allPlayers.find((x) => x.id === v);
                if (p) loadPlayer(p);
              }
            }}
          >
            <option value="">New player</option>
            {allPlayers
              .slice()
              .sort((a, b) => {
                const ta =
                  teamsEffective.find((t) => t.id === a.teamId)?.name ?? "";
                const tb =
                  teamsEffective.find((t) => t.id === b.teamId)?.name ?? "";
                return (
                  ta.localeCompare(tb) ||
                  (a.lineupOrder == null ? 999 : a.lineupOrder) -
                    (b.lineupOrder == null ? 999 : b.lineupOrder)
                );
              })
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {teamsEffective.find((t) => t.id === p.teamId)?.name ?? "?"} ·{" "}
                  {p.lineupOrder != null ? `S${p.lineupOrder}` : "UNSEEDED"} {listLabel(p)}
                </option>
              ))}
          </select>
          {editingId ? (
            <button
              type="button"
              className="rounded border border-zinc-500 px-3 py-2 text-sm hover:bg-black/30"
              onClick={() => clearForm()}
            >
              Clear (new player)
            </button>
          ) : null}
        </div>
      ) : null}

      {formErr ? (
        <p
          className={`mb-2 text-red-300 ${compact ? "text-[11px]" : "text-sm"}`}
        >
          {formErr}
        </p>
      ) : null}

      <form id="matbeast-player-entry-form" onSubmit={submit} className={formGapClass}>
        {compact && showMasterProfilePicker ? (
          <div className="col-span-2 mb-1 grid grid-cols-1 gap-2 sm:col-span-3 xl:col-span-4 sm:items-end">
            <div className="flex min-w-0 flex-wrap items-end gap-x-1.5 gap-y-1">
              <label className="shrink-0 text-zinc-500">Master profiles</label>
              <select
                className="min-w-0 max-w-[min(100%,14rem)] flex-1 rounded border border-zinc-600 bg-black/30 px-1.5 py-0.5 text-[11px] text-zinc-100"
                value={masterPickId}
                onChange={(e) => {
                  const id = e.target.value;
                  setMasterPickId(id);
                  const m = masterProfilesSorted.find((x) => x.id === id);
                  if (m) loadFromMasterProfile(m);
                }}
              >
                <option value="">Select…</option>
                {masterProfilesForPicker.map((m) => {
                  const ac = (m.academyName ?? "").trim();
                  const label =
                    ac.length > 0
                      ? `${m.lastName}, ${m.firstName} — ${ac}`
                      : `${m.lastName}, ${m.firstName}`;
                  return (
                    <option key={m.id} value={m.id}>
                      {label}
                    </option>
                  );
                })}
              </select>
              <div className="flex shrink-0 items-center gap-0.5 rounded border border-zinc-700/80 bg-black/25 p-0.5">
                <button
                  type="button"
                  title="Sort A–Z by player name"
                  aria-pressed={masterProfileSortMode === "name"}
                  className={`rounded px-1 py-0.5 text-[9px] font-semibold tabular-nums ${
                    masterProfileSortMode === "name"
                      ? "bg-teal-900/60 text-teal-100"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                  onClick={() => setMasterProfileSortMode("name")}
                >
                  A–Z
                </button>
                <button
                  type="button"
                  title="Sort by academy, then name"
                  aria-pressed={masterProfileSortMode === "academy"}
                  className={`rounded px-1 py-0.5 text-[9px] font-semibold tabular-nums ${
                    masterProfileSortMode === "academy"
                      ? "bg-teal-900/60 text-teal-100"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                  onClick={() => setMasterProfileSortMode("academy")}
                >
                  T
                </button>
              </div>
              <button
                type="button"
                title="Refresh master profiles"
                className="inline-flex shrink-0 items-center justify-center rounded border border-zinc-600 p-0.5 text-zinc-400 hover:border-teal-700/50 hover:text-teal-200 disabled:opacity-30"
                onClick={() => {
                  void queryClient.invalidateQueries({
                    queryKey: matbeastKeys.playerProfiles(
                      masterScopeId,
                      playerProfilesHintTeamId,
                      tournamentTrainingMode,
                    ),
                  });
                  void refetchMasterProfiles();
                }}
              >
                <RefreshIcon className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title="Filter master profiles by belt"
                aria-expanded={masterProfileBeltFilterOpen}
                className={`inline-flex shrink-0 items-center justify-center rounded border p-0.5 ${
                  ALL_BELT_OPTIONS.some((b) => !masterProfileBeltFilter.has(b))
                    ? "border-amber-700/50 bg-amber-950/30 text-amber-200/90 hover:border-amber-600/60 hover:bg-amber-950/45"
                    : "border-zinc-600 text-zinc-400 hover:border-teal-700/50 hover:text-teal-200"
                }`}
                onClick={() => setMasterProfileBeltFilterOpen(true)}
              >
                <BeltFilterFunnelIcon className="h-3.5 w-3.5" />
                <span className="sr-only">Belt filter</span>
              </button>
              <button
                type="button"
                title="Remove selected profile from master list"
                disabled={
                  !masterPickId || masterProfileDeleteBusy || saving
                }
                className="inline-flex shrink-0 items-center justify-center rounded border border-red-900/45 bg-red-950/25 p-0.5 text-red-400/90 hover:border-red-700/50 hover:bg-red-950/40 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-35"
                onClick={() => setMasterProfileDeleteDialogOpen(true)}
              >
                <SkullCrossbonesIcon className="h-3.5 w-3.5" />
                <span className="sr-only">Remove from master profiles</span>
              </button>
            </div>
          </div>
        ) : null}
        <Field
          label="First name"
          value={form.firstName}
          onChange={(v) => setForm((f) => ({ ...f, firstName: v }))}
          required
          upper
          compact={compact}
        />
        <Field
          label="Last name"
          value={form.lastName}
          onChange={(v) => setForm((f) => ({ ...f, lastName: v }))}
          required
          upper
          compact={compact}
        />
        <Field
          label="Nickname"
          value={form.nickname}
          onChange={(v) => setForm((f) => ({ ...f, nickname: v }))}
          upper
          compact={compact}
        />
        <div
          className={
            compact
              ? "col-span-2 grid min-w-0 grid-cols-1 gap-x-2 gap-y-1 sm:col-span-3 sm:grid-cols-2 xl:col-span-4"
              : "sm:col-span-2 grid grid-cols-1 gap-3 sm:grid-cols-[14rem_minmax(0,1fr)]"
          }
        >
          <div className={`min-w-0 ${compact ? "w-full" : "w-full"}`}>
            <label className={compact ? "block text-[11px] text-zinc-500" : "block text-zinc-500"}>
              Team
            </label>
            <select
              className={selClass}
              value={teamSelectValue}
              onChange={(e) => {
                void applyTeamSelectValue(e.target.value);
              }}
              required
            >
              {showMasterProfilePicker ? (
                <option value="" disabled>
                  SELECT TEAM
                </option>
              ) : null}
              {teamsSortedBySeed.map((t) => (
                <option key={t.id} value={`${TEAM_SEL_PREFIX_TEAM}${t.id}`}>
                  {showMasterProfilePicker ? teamOptionLabel(t.name) : `#${t.seedOrder} ${t.name}`}
                </option>
              ))}
              {!showMasterProfilePicker ? (
                <>
                  {mergedMasterTeamNames
                    .filter(
                      (n) =>
                        !teamsSortedBySeed.some(
                          (t) => t.name.trim().toUpperCase() === n,
                        ),
                    )
                    .map((n) => (
                      <option key={`mteam-${n}`} value={`${TEAM_SEL_PREFIX_NAME}${n}`}>
                        {n}
                      </option>
                    ))}
                  <option value={TEAM_SEL_NOT_LISTED}>NOT LISTED</option>
                </>
              ) : (
                <>
                  <option value={TEAM_SEL_NOT_LISTED}>NOT LISTED</option>
                </>
              )}
            </select>
          </div>
          <div className={`min-w-0 ${compact ? "w-full" : "w-full"}`}>
            <label className={compact ? "block text-[11px] text-zinc-500" : "block text-zinc-500"}>
              Academy
            </label>
            <input
              className={`mt-0.5 min-w-0 max-w-full rounded border border-zinc-600 bg-black/30 ${
                compact
                  ? "w-full px-1.5 py-0.5 text-left text-[11px]"
                  : "mt-1 w-full px-2 py-2"
              } uppercase`}
              value={form.academyName}
              onChange={(e) => {
                setAcademyManuallyEdited(true);
                setForm((f) => ({ ...f, academyName: e.target.value.toUpperCase() }));
              }}
            />
          </div>
        </div>
        {compact && showMasterProfilePicker ? (
          <div className="col-span-2 flex min-w-0 flex-wrap items-end gap-x-2 gap-y-1 sm:col-span-3 sm:flex-nowrap xl:col-span-4">
            <Field
              label="Unofficial weight"
              value={form.unofficialWeight}
              onChange={(v) =>
                setForm((f) => ({ ...f, unofficialWeight: numericWeightOnly(v) }))
              }
              className="min-w-[4ch] max-w-[8ch] flex-1"
              inputMode="numeric"
              pattern="^[0-9]{0,3}$"
              maxLength={3}
              compact={compact}
            />
            <div className="shrink-0">
              <span className="block text-[11px] text-zinc-500">Height</span>
              <div className="mt-0.5 flex flex-nowrap items-center gap-0.5">
                <select
                  className={heightSelectClass}
                  value={form.heightFeet}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, heightFeet: e.target.value }))
                  }
                  aria-label="Feet"
                >
                  <option value=""> </option>
                  {FEET_OPTS.map((ft) => (
                    <option key={ft} value={String(ft)}>
                      {ft}
                    </option>
                  ))}
                </select>
                <select
                  className={heightSelectClass}
                  value={form.heightInches}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, heightInches: e.target.value }))
                  }
                  aria-label="Inches"
                >
                  <option value=""> </option>
                  {INCH_OPTS.map((inch) => (
                    <option key={inch} value={String(inch)}>
                      {inch}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <Field
              label="Age"
              value={form.age}
              onChange={(v) => setForm((f) => ({ ...f, age: digitsOnly(v).slice(0, 3) }))}
              className="min-w-[3ch] max-w-[6ch] flex-1"
              inputMode="numeric"
              pattern="^[0-9]{0,3}$"
              maxLength={3}
              compact={compact}
            />
            <div className="flex min-w-0 flex-1 items-end gap-x-1.5">
              <div className="min-w-0 flex-[2_1_0%]">
                <label className="block text-[11px] text-zinc-500">Belt</label>
                <select
                  className={`${selClass} max-w-full`}
                  value={form.beltRank}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      beltRank: e.target.value as BeltRank,
                    }))
                  }
                >
                  {ALL_BELT_OPTIONS.map((b) => (
                    <option key={b} value={b}>
                      {BELT_COMPACT_ABBREV[b]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex shrink-0 items-center gap-1 pb-0.5">
                <button
                  type="submit"
                  disabled={saving}
                  title={editingId ? "Update player" : "Save player"}
                  className="inline-flex items-center justify-center rounded border border-amber-700/60 bg-amber-900/40 p-1 text-amber-100 hover:bg-amber-800/50 disabled:opacity-50"
                >
                  {saving ? (
                    <span className="text-[10px]">…</span>
                  ) : (
                    <SaveDiskIcon className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  title="Clear form"
                  className="inline-flex items-center justify-center rounded border border-zinc-600 p-1 text-zinc-400 hover:border-red-900/40 hover:text-red-300"
                  onClick={() => {
                    setMasterPickId("");
                    clearForm();
                  }}
                >
                  <FormTrashIcon className="h-3.5 w-3.5" />
                </button>
                {saveNotice ? (
                  <span className="max-w-[6rem] truncate text-[10px] text-emerald-300 sm:max-w-[8rem]">
                    {saveNotice}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <>
            <Field
              label="Unofficial weight"
              value={form.unofficialWeight}
              onChange={(v) =>
                setForm((f) => ({ ...f, unofficialWeight: numericWeightOnly(v) }))
              }
              className=""
              inputMode="numeric"
              pattern="^[0-9]{0,3}$"
              maxLength={3}
              compact={compact}
            />
            <div>
              <span
                className={
                  compact ? "block text-[11px] text-zinc-500" : "block text-zinc-500"
                }
              >
                Height
              </span>
              <div className="mt-0.5 flex flex-nowrap items-center gap-1">
                <select
                  className={selSmClass}
                  value={form.heightFeet}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, heightFeet: e.target.value }))
                  }
                >
                  <option value="">ft</option>
                  {FEET_OPTS.map((ft) => (
                    <option key={ft} value={String(ft)}>
                      {ft}′
                    </option>
                  ))}
                </select>
                <select
                  className={selSmClass}
                  value={form.heightInches}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, heightInches: e.target.value }))
                  }
                >
                  <option value="">in</option>
                  {INCH_OPTS.map((inch) => (
                    <option key={inch} value={String(inch)}>
                      {inch}″
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <Field
              label="Age"
              value={form.age}
              onChange={(v) => setForm((f) => ({ ...f, age: digitsOnly(v).slice(0, 2) }))}
              className=""
              inputMode="numeric"
              pattern="^[0-9]{0,2}$"
              maxLength={2}
              compact={compact}
            />
          </>
        )}
        {!compact ? (
          <>
            <div>
              <label className="block text-zinc-500">Belt</label>
              <select
                className={selClass}
                value={form.beltRank}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    beltRank: e.target.value as BeltRank,
                  }))
                }
              >
                {ALL_BELT_OPTIONS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2" />
          </>
        ) : null}

        {/* Profile photo + head shot upload controls removed (2026-04-17):
            this build does not persist image uploads. `profilePhotoUrl` /
            `headShotUrl` still exist on the player / master-profile data
            models (and the form state carries them through unchanged), so
            any legacy URLs imported from older roster files round-trip
            correctly — there's just no longer a UI to create or swap
            them. Re-add the two file-input blocks here (and restore
            `uploadImage`, `uploadingP`, `uploadingH`) if photo uploads
            come back. */}
        <div
          className={`flex flex-wrap items-center gap-2 ${
            compact ? "col-span-2 sm:col-span-3 xl:col-span-4" : "sm:col-span-2"
          }`}
        >
          {!compact ? (
            <>
              <button
                type="submit"
                disabled={saving}
                className="rounded bg-amber-600 px-4 py-2 font-medium text-black hover:bg-amber-500 disabled:opacity-50"
              >
                {saving ? "Saving…" : editingId ? "Update player" : "Save player"}
              </button>
              {saveNotice ? (
                <span className="text-sm text-emerald-300">{saveNotice}</span>
              ) : null}
            </>
          ) : null}
          {editingId ? (
            <button
              type="button"
              className={
                compact
                  ? "text-[11px] text-red-400 hover:underline"
                  : "rounded border border-red-800 px-4 py-2 text-red-300 hover:bg-red-950/50"
              }
              onClick={async () => {
                if (!confirm("Remove this player from the roster?")) return;
                await matbeastFetch(
                  `/api/players/${editingId}`,
                  mergeMasterScopeInInit({ method: "DELETE" }),
                );
                clearForm();
                await onSaved();
              }}
            >
              {compact ? "Remove" : "Delete player"}
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  className = "",
  required,
  upper,
  inputMode,
  pattern,
  maxLength,
  disabled = false,
  compact = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
  required?: boolean;
  upper?: boolean;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  pattern?: string;
  maxLength?: number;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={className}>
      <label
        className={`block text-zinc-500 ${compact ? "text-[11px]" : ""}`}
      >
        {label}
      </label>
      <input
        required={required}
        inputMode={inputMode}
        pattern={pattern}
        maxLength={maxLength}
        disabled={disabled}
        className={`mt-1 rounded border border-zinc-600 bg-black/30 ${
          compact
            ? "min-w-0 w-full max-w-full px-1.5 py-0.5 text-[11px]"
            : "w-full px-2 py-2"
        }${upper ? " uppercase" : ""}${disabled ? " cursor-not-allowed opacity-60" : ""}`}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          onChange(upper ? v.toUpperCase() : v);
        }}
      />
    </div>
  );
}
