"use client";

import { useEventWorkspace } from "@/components/EventWorkspaceProvider";
import {
  MATBEAST_TOURNAMENT_HEADER,
  matbeastFetch,
} from "@/lib/matbeast-fetch";
import { matbeastKeys } from "@/lib/matbeast-query-keys";
import { getResultLogOneLine } from "@/lib/result-log-summary";
import type { BoardPayload, ResultLogEntry } from "@/types/board";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z" />
    </svg>
  );
}

function splitFirstLast(fullName: string): { first: string; last: string } {
  const s = fullName.trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: s, last: "" };
  return { first: parts[0]!, last: parts.slice(1).join(" ") };
}

function fighterWithTeam(name: string, teamName: string | null): string {
  const { first, last } = splitFirstLast(name);
  const displayName = [first, last].filter(Boolean).join(" ").trim() || "—";
  const team = (teamName ?? "").trim();
  if (!team) return displayName;
  return `${displayName} (${team})`;
}

function outcomeMethodAbbrev(
  resultType: ResultLogEntry["resultType"],
): "SUB" | "ESC" | "DQ" | null {
  if (resultType.startsWith("SUBMISSION_")) return "SUB";
  if (resultType.startsWith("ESCAPE_")) return "ESC";
  if (resultType.startsWith("DQ_")) return "DQ";
  return null;
}

function buildResultLine(r: ResultLogEntry): string {
  const round = r.roundLabel?.trim() ?? "";
  const withRound = (line: string) =>
    round && !line.toUpperCase().includes(`— ${round.toUpperCase()}`)
      ? `${line} — ${round.toUpperCase()}`
      : line;
  if (r.isManual) {
    return withRound(r.leftName?.trim() || "MANUAL ENTRY");
  }
  const left = fighterWithTeam(r.leftName, r.leftTeamName);
  const right = fighterWithTeam(r.rightName, r.rightTeamName);

  if (r.resultType === "DRAW") {
    return withRound(`${left} DRAW ${right}`);
  }
  if (r.resultType === "NO_CONTEST") {
    return withRound(`${left} NO CONT. ${right}`);
  }

  const method = outcomeMethodAbbrev(r.resultType);
  const winnerIsLeft =
    r.resultType === "LEFT" ||
    r.resultType === "SUBMISSION_LEFT" ||
    r.resultType === "ESCAPE_LEFT" ||
    r.resultType === "DQ_RIGHT";
  const winner = winnerIsLeft ? left : right;
  const loser = winnerIsLeft ? right : left;
  if (method) return withRound(`${winner} def ${loser} by ${method}`);
  return withRound(`${winner} def ${loser}`);
}

export function ResultsLogPanel() {
  const { tournamentId, ready } = useEventWorkspace();
  const queryClient = useQueryClient();
  const { data: board } = useQuery({
    queryKey: matbeastKeys.board(tournamentId),
    queryFn: async ({ signal }) => {
      const res = await matbeastFetch("/api/board", {
        cache: "no-store",
        signal,
        headers: { [MATBEAST_TOURNAMENT_HEADER]: tournamentId! },
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `${res.status} ${res.statusText}`);
      }
      return (await res.json()) as BoardPayload;
    },
    enabled: ready && !!tournamentId,
    refetchInterval: 4000,
  });

  const rows = board?.resultsLog ?? [];

  const [busy, setBusy] = useState(false);

  const refreshBoard = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: matbeastKeys.board(tournamentId),
    });
  }, [queryClient, tournamentId]);

  const deleteRow = useCallback(
    async (id: string) => {
      if (!tournamentId) return;
      if (!window.confirm("Remove this result from the log?")) return;
      setBusy(true);
      try {
        const res = await matbeastFetch("/api/board", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            [MATBEAST_TOURNAMENT_HEADER]: tournamentId,
          },
          body: JSON.stringify({
            command: { type: "result_log_delete", resultLogId: id },
          }),
        });
        if (!res.ok) {
          const j = (await res.json()) as { error?: string };
          window.alert(j.error ?? "Could not delete");
        } else {
          refreshBoard();
        }
      } finally {
        setBusy(false);
      }
    },
    [refreshBoard, tournamentId],
  );

  return (
    <div className="min-w-0 max-w-full overflow-x-auto p-2 text-zinc-200">
      {rows.length === 0 ? (
        <p className="text-[11px] text-zinc-500">No results yet.</p>
      ) : (
        <ul className="scrollbar-thin max-h-[min(220px,40vh)] max-w-full list-none overflow-x-auto overflow-y-auto p-0 text-[10px] font-normal leading-normal text-zinc-400">
          {rows.map((r) => {
            const line =
              r.isManual || !r.createdAt
                ? buildResultLine(r)
                : getResultLogOneLine(r) ?? buildResultLine(r);
            return (
              <li
                key={r.id}
                className="flex w-max min-w-full items-start gap-1 py-0.5 leading-normal"
              >
                <span className="whitespace-nowrap text-left">{line}</span>
                <button
                  type="button"
                  disabled={busy}
                  title="Delete row"
                  onClick={() => void deleteRow(r.id)}
                  className="shrink-0 rounded p-0.5 text-zinc-600 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-40"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
