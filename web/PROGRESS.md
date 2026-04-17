# Progress Log

## Current Build Status
- Desktop app rebuilt successfully multiple times.
- Latest installer artifact:
  - `dist/Mat Beast Scoreboard Setup 0.6.0.exe` (2026-04-17 2:34 PM — DB
    schema-drift auto-heal + bundled-server.log rotation)

## Future Work Notes

### Built-in NDI audio sender with multi-destination fan-out
- Goal: keep the installer fully portable. All audio that plays through the
  scoreboard control (timer alerts, cue sounds, any future audio) should be
  exposable as an NDI audio source directly from the app — no VB-CABLE,
  VoiceMeeter, NDI Tools, or OBS plugin required on the production PC.
- Isolation requirement: NDI stream must contain **only** Mat Beast audio,
  never system sounds, browser audio, Teams, Windows notifications, etc.
- Selectable multi-destination output: user should be able to pick one or
  more simultaneous destinations from a single UI. Examples:
  - local speakers (real audio endpoint)
  - local headphones on a different endpoint (booth monitor)
  - NDI sender named "MATBEAST.SCOREBOARD.AUDIO" (or similar)
  - optionally another real device for a second operator
  Current Options ▸ AUDIO OUTPUT picker is single-select; this becomes a
  multi-select with the NDI sender appearing as a first-class destination
  alongside the system `audiooutput` devices.
- Architecture sketch (implementation-time reference):
  1. Renderer audio graph
     - Continue using a single `AudioContext` for all scoreboard audio.
     - Replace the current single-sink routing with a fan-out: one
       `AudioWorkletNode` (or `ScriptProcessorNode` fallback) taps the
       master bus and emits float32 interleaved PCM chunks.
     - For each selected real device, route `AudioContext.destination` via
       `setSinkId` in a per-device sub-context (Chromium only supports one
       sinkId per `AudioContext`, so multiple real devices require either
       multiple `AudioContext`s sharing a `MediaStream` source, or multiple
       `HTMLAudioElement`s each fed from a `MediaStreamAudioDestinationNode`
       with its own `setSinkId`).
  2. PCM → main process
     - Worklet posts fixed-size blocks (e.g. 480 frames @ 48 kHz = 10 ms)
       over IPC as `Float32Array` transferables.
     - Use a transfer-buffer pool to avoid GC pressure at steady state.
  3. Native NDI sender addon
     - N-API module wrapping NDI SDK 6 (`NDIlib_send_*`).
     - `NDIlib_send_create` on app start when NDI destination is enabled.
     - `NDIlib_util_send_send_audio_interleaved_32f` per PCM block.
     - Bundle `Processing.NDI.Lib.x64.dll` alongside the addon in
       `resources/app.asar.unpacked/` (DLLs cannot load from inside asar).
     - Electron ABI-matched prebuilds per supported arch (x64 now, add
       arm64 later if needed).
  4. Lifecycle
     - Create the NDI sender lazily the first time NDI is selected.
     - Tear down on destination deselection or app quit.
     - Handle device hot-plug for real sinks (re-query on
       `devicechange`).
- Licensing: NDI SDK redistribution is free but requires the standard
  "NDI®" attribution in About/credits. Note this when wiring up the About
  modal.
- Settings persistence: extend the existing `audio-output` storage key
  from a single device id to an ordered array of destinations, each
  `{ type: "device" | "ndi", id?: string, enabled: boolean }`. Migrate
  legacy single-string values transparently.
- UI: Options ▸ AUDIO OUTPUT becomes a checklist; show a small "NDI"
  badge on the NDI row and the stream name that will appear on the
  network. Disable the NDI row gracefully if the native addon failed to
  load (non-Windows, missing DLL, etc.) rather than crashing.
- Out of scope for this note: NDI receive. See companion video note below
  for the overlay-windows-as-NDI-sources plan that reuses this addon.

### Overlay output windows as NDI video sources (companion track)
- Goal: expose each overlay `BrowserWindow` (scoreboard, bracket, and any
  future overlay surfaces) as its own NDI video source, selectable
  independently. Zero external capture tools required.
- Shared infrastructure with the audio sender track:
  - same native N-API NDI addon
  - same bundled `Processing.NDI.Lib.x64.dll`
  - same `NDIlib_send_create` / teardown lifecycle owner in main
  - same licensing/attribution obligations
- Frame source: `webContents.beginFrameSubscription(false, callback)` on
  each visible overlay window. Do NOT switch to offscreen rendering; we
  need the on-monitor overlay output to keep working untouched. The
  subscription callback runs in main process and hands us BGRA pixels
  directly — no IPC to renderer.
- Send path: main-process callback → `NDIlib_send_send_video_v2` with
  `BGRA` format. Alpha is preserved end-to-end so downstream switchers
  can key the overlay over video without chroma keying.
- Per-window sender identity: e.g. `MATBEAST.SCOREBOARD`,
  `MATBEAST.BRACKET`. Consider exposing a rename in settings.
- Never route video pixels over IPC. 1080p60 BGRA is ~500 MB/s; frame
  buffer and NDI sender must both live in main.
- Frame rate: driven by the window's paint cadence; advertise via
  `frame_rate_N/frame_rate_D` (e.g. 60000/1000 for 60 fps).
- UI: add overlay-video destinations to the same destination picker used
  by audio. Each overlay window gets a row with an "NDI" badge and its
  stream name; toggling enables/disables that specific sender.
- Nice-to-have (optional, cheap once core is wired):
  - NDI tally → drive preview-card red-door indicator from actual PGM
    state upstream rather than only the local `overlayOutputLive` flag.
  - Per-source metadata: scene name, current round, active match id.
- Out of scope: video *receive*, NDI finder/browser UI inside the app,
  routing NDI to HTML.

## 2026-04-17 — Overlay "Application error" root-caused: DB schema drift

### Problem
Overlay windows (and sometimes the dashboard) intermittently rendered the
generic Next.js client error boundary: *"Application error: a client-side
exception has occurred while loading 127.0.0.1"*. Earlier sessions
attributed this to startup races / stale Chromium cache chunks and tried
to fix it with a strict `/api/health` readiness probe, route warm-up, and
`loadUrlWithRetry` wrapper in `electron/main.js`. That made the symptom
**more** frequent, not less, so the probe + retry changes were rolled
back before diagnosis continued.

### Root cause
The user's local `%APPDATA%\matbeastscore\matbeast.db` was from an older
install and badly out of sync with the current Prisma schema:
- `ResultLog` missing 7 columns: `tournamentId`, `leftTeamName`,
  `rightTeamName`, `isManual`, `manualDate`, `manualTime`,
  `finalSummaryLine`.
- `Team` missing `overlayColor`.
- `LiveScoreboardState` missing 4 sound columns **and** still had the
  legacy `id TEXT DEFAULT 'live'` primary key instead of the current
  `tournamentId` PK.
- `MasterPlayerProfile` and `MasterTeamName` tables missing entirely.

Every poll of `/api/board` hit `ResultLog.leftTeamName` first and threw
Prisma `P2022 ("The column main.ResultLog.leftTeamName does not exist")`.
That error surfaced in the renderer as the generic "Application error"
screen. Because the poll re-fires every few seconds and the log had no
size cap, `bundled-server.log` had grown to **434 MB** of the same
stacktrace.

The existing `patchUserDatabaseSchemaAdditive` only knew about 2
columns (`Team.overlayColor`, `ResultLog.tournamentId`) — no mechanism
existed for later schema additions or for the non-additive drifts
(PK rename, missing tables).

### Fix — immediate unblock
On the dev machine the broken DB + bloated log were moved aside to
`%APPDATA%\matbeastscore\_backup-<stamp>\`. Zero rows in every table
(empty event state), so no data loss. Next launch recopies the bundled
seed template (`resources/default-data/matbeast-template.db`) which is
regenerated at package time against the current Prisma schema.

### Fix — hardening in `electron/main.js`
1. **Data-driven additive patches** (`ADDITIVE_COLUMN_PATCHES`). List of
   every optional column any later Prisma revision added (12 entries
   today). When Prisma gains a new `Foo String?` / `Bar Int @default(N)`
   field, add one line here and old DBs are auto-healed on next launch.
   Both the `node:sqlite` fast path and the `sql.js` fallback now
   iterate this list; results are logged as
   `applied=[Team.overlayColor, ResultLog.leftTeamName, ...]`.
2. **Structural-drift detection** (`STRUCTURAL_DRIFT_RULES`). Captures
   the non-additive drifts that `ALTER TABLE ADD COLUMN` cannot fix:
   missing `LiveScoreboardState.tournamentId` PK, missing
   `MasterPlayerProfile`, missing `MasterTeamName`. Each rule is a
   predicate over `(hasTable, hasColumn)`.
3. **Auto-recovery on structural drift** (`restoreSeedDbOverBrokenDb`).
   When any structural rule fires, the user's DB + WAL/SHM sidecars are
   renamed to `matbeast.broken-<ISO stamp>.db{,-wal,-shm}` and the
   bundled seed template is copied in place. Data loss is the cost, but
   the broken file is preserved for manual inspection.
4. **Log size cap** (`BUNDLED_SERVER_LOG_MAX_BYTES = 8 MiB`,
   `rotateBundledServerLogIfTooLarge`). Every `appendBundledServerLog`
   stat-checks the file; above threshold it rotates to
   `bundled-server.log.old` (or truncates if the rename races a reader).
   A single stuck error can no longer bloat the log to hundreds of MB.

### Fix — rolled back
Earlier this session the following were added and then **removed** after
they made the error more frequent (they addressed a suspected startup
race that wasn't actually the cause):
- `src/app/api/health/route.ts` (strict Prisma-backed probe) — deleted.
- `waitForServerReady` / `warmUpNextRoutes` / `loadUrlWithRetry` +
  `TRANSIENT_LOAD_ERROR_PATTERNS` helpers in `electron/main.js` —
  removed.
- Startup probe reverted to `waitForHttpOk(appUrl/)` with the original
  20 s timeout; `mainWindow.loadURL` / overlay `win.loadURL` calls
  reverted to their original plain form.

If we ever need a strict ready-gate again, reintroduce a `/api/health`
route *and* confirm via logs that the symptom it's targeting is
actually a startup race — not schema drift, stale cache, or renderer
hydration — before wiring it into `loadURL`.

### Files touched
- `electron/main.js`
  - new `BUNDLED_SERVER_LOG_MAX_BYTES` + `rotateBundledServerLogIfTooLarge`
  - `appendBundledServerLog` now rotates before appending
  - new `ADDITIVE_COLUMN_PATCHES` table (data-driven, 12 entries)
  - new `STRUCTURAL_DRIFT_RULES` table
  - new `restoreSeedDbOverBrokenDb`
  - `patchUserDatabaseSchemaAdditive` rewritten: data-driven additive
    ALTERs via `node:sqlite` (preferred) with `sql.js` fallback,
    structural-drift detection afterwards, triggers seed restore if any
    rule fires. Reports via `applied=[...] drift=[...]` log line.
  - rolled back `/api/health` probe, warm-up, `loadUrlWithRetry`,
    `TRANSIENT_LOAD_ERROR_PATTERNS`, `isTransientLoadError`; reverted
    `mainWindow.loadURL` / overlay `win.loadURL` to their pre-regression
    calls.
- `src/app/api/health/route.ts` — deleted.

### Build
`dist/Mat Beast Scoreboard Setup 0.6.0.exe` rebuilt (2026-04-17 2:34 PM,
~157 MB). Existing dev-machine DB was manually rotated earlier in the
session, so this install is already running on a clean seed.

## 2026-04-16 — Follow-up: Open-flow filename race fix

### Problem
After opening an event file, the header filename showed `UNTITLED`
instead of the real filename, and `Save As` defaulted the dialog name to
`UNTITLED`. A spurious `Documents\UNTITLED.matb` file also appeared.

### Root cause
`matbeastImportOpenedEventFile` (in
`src/lib/matbeast-dashboard-file-actions.ts`) calls
`POST /api/tournament/import-roster` via `matbeastFetch`. That request
is a non-GET `/api/…` call without the `x-matbeast-skip-undo` header,
so `shouldCaptureUndo` returns `true` and fires
`markTournamentDirty(tournamentId)` the instant the response lands.

Meanwhile the autosave subscriber in `AppChrome` picks up that dirty
signal and calls `matbeastSaveTabById(...)` *in parallel with the rest
of the open flow*, before `syncBoardFileName(...)` a few lines below
has had a chance to set the real filename on the board. The racing
autosave:
1. reads `board.currentRosterFileName` as `UNTITLED` (the default for
   a freshly-created tournament);
2. falls back to `getDefaultEventSavePath` and writes a stray
   `Documents\UNTITLED.matb`;
3. PATCHes `currentRosterFileName = "UNTITLED"`, often landing *after*
   the open flow's correct `syncBoardFileName` PATCH and stomping
   the header back to `UNTITLED`.

### Fix
Added `x-matbeast-skip-undo: "1"` to the import-roster POST so it no
longer marks the tournament dirty. The existing explicit
`markTournamentDirty(j.id)` at the end of `matbeastImportOpenedEventFile`
— which runs *after* `setEventDiskPath` and `syncBoardFileName` — is
now the only dirty signal during open, so the post-open autosave runs
against the correct filename and disk path.

### Files touched
- `src/lib/matbeast-dashboard-file-actions.ts`
  (import-roster POST now passes skip-undo header; inline comment
  explains the race and why the explicit `markTournamentDirty` at the
  end of the function is still the right post-open dirty signal)

### Build
`dist/Mat Beast Scoreboard Setup 0.6.0.exe` rebuilt; icon/version
embedded via `afterPack` as before.

## 2026-04-16 Session Updates (Overlay polish, Autosave, Updates, Icon, Versioning, Bracket)

### Scoreboard overlay text polish
- Player name and team name text color changed to `#d9d9d9`
  (both DOM and canvas paths in
  `src/app/overlay/overlay-client.tsx` +
  `src/app/overlay/overlay-canvas-text-layer.tsx`).
- Player name font size reduced by 10%.
- Player name shifted down by 4 px; team name shifted down by 2 px.
- Round label color (below clock) also changed to `#d9d9d9`.

### Overlay preview — barn-door off-air indicator
- Implemented preview-only barn-door effect:
  - two sliding panes reveal a red background behind the captured
    scoreboard image
  - scoreboard image stays fully visible and editable while off-air
  - scoreboard layer sits on `z-10`; barn doors on `z-0`.
- Removed leftover `PREVIEW PREVIEW` debug badge from the Overlay card.
- Scoreboard preview now auto-centers vertically in the card:
  - scroll container tracks scene (scoreboard focus y=420, bracket y=540)
    and re-centers via a `ResizeObserver` on mount/resize/scale change
  - no manual scrolling required to find the scoreboard.

### 8-team bracket overlay wiring
- Explicit pixel rectangles set for all 14 slots:
  - 8 Quarter-Final boxes
  - 4 Semi-Final boxes
  - 2 Grand-Final boxes (split into home/away explicitly)
- `bracket-overlay-model.ts` updated: QF now `flatMap`s into 8 slots
  (home + away per match) instead of 4 match-level slots.
- `OverlayCanvasTextLayer` automatically consumes the new per-slot
  color selection through `slot.color`.

### Team colors — larger palette + WCAG contrast
- Expanded overlay team color picker (`DashboardTeamsPanel.tsx`) from a
  small set to 30 sports-team inspired swatches.
- Added WCAG 2.x contrast helpers in `bracket-overlay-model.ts`:
  - `relativeLuminance`, `contrastRatio`, `hasReadableTextContrast`.
- Swatch list filtered to only colors that can reach readable text
  contrast; bracket text now dynamically picks `#ffffff` / `#111111`
  per background for maximum legibility (with `#d9d9d9` null fallback).

### Team color persistence on save/reopen (root-caused stale build)
- Added `overlayColor String?` to Prisma `Team` model.
- `PATCH /api/teams/[id]` accepts + validates `overlayColor` via
  `normalizeCssColor` and stores to DB.
- Export/import round-trip:
  - `roster-export-build.ts` now always writes
    `overlayColor: team.overlayColor ?? null`.
  - `roster-file-parse.ts` preserves `undefined` for pre-color files so
    existing DB colors aren't wiped on re-import.
  - `import-roster-server.ts` only updates `overlayColor` when the
    incoming doc explicitly declares the field.
- Diagnosis: observed missing colors in user's saved file (`TESTEVENT1.matb`)
  were caused by running a stale compiled bundle — source had the field
  but the installed build was older. Fixed by full rebuild + reinstall.

### Desktop icon — custom `afterPack` embedding
- `scripts/generate-icon.mjs` now uses `sharp` with `fit: "contain"` +
  transparent padding so the full `matbeastlogo` fits into `icon.ico`
  (no more cropping).
- `win.signAndEditExecutable` kept at `false` (true broke the build on
  Windows due to `7za.exe` + macOS symlinks in `winCodeSign` archive).
- New `scripts/after-pack-embed-icon.js` electron-builder hook:
  - directly invokes `rcedit-x64.exe` on
    `Mat Beast Scoreboard.exe`
  - embeds `build/icon.ico`
  - sets version strings: `FileDescription`, `ProductName`,
    `CompanyName`, `OriginalFilename`, `InternalName`
  - retries up to 4× with 750 ms backoff and verifies by reading back
    `FileDescription`, throws a build error if not committed
  - `rcedit` is now a `devDependency` (used via binary, not JS API,
    because v5 is ESM-only and exposes named exports rather than default).
- End result: desktop shortcut icon now shows the Mat Beast logo after
  install, no manual icon fix-ups required.

### App version in window header
- Bumped `package.json` version: `0.5.1` → `0.6.0`.
- Electron main process now forces the window title to always include
  the app version:
  - intercepts `webContents.on("page-title-updated", ...)` and rewrites
    the title (Next.js `<title>` metadata was previously overwriting
    the initial Electron `BrowserWindow.title`).
  - final title format: `Mat Beast Scoreboard v<version>`.

### Update check feedback (no modals on auto-check)
- Replaced the unused `UpdateCheckModal` path with an inline header
  status line in `AppChrome.tsx`:
  - pulsing dot for `checking` / `downloading`
  - colored text for `info` / `warning` / `error` / `success` tones
  - `downloaded` state shows inline "Install & restart" / "Later"
    buttons (never opens a modal mid-session).
- Auto-check on launch: `AppChrome` fires a single `checkForUpdates()`
  1.5 s after mount; no dialog is shown unless an update is found.
- Manual check (Help menu) reuses the same status line path via a new
  `onHelpMenu("check-updates")` IPC bridge (added in `preload.js` +
  `matbeast-desktop.d.ts`).
- Offline detection in `electron/main.js`:
  - `isOfflineErrorMessage()` matches `ENOTFOUND`, `EAI_AGAIN`,
    `ECONNREFUSED`, `ETIMEDOUT`,
    `net::ERR_INTERNET_DISCONNECTED`, etc.
  - On offline errors, update state flips to `status: "offline"` and
    further retries are cancelled for the auto-check; user sees a
    short "You're offline" status instead of infinite spinning.

### Autosave — change-driven, timer-less, noise-free
- Root cause of "autosave does nothing" fixed earlier with a pull-based
  preferences handshake:
  - added `ipcMain.handle("options:get-preferences", ...)` in
    `electron/main.js`
  - exposed `window.matBeastDesktop.getDesktopPreferences()` via
    `preload.js` + typed in `matbeast-desktop.d.ts`
  - `AppChrome.tsx` pulls the `autoSaveEvery5Minutes` preference on
    mount, no longer relying on a one-shot `did-finish-load` push that
    raced the renderer's event listener.
- Menu label updated from `Auto-save every 5 minutes` to
  `Auto-save on change` to match new behavior. The underlying IPC action
  id (`autosave-5m`) is intentionally unchanged for back-compat.
- Autosave rewritten to be purely event-driven (no timers of any kind):
  - subscribes to `subscribeDocumentDirty()` from
    `src/lib/matbeast-document-dirty.ts`
  - when a dirty event arrives and the tournament is dirty, calls
    `matbeastSaveTabById(tid, { silent: true, allowPrompt: false })`
  - coalescing via two booleans (`inflight`, `pendingAfterInflight`) —
    if a dirty event lands mid-save, exactly one follow-up save is
    scheduled after the current one resolves
  - no `setTimeout` / `setInterval` / debounce / max-delay timers.
- Quieter save feedback:
  - `onSaveStatus` now respects a `silent` flag in the event detail
  - silent saves suppress the "Saving..." toast and show a short
    "Saved" (1200 ms) instead of the louder 2800 ms "File saved" path
  - keeps the indicator out of the way during rapid typing.

### Autosave exemptions (do not mark dirty)
- Timer ephemeral commands already bypass autosave via the existing
  `x-matbeast-skip-undo: "1"` header path in `matbeast-fetch.ts`
  (skips both undo capture and `markTournamentDirty`).
- `ControlPanel.tsx` `patch()` now accepts `opts?: { skipUndo?: boolean }`;
  when `true`, adds `x-matbeast-skip-undo: "1"` to the outgoing
  `/api/board` PATCH.
- `PLAY 10S` and `PLAY HORN` buttons pass `{ skipUndo: true }` so
  sound cue PATCHes no longer mark the tournament dirty and no longer
  trigger autosave.
- Verified (no code change needed) that these interactions never trigger
  autosave either:
  - `OVERLAY LIVE` / `OVERLAY STOPPED` — only toggles a
    `BroadcastChannel` message + opens overlay window via IPC.
  - `SHOW BRACKET` / `SHOW SCOREBOARD` — only flips local React state
    (`previewScene`).
  - `Preview scale` slider — only sets local `previewScale`.
  - Overlay preview capture — uses Electron IPC
    (`captureOverlayPreview`), never `matbeastFetch`.
  - Scroll containers — no `onScroll` fetches anywhere in the app.

### Roster card (compact) — Team + Academy UX fixes
- "SELECT TEAM" now actually shown after save in compact mode:
  - removed the `useEffect` auto-fill that was pulling the first
    available team id into `form.teamId` on mount
  - post-save `setForm` in compact mode clears `teamId` to `""`
  - `teamSelectValue` memo returns `""` when `form.teamId` is empty so
    the disabled `<option value="">SELECT TEAM</option>` stays selected
  - fixed a prior regression where `teamSelectValue` collapsed
    concrete `team:<id>` TBD selections to a synthetic `__TEAM_TBD__`
    sentinel with no matching option.
- "Show team" dropdown no longer lists every empty slot:
  - filtered to teams with non-empty, non-`TBD` names
  - single consolidated "TBD" entry at the bottom, no seed number,
    lists all players still on TBD slots
  - initial/fallback selection prefers first named team, falls back
    to the consolidated TBD bucket otherwise; migrates stale state.
- Academy field is no longer overwritten when picking a team:
  - both `applyTeamSelectValue` branches and the "Show team"
    `onChange` only set `academyName` when it is currently blank,
    preserving any manually entered academy name.

### Misc code hygiene
- Wrapped `masterTeamNames` and `masterProfiles` in `useMemo` in
  `RosterClient.tsx` and `DashboardTeamsPanel.tsx` to stop producing
  new array references every render.
- Cleaned up `useMemo` dependency lists (removed redundant
  `teamsEffective`, fixed `resolvedRosterListTeamId`).
- Removed unused imports/values (`setAudioVolumePercent`,
  `createTournamentOnServer`, `WIDE_CARD_FRAME`).

### Future NDI work (recorded, not implemented)
- Built-in NDI audio sender with multi-destination fan-out — full
  design note captured above ("Future Work Notes").
- Overlay output windows as NDI video sources (companion track) — full
  design note captured above.

## 2026-04-14 Session Updates (Overlay Preview Stability + Red Fill Behavior)
- Stabilized preview rendering path:
  - kept preview in capture/mirror mode (no iframe architecture switch)
  - preview capture now pauses during output live-state transitions to avoid choppy mirrored barn-door frames
  - preview capture is frozen while `OVERLAY LIVE` is off so preview does not collapse with output
- Added preview-only red effect with rollback safety:
  - implemented local preview red-door behavior behind a feature flag (`enablePreviewRedDoor`)
  - adjusted state logic so close/open follows `OVERLAY LIVE` changes deterministically
  - refined behavior per user feedback: no red doors obscuring scoreboard content
- Final preview behavior now:
  - output window still uses live/stop barn-door behavior
  - preview keeps scoreboard visible while stopped
  - red fill is shown in the preview background (behind scoreboard), not as a foreground shutter
- Rebuilt desktop installer after each validation pass; latest output:
  - `dist/Mat Beast Scoreboard Setup 0.5.1.exe`

## 2026-04-13 Session Updates (Desktop + Save UX + Results + Bracket Sync)
- Desktop packaging / versioning:
  - bumped app version to `0.5.0`
  - rebuilt installer successfully at:
    - `dist/Mat Beast Scoreboard Setup 0.5.0.exe`
- Event file extension + association:
  - switched primary event file extension from `.mat` to `.matb` to avoid Windows/Microsoft Access `.mat` association conflicts
  - installer file association now targets `.matb`
  - open/save/recent-file flows still accept legacy `.mat` and `.json`
  - default save path for new installs remains user `Documents`
- Save feedback in dashboard header:
  - added unified save-status events
  - `File -> Save` and autosave now show:
    - `Saving...` while running
    - `File saved` briefly on success
- Roster card updates:
  - team dropdown no longer shows `--` placeholder labels
  - duplicate TBD option removed; keep only one `TBD` path
- Results log formatting updates:
  - final lines include timestamp (`h:mm AM/PM`)
  - player lines include team in parentheses when available
  - append round label at end (`— ROUND LABEL`)
  - horizontal overflow scroll retained for long lines
- Control card updates:
  - fighter dropdown now shows full player name (`FIRST LAST`) instead of last name only
- Final save / unsave behavior:
  - when one side reaches 5 eliminations, appends a second match-level result line:
    - `<time> <WINNING TEAM> def. <LOSING TEAM> — <ROUND>`
  - final save can auto-mark the selected in-progress bracket match winner
  - `UNSAVE` now restores pre-final state end-to-end:
    - removes saved final row
    - removes added match summary row
    - restores elimination counts (removes red X effects)
    - restores/deselects bracket winner state to pre-save value
- Overlay card preview centering:
  - initial content-alpha centering was implemented first
  - replaced with geometry-based centering against actual overlay card viewport:
    - computes centered `left/top` from card size + preview size + content offset
    - re-centers on mount, resize, and preview scale changes

## 2026-04-13 Session Updates (Roster + Master Profiles + Installer)
- Rebuilt desktop installer after roster/master-profile changes; latest output remains:
  - `dist/Mat Beast Scoreboard Setup 0.1.4.exe`
- Master profile persistence hardening:
  - added legacy DB self-heal to create `MasterPlayerProfile` table/index when missing
  - profile GET/POST/DELETE now ensures table availability before access.
- Roster player entry updates:
  - removed manual `Lineup` entry from player form
  - new players are auto-assigned sequential lineup positions (`1..7`) within team
  - additional players beyond first 7 are saved as unnumbered overflow entries.
- Lineup behavior updates:
  - drag/drop into lineup positions now inserts and shifts existing lineup down
  - first 7 roster rows show lineup numbers; overflow rows show no lineup number
  - deleting or moving players now re-normalizes team lineup numbering.
- Team slot persistence update:
  - server-side slot assignment now allows extra (overflow) players and keeps them unnumbered.
- Desktop options update:
  - added `Options -> Auto-save every 5 minutes` checkbox toggle
  - toggle is persisted in desktop preferences and re-applied on app launch
  - renderer receives toggle state and runs periodic save using existing Save flow.
 - Profile entry UX updates:
   - selecting a master profile no longer locks first/last name fields
   - when a selected master profile is saved, it now updates that same master profile row by id
   - team dropdown moved onto a new row after nickname, followed by academy on the same row
   - academy now auto-prefills from selected team name but remains independently editable
   - compact profile action icons remain on the same row as profile photo file picker controls.
 - Autosave behavior update:
   - 5-minute autosave now saves silently without opening save dialogs/prompts
   - header shows temporary `Auto saving` status text during autosave runs.

## 2026-04-08 Session Updates (Overlay + Preview)
- Overlay output window now auto-opens when desktop app starts (`createOverlayWindow()` on startup/activate).
- Overlay output window is moved off-screen for OBS capture while remaining a real capturable window.
- Overlay output window restored to transparent background (`BrowserWindow.transparent = true` + transparent page chrome).
- Dashboard Overlay card:
  - removed `Open overlay window` button
  - preview iframe remounts on tournament change (`key={tournamentId}`)
  - default preview scale set to `40%`
  - preview layout re-centered against full panel canvas
  - vertical scrollbar restored for manual vertical adjustment
- LIVE/STOPPED visuals:
  - output window uses a 1s barn-door clip transition on scoreboard content
  - output stopped state remains transparent (no black shutters)
  - preview does not shutter the scoreboard content; instead a red background barn-door animation runs behind the preview content.
- Overlay art opacity in `public/scoreboard.svg` increased to `95%` for targeted masked/center regions (strips/center box/end bars appear less transparent).
- Overlay/preview stale-data hardening:
  - no-cache headers when loading `/overlay` in Electron
  - overlay query uses `staleTime: 0`, `gcTime: 0`, `refetchOnMount: "always"`, `refetchInterval: 1000`.
- Overlay live-state sync hardening:
  - dashboard overlay control now handles BroadcastChannel `live` + `pong` messages
  - dashboard sends an initial `ping` on mount so preview/live status re-syncs after reload.

## Completed Work

### Overlay / UI
- Removed control/home links from overlay.
- Name/team strips aligned to SVG regions.
- Overlay fighter display now uses first + last name (no nickname path).
- Red X silhouette overlay behavior updated previously.
- Removed overlay container shadow to keep chroma-key background flat.
- Rest-mode overlay updates:
  - Timer digits render yellow in rest mode.
  - Sub-label shows `REST PERIOD` in yellow during rest mode.
  - Reverts to normal round label + color after rest mode exits.

### Timer / Audio
- Added timer sound controls in control panel:
  - 10s toggle (`10S ENABLED` / `10S DISABLED`)
  - bell toggle (`BELL ENABLED` / `BELL DISABLED`)
  - `PLAY 10S` and `PLAY BELL`
- Added small horizontal volume slider (0-100, default 100) after `PLAY BELL`.
- Volume is persisted and applied to audio elements.
- Added output-device selection workflow via desktop menu:
  - `Options -> AUDIO OUTPUT`
  - lists output devices
  - supports system default fallback
- Prevented duplicate/erratic playback:
  - Overlay no longer triggers timer sounds.
  - Control is single audio source.
- Updated timer sound UI:
  - `10S WARNING:` caption + clickable sound icon toggle.
  - `AIR HORN:` caption + clickable sound icon toggle.
  - Enabled = green icon state; disabled = gray with red X overlay.
  - `PLAY BELL` renamed to `PLAY HORN`.
- Volume persistence updates:
  - New event now defaults volume to `100`.
  - Event file save/load now includes `audioVolumePercent` and restores slider value on open.
- **Timer cue pitch / speed vs output device (fixed):**
  - **Symptoms:** Playback sometimes slower with lower pitch; **different steady pitch** on Bluetooth (e.g. AirPods) vs PC speakers.
  - **Cause:** Cues were routed `GainNode → MediaStreamDestination → hidden HTMLAudioElement → setSinkId`. That forces a **media-stream** playback path, so the browser **resamples/buffers per device** on top of Web Audio — effective sample rate could drift from the decoded buffer.
  - **Fix (Chromium / Electron):** Prefer **`gain.connect(audioContext.destination)`** and **`audioContext.setSinkId(...)`** using the same persisted output id (`applySelectedAudioOutputToContext` in `src/lib/audio-output.ts`). One Web Audio graph to the device, **no** stream-to-`<audio>` bridge.
  - **Fallback:** If `AudioContext.setSinkId` is unavailable, keep the MediaStream + `HTMLAudioElement` path (`useTimerAlertSounds.ts`).
  - **Debug:** With DevTools console **Verbose** enabled, `[MatBeast timer audio] path: …` logs which route is active.

### Rest Period Mode
- Added `Set 1:00 Rest` button (yellow) in timer section after `Reset to 1:00`.
- Rest mode behavior:
  - sets timer to 1:00 (paused) and marks rest mode active
  - timer text becomes yellow in control + overlay
  - pressing `Reset to 4:00` or `Reset to 1:00` exits rest mode (white timer)
  - while in rest mode:
    - no 10-second warning at 0:10
    - at 0:00, if bell is enabled, plays 10s sound (not bell sound)
- Implementation uses existing state without DB migration risk:
  - rest mode encoded as `overtimeIndex < 0` (sent to client as `timerRestMode`).

### Final Result / Results Log
- Final winner display string normalized to:
  - `LEFT CORNER — <TEAM> — <NAME>`
  - `RIGHT CORNER — <TEAM> — <NAME>`
- Final label text adjusted to avoid duplicate side wording (action labels simplified).
- Strengthened legacy ResultLog writes:
  - robust fallback insert path for missing columns.
- Strengthened legacy ResultLog reads:
  - schema-aware fallback query (`PRAGMA table_info`) when Prisma `findMany` fails.
- `PATCH /api/board` response now uses `getBoardPayload(...)` for consistent compatibility read path.

### Misc
- Swap button sizing reduced to text-scale.
- Swap behavior adjusted to avoid unintended clear-state behavior by including current fighter payload.
- Desktop startup/session behavior updates:
  - Desktop startup now opens a fresh "Untitled event" session instead of restoring previous active tab from local storage.
  - Added `File -> Open Recent` menu in Electron; recent JSON event files can be reopened directly.
- Desktop packaging updates:
  - Reduced installer payload by avoiding duplicate app/runtime bundling in `app.asar`.
  - Updated installer init flow to continue with in-place upgrade when prior install exists (instead of forcing setup quit).

## Known Context / Notes
- The environment tool could not reliably enumerate local audio files despite user screenshots showing files in `public/sounds`.
- Audio source path handling supports `.mp3` and `.MP3` variants.
- Next.js build still shows existing non-blocking `<img>` lint warnings in overlay route.

## Last Verified
- Typecheck and lints pass after latest changes.
- Desktop rebuild succeeded with latest Brackets/Timer/Electron workflow updates.

### 2026-04-08 — Timer audio: correct pitch across outputs

- Resolved timer **10s / air horn** pitch and speed issues by routing Web Audio **directly** to `AudioContext.destination` and applying **`setSinkId` on the `AudioContext`** when supported, instead of `MediaStreamDestination` + hidden `<audio>` (see `useTimerAlertSounds.ts`, `audio-output.ts`). Added optional `console.debug` to confirm direct vs fallback path.

### 2026-04-08 — Brackets, file persistence, desktop workflow, audio controls

- Brackets card behavior/UI:
  - Added clickable "current match" border highlight with true toggle on/off.
  - Quarter-finals column visibility now depends on team readiness:
    - show QF only when 5+ named teams exist;
    - otherwise show Semi-finals, Grand final, Champion sections only.
  - Semi-finals / Grand final / Champion boxes remain visible with blank placeholders until populated.
  - Reworked vertical alignment so Semi-final boxes center against preceding match boxes (independent of section titles).
  - TV icon workflow implemented:
    - QF TV icons are non-clickable.
    - Semi/Grand/Champion TV icons are clickable per current rules.
    - Only one active TV group at a time; Champion is its own selection.
  - Removed experimental SVG connector-line rendering (rolled back in favor of TV-icon-only signaling).
  - Champion styling:
    - no gold highlight until winner exists;
    - lower `CHAMPION` label hidden until winner exists;
    - champion TV icon shown next to the title; enabled only after winner exists.
- Event file persistence enhancements:
  - Save now includes bracket snapshot (`bracket.version=1`, seed-based match rows) plus `audioVolumePercent`.
  - Open/import restores bracket state and audio volume from event file when present.
  - Implemented in:
    - `roster-file-types.ts`
    - `roster-file-parse.ts`
    - `roster-export-build.ts`
    - `matbeast-dashboard-file-actions.ts`
    - `/api/tournament/import-roster`
    - `import-roster-server.ts`
- Desktop runtime/menu integrations:
  - Added desktop preload + IPC helpers for reading files and adding recent docs.
  - Added Electron menu refresh for `Open Recent` updates after save/open actions.
## Next Steps (Shortlist)
1. Rebuild and smoke-test overlay behavior on desktop (`LIVE/STOPPED`, preview positioning, transparency in OBS).
2. Add optional user-toggle for overlay auto-open / off-screen mode.
3. Add automated UI/API checks for overlay live state sync and tournament switch behavior.

---

## Local setup (reminder)
```bash
cd web
npm install
npx prisma generate
npx prisma db push
npm run dev
```

Use `/overlay` for output and `/overlay?preview=1` for dashboard preview.

---

*Last updated: 2026-04-16 — v0.6.0 desktop build; overlay text polish, preview barn-door, 8-team bracket wiring, team color palette + contrast + persistence, custom icon embedding via afterPack + rcedit, app version in window title, inline update-check status line, timer-less event-driven autosave with skip-undo exemptions for timer/sound commands, roster Team/Academy UX fixes, and open-flow filename race fix (import-roster POST now skip-undo so autosave doesn't stomp `currentRosterFileName` back to `UNTITLED`).*
