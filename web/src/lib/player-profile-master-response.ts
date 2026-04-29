import { NextResponse } from "next/server";

/** Network tab: which physical table was used (`live` = Master*, `training` = TrainingMaster*). */
export const PROFILE_MASTER_TARGET_HEADER = "x-matbeast-profile-master-target";

export function jsonProfilePayload<T>(data: T, training: boolean) {
  return NextResponse.json(data, {
    headers: { [PROFILE_MASTER_TARGET_HEADER]: training ? "training" : "live" },
  });
}
