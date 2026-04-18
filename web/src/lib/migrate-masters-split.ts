import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { updateCloudConfig } from "@/lib/cloud-config";

const MIGRATION_ID = "masters_live_training_split_v1";

/**
 * Live vs training master lists (two separate DB tables):
 *
 * - **MasterPlayerProfile / MasterTeamName** — shared pool for **live** events
 *   (cloud-synced masters in production).
 * - **TrainingMasterPlayerProfile / TrainingMasterTeamName** — pool used only when
 *   `Tournament.trainingMode` is true (practice / sample data).
 *
 * Historically, sample data lived in Master*. This migration **copies** those
 * rows into Training* (preserving ids where possible), then **clears** Master*
 * so live work starts clean while training events keep the old sample rows.
 *
 * Runs on master-list API access until Master* is empty. Safe to call repeatedly:
 * if Master* is already empty, we only ensure the migration marker exists.
 *
 * **Repair:** If the marker was recorded early but Master* still had rows (e.g.
 * a race or old bug), we no longer bail out just because the marker exists —
 * we finish copy + delete whenever Master* is non-empty.
 *
 * After clearing live Master*, cloud **pull** for those tables is disabled so
 * Mat Beast Masters does not immediately refill local SQLite. Re-enable in
 * Cloud sync settings when you want live lists synced from the cloud again.
 */
export async function migrateMastersSplitIfNeeded(): Promise<void> {
  const masterProfiles = await prisma.masterPlayerProfile.count();
  const masterTeams = await prisma.masterTeamName.count();
  if (masterProfiles === 0 && masterTeams === 0) {
    await prisma.appSchemaMigration.upsert({
      where: { id: MIGRATION_ID },
      create: { id: MIGRATION_ID },
      update: {},
    });
    return;
  }

  await prisma.$transaction(async (tx) => {
    const profiles = await tx.masterPlayerProfile.findMany();
    for (const p of profiles) {
      const byId = await tx.trainingMasterPlayerProfile.findUnique({
        where: { id: p.id },
      });
      if (byId) continue;
      try {
        await tx.trainingMasterPlayerProfile.create({
          data: {
            id: p.id,
            firstName: p.firstName,
            lastName: p.lastName,
            nickname: p.nickname,
            academyName: p.academyName,
            unofficialWeight: p.unofficialWeight,
            heightFeet: p.heightFeet,
            heightInches: p.heightInches,
            age: p.age,
            beltRank: p.beltRank,
            profilePhotoUrl: p.profilePhotoUrl,
            headShotUrl: p.headShotUrl,
          },
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002"
        ) {
          /* same first/last already in training under another id — skip */
        } else {
          throw e;
        }
      }
    }

    const teams = await tx.masterTeamName.findMany();
    for (const t of teams) {
      const byId = await tx.trainingMasterTeamName.findUnique({
        where: { id: t.id },
      });
      if (byId) continue;
      try {
        await tx.trainingMasterTeamName.create({
          data: { id: t.id, name: t.name },
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002"
        ) {
          /* team name already in training */
        } else {
          throw e;
        }
      }
    }

    await tx.masterPlayerProfile.deleteMany();
    await tx.masterTeamName.deleteMany();
    await tx.appSchemaMigration.upsert({
      where: { id: MIGRATION_ID },
      create: { id: MIGRATION_ID },
      update: {},
    });
  });

  await updateCloudConfig({ liveMastersPullFromCloud: false });
}
