"use client";

import { useEventWorkspace } from "@/components/EventWorkspaceProvider";
import {
  MATBEAST_TOURNAMENT_HEADER,
  matbeastFetch,
} from "@/lib/matbeast-fetch";
import { matbeastKeys } from "@/lib/matbeast-query-keys";
import { formatTime12h, getResultLogOneLine } from "@/lib/result-log-summary";
import type { BoardPayload, ResultLogEntry } from "@/types/board";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

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

/**
 * Best-effort parse of a manual entry's operator-typed date/time into a Date.
 * Manual rows store free-form strings (e.g. "2026-06-07" + "14:30" from native
 * date/time inputs, or "6/7/2026" + "2:30 PM"); we try a few shapes and fall
 * back to a time-only parse so the recorded time still shows.
 */
function parseManualDateTime(
  date: string | null,
  time: string | null,
): Date | null {
  const dStr = (date ?? "").trim();
  const tStr = (time ?? "").trim();
  if (!dStr && !tStr) return null;
  if (dStr && tStr) {
    const combined = new Date(`${dStr} ${tStr}`);
    if (!Number.isNaN(combined.getTime())) return combined;
    const iso = new Date(`${dStr}T${tStr}`);
    if (!Number.isNaN(iso.getTime())) return iso;
  }
  if (dStr && !tStr) {
    const dOnly = new Date(dStr);
    if (!Number.isNaN(dOnly.getTime())) return dOnly;
  }
  const m = tStr.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    const ap = m[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    const d = new Date();
    d.setHours(h, min, 0, 0);
    return d;
  }
  return null;
}

/** 12-hour time label for any row, using the recorded time (manual date/time or createdAt). */
function resultLogTimeLabel(r: ResultLogEntry): string | null {
  if (r.isManual) {
    const manual = parseManualDateTime(r.manualDate, r.manualTime);
    if (manual) return formatTime12h(manual);
  }
  if (r.createdAt) {
    const c = new Date(r.createdAt);
    if (!Number.isNaN(c.getTime())) return formatTime12h(c);
  }
  return null;
}

/**
 * The one-line text shown for a result row (and reused for the PDF export).
 *
 * Decisive finals already carry their saved-at time inside `finalSummaryLine`
 * (via `getResultLogOneLine`). Draws, no-contests and manual rows are built by
 * `buildResultLine`, which has no time — so we prepend the recorded time here
 * to guarantee every entry shows a timestamp.
 */
function resultLogDisplayLine(r: ResultLogEntry): string {
  if (!r.isManual && r.createdAt) {
    const oneLine = getResultLogOneLine(r);
    if (oneLine) return oneLine;
  }
  const base = buildResultLine(r);
  const time = resultLogTimeLabel(r);
  return time ? `${time} ${base}` : base;
}

function resultSortTime(r: ResultLogEntry): number {
  const t = Date.parse(r.createdAt);
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Deduce the event date (or date range) from the log's `createdAt` stamps. */
function deduceEventDateText(rows: ResultLogEntry[]): string | null {
  const times: number[] = [];
  for (const r of rows) {
    const t = Date.parse(r.createdAt);
    if (!Number.isNaN(t)) times.push(t);
  }
  if (times.length === 0) return null;
  const min = new Date(Math.min(...times));
  const max = new Date(Math.max(...times));
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  const sameDay =
    min.getFullYear() === max.getFullYear() &&
    min.getMonth() === max.getMonth() &&
    min.getDate() === max.getDate();
  return sameDay ? fmt(min) : `${fmt(min)} – ${fmt(max)}`;
}

function buildResultsPdfHtml(params: {
  title: string;
  dateText: string | null;
  lines: string[];
}): string {
  const { title, dateText, lines } = params;
  const body = lines.length
    ? `<ol>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ol>`
    : `<p class="empty">No results recorded.</p>`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} — Results</title>
<style>
  @page { margin: 18mm 16mm; }
  html, body { margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; }
  .doc-title { text-align: center; font-size: 20px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 4px; }
  .doc-date { text-align: center; font-size: 12px; color: #333; margin: 0 0 18px; }
  ol { padding-left: 30px; margin: 0; }
  li { font-size: 12px; line-height: 1.55; padding: 3px 0; border-bottom: 1px solid #e5e5e5; }
  li:last-child { border-bottom: 0; }
  .empty { font-size: 12px; color: #666; text-align: center; }
</style>
</head>
<body>
  <h1 class="doc-title">${escapeHtml(title)}</h1>
  ${dateText ? `<div class="doc-date">${escapeHtml(dateText)}</div>` : ""}
  ${body}
</body>
</html>`;
}

/**
 * Render the printable document in a hidden iframe and open the system print
 * dialog (Chromium's dialog lets the user pick "Save as PDF" or a printer).
 * Using an iframe keeps the print scoped to this document and works inside the
 * Electron renderer without opening a popup window.
 */
function openPrintDocument(html: string): void {
  if (typeof document === "undefined") return;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.style.opacity = "0";
  document.body.appendChild(iframe);

  let printed = false;
  const triggerPrint = () => {
    if (printed) return;
    printed = true;
    const win = iframe.contentWindow;
    if (!win) {
      iframe.remove();
      return;
    }
    try {
      win.focus();
      win.print();
    } catch {
      /* ignore */
    }
    // Keep the iframe alive briefly so the print dialog can read its document.
    window.setTimeout(() => iframe.remove(), 1500);
  };

  iframe.onload = () => window.setTimeout(triggerPrint, 150);

  const doc = iframe.contentWindow?.document;
  if (!doc) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();
  // Fallback in case `onload` doesn't fire after document.write in Electron.
  window.setTimeout(triggerPrint, 700);
}

function ExportIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 3a1 1 0 0 1 1 1v8.59l2.3-2.3a1 1 0 0 1 1.4 1.42l-4 4a1 1 0 0 1-1.42 0l-4-4a1 1 0 1 1 1.42-1.42l2.3 2.3V4a1 1 0 0 1 1-1Zm-7 14a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

function PrintIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 3h10v4H7V3Zm12 6H5a3 3 0 0 0-3 3v6h4v3h12v-3h4v-6a3 3 0 0 0-3-3Zm-5 10H10v-4h4v4Zm4-6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
    </svg>
  );
}

/**
 * Header-bar actions for the Results card: export the results log to a PDF
 * (chronological, titled with the event name + deduced date) or print it.
 *
 * On desktop the PDF is produced with Chromium's built-in `printToPDF` and
 * saved through a native dialog — completely free, no Adobe / PDF printer
 * required (the renderer print dialog used to default to "Adobe PDF"). The
 * browser fallback uses the system print dialog. Reuses the board query (same
 * key) so it shares the panel's cached data.
 */
export function ResultsExportButton() {
  const { tournamentId, ready, tournamentName } = useEventWorkspace();
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

  const rows = useMemo(() => board?.resultsLog ?? [], [board?.resultsLog]);
  const hasRows = rows.length > 0;

  const buildHtml = useCallback(() => {
    const chronological = [...rows].sort(
      (a, b) => resultSortTime(a) - resultSortTime(b),
    );
    const lines = chronological.map((r) => resultLogDisplayLine(r));
    const title = (tournamentName?.trim() || "Event Results").toUpperCase();
    const dateText = deduceEventDateText(chronological);
    return buildResultsPdfHtml({ title, dateText, lines });
  }, [rows, tournamentName]);

  const defaultFileName = useMemo(() => {
    const base =
      (tournamentName?.trim() || "event")
        .replace(/[^a-zA-Z0-9\-_ ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim() || "event";
    return `${base} results.pdf`;
  }, [tournamentName]);

  const onSavePdf = useCallback(async () => {
    const html = buildHtml();
    const desk = window.matBeastDesktop;
    if (desk?.exportPdf) {
      const r = await desk.exportPdf({ html, defaultName: defaultFileName });
      if (!r.ok && !r.canceled && r.error) {
        window.alert(`Could not save PDF: ${r.error}`);
      }
      return;
    }
    // Browser/dev fallback: system print dialog (Save as PDF).
    openPrintDocument(html);
  }, [buildHtml, defaultFileName]);

  const onPrint = useCallback(async () => {
    const html = buildHtml();
    const desk = window.matBeastDesktop;
    if (desk?.printHtml) {
      const r = await desk.printHtml({ html });
      if (!r.ok && r.error) window.alert(`Could not print: ${r.error}`);
      return;
    }
    openPrintDocument(html);
  }, [buildHtml]);

  const disabled = !tournamentId || !hasRows;

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        disabled={disabled}
        onClick={() => void onSavePdf()}
        title="Save the results log as a PDF (chronological). Free — no Adobe required."
        className="inline-flex items-center gap-1 rounded border border-zinc-600/60 bg-zinc-800/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-200 hover:bg-zinc-700/50 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ExportIcon className="h-3 w-3" />
        Export PDF
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void onPrint()}
        title="Print the results log (choose Microsoft Print to PDF or a printer)."
        className="inline-flex items-center gap-1 rounded border border-zinc-600/60 bg-zinc-800/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-200 hover:bg-zinc-700/50 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <PrintIcon className="h-3 w-3" />
        Print
      </button>
    </div>
  );
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
            const line = resultLogDisplayLine(r);
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
