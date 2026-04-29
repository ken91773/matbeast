import type { BeltRank } from "@prisma/client";
import { drainOutbox, queueOutboxOp } from "@/lib/cloud-sync";

/** Push a fully-shaped profile.upsert op to the cloud outbox + drain. */
export async function queueProfileUpsertForCloud(row: {
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
}): Promise<void> {
  await queueOutboxOp("profile.upsert", {
    firstName: row.firstName,
    lastName: row.lastName,
    nickname: row.nickname,
    academyName: row.academyName,
    unofficialWeight: row.unofficialWeight,
    heightFeet: row.heightFeet,
    heightInches: row.heightInches,
    age: row.age,
    beltRank: row.beltRank,
    profilePhotoUrl: row.profilePhotoUrl,
    headShotUrl: row.headShotUrl,
  }).catch(() => {});
  await drainOutbox().catch(() => {});
}
