import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ensureCloudTables } from "@/lib/cloud-config-table";
import {
  getCloudConfig,
  isCloudConfigured,
  type CloudConfig,
} from "@/lib/cloud-config";

/* ============================================================================
 * Types matching the masters cloud API
 * ========================================================================== */

export type CloudEventMeta = {
  id: string;
  name: string;
  /**
   * Human-readable event title stored alongside the filename. Null for
   * rows created before v0.8.4 — the UI falls back to `name` in that
   * case so the homepage catalog never shows an empty label.
   */
  eventName: string | null;
  /** Training event files (separate master lists). Omitted on older cloud rows → treat as false. */
  trainingMode?: boolean;
  ownerUserId: string;
  currentVersion: number;
  currentBlobSha: string | null;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string;
  updatedByUserId: string;
};

export type PushResult =
  | { kind: "ok"; version: number; sha256: string; sizeBytes: number }
  | { kind: "conflict"; currentVersion: number }
  | { kind: "error"; status: number; message: string };

export type PullResult =
  | { kind: "ok"; version: number; sha256: string; bytes: Buffer }
  | { kind: "error"; status: number; message: string };

/* ============================================================================
 * Utility
 * ========================================================================== */

export function sha256Hex(bytes: Buffer | Uint8Array | string): string {
  return createHash("sha256")
    .update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes)
    .digest("hex");
}

const REQUEST_TIMEOUT_MS = 15_000;
// We run this on the user's own machine against their Vercel deployment.
// Keep the upper bound loose so larger events still succeed.
const BLOB_TIMEOUT_MS = 60_000;

function cloudUrl(cfg: CloudConfig, path: string): string {
  return `${cfg.cloudBaseUrl.replace(/\/+$/, "")}${path}`;
}

function authHeaders(cfg: CloudConfig): Record<string, string> {
  return { Authorization: `Bearer ${cfg.desktopToken}` };
}

async function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await run(ac.signal);
  } finally {
    clearTimeout(t);
  }
}

/* ============================================================================
 * Cloud-side CRUD helpers (metadata)
 * ========================================================================== */

export async function listCloudEvents(): Promise<CloudEventMeta[]> {
  const cfg = await getCloudConfig();
  if (!isCloudConfigured(cfg)) return [];
  return withTimeout(REQUEST_TIMEOUT_MS, async (signal) => {
    const r = await fetch(cloudUrl(cfg, "/api/events"), {
      headers: authHeaders(cfg),
      cache: "no-store",
      signal,
    });
    if (!r.ok) {
      throw new Error(`listCloudEvents: HTTP ${r.status}`);
    }
    const data = (await r.json()) as { events: CloudEventMeta[] };
    return data.events;
  });
}

/**
 * PATCH a cloud event's filename and/or human event title.
 *
 * Pass `eventName: null` to explicitly clear it; omit the key entirely
 * to leave it unchanged on the server. At least one of `name` or
 * `eventName` must be supplied.
 */
export async function patchCloudEvent(
  cloudEventId: string,
  patch: { name?: string; eventName?: string | null; trainingMode?: boolean },
): Promise<
  | { kind: "ok"; event: CloudEventMeta }
  | { kind: "error"; status: number; message: string }
> {
  const cfg = await getCloudConfig();
  if (!isCloudConfigured(cfg)) {
    return { kind: "error", status: 0, message: "cloud not configured" };
  }
  try {
    return await withTimeout(REQUEST_TIMEOUT_MS, async (signal) => {
      const r = await fetch(
        cloudUrl(cfg, `/api/events/${encodeURIComponent(cloudEventId)}`),
        {
          method: "PATCH",
          headers: {
            ...authHeaders(cfg),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(patch),
          signal,
        },
      );
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        return {
          kind: "error" as const,
          status: r.status,
          message: `HTTP ${r.status} ${txt.slice(0, 200)}`,
        };
      }
      const data = (await r.json()) as { event: CloudEventMeta };
      return { kind: "ok" as const, event: data.event };
    });
  } catch (e) {
    return {
      kind: "error",
      status: 0,
      message: e instanceof Error ? e.message : "patch failed",
    };
  }
}

/** Back-compat shim: rename only the filename. */
export async function renameCloudEvent(
  cloudEventId: string,
  name: string,
): Promise<
  | { kind: "ok"; event: CloudEventMeta }
  | { kind: "error"; status: number; message: string }
> {
  return patchCloudEvent(cloudEventId, { name });
}

/** Server-side duplicate via the masters /copy endpoint. */
export async function copyCloudEvent(
  cloudEventId: string,
): Promise<
  | { kind: "ok"; event: CloudEventMeta }
  | { kind: "error"; status: number; message: string }
> {
  const cfg = await getCloudConfig();
  if (!isCloudConfigured(cfg)) {
    return { kind: "error", status: 0, message: "cloud not configured" };
  }
  try {
    return await withTimeout(BLOB_TIMEOUT_MS, async (signal) => {
      const r = await fetch(
        cloudUrl(cfg, `/api/events/${encodeURIComponent(cloudEventId)}/copy`),
        {
          method: "POST",
          headers: {
            ...authHeaders(cfg),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
          signal,
        },
      );
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        return {
          kind: "error" as const,
          status: r.status,
          message: `HTTP ${r.status} ${txt.slice(0, 200)}`,
        };
      }
      const data = (await r.json()) as { event: CloudEventMeta };
      return { kind: "ok" as const, event: data.event };
    });
  } catch (e) {
    return {
      kind: "error",
      status: 0,
      message: e instanceof Error ? e.message : "copy failed",
    };
  }
}

/** Soft-delete a cloud event. */
export async function deleteCloudEvent(
  cloudEventId: string,
): Promise<
  | { kind: "ok" }
  | { kind: "error"; status: number; message: string }
> {
  const cfg = await getCloudConfig();
  if (!isCloudConfigured(cfg)) {
    return { kind: "error", status: 0, message: "cloud not configured" };
  }
  try {
    return await withTimeout(REQUEST_TIMEOUT_MS, async (signal) => {
      const r = await fetch(
        cloudUrl(cfg, `/api/events/${encodeURIComponent(cloudEventId)}`),
        {
          method: "DELETE",
          headers: authHeaders(cfg),
          signal,
        },
      );
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        return {
          kind: "error" as const,
          status: r.status,
          message: `HTTP ${r.status} ${txt.slice(0, 200)}`,
        };
      }
      return { kind: "ok" as const };
    });
  } catch (e) {
    return {
      kind: "error",
      status: 0,
      message: e instanceof Error ? e.message : "delete failed",
    };
  }
}

export async function getCloudEventMeta(
  cloudEventId: string,
): Promise<CloudEventMeta | null> {
  const cfg = await getCloudConfig();
  if (!isCloudConfigured(cfg)) return null;
  return withTimeout(REQUEST_TIMEOUT_MS, async (signal) => {
    const r = await fetch(
      cloudUrl(cfg, `/api/events/${encodeURIComponent(cloudEventId)}`),
      { headers: authHeaders(cfg), cache: "no-store", signal },
    );
    if (r.status === 404) return null;
    if (!r.ok) {
      throw new Error(`getCloudEventMeta: HTTP ${r.status}`);
    }
    const data = (await r.json()) as { event: CloudEventMeta };
    return data.event;
  });
}

/* ============================================================================
 * Pull: cloud -> bytes
 * ========================================================================== */

export async function pullCloudEventBlob(
  cloudEventId: string,
  version?: number,
): Promise<PullResult> {
  const cfg = await getCloudConfig();
  if (!isCloudConfigured(cfg)) {
    return { kind: "error", status: 0, message: "cloud not configured" };
  }
  try {
    return await withTimeout(BLOB_TIMEOUT_MS, async (signal) => {
      const suffix = version ? `?version=${version}` : "";
      const r = await fetch(
        cloudUrl(cfg, `/api/events/${encodeURIComponent(cloudEventId)}/blob${suffix}`),
        { headers: authHeaders(cfg), cache: "no-store", signal },
      );
      if (!r.ok) {
        return {
          kind: "error" as const,
          status: r.status,
          message: `HTTP ${r.status}`,
        };
      }
      const bytes = Buffer.from(await r.arrayBuffer());
      const sha = r.headers.get("x-event-sha256") ?? sha256Hex(bytes);
      const v = parseInt(r.headers.get("x-event-version") ?? "0", 10);
      return { kind: "ok" as const, version: v, sha256: sha, bytes };
    });
  } catch (e) {
    return {
      kind: "error",
      status: 0,
      message: e instanceof Error ? e.message : "pull failed",
    };
  }
}

/* ============================================================================
 * Push: bytes -> cloud
 * ========================================================================== */

/**
 * Create a brand-new cloud event from current local bytes.
 * Returns the new cloud event id + version/sha on success.
 */
export async function createCloudEvent(
  name: string,
  bytes: Buffer,
  opts?: { eventName?: string | null; trainingMode?: boolean },
): Promise<
  | { kind: "ok"; event: CloudEventMeta }
  | {
      kind: "error";
      status: number;
      message: string;
      /**
       * Populated for 409 responses from the masters "duplicate
       * filename" validator. Callers (specifically the auto-link
       * save path) use it to transparently adopt the existing
       * cloud event instead of creating a new one — without this
       * the desktop renderer would have to re-parse the nested
       * JSON out of `message`, which it was failing to do.
       */
      conflictingId?: string;
    }
> {
  const cfg = await getCloudConfig();
  if (!isCloudConfigured(cfg)) {
    return { kind: "error", status: 0, message: "cloud not configured" };
  }
  try {
    return await withTimeout(BLOB_TIMEOUT_MS, async (signal) => {
      const url = new URL(cloudUrl(cfg, "/api/events"));
      url.searchParams.set("name", name);
      if (opts?.eventName && opts.eventName.trim().length > 0) {
        url.searchParams.set("eventName", opts.eventName.trim());
      }
      if (opts?.trainingMode) {
        url.searchParams.set("trainingMode", "1");
      }
      const r = await fetch(url.toString(), {
        method: "POST",
        headers: {
          ...authHeaders(cfg),
          "Content-Type": "application/octet-stream",
        },
        // @ts-expect-error - Node fetch accepts Buffer
        body: bytes,
        signal,
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        let parsed: { conflictingId?: string; error?: string } = {};
        try {
          parsed = txt ? (JSON.parse(txt) as typeof parsed) : {};
        } catch {
          parsed = {};
        }
        return {
          kind: "error" as const,
          status: r.status,
          message: parsed.error
            ? `HTTP ${r.status} ${parsed.error}`
            : `HTTP ${r.status} ${txt.slice(0, 200)}`,
          conflictingId: parsed.conflictingId?.trim() || undefined,
        };
      }
      const data = (await r.json()) as { event: CloudEventMeta };
      return { kind: "ok" as const, event: data.event };
    });
  } catch (e) {
    return {
      kind: "error",
      status: 0,
      message: e instanceof Error ? e.message : "create failed",
    };
  }
}

/**
 * Upload a new blob version to an existing cloud event.
 *
 * `expectedVersion` must equal the cloud's `currentVersion` or the
 * cloud returns 409. Pass "*" to force-overwrite (the conflict-prompt
 * "Overwrite cloud" path).
 */
export async function pushCloudEventBlob(
  cloudEventId: string,
  bytes: Buffer,
  expectedVersion: number | "*",
): Promise<PushResult> {
  const cfg = await getCloudConfig();
  if (!isCloudConfigured(cfg)) {
    return { kind: "error", status: 0, message: "cloud not configured" };
  }
  try {
    return await withTimeout(BLOB_TIMEOUT_MS, async (signal) => {
      const r = await fetch(
        cloudUrl(cfg, `/api/events/${encodeURIComponent(cloudEventId)}/blob`),
        {
          method: "PUT",
          headers: {
            ...authHeaders(cfg),
            "Content-Type": "application/octet-stream",
            "X-Expected-Version": String(expectedVersion),
          },
          // @ts-expect-error - Node fetch accepts Buffer
          body: bytes,
          signal,
        },
      );
      if (r.status === 409) {
        const data = (await r.json()) as { currentVersion: number };
        return {
          kind: "conflict" as const,
          currentVersion: data.currentVersion,
        };
      }
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        return {
          kind: "error" as const,
          status: r.status,
          message: `HTTP ${r.status} ${txt.slice(0, 200)}`,
        };
      }
      const data = (await r.json()) as {
        version: number;
        sha256: string;
        sizeBytes: number;
      };
      return {
        kind: "ok" as const,
        version: data.version,
        sha256: data.sha256,
        sizeBytes: data.sizeBytes,
      };
    });
  } catch (e) {
    return {
      kind: "error",
      status: 0,
      message: e instanceof Error ? e.message : "push failed",
    };
  }
}

/* ============================================================================
 * Local link-row helpers
 * ========================================================================== */

export type CloudEventLinkRow = {
  tournamentId: string;
  cloudEventId: string;
  baseVersion: number;
  lastSyncedSha: string | null;
  currentLocalSha: string | null;
  lastSyncedBytes: number;
  lastPulledAt: Date | null;
  lastPushedAt: Date | null;
  pendingPushAt: Date | null;
  lastError: string | null;
  localMirrorPath: string | null;
};

export async function getCloudEventLink(
  tournamentId: string,
): Promise<CloudEventLinkRow | null> {
  await ensureCloudTables();
  return prisma.cloudEventLink.findUnique({ where: { tournamentId } });
}

export async function upsertCloudEventLink(
  tournamentId: string,
  patch: Partial<Omit<CloudEventLinkRow, "tournamentId">> & {
    cloudEventId?: string;
  },
): Promise<CloudEventLinkRow> {
  await ensureCloudTables();
  if (!patch.cloudEventId) {
    // Pure update against existing row.
    return prisma.cloudEventLink.update({
      where: { tournamentId },
      data: patch,
    });
  }
  return prisma.cloudEventLink.upsert({
    where: { tournamentId },
    create: {
      tournamentId,
      cloudEventId: patch.cloudEventId,
      baseVersion: patch.baseVersion ?? 0,
      lastSyncedSha: patch.lastSyncedSha ?? null,
      currentLocalSha: patch.currentLocalSha ?? null,
      lastSyncedBytes: patch.lastSyncedBytes ?? 0,
      lastPulledAt: patch.lastPulledAt ?? null,
      lastPushedAt: patch.lastPushedAt ?? null,
      pendingPushAt: patch.pendingPushAt ?? null,
      lastError: patch.lastError ?? null,
      localMirrorPath: patch.localMirrorPath ?? null,
    },
    update: patch,
  });
}

export async function deleteCloudEventLink(
  tournamentId: string,
): Promise<void> {
  await ensureCloudTables();
  await prisma.cloudEventLink
    .delete({ where: { tournamentId } })
    .catch(() => {
      /* already gone */
    });
}

/* ============================================================================
 * Status computation — the single source of truth for the header badge.
 * ========================================================================== */

export type SyncStatus =
  | { kind: "LOCAL_ONLY" }
  | {
      kind: "SYNCED";
      version: number;
      lastSyncedAt: Date | null;
    }
  | {
      kind: "NOT_SYNCED";
      version: number;
      reason: "dirty" | "pending";
    }
  | {
      kind: "CONFLICT";
      localVersion: number;
      cloudVersion: number;
    }
  | {
      kind: "OFFLINE";
      version: number;
      lastError: string;
    }
  | { kind: "SYNCING" };

/**
 * Compute the badge state for a given tournament from its CloudEventLink
 * row plus optional fresh cloud metadata. If `cloudMeta` is omitted we
 * derive status purely from the local row (faster but can be stale).
 *
 * A SYNCING state is returned when `pendingPushAt` is within the last
 * 30 seconds — i.e. a push is in flight or very recently attempted.
 */
export function computeStatus(
  link: CloudEventLinkRow | null,
  cloudMeta?: CloudEventMeta | null,
): SyncStatus {
  if (!link) return { kind: "LOCAL_ONLY" };

  const pendingAge = link.pendingPushAt
    ? Date.now() - link.pendingPushAt.getTime()
    : Number.POSITIVE_INFINITY;
  if (pendingAge < 30_000) return { kind: "SYNCING" };

  if (cloudMeta && cloudMeta.currentVersion > link.baseVersion) {
    return {
      kind: "CONFLICT",
      localVersion: link.baseVersion,
      cloudVersion: cloudMeta.currentVersion,
    };
  }

  const dirty =
    !!link.currentLocalSha &&
    !!link.lastSyncedSha &&
    link.currentLocalSha !== link.lastSyncedSha;
  const pending = !!link.pendingPushAt;
  if (dirty || pending) {
    if (link.lastError) {
      return {
        kind: "OFFLINE",
        version: link.baseVersion,
        lastError: link.lastError,
      };
    }
    return {
      kind: "NOT_SYNCED",
      version: link.baseVersion,
      reason: dirty ? "dirty" : "pending",
    };
  }

  return {
    kind: "SYNCED",
    version: link.baseVersion,
    lastSyncedAt: link.lastPushedAt ?? link.lastPulledAt,
  };
}
