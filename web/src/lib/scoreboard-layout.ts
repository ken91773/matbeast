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
