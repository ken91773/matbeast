/**
 * Regions in the *scoreboard* SVG user space (viewBox 0 0 1440 810).
 * Source: public/scoreboard.svg — path252 (timer cell), clipPath path301 / path300.
 * With object-fill on 1920×1080 (same 16:9 as 1440×810), % of stage = % of viewBox.
 */

export const SCOREBOARD_VIEWBOX = { width: 1440, height: 810 } as const;

export type VbRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Center hex/timer panel (`path252` bounding box) */
export const CENTER_TIMER: VbRect = {
  x: 563.72204,
  y: 238.79221,
  width: 815.57394 - 563.72204,
  height: 376.22722 - 238.79221,
};

/** Legacy lower strip (`clipPath301`); round label is rendered inside `CENTER_TIMER` in the overlay */
export const CENTER_ROUND: VbRect = {
  x: 514.5,
  y: 641.25,
  width: 925.49998 - 514.5,
  height: 694.5 - 641.25,
};

/** Lower strip for OT line (`path300`) */
export const CENTER_OT_STRIP: VbRect = {
  x: 514.5,
  y: 699,
  width: 925.5 - 514.5,
  height: 736.5 - 699,
};

/** Left upper strip (player last name) from `g24` / path23 under `g48`. */
export const LEFT_PLAYER_STRIP: VbRect = {
  x: 178.70051 + 0.890625,
  y: 237.60856 + 1.699219,
  width: 378.26953 - 0.890625,
  height: 52.558594 - 1.699219,
};

/**
 * Right upper strip (player last name): path49 with transform
 * matrix(-0.99732088,0,0,1,1201.3584,238.11408)
 */
export const RIGHT_PLAYER_STRIP: VbRect = (() => {
  const a = -0.99732088;
  const tx = 1201.3584;
  const x0 = 0.890625;
  const x1 = 378.26953;
  const xLeft = Math.min(a * x0 + tx, a * x1 + tx);
  const xRight = Math.max(a * x0 + tx, a * x1 + tx);
  return {
    x: xLeft,
    y: 238.11408 + 1.699219,
    width: xRight - xLeft,
    height: 52.558594 - 1.699219,
  };
})();

/** Left lower strip (team name): path328 with matrix(-1.2361338,0,0,1,558.85076,293.77459). */
export const LEFT_TEAM_STRIP: VbRect = (() => {
  const a = -1.2361338;
  const tx = 558.85076;
  const x0 = 2.3160834;
  const x1 = 305.78932;
  const xLeft = Math.min(a * x0 + tx, a * x1 + tx);
  const xRight = Math.max(a * x0 + tx, a * x1 + tx);
  return {
    x: xLeft,
    y: 293.77459 + 1.7276525,
    width: xRight - xLeft,
    height: 38.181588 - 1.7276525,
  };
})();

/** Right lower strip (team name): path51 with matrix(1.2361338,0,0,1,821.20814,294.28011). */
export const RIGHT_TEAM_STRIP: VbRect = (() => {
  const a = 1.2361338;
  const tx = 821.20814;
  const x0 = 2.3160834;
  const x1 = 305.78932;
  return {
    x: a * x0 + tx,
    y: 294.28011 + 1.7276525,
    width: a * (x1 - x0),
    height: 38.181588 - 1.7276525,
  };
})();

/** Five silhouette icons + health bar row (`g43`) — icon row only, viewBox units */
export const SILHOUETTE_ICON_SIZE = 40.394096;
/** Left column: image `x=` in scoreboard.svg (slot 0 … 4 left → … → toward timer). */
export const LEFT_SILHOUETTE_ICON_X: readonly number[] = [
  121.77338, 202.91637, 285.13171, 367.85257, 448.92139,
];

const LEFT_ICON_STRIP_X0 = LEFT_SILHOUETTE_ICON_X[0]!;
const LEFT_ICON_STRIP_X1 =
  LEFT_SILHOUETTE_ICON_X[4]! + SILHOUETTE_ICON_SIZE;

export const LEFT_SILHOUETTE_ICONS: VbRect = {
  x: LEFT_ICON_STRIP_X0,
  y: 336.9559,
  width: LEFT_ICON_STRIP_X1 - LEFT_ICON_STRIP_X0,
  height: SILHOUETTE_ICON_SIZE,
};

/** Right column: `g47` = mirror(matrix(-1,0,0,1,1379.044,…)) of `g43` */
const MIRROR_TX = 1379.044;
export const RIGHT_SILHOUETTE_ICONS: VbRect = {
  x: MIRROR_TX - LEFT_ICON_STRIP_X1,
  y: 336.9559,
  width: LEFT_ICON_STRIP_X1 - LEFT_ICON_STRIP_X0,
  height: SILHOUETTE_ICON_SIZE,
};

/** Center of slot `i` (0–4) as fraction [0,1] along the left icon strip (for overlay X). */
export function silhouetteSlotCenterLeftFrac(i: number): number {
  const x = LEFT_SILHOUETTE_ICON_X[i];
  if (x === undefined) return 0;
  const cx = x + SILHOUETTE_ICON_SIZE / 2;
  return (cx - LEFT_ICON_STRIP_X0) / (LEFT_ICON_STRIP_X1 - LEFT_ICON_STRIP_X0);
}

/** Center of slot `i` along the right strip (same slot index as left; 4 = toward timer). */
export function silhouetteSlotCenterRightFrac(i: number): number {
  const xL = LEFT_SILHOUETTE_ICON_X[i];
  if (xL === undefined) return 0;
  const cxWorld = MIRROR_TX - (xL + SILHOUETTE_ICON_SIZE / 2);
  const x0 = RIGHT_SILHOUETTE_ICONS.x;
  return (cxWorld - x0) / RIGHT_SILHOUETTE_ICONS.width;
}

/** CSS % positions relative to the 1920×1080 stage (matches viewBox). */
export function vbRectToPercentStyle(box: VbRect): {
  left: `${number}%`;
  top: `${number}%`;
  width: `${number}%`;
  height: `${number}%`;
} {
  const { width: vw, height: vh } = SCOREBOARD_VIEWBOX;
  return {
    left: `${(box.x / vw) * 100}%`,
    top: `${(box.y / vh) * 100}%`,
    width: `${(box.width / vw) * 100}%`,
    height: `${(box.height / vh) * 100}%`,
  };
}
