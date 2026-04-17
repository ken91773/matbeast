"use client";

import { useEventWorkspace } from "@/components/EventWorkspaceProvider";
import { MATBEAST_TOURNAMENT_HEADER, matbeastFetch } from "@/lib/matbeast-fetch";
import { matbeastKeys } from "@/lib/matbeast-query-keys";
import { matbeastJson } from "@/lib/matbeast-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  type BracketMatchJson,
  type BracketPayload,
  type BracketTeamRef as TeamRef,
  buildBracketProjection,
  isTbdTeamRef,
  normalizeBracketPayload,
  teamLabel,
} from "@/lib/bracket-display";
import { postOverlayBracketCurrentMatch } from "@/lib/overlay-output-broadcast";
import { pickTextOnBackground } from "@/lib/bracket-overlay-model";

export type { BracketMatchJson } from "@/lib/bracket-display";

type TeamRefWithOverlay = TeamRef & { overlayColor?: string | null };

/** Single shared BYE row in edit dropdowns; resolves to a real TBD team id on save. */
const BYE_SELECT_VALUE = "__MATBEAST_BYE__";

type BracketOptionRow = { value: string; label: string };

function bracketDropdownRows(teamOptions: TeamRef[]): BracketOptionRow[] {
  const named = teamOptions
    .filter((t) => !isTbdTeamRef(t))
    .sort((a, b) => a.seedOrder - b.seedOrder);
  const byes = teamOptions
    .filter(isTbdTeamRef)
    .sort((a, b) => a.seedOrder - b.seedOrder);
  const rows: BracketOptionRow[] = [];
  if (byes.length > 0) {
    rows.push({ value: BYE_SELECT_VALUE, label: "BYE" });
  }
  for (const t of named) {
    const n = (t.name || "").trim();
    rows.push({ value: t.id, label: `#${t.seedOrder} ${n}` });
  }
  return rows;
}

function resolveBracketMatchTeamIds(
  homePick: string,
  awayPick: string,
  m: BracketMatchJson,
  teamOptions: TeamRef[],
): { homeTeamId: string; awayTeamId: string } {
  const byes = teamOptions
    .filter(isTbdTeamRef)
    .sort((a, b) => a.seedOrder - b.seedOrder);
  if (byes.length === 0) {
    if (homePick === BYE_SELECT_VALUE || awayPick === BYE_SELECT_VALUE) {
      throw new Error("No BYE teams in roster");
    }
    return { homeTeamId: homePick, awayTeamId: awayPick };
  }

  const resolveSide = (
    raw: string,
    otherFixed: string | undefined,
    current: TeamRef,
  ): string => {
    if (raw !== BYE_SELECT_VALUE) return raw;
    if (isTbdTeamRef(current) && (!otherFixed || current.id !== otherFixed)) {
      return current.id;
    }
    const alt = byes.find((b) => b.id !== otherFixed);
    if (!alt) {
      throw new Error("Need two distinct teams for this match");
    }
    return alt.id;
  };

  if (homePick !== BYE_SELECT_VALUE && awayPick !== BYE_SELECT_VALUE) {
    return { homeTeamId: homePick, awayTeamId: awayPick };
  }
  if (homePick === BYE_SELECT_VALUE && awayPick === BYE_SELECT_VALUE) {
    const h = resolveSide(BYE_SELECT_VALUE, undefined, m.homeTeam);
    let a = resolveSide(BYE_SELECT_VALUE, h, m.awayTeam);
    if (h === a) {
      const second = byes.find((b) => b.id !== h);
      if (!second) {
        throw new Error("Need two distinct BYE slots for this match");
      }
      a = second.id;
    }
    return { homeTeamId: h, awayTeamId: a };
  }
  if (homePick === BYE_SELECT_VALUE) {
    const awayId = awayPick;
    const homeId = resolveSide(BYE_SELECT_VALUE, awayId, m.homeTeam);
    if (homeId === awayId) {
      throw new Error("Home and away must be different");
    }
    return { homeTeamId: homeId, awayTeamId: awayId };
  }
  const homeId = homePick;
  const awayId = resolveSide(BYE_SELECT_VALUE, homeId, m.awayTeam);
  if (homeId === awayId) {
    throw new Error("Home and away must be different");
  }
  return { homeTeamId: homeId, awayTeamId: awayId };
}

function TeamEditIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="m3 17.25 9.06-9.06 3.75 3.75L6.75 21H3v-3.75ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.84 1.84 3.75 3.75 1.84-1.84Z" />
    </svg>
  );
}

function ChampionColumn({
  grandFinal,
  tvActive,
  onTvToggle,
  teamOverlayColor,
}: {
  grandFinal: BracketMatchJson | null;
  tvActive: boolean;
  onTvToggle: () => void;
  teamOverlayColor?: (teamId: string) => string | null;
}) {
  const winner = grandFinal?.winnerTeam;
  const picked =
    Boolean(grandFinal?.winnerTeamId) &&
    winner &&
    (winner.name || "").trim().toUpperCase() !== "TBD";
  const champHex =
    picked && winner && teamOverlayColor
      ? teamOverlayColor(winner.id)?.trim() || null
      : null;

  return (
    <div className="flex min-h-0 min-w-[9.45rem] flex-1 flex-col pl-5">
      <div className="mb-3 shrink-0 flex items-center justify-center gap-2">
        <p className="text-center text-[11px] font-bold uppercase tracking-widest text-zinc-500">
          Champion
        </p>
        <button
          type="button"
          disabled={!picked}
          onClick={onTvToggle}
          className={[
            "inline-flex h-5 w-5 items-center justify-center rounded border transition",
            picked
              ? "border-zinc-600 text-white hover:border-zinc-400"
              : "cursor-not-allowed border-zinc-700 text-zinc-500 opacity-50",
            tvActive ? "border-amber-600 bg-amber-600 text-black" : "",
          ].join(" ")}
          title={
            picked
              ? "Send champion column to overlay"
              : "Select grand final winner to enable champion overlay selection"
          }
        >
          <span className="text-[9px] font-extrabold leading-none tracking-tight">VS</span>
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-center">
        {!grandFinal ? (
          <div className="flex w-full min-w-0 flex-col items-stretch gap-1">
            <div className="w-full rounded-lg border border-zinc-700 bg-zinc-900/80 px-2 py-1.5 text-center">
              <p className="min-h-3 text-[11px] font-bold leading-tight tracking-tight text-zinc-200">
                {" "}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex w-full min-w-0 flex-col items-stretch gap-1">
            <div
              className={
                picked
                  ? champHex
                    ? "w-full rounded-lg border-2 border-amber-400/90 px-2 py-1.5 text-center shadow-[0_0_22px_rgba(234,179,8,0.22),inset_0_1px_0_rgba(255,255,255,0.14)] ring-1 ring-amber-300/40"
                    : "w-full rounded-lg border-2 border-amber-400/90 bg-gradient-to-b from-amber-950/55 via-zinc-950/90 to-zinc-950 px-2 py-1.5 text-center shadow-[0_0_22px_rgba(234,179,8,0.22),inset_0_1px_0_rgba(255,255,255,0.14),inset_0_0_24px_rgba(251,191,36,0.07)] ring-1 ring-amber-300/40"
                  : "w-full rounded-lg border border-zinc-700 bg-zinc-900/80 px-2 py-1.5 text-center"
              }
              style={picked && champHex ? { backgroundColor: champHex } : undefined}
            >
              <p
                className={`min-h-3 text-[11px] font-bold leading-tight tracking-tight ${
                  picked ? (champHex ? "" : "text-amber-50") : "text-zinc-200"
                }`}
                style={
                  picked && champHex
                    ? { color: pickTextOnBackground(champHex) }
                    : undefined
                }
              >
                {picked && winner ? teamLabel(winner, true) : " "}
              </p>
            </div>
            {picked ? (
              <p className="px-1 text-center text-[13px] font-extrabold uppercase leading-tight tracking-wide text-amber-100">
                CHAMPION
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function MatchCard({
  m,
  onPickWinner,
  busy,
  tealAccent,
  teamOptions,
  onEditTeams,
  isSelected,
  onSelect,
  hideTbdNames = false,
  placeholder = false,
  tvActive = false,
  tvClickable = false,
  onTvToggle,
  teamOverlayColor,
}: {
  m: BracketMatchJson;
  onPickWinner: (matchId: string, teamId: string | null) => void;
  onEditTeams: (
    matchId: string,
    homeTeamId: string,
    awayTeamId: string,
  ) => Promise<void>;
  teamOptions: TeamRef[];
  busy: boolean;
  tealAccent?: boolean;
  isSelected: boolean;
  onSelect: (matchId: string | null) => void;
  hideTbdNames?: boolean;
  placeholder?: boolean;
  tvActive?: boolean;
  tvClickable?: boolean;
  onTvToggle?: () => void;
  /** Roster `overlayColor` hex for each team id (dashboard bracket swatches). */
  teamOverlayColor?: (teamId: string) => string | null;
}) {
  const [editingTeams, setEditingTeams] = useState(false);
  const [homePick, setHomePick] = useState(
    isTbdTeamRef(m.homeTeam) ? BYE_SELECT_VALUE : m.homeTeam.id,
  );
  const [awayPick, setAwayPick] = useState(
    isTbdTeamRef(m.awayTeam) ? BYE_SELECT_VALUE : m.awayTeam.id,
  );
  const canSaveTeams = useMemo(() => {
    try {
      const resolved = resolveBracketMatchTeamIds(homePick, awayPick, m, teamOptions);
      return resolved.homeTeamId !== resolved.awayTeamId;
    } catch {
      return false;
    }
  }, [homePick, awayPick, m, teamOptions]);

  useEffect(() => {
    if (editingTeams) return;
    setHomePick(isTbdTeamRef(m.homeTeam) ? BYE_SELECT_VALUE : m.homeTeam.id);
    setAwayPick(isTbdTeamRef(m.awayTeam) ? BYE_SELECT_VALUE : m.awayTeam.id);
  }, [m.homeTeam, m.awayTeam, editingTeams]);
  const dropdownRows = bracketDropdownRows(teamOptions);
  const homeWon = m.winnerTeamId === m.homeTeam.id;
  const awayWon = m.winnerTeamId === m.awayTeam.id;
  const win = tealAccent
    ? "border-emerald-400 text-white"
    : "border-emerald-500 text-white";

  const homeHex = teamOverlayColor?.(m.homeTeam.id) ?? null;
  const awayHex = teamOverlayColor?.(m.awayTeam.id) ?? null;

  function handleCardBorderClick(e: MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const borderPx = 10;
    const w = r.width;
    const h = r.height;
    const onBorder =
      x < borderPx || x > w - borderPx || y < borderPx || y > h - borderPx;
    if (!onBorder) return;
    onSelect(isSelected ? null : m.id);
  }

  return (
    <div
      title="Click the card edge to set the current match (shown on the bracket overlay)"
      className={[
        "w-full min-w-0 rounded-md border px-1.5 py-1 shadow-inner transition",
        isSelected
          ? "border-amber-400/90 bg-amber-400/10 ring-1 ring-amber-300/60"
          : "border-zinc-600/90 bg-[#1e1e1e]",
      ].join(" ")}
      onClick={handleCardBorderClick}
    >
      <div className="flex flex-col gap-0.5">
        {editingTeams ? (
          <div className="mb-1 rounded border border-zinc-700/80 bg-zinc-900/50 p-1.5">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Edit match teams</div>
            <div className="grid grid-cols-1 gap-1.5">
            <select
              className="rounded border border-zinc-700 bg-zinc-900/80 px-1.5 py-0.5 text-[11px] text-zinc-100"
              value={homePick}
              onChange={(e) => setHomePick(e.target.value)}
            >
              {dropdownRows.map((row) => (
                <option key={`home-${m.id}-${row.value}`} value={row.value}>
                  {row.label}
                </option>
              ))}
            </select>
            <select
              className="rounded border border-zinc-700 bg-zinc-900/80 px-1.5 py-0.5 text-[11px] text-zinc-100"
              value={awayPick}
              onChange={(e) => setAwayPick(e.target.value)}
            >
              {dropdownRows.map((row) => (
                <option key={`away-${m.id}-${row.value}`} value={row.value}>
                  {row.label}
                </option>
              ))}
            </select>
              <div className="mt-0.5 flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={!canSaveTeams || busy}
                  onClick={async () => {
                    if (!canSaveTeams || busy) return;
                    try {
                      const { homeTeamId, awayTeamId } =
                        resolveBracketMatchTeamIds(
                          homePick,
                          awayPick,
                          m,
                          teamOptions,
                        );
                      await onEditTeams(m.id, homeTeamId, awayTeamId);
                      setEditingTeams(false);
                    } catch (e) {
                      window.alert(
                        e instanceof Error ? e.message : "Invalid team selection",
                      );
                    }
                  }}
                  className="rounded border border-teal-700/50 bg-teal-900/30 px-1.5 py-0.5 text-[11px] text-teal-100 disabled:opacity-40"
                >
                  Apply
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setHomePick(
                      isTbdTeamRef(m.homeTeam) ? BYE_SELECT_VALUE : m.homeTeam.id,
                    );
                    setAwayPick(
                      isTbdTeamRef(m.awayTeam) ? BYE_SELECT_VALUE : m.awayTeam.id,
                    );
                    setEditingTeams(false);
                  }}
                  className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800/70 disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {!editingTeams ? (
          <>
            <div className="flex min-h-0 items-stretch gap-1">
              <button
                type="button"
                disabled={busy || placeholder}
                onClick={() => !placeholder && onPickWinner(m.id, homeWon ? null : m.homeTeam.id)}
                className={[
                  "min-h-6 min-w-0 flex-1 rounded border px-1 py-0.5 text-left text-[11px] font-medium leading-tight transition",
                  homeWon
                    ? win
                    : homeHex
                      ? "border-zinc-900/60 hover:border-zinc-600"
                      : "border-zinc-700 bg-zinc-900/80 text-zinc-200 hover:border-zinc-500",
                ].join(" ")}
                style={
                  homeHex
                    ? { backgroundColor: homeHex, color: pickTextOnBackground(homeHex) }
                    : homeWon
                      ? { backgroundColor: "rgba(24,24,27,0.8)" }
                    : undefined
                }
              >
                {teamLabel(m.homeTeam, hideTbdNames)}
              </button>
              <button
                type="button"
                disabled={!tvClickable}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!tvClickable || !onTvToggle) return;
                  onTvToggle();
                }}
                className={[
                  "inline-flex w-7 shrink-0 items-center justify-center self-stretch rounded border p-0.5 transition",
                  tvClickable
                    ? "border-zinc-700 text-white hover:border-zinc-500"
                    : "cursor-default border-zinc-700 text-zinc-500",
                  tvActive ? "border-amber-600 bg-amber-600 text-black" : "",
                ].join(" ")}
                title="Choose which bracket group is sent to the overlay"
              >
                <span className="text-[9px] font-extrabold leading-none tracking-tight">VS</span>
              </button>
            </div>
            <div className="flex min-h-0 items-stretch gap-1">
              <button
                type="button"
                disabled={busy || placeholder}
                onClick={() => !placeholder && onPickWinner(m.id, awayWon ? null : m.awayTeam.id)}
                className={[
                  "min-h-6 min-w-0 flex-1 rounded border px-1 py-0.5 text-left text-[11px] font-medium leading-tight transition",
                  awayWon
                    ? win
                    : awayHex
                      ? "border-zinc-900/60 hover:border-zinc-600"
                      : "border-zinc-700 bg-zinc-900/80 text-zinc-200 hover:border-zinc-500",
                ].join(" ")}
                style={
                  awayHex
                    ? { backgroundColor: awayHex, color: pickTextOnBackground(awayHex) }
                    : awayWon
                      ? { backgroundColor: "rgba(24,24,27,0.8)" }
                    : undefined
                }
              >
                {teamLabel(m.awayTeam, hideTbdNames)}
              </button>
              <button
                type="button"
                disabled={busy || placeholder}
                title="Edit teams"
                onClick={() => {
                  if (placeholder) return;
                  setHomePick(
                    isTbdTeamRef(m.homeTeam) ? BYE_SELECT_VALUE : m.homeTeam.id,
                  );
                  setAwayPick(
                    isTbdTeamRef(m.awayTeam) ? BYE_SELECT_VALUE : m.awayTeam.id,
                  );
                  setEditingTeams(true);
                }}
                className="inline-flex w-7 shrink-0 items-center justify-center self-stretch rounded border border-zinc-700 p-0.5 text-zinc-400 hover:border-zinc-500 hover:text-zinc-100"
              >
                <TeamEditIcon className="h-2.5 w-2.5" />
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default function BracketPanel({ embed = false }: { embed?: boolean }) {
  const queryClient = useQueryClient();
  const { tournamentId, ready } = useEventWorkspace();
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [tvGroupKey, setTvGroupKey] = useState<string | null>(null);

  const { data: teamsPayload } = useQuery({
    queryKey: matbeastKeys.teams(tournamentId),
    queryFn: () =>
      matbeastJson<{ teams: TeamRefWithOverlay[] }>("/api/teams", {
        headers: { [MATBEAST_TOURNAMENT_HEADER]: tournamentId! },
      }),
    enabled: ready && !!tournamentId,
  });
  const teamOptions = (teamsPayload?.teams ?? []).slice().sort((a, b) => a.seedOrder - b.seedOrder);

  const teamOverlayColor = useCallback((teamId: string) => {
    const row = teamOptions.find((t) => t.id === teamId);
    const c = (row as TeamRefWithOverlay | undefined)?.overlayColor?.trim();
    return c && c.length > 0 ? c : null;
  }, [teamOptions]);

  const {
    data: dataRaw,
    isLoading: loading,
    error: loadError,
  } = useQuery({
    queryKey: matbeastKeys.bracket(tournamentId),
    queryFn: async () => {
      const res = await matbeastFetch("/api/bracket", { cache: "no-store" });
      const j = (await res.json()) as BracketPayload & { error?: string };
      if (!res.ok) {
        throw new Error(j.error ?? "Could not load bracket");
      }
      return normalizeBracketPayload(j);
    },
    enabled: ready && !!tournamentId,
  });

  const data = dataRaw ?? null;

  useEffect(() => {
    if (!data) {
      setSelectedMatchId(null);
      return;
    }
    const ids = new Set([
      ...data.quarterFinals.map((m) => m.id),
      ...data.semiFinals.map((m) => m.id),
      ...(data.grandFinal ? [data.grandFinal.id] : []),
    ]);
    if (!selectedMatchId || ids.has(selectedMatchId)) return;
    setSelectedMatchId(null);
  }, [data, selectedMatchId]);

  const genMutation = useMutation({
    mutationFn: async () => {
      const res = await matbeastFetch("/api/bracket/generate", {
        method: "POST",
      });
      const j = (await res.json()) as BracketPayload & { error?: string };
      if (!res.ok) {
        throw new Error(j.error ?? "Generate failed");
      }
      return normalizeBracketPayload(j);
    },
    onSuccess: (payload) => {
      queryClient.setQueryData(matbeastKeys.bracket(tournamentId), payload);
    },
  });

  const pickMutation = useMutation({
    mutationFn: async ({
      matchId,
      winnerTeamId,
    }: {
      matchId: string;
      winnerTeamId: string | null;
    }) => {
      const res = await matbeastFetch(`/api/bracket/matches/${matchId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ winnerTeamId }),
      });
      const j = (await res.json()) as BracketPayload & { error?: string };
      if (!res.ok) {
        throw new Error(j.error ?? "Could not update match");
      }
      return normalizeBracketPayload(j);
    },
    onSuccess: (payload) => {
      queryClient.setQueryData(matbeastKeys.bracket(tournamentId), payload);
      void queryClient.invalidateQueries({
        queryKey: matbeastKeys.board(tournamentId),
      });
    },
  });
  const editTeamsMutation = useMutation({
    mutationFn: async ({
      matchId,
      homeTeamId,
      awayTeamId,
    }: {
      matchId: string;
      homeTeamId: string;
      awayTeamId: string;
    }) => {
      const res = await matbeastFetch(`/api/bracket/matches/${matchId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ homeTeamId, awayTeamId }),
      });
      const j = (await res.json()) as BracketPayload & { error?: string };
      if (!res.ok) {
        throw new Error(j.error ?? "Could not update match teams");
      }
      return normalizeBracketPayload(j);
    },
    onSuccess: (payload) => {
      queryClient.setQueryData(matbeastKeys.bracket(tournamentId), payload);
    },
  });

  const busy = genMutation.isPending || pickMutation.isPending || editTeamsMutation.isPending;
  const err =
    (loadError instanceof Error ? loadError.message : null) ||
    (genMutation.error instanceof Error ? genMutation.error.message : null) ||
    (pickMutation.error instanceof Error ? pickMutation.error.message : null) ||
    (editTeamsMutation.error instanceof Error ? editTeamsMutation.error.message : null);

  const generate = useCallback(async () => {
    if (
      !window.confirm(
        "Build quarter-finals from current seeds (1v8, 4v5, 3v6, 2v7)? This replaces any existing bracket for this event.",
      )
    ) {
      return;
    }
    try {
      await genMutation.mutateAsync();
    } catch {
      /* surfaced via err */
    }
  }, [genMutation]);

  useEffect(() => {
    const onGenerate = (e: Event) => {
      const detail = (e as CustomEvent<{ tournamentId?: string | null }>).detail;
      if (!detail?.tournamentId || detail.tournamentId !== tournamentId) return;
      void generate();
    };
    window.addEventListener("matbeast-bracket-generate", onGenerate);
    return () => window.removeEventListener("matbeast-bracket-generate", onGenerate);
  }, [tournamentId, generate]);

  async function pickWinner(matchId: string, winnerTeamId: string | null) {
    try {
      await pickMutation.mutateAsync({ matchId, winnerTeamId });
    } catch {
      /* surfaced via err */
    }
  }
  async function editTeams(
    matchId: string,
    homeTeamId: string,
    awayTeamId: string,
  ): Promise<void> {
    await editTeamsMutation.mutateAsync({ matchId, homeTeamId, awayTeamId });
  }

  const { quarterSlots, semiSlots, grandFinalSlot, showQuarterFinalsColumn } = useMemo(
    () => buildBracketProjection(data, teamOptions),
    [data, teamOptions],
  );
  const selectedMatch = useMemo(() => {
    if (!data || !selectedMatchId) return null;
    const allMatches = [
      ...data.quarterFinals,
      ...data.semiFinals,
      ...(data.grandFinal ? [data.grandFinal] : []),
    ];
    return allMatches.find((m) => m.id === selectedMatchId) ?? null;
  }, [data, selectedMatchId]);

  useEffect(() => {
    const teamIds = selectedMatch
      ? Array.from(new Set([selectedMatch.homeTeam.id, selectedMatch.awayTeam.id]))
      : null;
    const matchId = selectedMatch?.id ?? null;
    postOverlayBracketCurrentMatch(tournamentId ?? null, matchId);
    window.dispatchEvent(
      new CustomEvent("matbeast-bracket-selection", {
        detail: { tournamentId, teamIds, matchId },
      }),
    );
    return () => {
      postOverlayBracketCurrentMatch(null, null);
      window.dispatchEvent(
        new CustomEvent("matbeast-bracket-selection", {
          detail: { tournamentId, teamIds: null, matchId: null },
        }),
      );
    };
  }, [selectedMatch, tournamentId]);

  const toggleTvGroup = useCallback((key: string) => {
    setTvGroupKey((prev) => (prev === key ? null : key));
  }, []);
  const activeSemiIndex =
    tvGroupKey?.startsWith("semi:") ? Number(tvGroupKey.split(":")[1]) : null;
  const isGrandGroup = tvGroupKey === "grand";
  const isChampionGroup = tvGroupKey === "champion";
  const quarterTvActive = (idx: number) =>
    activeSemiIndex === 0 ? idx === 0 || idx === 1 : activeSemiIndex === 1 ? idx === 2 || idx === 3 : false;
  const semiTvActive = (idx: number) =>
    activeSemiIndex === idx || isGrandGroup;
  const grandTvActive = isGrandGroup;
  const championTvActive = isChampionGroup;

  const shell = embed
    ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-x-auto overflow-y-auto p-3"
    : "scroll-mt-24 rounded-lg border border-zinc-700/80 bg-[#2a2a2a] p-5 shadow-lg";

  return (
    <section id="brackets" className={shell}>
      {err ? (
        <p className="mt-2 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {err}
        </p>
      ) : null}

      {loading ? (
        <p className="mt-6 text-sm text-zinc-500">Loading bracket…</p>
      ) : (
        <div className="mt-1 w-full min-w-0 overflow-x-auto overflow-y-visible pb-2 [scrollbar-gutter:stable]">
          <div className="relative flex min-w-[810px] items-stretch gap-0">
            <div className="relative z-10 flex min-w-[810px] items-stretch gap-0">
            {showQuarterFinalsColumn ? (
              <>
                {/* Quarter-finals */}
                <div className="flex min-w-0 flex-1 flex-col pr-5">
                  <p className="mb-2 shrink-0 text-center text-[11px] font-bold uppercase tracking-widest text-zinc-500">
                    Quarter-finals
                  </p>
                  <div className="flex min-h-0 flex-1 flex-col justify-evenly gap-1">
                    {quarterSlots.map((m) => (
                      <MatchCard
                        key={m.id}
                        m={m}
                        onPickWinner={pickWinner}
                        onEditTeams={editTeams}
                        teamOptions={teamOptions}
                        busy={busy}
                        tealAccent={embed}
                        isSelected={selectedMatchId === m.id}
                        onSelect={setSelectedMatchId}
                        tvActive={quarterTvActive(m.bracketIndex)}
                        tvClickable={false}
                        hideTbdNames
                        placeholder={m.id.startsWith("quarter-placeholder-")}
                        teamOverlayColor={teamOverlayColor}
                      />
                    ))}
                  </div>
                </div>

                <div
                  className="w-px shrink-0 bg-gradient-to-b from-transparent via-zinc-600 to-transparent"
                  aria-hidden
                />
              </>
            ) : null}

            {/* Semi-finals */}
            <div className="flex flex-1 flex-col px-5">
              <p className="mb-2 shrink-0 text-center text-[11px] font-bold uppercase tracking-widest text-zinc-500">
                Semi-finals
              </p>
              <div className="flex min-h-0 flex-1 flex-col justify-evenly gap-1">
                {semiSlots.map((m) => (
                  <MatchCard
                    key={m.id}
                    m={m}
                    onPickWinner={pickWinner}
                    onEditTeams={editTeams}
                    teamOptions={teamOptions}
                    busy={busy}
                    tealAccent={embed}
                    isSelected={selectedMatchId === m.id}
                    onSelect={setSelectedMatchId}
                    hideTbdNames
                    placeholder={m.id.startsWith("semi-placeholder-")}
                    tvActive={semiTvActive(m.bracketIndex)}
                    tvClickable={showQuarterFinalsColumn}
                    onTvToggle={() => toggleTvGroup(`semi:${m.bracketIndex}`)}
                    teamOverlayColor={teamOverlayColor}
                  />
                ))}
              </div>
            </div>

            <div
              className="w-px shrink-0 bg-gradient-to-b from-transparent via-zinc-600 to-transparent"
              aria-hidden
            />

            {/* Grand final — px-5 so divider sits centered between GF card and Champion (matches Champion pl-5) */}
            <div className="flex flex-1 flex-col px-5">
              <p className="mb-2 shrink-0 text-center text-[11px] font-bold uppercase tracking-widest text-zinc-500">
                Grand final
              </p>
              <div className="flex min-h-0 flex-1 items-center">
                <MatchCard
                  m={grandFinalSlot}
                  onPickWinner={pickWinner}
                  onEditTeams={editTeams}
                  teamOptions={teamOptions}
                  busy={busy}
                  tealAccent={embed}
                  isSelected={selectedMatchId === grandFinalSlot.id}
                  onSelect={setSelectedMatchId}
                  hideTbdNames
                  placeholder={grandFinalSlot.id === "grand-final-placeholder"}
                  tvActive={grandTvActive}
                  tvClickable={true}
                  onTvToggle={() => toggleTvGroup("grand")}
                  teamOverlayColor={teamOverlayColor}
                />
              </div>
            </div>

            <div
              className="w-px shrink-0 bg-gradient-to-b from-transparent via-zinc-600 to-transparent"
              aria-hidden
            />

            <ChampionColumn
              grandFinal={data!.grandFinal}
              tvActive={championTvActive}
              onTvToggle={() => toggleTvGroup("champion")}
              teamOverlayColor={teamOverlayColor}
            />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
