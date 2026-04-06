"use client";

import type { BeltRank } from "@prisma/client";
import Link from "next/link";
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
  lineupOrder: number;
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
  lineupOrder: number;
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
    if (p.lineupOrder >= 1 && p.lineupOrder <= 7) {
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

async function uploadImage(file: File): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: fd });
  const j = (await res.json()) as { url?: string; error?: string };
  if (!res.ok || !j.url) {
    throw new Error(j.error ?? "Upload failed");
  }
  return j.url;
}

export function RosterClient({
  eventKind,
  title,
  subtitle,
  shellClassName,
}: {
  eventKind: RosterEventKind;
  title: string;
  subtitle: string;
  shellClassName: string;
}) {
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
    const tRes = await fetch(
      `/api/teams?eventKind=${encodeURIComponent(eventKind)}`,
    );
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
  }, [eventKind]);

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
    await fetch("/api/board", {
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
      eventKind,
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
          .sort((a, b) => a.lineupOrder - b.lineupOrder),
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
    if (obj.eventKind !== "BLUE_BELT" && obj.eventKind !== "PURPLE_BROWN") {
      throw new Error("Roster file event kind is invalid");
    }
    if (!Array.isArray(obj.teams)) {
      throw new Error("Roster file teams are invalid");
    }
    return {
      version: 1,
      app: "Mat Beast Score",
      eventKind: obj.eventKind,
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
                : 1;
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

  async function applyDocumentToCurrentRoster(doc: RosterFileDocument) {
    if (doc.eventKind !== eventKind) {
      throw new Error("This file is for the other division/event");
    }
    const seedMap = new Map<number, Team>();
    for (const team of sortedTeams) {
      seedMap.set(team.seedOrder, team);
    }
    for (const team of doc.teams) {
      if (team.seedOrder < 1 || team.seedOrder > 8) {
        throw new Error("Team seeds must be between 1 and 8");
      }
      const seenSlots = new Set<number>();
      for (const player of team.players) {
        if (!player.firstName.trim() || !player.lastName.trim()) {
          throw new Error(`Seed ${team.seedOrder} has player missing names`);
        }
        if (seenSlots.has(player.lineupOrder)) {
          throw new Error(`Seed ${team.seedOrder} has duplicate lineup slots`);
        }
        seenSlots.add(player.lineupOrder);
      }
      if (team.players.length > 7) {
        throw new Error(`Seed ${team.seedOrder} has more than 7 players`);
      }
    }

    for (const team of sortedTeams) {
      for (const p of team.players) {
        const del = await fetch(`/api/players/${p.id}`, { method: "DELETE" });
        if (!del.ok) {
          throw new Error("Failed clearing existing roster players");
        }
      }
    }

    for (const docTeam of doc.teams) {
      const team = seedMap.get(docTeam.seedOrder);
      if (!team) continue;
      const patch = await fetch(`/api/teams/${team.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: docTeam.name }),
      });
      if (!patch.ok) {
        throw new Error(`Failed updating team #${docTeam.seedOrder}`);
      }

      for (const p of docTeam.players) {
        const create = await fetch("/api/players", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
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
        });
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
      "Start a new roster? This clears the current division roster.",
    );
    if (!ok) return;
    setFileBusy(true);
    setErr(null);
    try {
      const blankDoc: RosterFileDocument = {
        version: 1,
        app: "Mat Beast Score",
        eventKind,
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
    const res = await fetch(`/api/teams/${teamId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
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
    const res = await fetch("/api/players/move-slot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...args, eventKind }),
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
    const res = await fetch(`/api/players/${playerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(flags),
    });
    if (!res.ok) {
      const j = (await res.json()) as { error?: string };
      setErr(j.error ?? "Could not update checkboxes");
      return;
    }
    await refresh();
  }

  async function postTeamReorder(orderedIds: string[]) {
    setErr(null);
    const res = await fetch("/api/tournament/reorder-teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamIds: orderedIds, eventKind }),
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

  return (
    <div className={`min-h-screen p-6 text-zinc-100 ${shellClassName}`}>
      <header className="mb-8 flex flex-wrap items-center gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-zinc-300">{subtitle}</p>
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
            Home
          </Link>
          <Link className="hover:text-white" href="/roster">
            Roster hub
          </Link>
          <Link className="hover:text-white" href="/control">
            Control
          </Link>
          <Link className="hover:text-white" href="/overlay">
            Overlay
          </Link>
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
          <section className="mb-8">
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

          <section className="mb-10 overflow-x-auto">
            <h2 className="mb-3 text-lg font-medium text-zinc-200">
              Roster grid (drag team rows to re-seed; drag a player to another slot
              or team; <strong>SEED</strong> / <strong>WEIGHED</strong> when
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
                                  <span className="select-none">SEED</span>
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
                                  <span className="select-none">WEIGHED</span>
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

          <PlayerEntryForm
            teams={sortedTeams}
            defaultBelt={defaultBelt}
            onSaved={() => refresh()}
          />
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

function PlayerEntryForm({
  teams,
  defaultBelt,
  onSaved,
}: {
  teams: Team[];
  defaultBelt: BeltRank;
  onSaved: () => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    teamId: "",
    firstName: "",
    lastName: "",
    nickname: "",
    academyName: "",
    unofficialWeight: "",
    officialWeight: "",
    heightFeet: "",
    heightInches: "",
    age: "",
    beltRank: defaultBelt,
    profilePhotoUrl: "",
    headShotUrl: "",
    lineupOrder: "1",
    lineupConfirmed: false,
    weighedConfirmed: false,
  });
  const [formErr, setFormErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingP, setUploadingP] = useState(false);
  const [uploadingH, setUploadingH] = useState(false);

  const allPlayers = useMemo(
    () => teams.flatMap((t) => t.players),
    [teams],
  );

  function loadPlayer(p: Player) {
    setEditingId(p.id);
    setForm({
      teamId: p.teamId,
      firstName: p.firstName,
      lastName: p.lastName,
      nickname: p.nickname ?? "",
      academyName: p.academyName ?? "",
      unofficialWeight: p.unofficialWeight?.toString() ?? "",
      officialWeight: p.officialWeight?.toString() ?? "",
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
      lineupOrder: String(p.lineupOrder),
      lineupConfirmed: p.lineupConfirmed ?? false,
      weighedConfirmed: p.weighedConfirmed ?? false,
    });
    setFormErr(null);
  }

  function clearForm() {
    setEditingId(null);
    setForm({
      teamId: teams[0]?.id ?? "",
      firstName: "",
      lastName: "",
      nickname: "",
      academyName: "",
      unofficialWeight: "",
      officialWeight: "",
      heightFeet: "",
      heightInches: "",
      age: "",
      beltRank: defaultBelt,
      profilePhotoUrl: "",
      headShotUrl: "",
      lineupOrder: "1",
      lineupConfirmed: false,
      weighedConfirmed: false,
    });
    setFormErr(null);
  }

  useEffect(() => {
    if (!form.teamId && teams[0]) {
      setForm((f) => ({ ...f, teamId: teams[0].id }));
    }
  }, [teams, form.teamId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormErr(null);
    setSaving(true);
    const lineupOrder = Number(form.lineupOrder);
    if (lineupOrder < 1 || lineupOrder > 7) {
      setFormErr("Seed must be 1–7 (6–7 = alternates)");
      setSaving(false);
      return;
    }

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

    const payload = {
      teamId: form.teamId,
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      nickname: form.nickname.trim() || null,
      academyName: form.academyName.trim() || null,
      unofficialWeight: form.unofficialWeight
        ? Number(form.unofficialWeight)
        : null,
      officialWeight: form.officialWeight ? Number(form.officialWeight) : null,
      heightFeet: hf,
      heightInches: hi,
      age: form.age ? Number(form.age) : null,
      beltRank: form.beltRank,
      profilePhotoUrl: form.profilePhotoUrl.trim() || null,
      headShotUrl: form.headShotUrl.trim() || null,
      lineupOrder,
      lineupConfirmed: form.lineupConfirmed,
      weighedConfirmed: form.weighedConfirmed,
    };

    try {
      if (editingId) {
        const res = await fetch(`/api/players/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const j = (await res.json()) as { error?: string };
          throw new Error(j.error ?? "Save failed");
        }
      } else {
        const res = await fetch("/api/players", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const j = (await res.json()) as { error?: string };
          throw new Error(j.error ?? "Create failed");
        }
      }
      await onSaved();
      if (!editingId) clearForm();
    } catch (er) {
      setFormErr(er instanceof Error ? er.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="max-w-4xl">
      <h2 className="mb-3 text-lg font-medium text-zinc-200">
        Player profile
      </h2>
      <p className="mb-4 text-sm text-zinc-400">
        Text fields save as <strong>ALL CAPS</strong>. Belt may be{" "}
        <strong>WHITE, BLUE, PURPLE, BROWN, or BLACK</strong>. Seeds{" "}
        <strong>6–7</strong> are alternates (shown as <strong>ALT</strong> in the
        grid). Upload photos below; URLs are stored in the database.
      </p>

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
              const ta = teams.find((t) => t.id === a.teamId)?.name ?? "";
              const tb = teams.find((t) => t.id === b.teamId)?.name ?? "";
              return ta.localeCompare(tb) || a.lineupOrder - b.lineupOrder;
            })
            .map((p) => (
              <option key={p.id} value={p.id}>
                {teams.find((t) => t.id === p.teamId)?.name ?? "?"} · S
                {p.lineupOrder} {listLabel(p)}
              </option>
            ))}
        </select>
        {editingId && (
          <button
            type="button"
            className="rounded border border-zinc-500 px-3 py-2 text-sm hover:bg-black/30"
            onClick={clearForm}
          >
            Clear (new player)
          </button>
        )}
      </div>

      {formErr && (
        <p className="mb-3 text-sm text-red-300">{formErr}</p>
      )}

      <form
        onSubmit={submit}
        className="grid gap-3 text-sm sm:grid-cols-2"
      >
        <div className="sm:col-span-2">
          <label className="block text-zinc-500">Team</label>
          <select
            className="mt-1 w-full rounded border border-zinc-600 bg-black/30 px-2 py-2"
            value={form.teamId}
            onChange={(e) =>
              setForm((f) => ({ ...f, teamId: e.target.value }))
            }
            required
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                #{t.seedOrder} {t.name}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="First name"
          value={form.firstName}
          onChange={(v) => setForm((f) => ({ ...f, firstName: v }))}
          required
          upper
        />
        <Field
          label="Last name"
          value={form.lastName}
          onChange={(v) => setForm((f) => ({ ...f, lastName: v }))}
          required
          upper
        />
        <Field
          label="Nickname (not shown on roster grid)"
          value={form.nickname}
          onChange={(v) => setForm((f) => ({ ...f, nickname: v }))}
          upper
        />
        <Field
          label="Academy (info)"
          value={form.academyName}
          onChange={(v) => setForm((f) => ({ ...f, academyName: v }))}
          upper
        />
        <Field
          label="Unofficial weight"
          value={form.unofficialWeight}
          onChange={(v) =>
            setForm((f) => ({ ...f, unofficialWeight: v }))
          }
        />
        <Field
          label="Official weight"
          value={form.officialWeight}
          onChange={(v) => setForm((f) => ({ ...f, officialWeight: v }))}
        />
        <div>
          <span className="block text-zinc-500">Height</span>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <select
              className="rounded border border-zinc-600 bg-black/30 px-2 py-2"
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
              className="rounded border border-zinc-600 bg-black/30 px-2 py-2"
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
          onChange={(v) => setForm((f) => ({ ...f, age: v }))}
        />
        <div>
          <label className="block text-zinc-500">Belt</label>
          <select
            className="mt-1 w-full rounded border border-zinc-600 bg-black/30 px-2 py-2"
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
        <div>
          <label className="block text-zinc-500">
            Seed / lineup (1–5 primary, 6–7 ALT)
          </label>
          <input
            type="number"
            min={1}
            max={7}
            required
            className="mt-1 w-full rounded border border-zinc-600 bg-black/30 px-2 py-2"
            value={form.lineupOrder}
            onChange={(e) =>
              setForm((f) => ({ ...f, lineupOrder: e.target.value }))
            }
          />
        </div>

        <div className="sm:col-span-2 flex flex-wrap gap-4">
          <label
            className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-zinc-300 ${
              form.lineupConfirmed ? "bg-emerald-600/70" : "bg-zinc-800/60"
            }`}
          >
            <input
              type="checkbox"
              checked={form.lineupConfirmed}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  lineupConfirmed: e.target.checked,
                }))
              }
              className="accent-emerald-300"
            />
            <span>
              <strong>SEED</strong> — lineup order confirmed
            </span>
          </label>
          <label
            className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-zinc-300 ${
              form.weighedConfirmed ? "bg-emerald-600/70" : "bg-zinc-800/60"
            }`}
          >
            <input
              type="checkbox"
              checked={form.weighedConfirmed}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  weighedConfirmed: e.target.checked,
                }))
              }
              className="accent-emerald-300"
            />
            <span>
              <strong>WEIGHED</strong> — weigh-in confirmed
            </span>
          </label>
        </div>

        <div className="sm:col-span-2">
          <label className="block text-zinc-500">Profile photo</label>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              disabled={uploadingP}
              className="max-w-full text-xs file:mr-2 file:rounded file:border file:border-zinc-600 file:bg-zinc-800 file:px-2 file:py-1"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setUploadingP(true);
                setFormErr(null);
                try {
                  const url = await uploadImage(file);
                  setForm((f) => ({ ...f, profilePhotoUrl: url }));
                } catch (er) {
                  setFormErr(
                    er instanceof Error ? er.message : "Profile upload failed",
                  );
                } finally {
                  setUploadingP(false);
                  e.target.value = "";
                }
              }}
            />
            {uploadingP && (
              <span className="text-xs text-zinc-500">Uploading…</span>
            )}
          </div>
          {form.profilePhotoUrl ? (
            <div className="mt-2 flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={form.profilePhotoUrl}
                alt=""
                className="h-16 w-16 rounded border border-zinc-600 object-cover"
              />
              <button
                type="button"
                className="text-xs text-red-400 hover:underline"
                onClick={() =>
                  setForm((f) => ({ ...f, profilePhotoUrl: "" }))
                }
              >
                Remove
              </button>
            </div>
          ) : null}
        </div>

        <div className="sm:col-span-2">
          <label className="block text-zinc-500">Head shot</label>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              disabled={uploadingH}
              className="max-w-full text-xs file:mr-2 file:rounded file:border file:border-zinc-600 file:bg-zinc-800 file:px-2 file:py-1"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setUploadingH(true);
                setFormErr(null);
                try {
                  const url = await uploadImage(file);
                  setForm((f) => ({ ...f, headShotUrl: url }));
                } catch (er) {
                  setFormErr(
                    er instanceof Error ? er.message : "Head shot upload failed",
                  );
                } finally {
                  setUploadingH(false);
                  e.target.value = "";
                }
              }}
            />
            {uploadingH && (
              <span className="text-xs text-zinc-500">Uploading…</span>
            )}
          </div>
          {form.headShotUrl ? (
            <div className="mt-2 flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={form.headShotUrl}
                alt=""
                className="h-16 w-16 rounded border border-zinc-600 object-cover"
              />
              <button
                type="button"
                className="text-xs text-red-400 hover:underline"
                onClick={() => setForm((f) => ({ ...f, headShotUrl: "" }))}
              >
                Remove
              </button>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-amber-600 px-4 py-2 font-medium text-black hover:bg-amber-500 disabled:opacity-50"
          >
            {saving ? "Saving…" : editingId ? "Update player" : "Save player"}
          </button>
          {editingId && (
            <button
              type="button"
              className="rounded border border-red-800 px-4 py-2 text-red-300 hover:bg-red-950/50"
              onClick={async () => {
                if (!confirm("Remove this player from the roster?")) return;
                await fetch(`/api/players/${editingId}`, { method: "DELETE" });
                clearForm();
                await onSaved();
              }}
            >
              Delete player
            </button>
          )}
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
  required?: boolean;
  upper?: boolean;
}) {
  return (
    <div className={className}>
      <label className="block text-zinc-500">{label}</label>
      <input
        required={required}
        className={`mt-1 w-full rounded border border-zinc-600 bg-black/30 px-2 py-2${
          upper ? " uppercase" : ""
        }`}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          onChange(upper ? v.toUpperCase() : v);
        }}
      />
    </div>
  );
}
