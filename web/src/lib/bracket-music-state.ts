/**
 * Shared shape for the bracket overlay music state — host filesystem
 * audio loop that the operator pairs with the bracket overlay window for
 * NDI capture. Owned by the Electron main process (persisted in
 * `desktop-preferences.json`) and pushed to renderers on every change via
 * `window.matBeastDesktop.onBracketMusicStateChange`.
 *
 * Imported by:
 *  - `src/types/matbeast-desktop.d.ts` (declares the IPC API surface)
 *  - `src/app/overlay/use-bracket-overlay-music.ts` (audio engine in the
 *    bracket output window)
 *  - `src/components/dashboard/DashboardFullWorkspace.tsx` (operator UI in
 *    the Overlay card header)
 */
export type BracketMusicState = {
  /** Absolute host path the operator picked, or `null` for explicit NONE. */
  filePath: string | null;
  /** Base name for display in the dashboard ("track.mp3"); `null` when `filePath` is null. */
  fileName: string | null;
  /**
   * Bumped on every persisted change in main. Renderers append `?r=<revision>`
   * to the stable `mat-beast-asset://music/track` URL to force a reload of
   * the underlying file even though the URL itself doesn't change.
   */
  revision: number;
  /** PLAY/STOP toggle on the dashboard header. Defaults to `true` so a configured track auto-loops on launch. */
  playing: boolean;
  /**
   * Whether the operator hears the music locally on their PC. `false`
   * silences the bracket overlay's `AudioContext` via
   * `setSinkId({ type: "none" })` (or a gain-mute fallback) while leaving
   * the audio graph live so future NDI worklet taps still see PCM.
   */
  monitor: boolean;
};

/** Result of opening the file picker via `chooseBracketMusicFile`. */
export type BracketMusicChooseResult =
  | { ok: true; state: BracketMusicState }
  | { ok: false; canceled?: boolean; error?: string };

/** Result of any state-mutating IPC call (set-playing, set-monitor, clear-file). */
export type BracketMusicMutationResult =
  | { ok: true; state: BracketMusicState }
  | { ok: false; error?: string };
