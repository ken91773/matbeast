import type { BeltRank } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ensureMasterPlayerProfileTable } from "@/lib/master-player-profile-table";
import { migrateMastersSplitIfNeeded } from "@/lib/migrate-masters-split";
import { queueProfileUpsertForCloud } from "@/lib/master-profile-outbox";

const BELTS: readonly BeltRank[] = [
  "WHITE",
  "BLUE",
  "PURPLE",
  "BROWN",
  "BLACK",
];

function parseBelt(v: BeltRank): BeltRank {
  return BELTS.includes(v) ? v : "WHITE";
}

export type RosterPlayerMasterFields = {
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

/**
 * When a roster row is created/updated via `/api/players`, mirror it into the
 * global master profile table (live or training) so the master picker stays in sync.
 *
 * The `useTrainingMasters` flag must come from the same rules as
 * `resolveUseTrainingMastersForProfileRequest` (active tab / header / body
 * `tournamentId` first — not only the team row's linked tournament), or
 * production tabs can write `TrainingMaster*` while `/api/player-profiles`
 * writes `Master*`.
 */
export async function upsertGlobalMasterPlayerFromRosterPlayer(
  player: RosterPlayerMasterFields,
  useTrainingMasters: boolean,
): Promise<void> {
  await migrateMastersSplitIfNeeded();
  const firstName = player.firstName.trim().toUpperCase();
  const lastName = player.lastName.trim().toUpperCase();
  if (!firstName || !lastName) return;

  if (useTrainingMasters) {
    const existing = await prisma.trainingMasterPlayerProfile.findUnique({
      where: { firstName_lastName: { firstName, lastName } },
    });
    const data = {
      nickname: player.nickname,
      academyName: player.academyName,
      unofficialWeight: player.unofficialWeight,
      heightFeet: player.heightFeet,
      heightInches: player.heightInches,
      age: player.age,
      beltRank: parseBelt(player.beltRank),
      profilePhotoUrl: player.profilePhotoUrl,
      headShotUrl: player.headShotUrl,
    };
    if (existing) {
      await prisma.trainingMasterPlayerProfile.update({
        where: { id: existing.id },
        data,
      });
    } else {
      await prisma.trainingMasterPlayerProfile.create({
        data: {
          firstName,
          lastName,
          ...data,
        },
      });
    }
    return;
  }

  await ensureMasterPlayerProfileTable();
  const existing = await prisma.masterPlayerProfile.findUnique({
    where: { firstName_lastName: { firstName, lastName } },
  });
  const data = {
    nickname: player.nickname,
    academyName: player.academyName,
    unofficialWeight: player.unofficialWeight,
    heightFeet: player.heightFeet,
    heightInches: player.heightInches,
    age: player.age,
    beltRank: parseBelt(player.beltRank),
    profilePhotoUrl: player.profilePhotoUrl,
    headShotUrl: player.headShotUrl,
  };

  let row;
  if (existing) {
    row = await prisma.masterPlayerProfile.update({
      where: { id: existing.id },
      data,
    });
  } else {
    row = await prisma.masterPlayerProfile.create({
      data: {
        firstName,
        lastName,
        ...data,
      },
    });
  }
  await queueProfileUpsertForCloud(row);
}
