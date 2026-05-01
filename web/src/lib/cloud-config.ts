import { prisma } from "@/lib/prisma";
import { ensureCloudTables } from "@/lib/cloud-config-table";

const SINGLETON_ID = "default";
const DEFAULT_CLOUD_BASE_URL = "https://matbeast-masters.vercel.app";

export type CloudConfig = {
  id: string;
  desktopToken: string;
  cloudBaseUrl: string;
  syncEnabled: boolean;
  lastProfilesPullAt: Date | null;
  lastTeamNamesPullAt: Date | null;
  lastSyncError: string | null;
  /** When false, pullProfiles/pullTeamNames skip downloading live masters from cloud. */
  liveMastersPullFromCloud: boolean;
  updatedAt: Date;
};

/**
 * Read the singleton cloud config row, creating it with defaults if it
 * doesn't exist yet. Always returns a row.
 */
export async function getCloudConfig(): Promise<CloudConfig> {
  await ensureCloudTables();
  let row = await prisma.cloudConfig.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) {
    row = await prisma.cloudConfig.create({
      data: {
        id: SINGLETON_ID,
        desktopToken: "",
        cloudBaseUrl: DEFAULT_CLOUD_BASE_URL,
        syncEnabled: true,
        liveMastersPullFromCloud: true,
      },
    });
  }
  return row;
}

export type UpdateCloudConfigInput = {
  desktopToken?: string;
  cloudBaseUrl?: string;
  syncEnabled?: boolean;
  lastProfilesPullAt?: Date | null;
  lastTeamNamesPullAt?: Date | null;
  lastSyncError?: string | null;
  liveMastersPullFromCloud?: boolean;
};

export async function updateCloudConfig(
  input: UpdateCloudConfigInput,
): Promise<CloudConfig> {
  await ensureCloudTables();
  await prisma.cloudConfig.upsert({
    where: { id: SINGLETON_ID },
    create: {
      id: SINGLETON_ID,
      desktopToken: input.desktopToken ?? "",
      cloudBaseUrl: input.cloudBaseUrl ?? DEFAULT_CLOUD_BASE_URL,
      syncEnabled: input.syncEnabled ?? true,
      lastProfilesPullAt: input.lastProfilesPullAt ?? null,
      lastTeamNamesPullAt: input.lastTeamNamesPullAt ?? null,
      lastSyncError: input.lastSyncError ?? null,
      liveMastersPullFromCloud: input.liveMastersPullFromCloud ?? true,
    },
    update: {
      ...(input.desktopToken !== undefined && { desktopToken: input.desktopToken }),
      ...(input.cloudBaseUrl !== undefined && { cloudBaseUrl: input.cloudBaseUrl }),
      ...(input.syncEnabled !== undefined && { syncEnabled: input.syncEnabled }),
      ...(input.lastProfilesPullAt !== undefined && {
        lastProfilesPullAt: input.lastProfilesPullAt,
      }),
      ...(input.lastTeamNamesPullAt !== undefined && {
        lastTeamNamesPullAt: input.lastTeamNamesPullAt,
      }),
      ...(input.lastSyncError !== undefined && {
        lastSyncError: input.lastSyncError,
      }),
      ...(input.liveMastersPullFromCloud !== undefined && {
        liveMastersPullFromCloud: input.liveMastersPullFromCloud,
      }),
    },
  });
  return getCloudConfig();
}

/**
 * True when the desktop is allowed to talk to the cloud right now.
 *
 * v1.2.0 (Model A — shared workspace, no auth): the cloud no longer
 * requires a token, so the only gate is whether the operator has
 * paused sync from Cloud Settings. The `desktopToken` field is kept
 * for backwards compatibility (some installs still have one saved
 * from v1.1.x and earlier) and is forwarded as a Bearer header when
 * present, but its presence/absence no longer affects "configured".
 *
 * All cloud sync helpers no-op when this returns false.
 */
export function isCloudConfigured(cfg: CloudConfig): boolean {
  return cfg.syncEnabled;
}
