# Progress Log

## Current Build Status
- Desktop app rebuilt successfully multiple times.
- Latest installer artifact:
  - `dist/Mat Beast Scoreboard Setup 0.9.11.exe` (2026-04-17 —
    Silenced the one-time "Reconnected to an existing cloud
    event" info dialog. 0.9.10's orphan-link sweep is working
    in the field (user confirmed the save succeeded), but the
    companion notification in `uploadEnvelopeAsNewCloudEvent`
    was firing every time the tab was reopened — each session
    gets a fresh in-memory `Set`, so the "first adoption this
    session" gate fires once per app launch for every tab the
    user happens to have pinned. User feedback: "it worked
    but whenever i open the file i get this annoying message.
    Let's remove this." Removed the `window.alert`, the
    `adoptedTabsNotifiedThisSession` set, and the comment
    block that described the gate. Replaced with a silent
    `matbeastDebugLog("save:auto-link", "adopted existing
    cloud event (silent)", ...)` so post-mortems from
    `bundled-server.log` still record which tab adopted
    which cloud event, without any UI interruption. The
    adopt path is otherwise unchanged — the save still
    completes, the board is still patched to the cloud
    filename, and the sync indicator still flips to
    "synced" once the `CloudEventLink` is in place.)
  - `dist/Mat Beast Scoreboard Setup 0.9.10.exe` (2026-04-17 —
    Orphan-link sweep in adopt. 0.9.9's diagnostics pinned the
    failure: `PrismaClientKnownRequestError: Unique constraint
    failed on the fields: (cloudEventId)` at the `link` stage.
    Root cause: `CloudEventLink.cloudEventId` is `@unique` and
    local SQLite already had stale rows claiming the target
    `cloudEventId` under a different `tournamentId` (an
    artefact of earlier sessions that imported the same cloud
    event into a new tournament each time). The upsert is
    keyed on `tournamentId`, so every adopt attempt tried to
    INSERT a fresh row with a colliding `cloudEventId` and
    tripped the constraint. Fix: before the upsert, the adopt
    route now calls `prisma.cloudEventLink.findMany` /
    `deleteMany` scoped to the target `cloudEventId` with
    `NOT: { tournamentId }` to clear any orphan links, and
    logs the cleared tournament IDs as
    `[cloud-adopt] clearing orphan links {...}` for
    post-mortem. The orphans are pure metadata — deleting
    them doesn't touch the cloud event or the Tournament row
    itself — so the sweep is safe for in-flight use. After
    this build the first autosave on a rediscovered-orphan
    tab should transparently adopt the existing cloud event,
    fire the one-time "reconnected to existing cloud event"
    alert, and flip the sync indicator to "synced".)
  - `dist/Mat Beast Scoreboard Setup 0.9.9.exe` (2026-04-17 —
    Adopt-route diagnostics. 0.9.8's adoption endpoint was
    returning a bare HTTP 500 with no body, so the save-failed
    dialog only said "Adopt-existing failed: HTTP 500" without
    naming the failing step. Wrapped the whole adopt handler
    in a stage-tagged try/catch ("meta" → "push" → "link") so
    any thrown exception is logged to `bundled-server.log` as
    `[cloud-adopt] threw {tournamentId, cloudEventId, stage,
    message, stack}` and echoed back to the renderer as
    `{ error, stage }`. The red "save failed" dialog now
    displays `Adopt-existing failed: HTTP 500 @stage — detail`
    so the next reproduction will identify whether the
    failure is in the cloud-meta probe, the force-push, or
    the local link upsert. No behavior change on the happy
    path.)
  - `dist/Mat Beast Scoreboard Setup 0.9.8.exe` (2026-04-17 —
    Adoption path plumbing fix. 0.9.7 added the orphaned-tab
    adoption flow but it never triggered in practice because
    `createCloudEvent` was wrapping the masters 409 body inside
    its `message` string (`HTTP 409 {"error":"duplicate…,
    "conflictingId":"cmo3soje…"}`) instead of surfacing
    `conflictingId` as a typed field. The desktop proxy's JSON
    response therefore had no top-level `conflictingId` either,
    so the renderer's `upRes.json().conflictingId` read was
    always undefined and the adoption branch never ran.
    Fixed by: (a) `createCloudEvent` now JSON-parses the
    masters body on error and returns
    `{ kind: "error", status, message, conflictingId? }`,
    (b) `/api/cloud/events/upload` hoists `conflictingId` to
    the top-level response when the upstream returned 409, and
    (c) its `[cloud-upload] create event failed` log line now
    includes `conflictingId`. No change needed in the renderer
    — the save pipeline already reads `parsed.conflictingId`
    at the top level, it just never saw one before.)
  - `dist/Mat Beast Scoreboard Setup 0.9.7.exe` (2026-04-17 —
    Orphaned LOCAL_ONLY recovery. 0.9.6 made the actual error
    visible ("Auto-link upload failed: HTTP 409 — duplicate
    filename") and exposed the real failure mode: a local tab
    with no `CloudEventLink` whose filename already exists in
    the cloud (e.g. a DB reset left the cloud event behind).
    Every autosave POSTed `/upload`, masters rejected with 409,
    the user's edits never reached the cloud. Added a new
    desktop route `POST /api/cloud/events/adopt` that takes
    `{ tournamentId, cloudEventId, envelope }`, fetches the
    target cloud event's metadata, force-pushes the local
    bytes with `X-Expected-Version: *`, and upserts a
    `CloudEventLink` pointing at the adopted cloud event. The
    auto-link save path now calls this endpoint when `/upload`
    returns 409 with a `conflictingId`, so the first autosave
    after an orphaned-tab reboot transparently reconnects and
    uploads the in-memory edits. A one-time per-tab alert
    tells the user that we reattached to an existing cloud
    event rather than creating a duplicate, so if it's a
    legitimately different event they can rename the filename
    and the next autosave creates a fresh cloud event.)
  - `dist/Mat Beast Scoreboard Setup 0.9.6.exe` (2026-04-17 —
    Real failure reasons. 0.9.5 made "save failed" clickable but
    the dialog often said "No specific error message was
    returned" because the per-tab `link.lastError` channel is
    empty while a LOCAL_ONLY tab is still trying to auto-link
    (upload). Added a `lastErrorMessage` field to
    `matbeast-cloud-online` and had every `markCloudUnreachable`
    call site in the save pipeline pass a real message — the
    auto-link upload failure now reports the actual HTTP status
    and body (e.g. `HTTP 409 duplicate filename`, `HTTP 502
    cloud not configured`), and the regular `pushToCloudSync`
    helper does the same on non-409 errors. The badge consults
    `link.lastError` first, then falls back to
    `cloudOnline.lastErrorMessage`, so clicking red "save
    failed" now shows the actual cause whether the tab is
    LOCAL_ONLY or already linked. Also added a
    `[cloud-upload] create event failed` log line in the
    `/api/cloud/events/upload` route to mirror the
    `[cloud-push]` log added in 0.9.5.)
  - `dist/Mat Beast Scoreboard Setup 0.9.5.exe` (2026-04-17 —
    Cloud-failure visibility. The new small-text indicator used to
    show a persistent "connecting…" whenever the push pipeline was
    hitting 502/401/timeout errors in a row, which let data-loss
    risk hide in plain sight. The indicator now escalates to
    "save failed" (red, clickable) after 15 seconds of sustained
    failure; clicking opens an alert with the real HTTP/push
    error message so the user can distinguish a quick network
    blip from an auth reject or a structural 5xx. Hover tooltip
    on the ambient "connecting…" also surfaces the underlying
    error whenever the server reported one. The push route
    (`/api/cloud/events/push`) now writes a `[cloud-push]` line
    into `bundled-server.log` on every failed blob push so a
    tester seeing "save failed" can capture the exact status +
    message for post-mortem. No schema or behavior change for
    the happy path — saves that succeed still flip the text back
    to "synced" silently.)
  - `dist/Mat Beast Scoreboard Setup 0.9.4.exe` (2026-04-17 —
    Cloud sync indicator redesign. The coloured CloudSyncBadge
    chip (LOCAL ONLY / SYNCED / NOT SYNCED / CONNECTION LOST / NO
    CLOUD) was drawing the user's eye during every 3-second poll.
    Replaced with ambient small italic text next to the dashboard
    toolbar that reduces to three labels: "synced", "saving…",
    and "connecting…" (all seven upstream states collapse down
    into those). The popover, refresh icon, and inline conflict
    "Resolve…" button are gone — conflict resolution still fires
    through the pre-existing `matbeast-cloud-conflict` event +
    CloudEventDialogs modal, so that path is unchanged. When the
    user has no cloud configured the indicator renders nothing at
    all.)
  - `dist/Mat Beast Scoreboard Setup 0.9.3.exe` (2026-04-17 —
    CONNECTION LOST false-positive fix. The badge's 30-second
    cloud poll used to infer connectivity from `cloudMeta`
    presence — a reachable-but-deleted event or a transient
    single-endpoint blip would flip the header to CONNECTION LOST
    even while the save pipeline was successfully pushing to
    `/api/cloud/events/push`. The desktop proxy
    `/api/cloud/events/status` now returns an explicit
    `cloudProbe: "ok" | "not-found" | "unreachable" |
    "not-configured" | "skipped"` discriminator; the renderer
    only marks the cloud unreachable on `"unreachable"` and
    marks reachable on both `"ok"` and `"not-found"`. Legacy
    fallback is preserved for mixed-version server/renderer
    combinations.)
  - `dist/Mat Beast Scoreboard Setup 0.9.2.exe` (2026-04-17 —
    Filename uniqueness enforcement. Masters now rejects duplicate
    filenames on upload (POST /api/events) and rename (PATCH
    /api/events/:id) with a 409 + `code: "duplicate_filename"`
    body; the server-side copy route auto-resolves collisions by
    appending ` (2)`, ` (3)`, … so "Copy" always succeeds. All
    three desktop proxy routes (`/upload`, `/rename`, `/:id/name`)
    preserve 409 intact instead of collapsing to 502. The client
    side covers every rename surface: NewEventDialog disables
    Create when the filename matches an existing cloud event
    (with a red inline warning); HomeCloudPanel pre-checks the
    cached catalog on inline filename rename and handles 409 from
    the server; the dashboard-header rename dialog fetches a
    fresh catalog before committing the rename and also handles
    409 from the mirror call. Race between dialog-open and Create
    (someone else uploads the same name in between) rolls the
    half-created tournament back and leaves the dialog open.)
  - `dist/Mat Beast Scoreboard Setup 0.9.1.exe` (2026-04-17 — Tab
    UX pass: every tab now claims an equal share of the header
    width (1 tab → 100%, 2 → 50/50, 3 → 33/33/33, …) and the
    entire tab area is a switch target, not just the title label.
    "New event" (from both the File menu and the homepage) now
    pops a dialog that collects the Event title (default
    `UNTITLED EVENT`) and Filename (default next free `MMDD-N`
    from a live cloud probe, with an inline collision warning)
    before the event is actually created. Patch-number rollover
    extended to 3 digits — the next patch after 0.9.9 will be
    0.9.10, not 0.10.0.)
  - `dist/Mat Beast Scoreboard Setup 0.9.0.exe` (2026-04-17 —
    connectivity-aware New event + close-tab flow. "New event" now
    blocks unless the cloud is reachable (so you never create a
    permanently LOCAL ONLY tab by accident). The cloud badge now
    displays `CONNECTION LOST` (red) when the masters host is
    unreachable, `NO CLOUD` when the install isn't configured, and
    flips back to `SYNCED` automatically on reconnect — the badge
    also queues a silent re-push for its tournament on reconnect so
    any edits made while offline reach the cloud without user
    action. Closing a dirty tab while offline opens a "Not synced.
    Backup to disk before closing?" dialog with Backup / Close
    without backup / Cancel. Tab layout rebalanced so the active
    tab's toolbar (filename, save feedback, badge, undo/redo)
    claims 3× the header space of inactive tabs and only starts
    compressing when enough tabs are open to exceed the bar.)
  - `dist/Mat Beast Scoreboard Setup 0.8.9.exe` (2026-04-17 — saves
    are now cloud-only. Disk writes are reserved for File ▸ Backup
    copy to disk. Autosaves of `LOCAL ONLY` tabs auto-link to the
    cloud. The "Save before closing?" modal is gone — closing a
    dirty tab fires a silent cloud save and closes.)
  - `dist/Mat Beast Scoreboard Setup 0.8.8.exe` (2026-04-17 — slim
    File menu: Home page / Dashboard toggle, New event, Backup copy
    to disk, Restore copy from disk. Restore uploads the recovered
    envelope to the cloud under `<original>(recovered)`.)
  - `dist/Mat Beast Scoreboard Setup 0.8.7.exe` (2026-04-17 — cloud-
    first save pipeline: a local-disk permission error no longer
    blocks the cloud push, the Electron IPC now returns a
    structured `{ok:false,reason}` instead of throwing (so the
    "Saving..." indicator always clears), bad stored disk paths
    inside the install dir are auto-discarded, and the cloud-first
    new-event flow now logs why its upload failed so future
    "LOCAL ONLY" badge mysteries are actually diagnosable.)
  - `dist/Mat Beast Scoreboard Setup 0.8.6.exe` (2026-04-17 — real
    fix for the overlay-preview "Application error" on tab switch:
    `EventWorkspaceProvider` and `overlay-client` shared the
    `matbeastKeys.tournaments()` React Query cache slot but wrote
    different shapes (`Array<TournamentSummary>` vs
    `{ tournaments: [...] }`). Whichever queryFn fetched last
    overwrote the cache, so the provider's tab-name sync effect
    crashed with `find is not a function`. Normalized
    overlay-client's queryFn to return the array and added a
    defensive `Array.isArray` guard on the provider side.)
  - `dist/Mat Beast Scoreboard Setup 0.8.5.exe` (2026-04-17 — dated
    filename convention (`MMDD-N`), fixed the dashboard header
    rename dialog (Electron focus race), split rename into
    separate Event name + Filename fields, added a double-clickable
    filename indicator in the dashboard header, and added
    homepage in-place filename rename via double-click.)
  - `dist/Mat Beast Scoreboard Setup 0.8.4.exe` (2026-04-17 — homepage
    catalog overhaul: hides the internal revision number, shows the
    tournament event name beneath the filename, adds a 3-dot actions
    menu per row with "Make a copy" (server-side duplicate prefixed
    with "Copy of ") and "Delete" (soft-delete on masters + local
    link drop), and sorts by whichever of createdAt/updatedAt is
    later. Requires matbeast-masters v0.4.1 which adds the
    `CloudEvent.eventName` column and a /copy endpoint; already
    deployed to `matbeast-masters.vercel.app` via Neon
    `prisma db push`.)
  - `dist/Mat Beast Scoreboard Setup 0.8.3.exe` (2026-04-17 — fixes the
    overlay-preview "Application error" on tab switch: `buildBracketProjection`
    now guards against a partial bracket payload where
    `quarterFinals`/`semiFinals` arrive missing or non-array during the
    iframe remount window. Error captured via v0.8.2 diagnostics
    (`TypeError: C.find is not a function`) and pinned to
    `src/lib/bracket-display.ts:76`.)
  - `dist/Mat Beast Scoreboard Setup 0.8.2.exe` (2026-04-17 — cloud-first
    new-event flow with auto-`UNTITLED(N)` naming, homepage cloud catalog,
    tab-rename → cloud rename propagation, and a `global-error` +
    `/api/diagnostics/client-error` reporter so overlay/layout crashes land
    in `bundled-server.log` for triage.)
  - `dist/Mat Beast Scoreboard Setup 0.8.1.exe` (2026-04-17 — cloud upload
    default name now mirrors current roster filename; friendly
    "not configured" notice replaces the generic HTTP 502 surface on
    Open/Upload when sync is paused or tokenless.)
  - `dist/Mat Beast Scoreboard Setup 0.8.0.exe` (2026-04-17 — cloud
    event files: Open-from-cloud and Upload-to-cloud in the File menu,
    auto-push on every save, CloudSyncBadge on the header with force-
    sync button, conflict prompt (overwrite / keep cloud / save local
    copy), powered by matbeast-masters v0.4.0.)
  - `dist/Mat Beast Scoreboard Setup 0.7.0.exe` (2026-04-17 — cloud sync
    v1: on-demand pull+push of master player profiles and master team
    names, with local outbox for offline writes; Cloud sync settings
    modal under Options menu; revocable desktop tokens minted from the
    `matbeast-masters` cloud service.)
  - `dist/Mat Beast Scoreboard Setup 0.6.0.exe` (2026-04-17 2:34 PM — DB
    schema-drift auto-heal + bundled-server.log rotation)

## v0.8.9 — Cloud-only save pipeline, auto-link LOCAL ONLY tabs, no more close prompt (2026-04-17)

### What the user reported
- **Autosave kept popping "Refusing to save to a relative path:
  0417-1.matb"** on every edit. Tracked down to
  `app.getPath("documents")` returning `""` on this machine
  (likely OneDrive-redirected Documents or a broken known-folder
  registry key), so `getDefaultEventSavePath` produced the bare
  filename. v0.8.7's guard correctly refused that path, but the
  autosave retry-storm made the refusal visible to the user.
- **"LOCAL ONLY" badge + missing cloud sync.** The original
  tournament was never linked to the cloud because its first-save
  upload failed silently. Every subsequent save went through the
  disk-mirror branch and skipped the cloud entirely.
- **Close prompt after ~every edit** ("Save changes before
  closing?") — not useful when the cloud is the source of truth.

### Fixes
1. **Cloud-only save pipeline** (`matbeastSaveTabById`). The disk
   mirror branch is gone. The flow now is:
   - If the tab has a `CloudEventLink` → `/api/cloud/events/push`.
   - If not linked and cloud is configured → auto-upload via
     `/api/cloud/events/upload` under the current filename
     (falling back to a fresh `MMDD-N` when the board still holds
     the placeholder "UNTITLED"). This flips the badge from
     `LOCAL_ONLY` to `SYNCED` on the next poll.
   - If not linked and cloud is not configured → warn the user
     once per session, mark the tab clean, and succeed. The
     recourse is File ▸ Backup copy to disk.
2. **Close-tab prompt removed.** `requestCloseTab` fires a silent
   cloud save and closes unconditionally. If the save fails, the
   edits are still preserved in the tournament row in the local
   DB — the next time the user opens the event and saves, the
   cloud catches up.
3. **One-shot "cloud not configured" notice**
   (`cloudNotConfiguredWarnedThisSession`) so the user sees the
   message at most once per app run, not on every keystroke.
4. **Backup copy to disk** is now the *only* path that writes a
   .matb to disk. Restore still uploads to the cloud after
   import.

### Side effects / removed code
- `forgetTournamentDocumentState` is no longer called from the
  close-tab flow (closing is always a save-through, never a
  discard). Still exported and still called from other paths
  (DB reset, etc.).
- `handleCloseDecision` deleted.
- The "Save / Discard / Cancel" modal JSX deleted from
  `AppChrome`.
- Several helpers in `matbeast-dashboard-file-actions.ts` are now
  unused by the normal save path but kept exported because Save As
  and Import still rely on them: `getEventDiskPath`,
  `setEventDiskPath`, `eventNameFromPath`, `pushToCloudAfterSave`.

### Files touched
- `web/src/lib/matbeast-dashboard-file-actions.ts`
  — `matbeastSaveTabById` rewrite; new
  `isTournamentLinkedToCloud`, `isCloudConfigured`,
  `chooseAutoLinkCloudName`, `uploadEnvelopeAsNewCloudEvent` helpers;
  session-scoped "cloud not configured" warning.
- `web/src/components/AppChrome.tsx` — removed
  `closePromptForTabId` state, `handleCloseDecision`, and the
  modal. `requestCloseTab` now does a silent save + close.
  Imported `matbeastDebugLog`, removed unused
  `forgetTournamentDocumentState` import.
- `web/package.json` — bumped to `0.8.9`.

## v0.8.8 — Slim File menu & cloud-aware "Restore copy from disk" (2026-04-17)

### Menu changes
The native window File menu now has exactly four items:

1. **Home page** ↔ **Dashboard** (toggle). The label swaps based on
   what the renderer is currently showing. Switching to "Home page"
   surfaces the cloud catalog *without closing any open event tabs*;
   switching back to "Dashboard" returns to the last-active event.
2. **New event** — same as clicking "Create new event" on the home
   page.
3. **Backup copy to disk** — writes the current event envelope to a
   user-chosen `.matb` file. Pure backup; doesn't retarget the
   cloud link.
4. **Restore copy from disk** — pick a `.matb` / `.json` / `.mat`
   file, import it into a fresh tab, and upload it to the cloud as
   `<original-stem>(recovered)` (with `(recovered)(1)`,
   `(recovered)(2)` fallbacks on collision). Never overwrites
   whatever is currently in the cloud under the original name.

Everything else (Open Event…, Open Recent, Save, Save As,
Open from Cloud, Upload to Cloud, Dashboard shortcut, Open Overlay
Output Windows, Quit) has been removed from the File menu per the
user's spec. Alt+F4 / window close still quits.

### Implementation
- `EventWorkspaceProvider` — added `showHome: boolean` +
  `setShowHome` context fields. Cleared whenever the user opens or
  switches to a tab via `openEventInTab`.
- `DashboardClient` — renders `HomeCloudPanel` when `showHome` is
  true (even with tabs open). Publishes the view state to Electron
  main via a new `setWorkspaceViewState` IPC so the native menu
  label stays in sync.
- `electron/main.js` —
  - New `workspaceViewState` object tracks `{showingHome, hasTabs}`.
  - `buildMenuTemplate()` emits only the four items, with the
    first one conditionally labelled **Home page** or **Dashboard**.
  - New `app:set-workspace-view-state` IPC handler calls
    `refreshApplicationMenu()` only when the reported state
    changed.
  - Added `home`, `dashboard`, `backupToDisk`, `restoreFromDisk`
    to the allow-list in `sendFileMenuAction`.
- `electron/preload.js` — exposed `setWorkspaceViewState` with a
  `.catch()` guard so renderer effects can never leak a rejection.
- `src/types/matbeast-desktop.d.ts` — typed the new preload surface.
- `src/components/NativeFileMenuBridge.tsx` — handles `home`,
  `dashboard`, `backupToDisk`, and `restoreFromDisk` actions.
  `backupToDisk` reuses `matbeastSaveActiveTabAs`.
- `src/lib/matbeast-dashboard-file-actions.ts` —
  - New `matbeastRestoreFromDiskToCloud(…)` helper: picks a file,
    creates a fresh tournament, imports roster/bracket, picks a
    non-colliding `<stem>(recovered)[(N)]` cloud filename, uploads
    the envelope, syncs `currentRosterFileName`, and links the
    tournament to the new cloud event so future saves sync.
  - New `pickRecoveredCloudFilename(stem, existing)` helper with
    sequential collision handling.

## v0.8.7 — Cloud-first save, EPERM-safe disk mirror, no more stuck "Saving..." (2026-04-17)

### What the user saw (all from one test session)
1. **"Saving..." notification stuck.** Close-tab → Save prompt → click
   Save → big Electron dialog reading
   `Error invoking remote method 'app:write-text-file': Error: EPERM:
   operation not permitted, open
   'C:\Program Files\Mat Beast Scoreboard\0417-1.matb'`. The header
   indicator never cleared.
2. **Badge often says "LOCAL ONLY"** even after the user believed an
   event was cloud-backed.
3. **Cloud copy is stale.** Reopening a cloud event loses the edits
   the user made since the last successful save.

### Root causes
- **Stored disk path pointing into `C:\Program Files\…`.** Earlier
  builds let the Electron "Save" dialog default to a relative
  filename; if the user ever pressed Save without navigating, Node
  resolved that against the main process cwd — which is the install
  folder when the app is launched from the Start Menu. That path
  was cached in `localStorage` under `matbeast-disk-path::…` and
  every subsequent save re-used it. Windows (correctly) denies
  writes there for non-admin processes → `EPERM`.
- **Main-process `app:write-text-file` handler didn't catch the
  EPERM.** `await fs.promises.writeFile(...)` threw, Electron's
  `ipcRenderer.invoke` rejected the promise, and the renderer's
  `const w = await desk.writeTextFile(...)` escaped the entire
  save flow before it could `emitSaveStatus("error")`. Hence the
  stuck "Saving..." indicator.
- **Local-write failure short-circuited cloud push.** The old save
  flow ran disk-write first and only pushed to the cloud if disk
  succeeded. So when EPERM hit, nothing ever landed in the cloud
  — confirming the user's "edits aren't saved".
- **No logging on the cloud-first new-event flow.** When the initial
  cloud upload failed silently (offline / 502 / token revoked),
  the event stayed local-only forever with no trace in
  `bundled-server.log` of *why*.

### Fixes
- `electron/main.js` — `app:write-text-file` now:
  - Validates `filePath` is absolute.
  - Rejects writes inside the app install directory with a
    user-friendly `reason: "inside-install-dir"` error.
  - Catches fs errors (EPERM/EACCES → `reason: "permission"`).
  - Never throws back up the IPC channel.
- `electron/preload.js` — wraps the `invoke` in `.catch()` so even
  a genuinely unexpected rejection still resolves to
  `{ok:false, reason:"ipc-rejected"}`.
- `src/types/matbeast-desktop.d.ts` — added the structured
  `reason` enum so the renderer can branch.
- `src/lib/matbeast-dashboard-file-actions.ts` — `matbeastSaveTabById`
  is now cloud-first:
  1. Probes `/api/cloud/events/status` to see if the tab is linked.
  2. Pushes to the cloud synchronously when linked (the cloud is
     authoritative for cloud-linked events).
  3. Writes the local disk mirror best-effort. Skipped entirely
     for cloud-linked events that don't have a user-chosen disk
     path (Save As is how you opt in to a local copy).
  4. If the disk write fails with `inside-install-dir` /
     `permission`, clears the bad `matbeast-disk-path::…`
     localStorage entry so the next save isn't poisoned by the
     same stale path.
  5. Save is a success whenever the authoritative side
     succeeded; disk failures surface a non-modal "Saved to cloud
     (local copy skipped)" message for linked events.
  6. The `emitSaveStatus("error", …)` path always runs on
     failure, so the header chip always clears to either
     "File saved" or "Save failed".
- `createCloudUntitledForNewTab` now logs (via `matbeastDebugLog`)
  every failure mode — config-not-configured, list fetch failed,
  upload non-2xx with a snippet of the server body, thrown
  exception — so next time an event ends up LOCAL ONLY we can
  grep `bundled-server.log` for `file:new-tab cloud upload …` and
  actually see why.

### Files touched
- `web/electron/main.js`
- `web/electron/preload.js`
- `web/src/types/matbeast-desktop.d.ts`
- `web/src/lib/matbeast-dashboard-file-actions.ts`
  (`matbeastSaveTabById` rewrite, new `pushToCloudSync` helper,
  logging added to `createCloudUntitledForNewTab`)
- `web/package.json` — bumped to `0.8.7`.

### Migration note for existing installs
- The first save after upgrading will notice any stale
  `matbeast-disk-path::…` entry pointing into the install dir,
  fail that specific write with the new structured reason, and
  clear the entry. The cloud push still happens, so the save is
  preserved. The *next* save will use `getDefaultEventSavePath`
  (`Documents\<filename>.matb`) instead.

## v0.8.6 — Real fix for overlay-preview `find is not a function` on tab switch (2026-04-17)

### What shipped
- **Root cause.** Two `useQuery` observers — one in
  `EventWorkspaceProvider` (app-root provider) and one in
  `overlay-client.tsx` — share the cache slot
  `matbeastKeys.tournaments()`. The provider's queryFn returns
  `Array<TournamentSummary>`; the overlay-client's queryFn used to
  return the HTTP envelope `{ tournaments: [...] }`. React Query
  caches by key only, so whichever observer refetched last
  overwrote the cache. When the object-shape write won the race
  (reliably on tab switch, because `overlayTournamentId` changing
  retriggers the overlay query), the provider's tab-name sync
  effect at `EventWorkspaceProvider.tsx:265–279` ran
  `tournaments.find(...)` on the object and crashed the whole
  iframe via `global-error`.
- **Stack trace confirmation.** v0.8.2 diagnostics captured
  `TypeError: C.find is not a function` with a useState frame
  inside chunk `4160`. De-minifying that chunk (it's
  `EventWorkspaceProvider`) showed the exact `setOpenTabs(prev =>
  prev.map(tab => C.find(t => t.id === tab.id) ...))` pattern,
  confirming the cache-shape collision hypothesis rather than the
  v0.8.3 `buildBracketProjection` hypothesis (which did also
  exist, but wasn't the source of this crash).
- **Fixes**
  - `web/src/app/overlay/overlay-client.tsx` — the `tournaments`
    query now unwraps the `{ tournaments: [...] }` HTTP envelope
    to the array shape, matching the provider. A small
    `useMemo`-backed alias re-wraps to `{ tournaments }` for the
    two consumers already reading `tournamentsPayload?.tournaments`
    downstream.
  - `web/src/components/EventWorkspaceProvider.tsx` — added
    defensive `Array.isArray(tournamentsRaw) ? ... : []`
    normalization so any future shape regression can't crash the
    app. All downstream effects now always see an array.
- `web/package.json` — bumped to `0.8.6`.

### Why the v0.8.3 fix didn't stop this
- v0.8.3 added `Array.isArray` guards to `buildBracketProjection`
  in `src/lib/bracket-display.ts`, fixing a different non-array
  `.find` crash in the same minified pattern (`[0..N].map((idx)
  => list.find(...))`). That was a real bug but not the source
  of this error — the v0.8.4 log entries also showed
  `ua=matbeastscore/0.8.4` crashing with the same
  `C.find is not a function`, pointing to a second, distinct
  site.

## v0.8.5 — Dated filenames, split rename, in-place homepage edit (2026-04-17)

### What shipped
- **Dated filename convention for new events.** `UNTITLED`, `UNTITLED(1)`,
  ... is out. The cloud-first new-event flow now picks `MMDD-N` —
  today's month+day followed by a per-day sequential counter — so
  the first event created on April 17 is `0417-1`, the second is
  `0417-2`, and yesterday's `0416-*` names never collide with today.
  Holes are filled (deleting `0417-2` while `0417-1` and `0417-3`
  exist yields `0417-2` on the next new event). Implemented in
  `pickNextDatedFilename(existingNames, now?)` in
  `web/src/lib/matbeast-dashboard-file-actions.ts`; the old export
  `pickNextUntitledName` is retained as a shim that forwards to the
  new picker so any stray call sites keep working.
- **New events no longer rewrite the tab label to the filename.**
  Previously the cloud-first flow set both `Tournament.name` and
  `currentRosterFileName` to the cloud filename, which left every
  brand-new event looking like `0417-1` in both the tab and the
  filename indicator — with `eventName` equal to `name`, the
  homepage's "event name under filename" secondary line was
  always hidden. v0.8.5 only rewrites the filename; the tab label
  stays at the server default ("Untitled event") until the user
  renames it via the new rename dialog.
- **Rename dialog now edits both fields.** Double-clicking the tab
  label opens the dialog focused on **Event name**; double-clicking
  the filename indicator (now a clickable button immediately to
  the right of the tab label) opens the same dialog focused on
  **Filename**. Both are editable in the same modal and saved
  together on `Save`/Enter. The dialog uses React `autoFocus` plus
  a caret-to-end effect, which fixes the Electron focus race that
  made keystrokes appear to do nothing in v0.8.4.
- **Homepage catalog: double-click to rename filename in place.**
  Clicking the filename label on a homepage row in edit mode spawns
  an inline `<input>` that commits on Enter/blur (Esc cancels). The
  rename hits a new desktop proxy
  `PATCH /api/cloud/events/:id/name`, which forwards to the existing
  masters `PATCH /events/:id` endpoint via `patchCloudEvent`.
- **Separated rename route payloads.** `/api/cloud/events/rename`
  now accepts `{ tournamentId, name?, eventName? }` (at least one
  required) instead of always writing both to the same value; the
  tab-rename path sends only the changed field, so renaming the
  event name doesn't stomp the filename and vice versa.

### Files touched
- `web/src/lib/matbeast-dashboard-file-actions.ts` — added
  `formatTodayMMDD`, `pickNextDatedFilename`; `matbeastCreateNewEventTab`
  no longer renames `Tournament.name` to the cloud filename.
- `web/src/components/AppChrome.tsx` — new `renameState` shape
  (separate `eventNameDraft`/`filenameDraft`, `focusField`),
  new double-click target on the header filename, dialog uses
  `autoFocus`, caret-to-end via `setSelectionRange`, save path
  writes `tournaments/:id` and `/api/board` (for
  `currentRosterFileName`) and mirrors the delta to the cloud.
- `web/src/app/api/cloud/events/rename/route.ts` — accepts and
  forwards `name?` and `eventName?` separately.
- `web/src/app/api/cloud/events/[id]/name/route.ts` (new) — desktop
  proxy for in-place homepage filename edits.
- `web/src/components/HomeCloudPanel.tsx` — inline-rename input,
  `commitRename` callback, double-click on the filename label.
- `web/package.json` — bumped to `0.8.5`.

### Why this was needed
- The v0.8.4 homepage secondary line ("event name under filename")
  never appeared for freshly-created events because the v0.8.2
  cloud-first flow synced both the tab label and the filename to
  the same cloud-picked string, which meant `eventName === name`
  and the HomeCloudPanel deliberately hid a duplicate.
- User reported the dashboard rename dialog was "opening but not
  allowing actual editing". Root cause was the `useEffect` that
  called `el.focus(); el.select();` inside a `requestAnimationFrame`
  racing the Electron window-focus handoff — in practice the
  select() took, the focus() returned, and then the top-level
  keyboard listener received the first keystroke because the
  input had momentarily lost focus. Replacing the manual focus
  dance with `autoFocus` plus a caret-only selection restores
  reliable typing.
- The masters service already accepted separate `name` /
  `eventName` on `PATCH /events/:id`, so no masters changes were
  required for this release.

## v0.8.4 — Homepage catalog: event-name, copy + delete, cleaner metadata (2026-04-17)

### What shipped
- **Version number hidden** on the homepage rows (it stays visible
  in tooltips and the conflict prompt). The number was only ever
  meaningful as a revision counter for conflict detection; removing
  it from the primary catalog view stops "why did a 1-character
  edit bump me to v3?" confusion.
- **Event name shown under the filename.** Each row now reads:
  - Line 1 (bold, primary): filename, e.g. `UNTITLED` /
    `regionals-2025`.
  - Line 2: the tournament's display event name from inside the
    envelope, e.g. `Summer Grapple Open 2026`. Rendered only when
    the event name actually differs from the filename, so rows on
    fresh `UNTITLED` events stay single-line.
  - Line 3 (dim): size · "updated Xm ago".
- **Sorted newest-first** using `max(createdAt, updatedAt)`. The
  previous build sorted by `updatedAt` only, which meant a
  freshly-duplicated event whose blob timestamp lagged the row's
  `createdAt` could drop a few positions.
- **3-dot actions menu per row.** A kebab button next to "Open"
  reveals two items:
  - *Make a copy* — POSTs to `/api/cloud/events/:id/copy`. The
    masters service server-side duplicates the latest blob into a
    new `CloudEvent` with `eventName = "Copy of <original>"` (so
    the copy is unambiguous in the catalog) and the bytes never
    leave the cloud.
  - *Delete* — DELETE on `/api/cloud/events/:id`. The masters
    service soft-deletes (`deletedAt` set), and the desktop proxy
    additionally drops any local `CloudEventLink` rows so the
    desktop never tries to push/pull against the tombstone.
    Guarded by a native `window.confirm` dialog.
- **Background clicks close the menu** — a single `mousedown`
  listener on the panel window dismisses the open menu.

### New schema (masters)
- `CloudEvent.eventName String?` (nullable, back-compat with rows
  created before v0.8.4). Deployed to Neon via `prisma db push`.

### New masters endpoints
- `POST /api/events/:id/copy` — server-side duplicate of the latest
  blob; returns the new event metadata.
- `PATCH /api/events/:id` — now accepts optional `eventName` field
  alongside `name`. At least one of the two must be present.

### New desktop proxy endpoints
- `DELETE /api/cloud/events/:id` — soft-delete + drop local
  `CloudEventLink` rows.
- `POST /api/cloud/events/:id/copy` — thin proxy to the masters
  /copy endpoint.

### Modified files
- `src/components/HomeCloudPanel.tsx` — UI rewrite (two-line rows,
  kebab menu, copy + delete handlers, newest-first sort).
- `src/lib/cloud-events.ts` — `patchCloudEvent`, `copyCloudEvent`,
  `deleteCloudEvent` helpers; `CloudEventMeta.eventName` field;
  `createCloudEvent` now accepts optional `{ eventName }`.
- `src/app/api/cloud/events/upload/route.ts` — includes the
  current `Tournament.name` as `eventName` when creating cloud
  events.
- `src/app/api/cloud/events/push/route.ts` — after a successful
  push, best-effort PATCHes `eventName` to keep the catalog
  label aligned with the local tab title.
- `src/app/api/cloud/events/rename/route.ts` — tab-rename now
  updates BOTH the cloud filename (`name`) and the display
  title (`eventName`).
- `masters/prisma/schema.prisma` — `CloudEvent.eventName` column.
- `masters/src/app/api/events/route.ts` — accepts `?eventName=`
  on create, returns it on GET.
- `masters/src/app/api/events/[id]/route.ts` — PATCH accepts
  `eventName: string | null`; GET returns it.
- `masters/src/app/api/events/[id]/copy/route.ts` — new /copy
  endpoint.

## v0.8.3 — Overlay tab-switch crash fix (2026-04-17)

### What shipped
- **Root cause**: The v0.8.2 diagnostics landed a clean stack in
  `bundled-server.log`:
  `TypeError: C.find is not a function` inside `[0,1,2,3].map` on
  `http://127.0.0.1:.../overlay?preview=1&tournamentId=...`. That
  pointed at `buildBracketProjection` in `src/lib/bracket-display.ts`,
  where `data?.quarterFinals.find(...)` only short-circuits when
  `data` itself is nullish. During the iframe remount that happens
  on every tab switch, the cached react-query bracket payload for
  the new tournament can briefly arrive with `quarterFinals` or
  `semiFinals` missing / non-array (e.g. an error envelope shaped
  `{ error }`). Calling `.find` on that non-array threw, the
  overlay's error boundary caught it, and Next's built-in
  "Application error" fallback rendered.
- **Fix**: Added `Array.isArray(...)` guards in
  `buildBracketProjection` so a malformed bracket payload degrades
  to the placeholder match branch (same output as "no bracket data
  yet") instead of throwing.
- **Diagnostics stay in place**: the `global-error` +
  `/api/diagnostics/client-error` reporter from v0.8.2 is unchanged,
  so any future render-time crash still leaves a one-line JSON
  trace in `bundled-server.log` instead of a blank "Application
  error" screen.

### Modified files
- `src/lib/bracket-display.ts` — array guards before `.find`.

## v0.8.2 — Cloud-first New Events + Home Catalog + Diagnostics (2026-04-17)

### What shipped
- **New Event = cloud event by default.** `File ▸ New Event` (and the
  homepage "Create new event" button) now:
  1. creates the local tournament as today,
  2. checks `GET /api/cloud/config`; if sync is configured,
  3. asks `GET /api/cloud/events` for existing cloud names,
  4. picks the first free `UNTITLED`, `UNTITLED(1)`, `UNTITLED(2)`, … name,
  5. uploads an empty envelope for the new tournament so it appears
     immediately in the cloud catalog, and
  6. renames the local tournament + dashboard tab label to match so
     the two stay in lockstep.
  If cloud is paused/offline, step 2 short-circuits and the event stays
  purely local — the existing "link later" flow still works.
- **Homepage lists the cloud catalog.** When no event tabs are open,
  the dashboard now renders `HomeCloudPanel` in place of the empty
  workspace. Lists every cloud event with name/version/size/updated
  metadata, one-click "Open" (reuses the Open-from-Cloud pipeline),
  and a prominent "+ Create new event" button. Shows a friendly
  "Not configured" notice with a Cloud Settings shortcut when sync is
  paused or tokenless, and a "Could not reach cloud" notice on
  network errors so the homepage never goes blank.
- **Tab rename → cloud rename.** Renaming a tab (double-click header
  or File ▸ Rename) now also PATCHes the linked cloud event so the
  catalog, Open-from-cloud dialog, and homepage list reflect the new
  name without waiting for a fresh push.
- **Client-error telemetry.** New `global-error.tsx` at the app root
  and updated `overlay/error.tsx` both POST their error message,
  stack, digest, URL, and UA to a new `/api/diagnostics/client-error`
  route, which writes a single-line JSON record to `bundled-server.log`.
  Reproducing the overlay-preview crash on tab switch now leaves a
  usable trace we can grep without a devtools session.

### New files
- `src/components/HomeCloudPanel.tsx` — homepage cloud catalog UI.
- `src/app/global-error.tsx` — root-level React error boundary.
- `src/app/api/diagnostics/client-error/route.ts` — error sink.
- `src/app/api/cloud/events/rename/route.ts` — PATCH bridge that
  forwards a local tournament rename to the linked cloud event.

### Modified files
- `src/lib/matbeast-dashboard-file-actions.ts` — `pickNextUntitledName`
  + `createCloudUntitledForNewTab`; `matbeastCreateNewEventTab` runs
  the cloud-first flow and fixes the tournaments rename URL to
  `/api/tournaments/[id]`.
- `src/components/NativeFileMenuBridge.tsx` — threads `updateTabName`
  through so the new-event flow can relabel the freshly-opened tab.
- `src/components/DashboardClient.tsx` — renders `HomeCloudPanel` when
  `openTabs.length === 0`.
- `src/components/AppChrome.tsx` — `saveRenamedTab` POSTs to
  `/api/cloud/events/rename` and broadcasts
  `matbeast-cloud-sync-changed` so the badge and catalog refresh.
- `src/lib/cloud-events.ts` — `renameCloudEvent(cloudEventId, name)`
  wrapper around the masters `PATCH /api/events/[id]` endpoint.
- `src/app/overlay/error.tsx` — pipes overlay errors into the
  diagnostic sink.

### Known open
- Overlay-preview "Application error" on tab switch is still reported
  in the wild. The v0.8.2 diagnostics are the setup for the fix —
  the next reproduction will land a concrete error+stack in
  `bundled-server.log` under the `overlay-error` or `global-error`
  scope, which we will use to land the actual patch in v0.8.3.

## v0.8.1 — Cloud Upload UX Fixes (2026-04-17)

- **Upload dialog default name** now reads `currentRosterFileName`
  from `/api/board` first and falls back to the tab label only when
  the roster filename is empty / `UNTITLED`. Fixes the report that
  "save to cloud defaulted to the event name instead of the
  filename".
- **Friendly not-configured notice.** Both `CloudUploadDialog` and
  `CloudOpenDialog` now preflight `GET /api/cloud/config` and, when
  `configured: false`, render an inline `NotConfiguredNotice` with a
  one-click "Open Cloud Settings" button instead of surfacing the
  generic `HTTP 502 {"error":"cloud not configured"}` from the
  upload/list endpoints.

## v0.8.0 — Cloud Event Files (2026-04-17)

### What shipped
- **Shared event files in the cloud.** Any `.matb` event can be
  uploaded and then opened on any other signed-in desktop. All
  tournament state — roster, brackets, results, audio volume — travels
  as a single opaque JSON blob stored in Neon Postgres (`bytea`).
- **Auto-push on save.** Every successful disk save triggers a
  best-effort cloud push for tournaments linked to a cloud event.
  Disk save is the source of truth; cloud failures never turn a
  successful save into a failure.
- **CloudSyncBadge on the dashboard header.** Shows one of six
  states per active tab: `LOCAL ONLY`, `SYNCED`, `NOT SYNCED`,
  `SYNCING`, `CONFLICT`, `OFFLINE`. A force-sync icon next to it
  retries the push immediately. Badge polls local state every 3 s
  and the cloud metadata every 30 s.
- **Conflict prompt** (last-save-wins protected by a version fence):
  if someone else pushed a newer version, the next push returns
  409 and the user sees a three-button prompt — Overwrite cloud,
  Keep cloud, or Save mine as a local-only copy.
- **Two new File menu items**: `Open from Cloud…` and `Upload Current
  to Cloud…`. Open reuses the existing import pipeline so each cloud
  event becomes a new local tournament (same way disk opens work).
- **Offline resilience**: users can save locally as always; the badge
  will read NOT SYNCED / OFFLINE. When connectivity returns, the next
  save flushes the pending bytes to the cloud.

### New files
- `src/lib/cloud-events.ts` — sync engine: hash helpers, pull/push
  clients, link-row upsert, `computeStatus()` state machine for the
  badge.
- `src/app/api/cloud/events/*` — 6 route handlers: `GET /` (list),
  `POST /push` (push with conflict detection), `POST /pull`
  (download), `POST /upload` (create new cloud event), `GET /status`
  (badge poll), `DELETE /link` (unlink).
- `src/components/CloudSyncBadge.tsx` — the header badge + force-sync
  button + details popover.
- `src/components/CloudEventDialogs.tsx` — Open / Upload / Conflict
  modal shell, mounted once in `RouteChromeShell`.

### Schema additions (lazy-created, legacy DBs auto-heal)
- `CloudEventLink` — one row per locally-linked tournament. Tracks
  `baseVersion`, `lastSyncedSha`, `currentLocalSha`, `pendingPushAt`,
  `lastError`, and an optional `localMirrorPath`. All fields are
  created by `ensureCloudTables()` the first time any cloud route is
  hit, so pre-0.8.0 user DBs get the table on first use without a
  migration step.

### Cloud side (matbeast-masters v0.4.0)
- `CloudEvent` + `CloudEventBlob` models. Blob bytes live in Postgres
  `bytea` (decision 1a) with a simple version counter and a SHA-256
  over each version. Soft-delete via `deletedAt`.
- `GET/POST /api/events`, `GET/PATCH/DELETE /api/events/:id`,
  `GET/PUT /api/events/:id/blob`. Uploads use
  `application/octet-stream`, so no base64 overhead. PUT requires
  `X-Expected-Version: <N>` — the cloud returns 409 on mismatch
  (decision 3b: last-save-wins, no soft lock).
- `/events` admin page lists + renames + soft-deletes cloud events
  for quick cleanup from the browser.

### Design notes / known limitations
- **Request body limit**: Vercel Hobby plan caps bodies at ~4.5 MB.
  Events with many large profile photos can exceed this. The fix path
  (deferred): switch `/events/:id/blob` to direct-to-storage uploads
  via Vercel Blob or R2. For now, oversize events still work
  offline / on disk, just not in the cloud.
- **Delete semantics**: `DELETE /api/events/:id` is soft-delete only.
  Local desktops that have the event still see LOCAL state because
  their `CloudEventLink` row is intact; they'll just hit a 404 on the
  next push and the badge flips to OFFLINE with a clear error.
  Explicit unlink is available via `DELETE /api/cloud/events/link`.
- **Conflict prompt policy** (decision 4a, prompt every time): we do
  NOT silently auto-merge or auto-overwrite. Every 409 surfaces the
  3-button dialog on the originating desktop. Users who never want
  to see the dialog should coordinate out-of-band (group chat) — by
  design we never assume who's "right".
- **Badge polling cost**: the 30-second cloud metadata poll is a
  tiny GET per active tab. Five users × a handful of tabs is trivial
  on Neon's free tier. If this ever becomes expensive, bump to 60s
  or switch to an SSE push.

## v0.7.0 — Cloud Sync for Master Lists (2026-04-17)

### What shipped
- **Two master lists synced separately**: `MasterPlayerProfile` and
  `MasterTeamName` each have their own independent pull+push cycle. You
  can open the profiles panel without triggering a team-names sync and
  vice versa.
- **On-demand sync**: every GET of `/api/master-team-names` and
  `/api/player-profiles` runs `syncTeamNames()` / `syncProfiles()` before
  serving; every POST / PATCH / DELETE queues a `MasterCloudOutbox` op
  and attempts an immediate drain. No background timers, no manual-sync
  button requirement.
- **Offline resilience**: pulls + drains are best-effort. Local SQLite
  always wins — a cloud failure (no internet, cloud down, 401 from
  revoked token) is swallowed and the route serves cached data. The
  outbox drains the next time any sync succeeds. Cap: 5 attempts per op
  before it's left for manual intervention.
- **Revocable per-desktop auth**: each desktop install links with a
  long-lived Mat Beast Masters token (`mbk_...`), pasted into
  Options ▸ CLOUD SYNC... The token is stored hashed in the cloud DB;
  admin (any signed-in Clerk user) can revoke any token at
  `https://matbeast-masters.vercel.app/desktop-tokens` for an instant cutoff.
  Revocation check happens on every cloud request — no cached JWT to
  wait out.

### New files
- `src/lib/cloud-config.ts` — singleton CloudConfig row (token, base URL,
  last-sync times, error, sync-enabled flag).
- `src/lib/cloud-config-table.ts` — lazy CREATE TABLE IF NOT EXISTS for
  CloudConfig + MasterCloudOutbox (same self-heal pattern as
  `master-team-name-table.ts` / `master-player-profile-table.ts`).
- `src/lib/cloud-sync.ts` — the sync engine. Exports `pullTeamNames()`,
  `pullProfiles()`, `drainOutbox()`, `queueOutboxOp()`, and the bundled
  `syncTeamNames()` / `syncProfiles()` used by the route handlers.
- `src/app/api/cloud/config/route.ts` — GET/PATCH/DELETE local cloud
  settings (token, base URL, sync-enabled).
- `src/app/api/cloud/sync/route.ts` — POST with `{ kind:
  "profiles" | "team-names" | "drain" | "all" }` to force a sync.
- `src/components/CloudSettingsModal.tsx` — Cloud settings UI (status,
  token paste, "Sync now", unlink, pause/resume).
- `electron/main.js` — new menu entry `Options ▸ CLOUD SYNC...` dispatches
  `matbeast-native-options` with `action: "cloud"` which `AppChrome`
  listens for to open the modal.

### Schema additions (lazy-created, not in seed template, so legacy user DBs upgrade silently)
- `MasterTeamName.cloudId` (TEXT, nullable) — remote row id cached after
  first push/pull so deletes can hit the cloud directly.
- `MasterPlayerProfile.cloudId` (TEXT, nullable) — same.
- `CloudConfig` (singleton) — one row, id always "default".
- `MasterCloudOutbox` (FIFO queue of pending cloud writes).

### Additive migration in `electron/main.js`
Added `cloudId` TEXT to `ADDITIVE_COLUMN_PATCHES` for both
`MasterTeamName` and `MasterPlayerProfile`. Existing user DBs get the
column on next launch via the same ALTER-TABLE self-heal that handles
the LiveScoreboardState evolutions. The CloudConfig / MasterCloudOutbox
tables are lazy-created by `ensureCloudTables()` on first cloud-related
API call, so no structural-drift trigger fires.

### Cloud side (matbeast-masters v0.3.0)
- `DesktopToken` model: id, userId, label, tokenHash (sha256),
  tokenPreview (last 4), createdAt, lastUsedAt, revokedAt,
  revokedByUserId. Instant revocation — checked on every request.
- `POST /api/desktop-tokens` (mint, plaintext shown once),
  `GET /api/desktop-tokens` (list), `DELETE /api/desktop-tokens/:id`
  (revoke).
- `/desktop-tokens` admin page with "Generate / Copy / Revoke" UI.
- Middleware + `requireUserId()` accept `Authorization: Bearer mbk_...`
  in addition to Clerk session cookies. 401 returned for Bearer failures
  (NOT 404) so the desktop can distinguish "relink needed" from
  "endpoint gone".

### Design notes / known limitations
- Dedup key is the natural key on both sides: `(firstName, lastName)`
  for profiles, `name` for teams. Both sides normalize to UPPERCASE.
  Two desktops creating "John Smith" independently end up with one row.
- **Deletes do NOT propagate via pull**. If Desktop A deletes a profile
  and pushes that delete to the cloud, Desktop B's local copy survives
  until B explicitly deletes it. This is deliberate — avoids surprise
  deletions of a local row that was added offline but hasn't been
  pushed yet. Can be revisited if the group grows.
- **Sync timeout is 12s**. If the venue has no internet, the first read
  of the day pays a 12s cloud-timeout before falling back to cache.
  Mitigate by toggling `syncEnabled` off in Cloud settings before the
  venue.
- Token is stored plaintext in the local SQLite under %LOCALAPPDATA%.
  Per-user OS protection is the floor; OS keyring storage (keytar) is a
  future upgrade if needed.

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
