"use client";

import { useEventWorkspace } from "@/components/EventWorkspaceProvider";
import {
  buildEnvelopeTextForActiveTab,
  matbeastImportOpenedEventFile,
  matbeastSaveTabById,
  tryFocusExistingTabForCloudEvent,
} from "@/lib/matbeast-dashboard-file-actions";
import { matbeastKeys } from "@/lib/matbeast-query-keys";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

type CloudEventMeta = {
  id: string;
  name: string;
  /**
   * Human-readable event title stored alongside the filename. Null for
   * rows created before v0.8.4. v0.9.36 uses this as the authoritative
   * display title when opening from cloud, healing the legacy bug
   * where the cloud blob's envelope had the FILENAME mistakenly
   * written into its `eventName` field.
   */
  eventName: string | null;
  ownerUserId: string;
  currentVersion: number;
  currentBlobSha: string | null;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string;
  updatedByUserId: string;
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Three modals driven by custom window events:
 *
 *   matbeast-cloud-open-dialog   -> CloudOpenDialog
 *   matbeast-cloud-upload-dialog -> CloudUploadDialog
 *   matbeast-cloud-conflict      -> CloudConflictDialog
 *
 * Kept in a single file because they share a lot of layout + they're
 * only mounted once (via RouteChromeShell) so they can't fight over
 * the "active" state.
 */
export default function CloudEventDialogs() {
  const queryClient = useQueryClient();
  const {
    openEventInTab,
    refreshTournaments,
    tournamentId,
    openTabs,
    selectTab,
    setShowHome,
  } = useEventWorkspace();

  const openTabsRef = useRef(openTabs);
  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  const [openDialog, setOpenDialog] = useState<
    null | "open" | "upload" | { kind: "conflict"; tournamentId: string }
  >(null);

  useEffect(() => {
    const onOpen = () => setOpenDialog("open");
    const onUpload = () => setOpenDialog("upload");
    const onConflict = (e: Event) => {
      const d = (e as CustomEvent<{ tournamentId?: string }>).detail;
      if (!d?.tournamentId) return;
      setOpenDialog({ kind: "conflict", tournamentId: d.tournamentId });
    };
    window.addEventListener("matbeast-cloud-open-dialog", onOpen);
    window.addEventListener("matbeast-cloud-upload-dialog", onUpload);
    window.addEventListener("matbeast-cloud-conflict", onConflict);
    return () => {
      window.removeEventListener("matbeast-cloud-open-dialog", onOpen);
      window.removeEventListener("matbeast-cloud-upload-dialog", onUpload);
      window.removeEventListener("matbeast-cloud-conflict", onConflict);
    };
  }, []);

  const close = useCallback(() => setOpenDialog(null), []);

  /* -------------------------------------------------------------------------
   * Open-from-cloud flow:
   *   1. Fetch event list via /api/cloud/events.
   *   2. User picks one -> call /api/cloud/events/pull (no tournamentId).
   *   3. Parse the returned envelope into a new tournament via the existing
   *      matbeastImportOpenedEventFile() helper. We reuse it so JSON parsing
   *      and roster/bracket import stay in one place.
   *   4. Once the new tournament id is known, call /api/cloud/events/pull
   *      AGAIN with tournamentId set to bind the CloudEventLink. (A second
   *      small GET is cheaper than reworking the import helper to return
   *      the new tournament id synchronously.)
   * ----------------------------------------------------------------------- */

  const handleCloudOpen = useCallback(
    async (cloudEventId: string) => {
      const focused = await tryFocusExistingTabForCloudEvent({
        cloudEventId,
        openTabs,
        selectTab,
        setShowHome,
      });
      if (focused) {
        void queryClient.invalidateQueries({ queryKey: matbeastKeys.all });
        close();
        return;
      }

      // Pull blob.
      const r = await fetch("/api/cloud/events/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cloudEventId }),
      });
      if (!r.ok) {
        window.alert(`Could not download event: HTTP ${r.status}`);
        return;
      }
      const { envelope, meta } = (await r.json()) as {
        envelope: string;
        meta: CloudEventMeta;
      };

      // Track currently-open tab ids so we can identify the new one.
      const before = new Set(openTabsRef.current.map((t) => t.id));
      await matbeastImportOpenedEventFile({
        filePath: `${meta.name}.matb`,
        text: envelope,
        queryClient,
        openEventInTab,
        refreshTournaments,
        openTabs,
        selectTab,
        setShowHome,
        cloudEventId: meta.id,
        /**
         * v0.9.36: prefer the cloud catalog's display title over the
         * envelope's `eventName` when both are present. Heals events
         * whose blob was uploaded by an older build with the
         * filename mistakenly written into the envelope. See
         * `matbeastImportOpenedEventFile` JSDoc.
         */
        displayNameOverride: meta.eventName ?? null,
      });

      // matbeastImportOpenedEventFile creates a tournament + opens a tab.
      // Give React one tick to reflect the new tab, then diff.
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
      const after = openTabsRef.current;
      const newTab = after.find((t) => !before.has(t.id));
      if (newTab) {
        // Bind local tournament to cloud event.
        await fetch("/api/cloud/events/pull", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cloudEventId: meta.id,
            tournamentId: newTab.id,
          }),
        }).catch(() => {
          /* link binding is best-effort; badge will show LOCAL_ONLY otherwise */
        });
        window.dispatchEvent(
          new CustomEvent("matbeast-cloud-sync-changed", {
            detail: { tournamentId: newTab.id },
          }),
        );
      }
      void queryClient.invalidateQueries({ queryKey: matbeastKeys.all });
      close();
    },
    [queryClient, openEventInTab, refreshTournaments, close, openTabs, selectTab, setShowHome],
  );

  return (
    <>
      {openDialog === "open" ? (
        <CloudOpenDialog onPick={handleCloudOpen} onClose={close} />
      ) : null}
      {openDialog === "upload" ? (
        <CloudUploadDialog
          tournamentId={tournamentId}
          openTabs={openTabs}
          onClose={close}
          onDone={() => {
            window.dispatchEvent(
              new CustomEvent("matbeast-cloud-sync-changed", {
                detail: { tournamentId },
              }),
            );
            close();
          }}
        />
      ) : null}
      {openDialog && typeof openDialog === "object" && openDialog.kind === "conflict" ? (
        <CloudConflictDialog
          tournamentId={openDialog.tournamentId}
          onClose={close}
          onForcePush={async () => {
            if (!openDialog.tournamentId) return;
            const tabName =
              openTabsRef.current.find(
                (t) => t.id === openDialog.tournamentId,
              )?.name ?? "Untitled event";
            try {
              const envelope = await rebuildEnvelope(tabName);
              await fetch("/api/cloud/events/push", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  tournamentId: openDialog.tournamentId,
                  envelope,
                  force: true,
                }),
              });
            } catch (e) {
              window.alert(
                `Force-push failed: ${e instanceof Error ? e.message : "unknown"}`,
              );
            }
            window.dispatchEvent(
              new CustomEvent("matbeast-cloud-sync-changed", {
                detail: { tournamentId: openDialog.tournamentId },
              }),
            );
            close();
          }}
          onKeepCloud={async () => {
            // Pull cloud blob into a new local tournament (safe path -
            // we DON'T overwrite the current local tournament; user opted
            // to keep cloud, so we open the cloud version fresh and they
            // can close the dirty local tab).
            const link = await fetch(
              `/api/cloud/events/status?tournamentId=${encodeURIComponent(
                openDialog.tournamentId,
              )}`,
            ).then((r) => (r.ok ? r.json() : null));
            const cloudId = link?.link?.cloudEventId;
            if (cloudId) {
              await handleCloudOpen(cloudId);
            }
            close();
          }}
          onSaveLocalCopy={async () => {
            // Break the cloud link so this tournament becomes local-only,
            // then trigger a save. The user keeps their work locally;
            // the cloud event stays intact.
            await fetch(
              `/api/cloud/events/link?tournamentId=${encodeURIComponent(
                openDialog.tournamentId,
              )}`,
              { method: "DELETE" },
            ).catch(() => {});
            await matbeastSaveTabById(
              queryClient,
              selectTab,
              () => openTabsRef.current,
              openDialog.tournamentId,
            );
            window.dispatchEvent(
              new CustomEvent("matbeast-cloud-sync-changed", {
                detail: { tournamentId: openDialog.tournamentId },
              }),
            );
            close();
          }}
        />
      ) : null}
    </>
  );
}

/* ===========================================================================
 * Open dialog
 * ======================================================================== */

function CloudOpenDialog({
  onPick,
  onClose,
}: {
  onPick: (id: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<CloudEventMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cloudReady, setCloudReady] = useState<boolean | null>(null);
  const [cloudStatus, setCloudStatus] = useState<{
    tokenSet: boolean;
    syncEnabled: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfgRes = await fetch("/api/cloud/config", { cache: "no-store" });
        if (cancelled) return;
        if (!cfgRes.ok) {
          setCloudReady(false);
          return;
        }
        const c = (await cfgRes.json()) as {
          configured: boolean;
          tokenSet: boolean;
          syncEnabled: boolean;
        };
        setCloudReady(c.configured);
        setCloudStatus({ tokenSet: c.tokenSet, syncEnabled: c.syncEnabled });
        if (!c.configured) return; // skip listing — we'll show the notice
        const r = await fetch("/api/cloud/events", { cache: "no-store" });
        if (!r.ok) {
          setError(`HTTP ${r.status}`);
          return;
        }
        const data = (await r.json()) as { events: CloudEventMeta[] };
        if (!cancelled) setEvents(data.events);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ModalShell onClose={onClose} title="Open from Cloud">
      {cloudReady === false ? (
        <NotConfiguredNotice
          status={cloudStatus}
          onOpenSettings={() => {
            onClose();
            window.dispatchEvent(
              new CustomEvent("matbeast-native-options", {
                detail: { source: "menu", action: "cloud" },
              }),
            );
          }}
        />
      ) : error ? (
        <p className="text-red-300">Failed to load: {error}</p>
      ) : events === null ? (
        <p className="opacity-60">Loading…</p>
      ) : events.length === 0 ? (
        <p className="opacity-60">
          No events in the cloud yet. Use{" "}
          <strong>File ▸ Upload Current to Cloud…</strong> first.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {events.map((e) => (
            <li
              key={e.id}
              className="flex items-center justify-between gap-3 rounded border border-zinc-700 bg-zinc-900/60 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="m-0 truncate font-semibold">{e.name}</p>
                <p className="m-0 mt-0.5 text-[10px] opacity-60">
                  v{e.currentVersion} • {fmtSize(e.sizeBytes)} • updated{" "}
                  {fmtDate(e.updatedAt)}
                </p>
              </div>
              <button
                type="button"
                disabled={busyId === e.id}
                onClick={async () => {
                  setBusyId(e.id);
                  try {
                    await onPick(e.id);
                  } finally {
                    setBusyId(null);
                  }
                }}
                className="shrink-0 rounded bg-teal-700 px-3 py-1 text-[11px] font-semibold text-white hover:bg-teal-600 disabled:opacity-50"
              >
                {busyId === e.id ? "Opening…" : "Open"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </ModalShell>
  );
}

/* ===========================================================================
 * Upload dialog
 * ======================================================================== */

function CloudUploadDialog({
  tournamentId,
  openTabs,
  onClose,
  onDone,
}: {
  tournamentId: string | null;
  openTabs: Array<{ id: string; name: string }>;
  onClose: () => void;
  onDone: () => void;
}) {
  const tab = openTabs.find((t) => t.id === tournamentId);
  // Default is intentionally blank until we've fetched the event's
  // on-disk file name; showing the event display name here was
  // confusing because users save as "Worlds-Day1.matb" but the tab
  // reads "Worlds 2026 - Day 1".
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloudReady, setCloudReady] = useState<boolean | null>(null);
  const [cloudStatus, setCloudStatus] = useState<{
    tokenSet: boolean;
    syncEnabled: boolean;
  } | null>(null);

  // Preflight: fetch the board's current roster file name AND the cloud
  // config so we can (a) default the filename correctly and (b) surface
  // a helpful message instead of letting the user hit "Upload" only to
  // get a generic 502.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [boardRes, cfgRes] = await Promise.all([
          fetch("/api/board", { cache: "no-store" }).catch(() => null),
          fetch("/api/cloud/config", { cache: "no-store" }).catch(() => null),
        ]);
        if (cancelled) return;
        // Filename default
        if (boardRes && boardRes.ok) {
          const b = (await boardRes.json()) as {
            currentRosterFileName?: string;
          };
          const raw = b.currentRosterFileName?.trim() ?? "";
          if (raw && raw.toUpperCase() !== "UNTITLED") {
            setName(raw);
          } else {
            setName(tab?.name ?? "Untitled event");
          }
        } else {
          setName(tab?.name ?? "Untitled event");
        }
        // Cloud configuration
        if (cfgRes && cfgRes.ok) {
          const c = (await cfgRes.json()) as {
            configured: boolean;
            tokenSet: boolean;
            syncEnabled: boolean;
          };
          setCloudReady(c.configured);
          setCloudStatus({
            tokenSet: c.tokenSet,
            syncEnabled: c.syncEnabled,
          });
        } else {
          setCloudReady(false);
          setCloudStatus(null);
        }
      } catch {
        if (!cancelled) setCloudReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab?.name]);

  const canUpload =
    Boolean(tournamentId) &&
    name.trim().length > 0 &&
    !busy &&
    cloudReady === true;

  const submit = async () => {
    if (!tournamentId) return;
    setBusy(true);
    setError(null);
    try {
      const envelope = await rebuildEnvelope(tab?.name ?? "Untitled event");
      const r = await fetch("/api/cloud/events/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tournamentId, envelope, name: name.trim() }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        setError(`Upload failed: HTTP ${r.status} ${t.slice(0, 200)}`);
        return;
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onClose} title="Upload Current Event to Cloud">
      {!tournamentId ? (
        <p>Open an event first, then upload it.</p>
      ) : cloudReady === false ? (
        <NotConfiguredNotice
          status={cloudStatus}
          onOpenSettings={() => {
            onClose();
            window.dispatchEvent(
              new CustomEvent("matbeast-native-options", {
                detail: { source: "menu", action: "cloud" },
              }),
            );
          }}
        />
      ) : (
        <>
          <p className="text-[11px] opacity-75">
            Creates a new cloud copy of the currently-open event. Other
            signed-in desktops will see it under{" "}
            <strong>File ▸ Open from Cloud…</strong>.
          </p>
          <label className="mt-3 flex flex-col gap-1 text-[11px]">
            <span className="opacity-75">Name in the cloud:</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={cloudReady === null ? "Loading…" : "Name"}
              disabled={cloudReady === null}
              className="rounded border border-zinc-600 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-100 disabled:opacity-50"
              autoFocus
            />
          </label>
          {error ? (
            <p className="mt-2 break-words text-[11px] text-red-300">
              {error}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded bg-zinc-700 px-3 py-1 text-[11px] text-zinc-100 hover:bg-zinc-600"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canUpload}
              onClick={() => void submit()}
              className="rounded bg-teal-700 px-3 py-1 text-[11px] font-semibold text-white hover:bg-teal-600 disabled:opacity-50"
            >
              {busy ? "Uploading…" : "Upload"}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}

/* ===========================================================================
 * Conflict dialog
 * ======================================================================== */

function CloudConflictDialog({
  tournamentId,
  onClose,
  onForcePush,
  onKeepCloud,
  onSaveLocalCopy,
}: {
  tournamentId: string;
  onClose: () => void;
  onForcePush: () => void | Promise<void>;
  onKeepCloud: () => void | Promise<void>;
  onSaveLocalCopy: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<null | "push" | "pull" | "local">(null);
  void tournamentId;

  const wrap = (kind: "push" | "pull" | "local", fn: () => unknown) => async () => {
    setBusy(kind);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <ModalShell onClose={onClose} title="Cloud conflict">
      <p className="text-[12px]">
        Someone else updated this event in the cloud since you last synced.
        Choose how to resolve:
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={wrap("push", onForcePush)}
          className="rounded bg-fuchsia-700 px-3 py-2 text-left text-[11px] text-white hover:bg-fuchsia-600 disabled:opacity-50"
        >
          <strong className="block">Overwrite cloud with my version</strong>
          <span className="text-[10px] opacity-80">
            Their changes will be kept in version history but the latest
            cloud version becomes yours.
          </span>
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={wrap("pull", onKeepCloud)}
          className="rounded bg-sky-700 px-3 py-2 text-left text-[11px] text-white hover:bg-sky-600 disabled:opacity-50"
        >
          <strong className="block">Keep the cloud version</strong>
          <span className="text-[10px] opacity-80">
            Opens the cloud version as a fresh local event. Your unsaved
            local changes stay in the current tab — close it to discard.
          </span>
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={wrap("local", onSaveLocalCopy)}
          className="rounded bg-amber-700 px-3 py-2 text-left text-[11px] text-white hover:bg-amber-600 disabled:opacity-50"
        >
          <strong className="block">Save mine as a local-only copy</strong>
          <span className="text-[10px] opacity-80">
            Disconnects this tab from the cloud event and saves locally.
            The cloud event is untouched.
          </span>
        </button>
      </div>
    </ModalShell>
  );
}

/* ===========================================================================
 * Shared modal shell
 * ======================================================================== */

function ModalShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[520px] max-w-[90vw] rounded border border-zinc-700 bg-[#1e293b] p-5 text-zinc-100 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="m-0 text-[14px] font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[12px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ===========================================================================
 * Not-configured notice — shared by Open and Upload dialogs
 *
 * Appears when /api/cloud/config reports `configured: false`. We split
 * the two underlying reasons (no token vs. sync paused) because they
 * need different actions:
 *   - no token   -> user must paste a token from matbeast-masters
 *   - paused     -> user just needs to flip the toggle back on
 * ======================================================================== */

function NotConfiguredNotice({
  status,
  onOpenSettings,
}: {
  status: { tokenSet: boolean; syncEnabled: boolean } | null;
  onOpenSettings: () => void;
}) {
  const reason = !status
    ? "Cloud settings could not be read."
    : !status.tokenSet
      ? "No desktop token is saved on this install. Sign in at Mat Beast Masters → Desktop tokens and paste a token you generated there."
      : !status.syncEnabled
        ? "Cloud sync is paused. Re-enable it in Cloud Sync settings."
        : "Cloud is not configured.";
  return (
    <>
      <p className="text-[12px] leading-relaxed">{reason}</p>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onOpenSettings}
          className="rounded bg-teal-700 px-3 py-1 text-[11px] font-semibold text-white hover:bg-teal-600"
        >
          Open Cloud Settings
        </button>
      </div>
    </>
  );
}

/* ===========================================================================
 * Envelope rebuild
 *
 * The .matb envelope is built client-side (buildEnvelopeText uses
 * matbeastFetch which adds the tournament header from the global store).
 * Since Upload / Force-Push always target the currently-active tab, we
 * can just call the exported helper directly.
 *
 * The `_tournamentId` argument is retained for future-proofing (when
 * we support cloud operations on background tabs), but is currently
 * unused — we rely on the caller having selected the correct tab.
 * ======================================================================== */

async function rebuildEnvelope(tabName: string): Promise<string> {
  return buildEnvelopeTextForActiveTab(tabName);
}
