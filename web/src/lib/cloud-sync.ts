import { prisma } from "@/lib/prisma";
import {
  getCloudConfig,
  updateCloudConfig,
  isCloudConfigured,
  type CloudConfig,
} from "@/lib/cloud-config";
import { ensureCloudTables } from "@/lib/cloud-config-table";
import { ensureMasterPlayerProfileTable } from "@/lib/master-player-profile-table";
import { ensureMasterTeamNameTable } from "@/lib/master-team-name-table";
import type { BeltRank } from "@prisma/client";

/* ============================================================================
 * Types matching the Mat Beast Masters cloud API
 * ========================================================================== */

type CloudTeamRow = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};
type CloudTeamListResponse = { teams: CloudTeamRow[] };
type CloudTeamUpsertResponse = { team: CloudTeamRow; alreadyExisted?: boolean };

type CloudProfileRow = {
  id: string;
  firstName: string;
  lastName: string;
  nickname: string | null;
  academyName: string | null;
  unofficialWeight: number | null;
  heightFeet: number | null;
  heightInches: number | null;
  age: number | null;
  beltRank: BeltRank;
  profilePhotoUrl: string | null;
  headShotUrl: string | null;
  createdAt: string;
  updatedAt: string;
};
type CloudProfileListResponse = { profiles: CloudProfileRow[] };
type CloudProfileUpsertResponse = {
  profile: CloudProfileRow;
  alreadyExisted?: boolean;
};

/* ============================================================================
 * Outbox payload shapes (what we put in MasterCloudOutbox.payloadJson)
 * ========================================================================== */

export type OutboxOpKind =
  | "team-name.upsert"
  | "team-name.delete"
  | "profile.upsert"
  | "profile.delete";

type TeamUpsertPayload = { name: string };
type TeamDeletePayload = { name: string; cloudId: string | null };
type ProfileUpsertPayload = {
  firstName: string;
  lastName: string;
  nickname: string | null;
  academyName: string | null;
  unofficialWeight: number | null;
  heightFeet: number | null;
  heightInches: number | null;
  age: number | null;
  beltRank: BeltRank;
  profilePhotoUrl: string | null;
  headShotUrl: string | null;
};
type ProfileDeletePayload = {
  firstName: string;
  lastName: string;
  cloudId: string | null;
};

/* ============================================================================
 * HTTP helper: every cloud call goes through this so we get consistent
 * timeout, header, and error handling.
 * ========================================================================== */

const REQUEST_TIMEOUT_MS = 12_000;

async function cloudFetch(
  cfg: CloudConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `${cfg.cloudBaseUrl.replace(/\/+$/, "")}${path}`;
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.desktopToken}`,
        ...(init.headers ?? {}),
      },
      cache: "no-store",
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function expectOk(res: Response, ctx: string): Promise<void> {
  if (res.ok) return;
  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {
    /* ignore */
  }
  throw new Error(`${ctx}: HTTP ${res.status} ${bodyText.slice(0, 200)}`);
}

/* ============================================================================
 * OUTBOX queueing
 * ========================================================================== */

export async function queueOutboxOp(
  kind: OutboxOpKind,
  payload: unknown,
): Promise<void> {
  await ensureCloudTables();
  await prisma.masterCloudOutbox.create({
    data: { kind, payloadJson: JSON.stringify(payload) },
  });
}

/* ============================================================================
 * PULL: cloud -> local
 * ========================================================================== */

/** Pull master team names from cloud and merge into local SQLite. */
export async function pullTeamNames(): Promise<{ pulled: number }> {
  const cfg = await getCloudConfig();
  if (!isCloudConfigured(cfg)) return { pulled: 0 };
  await ensureMasterTeamNameTable();

  const res = await cloudFetch(cfg, "/api/master-team-names", { method: "GET" });
  await expectOk(res, "pullTeamNames");
  const data = (await res.json()) as CloudTeamListResponse;

  let pulled = 0;
  for (const cloudTeam of data.teams) {
    const name = cloudTeam.name.trim().toUpperCase();
    if (!name) continue;
    await prisma.masterTeamName.upsert({
      where: { name },
      create: { name, cloudId: cloudTeam.id },
      update: { cloudId: cloudTeam.id },
    });
    pulled++;
  }
  await updateCloudConfig({
    lastTeamNamesPullAt: new Date(),
    lastSyncError: null,
  });
  return { pulled };
}

/** Pull master player profiles from cloud and merge into local SQLite. */
export async function pullProfiles(): Promise<{ pulled: number }> {
  const cfg = await getCloudConfig();
  if (!isCloudConfigured(cfg)) return { pulled: 0 };
  await ensureMasterPlayerProfileTable();

  const res = await cloudFetch(cfg, "/api/master-player-profiles", {
    method: "GET",
  });
  await expectOk(res, "pullProfiles");
  const data = (await res.json()) as CloudProfileListResponse;

  let pulled = 0;
  for (const c of data.profiles) {
    const firstName = c.firstName.trim().toUpperCase();
    const lastName = c.lastName.trim().toUpperCase();
    if (!firstName || !lastName) continue;

    const fields = {
      nickname: c.nickname,
      academyName: c.academyName,
      unofficialWeight: c.unofficialWeight,
      heightFeet: c.heightFeet,
      heightInches: c.heightInches,
      age: c.age,
      beltRank: c.beltRank,
      profilePhotoUrl: c.profilePhotoUrl,
      headShotUrl: c.headShotUrl,
      cloudId: c.id,
    };
    await prisma.masterPlayerProfile.upsert({
      where: { firstName_lastName: { firstName, lastName } },
      create: { firstName, lastName, ...fields },
      update: fields,
    });
    pulled++;
  }
  await updateCloudConfig({
    lastProfilesPullAt: new Date(),
    lastSyncError: null,
  });
  return { pulled };
}

/* ============================================================================
 * PUSH (single op against cloud) — used by drainOutbox
 * ========================================================================== */

async function pushTeamUpsert(
  cfg: CloudConfig,
  payload: TeamUpsertPayload,
): Promise<void> {
  const res = await cloudFetch(cfg, "/api/master-team-names", {
    method: "POST",
    body: JSON.stringify({ name: payload.name }),
  });
  await expectOk(res, "pushTeamUpsert");
  const data = (await res.json()) as CloudTeamUpsertResponse;
  // Cache cloudId locally so future deletes are direct.
  await prisma.masterTeamName.updateMany({
    where: { name: payload.name },
    data: { cloudId: data.team.id },
  });
}

async function pushTeamDelete(
  cfg: CloudConfig,
  payload: TeamDeletePayload,
): Promise<void> {
  // Find the cloud id, preferring our cached one but falling back to a
  // name lookup so deletes still work for rows we never pushed ourselves.
  let cloudId = payload.cloudId;
  if (!cloudId) {
    const list = await cloudFetch(cfg, "/api/master-team-names", { method: "GET" });
    await expectOk(list, "pushTeamDelete (lookup)");
    const data = (await list.json()) as CloudTeamListResponse;
    cloudId = data.teams.find((t) => t.name === payload.name)?.id ?? null;
  }
  if (!cloudId) return; // already gone from cloud, treat as success
  const res = await cloudFetch(cfg, `/api/master-team-names/${cloudId}`, {
    method: "DELETE",
  });
  if (res.status === 404) return; // already gone, treat as success
  await expectOk(res, "pushTeamDelete");
}

async function pushProfileUpsert(
  cfg: CloudConfig,
  payload: ProfileUpsertPayload,
): Promise<void> {
  const res = await cloudFetch(cfg, "/api/master-player-profiles", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  await expectOk(res, "pushProfileUpsert");
  const data = (await res.json()) as CloudProfileUpsertResponse;
  await prisma.masterPlayerProfile.updateMany({
    where: { firstName: payload.firstName, lastName: payload.lastName },
    data: { cloudId: data.profile.id },
  });
}

async function pushProfileDelete(
  cfg: CloudConfig,
  payload: ProfileDeletePayload,
): Promise<void> {
  let cloudId = payload.cloudId;
  if (!cloudId) {
    const list = await cloudFetch(cfg, "/api/master-player-profiles", {
      method: "GET",
    });
    await expectOk(list, "pushProfileDelete (lookup)");
    const data = (await list.json()) as CloudProfileListResponse;
    cloudId =
      data.profiles.find(
        (p) =>
          p.firstName === payload.firstName && p.lastName === payload.lastName,
      )?.id ?? null;
  }
  if (!cloudId) return;
  const res = await cloudFetch(cfg, `/api/master-player-profiles/${cloudId}`, {
    method: "DELETE",
  });
  if (res.status === 404) return;
  await expectOk(res, "pushProfileDelete");
}

/* ============================================================================
 * DRAIN: process the outbox FIFO. Stops at the first transient failure
 * (no point hammering the cloud while it's down). Returns a summary.
 * ========================================================================== */

const MAX_ATTEMPTS = 5;

export type DrainResult = {
  drained: number;
  remaining: number;
  failedThisRun: number;
  lastError?: string;
};

export async function drainOutbox(): Promise<DrainResult> {
  await ensureCloudTables();
  const cfg = await getCloudConfig();
  if (!isCloudConfigured(cfg)) {
    const remaining = await prisma.masterCloudOutbox.count();
    return { drained: 0, remaining, failedThisRun: 0 };
  }

  let drained = 0;
  let failedThisRun = 0;
  let lastError: string | undefined;

  // FIFO; cap a single drain to 100 ops to keep request latency bounded.
  const queue = await prisma.masterCloudOutbox.findMany({
    where: { attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    take: 100,
  });

  for (const op of queue) {
    try {
      const payload = JSON.parse(op.payloadJson) as unknown;
      switch (op.kind) {
        case "team-name.upsert":
          await pushTeamUpsert(cfg, payload as TeamUpsertPayload);
          break;
        case "team-name.delete":
          await pushTeamDelete(cfg, payload as TeamDeletePayload);
          break;
        case "profile.upsert":
          await pushProfileUpsert(cfg, payload as ProfileUpsertPayload);
          break;
        case "profile.delete":
          await pushProfileDelete(cfg, payload as ProfileDeletePayload);
          break;
        default:
          throw new Error(`unknown outbox kind: ${op.kind}`);
      }
      await prisma.masterCloudOutbox.delete({ where: { id: op.id } });
      drained++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      lastError = msg;
      failedThisRun++;
      await prisma.masterCloudOutbox.update({
        where: { id: op.id },
        data: {
          attempts: op.attempts + 1,
          lastError: msg,
          lastAttemptAt: new Date(),
        },
      });
      // Stop on first failure; the cloud is probably unreachable.
      break;
    }
  }

  const remaining = await prisma.masterCloudOutbox.count();
  if (lastError) {
    await updateCloudConfig({ lastSyncError: lastError });
  } else if (drained > 0) {
    await updateCloudConfig({ lastSyncError: null });
  }
  return { drained, remaining, failedThisRun, lastError };
}

/* ============================================================================
 * Convenience: bundle pull + drain into a single "make local match cloud
 * as well as we can right now" call. Used by the on-demand sync that runs
 * before the existing master-list routes serve their response.
 * ========================================================================== */

export async function syncTeamNames(): Promise<{
  pulled: number;
  drainedOps: number;
  remainingOps: number;
  error?: string;
}> {
  let pulled = 0;
  let error: string | undefined;
  try {
    const r = await pullTeamNames();
    pulled = r.pulled;
  } catch (e) {
    error = e instanceof Error ? e.message : "pull failed";
    await updateCloudConfig({ lastSyncError: error });
  }
  const drain = await drainOutbox().catch((e) => {
    error = error ?? (e instanceof Error ? e.message : "drain failed");
    return { drained: 0, remaining: -1, failedThisRun: 0 };
  });
  return {
    pulled,
    drainedOps: drain.drained,
    remainingOps: drain.remaining,
    error,
  };
}

export async function syncProfiles(): Promise<{
  pulled: number;
  drainedOps: number;
  remainingOps: number;
  error?: string;
}> {
  let pulled = 0;
  let error: string | undefined;
  try {
    const r = await pullProfiles();
    pulled = r.pulled;
  } catch (e) {
    error = e instanceof Error ? e.message : "pull failed";
    await updateCloudConfig({ lastSyncError: error });
  }
  const drain = await drainOutbox().catch((e) => {
    error = error ?? (e instanceof Error ? e.message : "drain failed");
    return { drained: 0, remaining: -1, failedThisRun: 0 };
  });
  return {
    pulled,
    drainedOps: drain.drained,
    remainingOps: drain.remaining,
    error,
  };
}
