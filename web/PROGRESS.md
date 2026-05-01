# Progress Log

## Current Build Status
- Desktop app rebuilt successfully multiple times. v0.9.13 → v0.9.19
  in a single session diagnosed and shipped a hardened preload-bridge
  pipeline along with the new bracket-music feature; full breakdown
  under **2026-04-28 Session Updates**. v0.9.21 (2026-04-29) lays the
  first NDI scaffolding — offscreen-render smoke test, no NDI library
  yet; v0.9.22 fixes a v0.9.21-shipped exclusivity-lock race that made
  every smoke-test invocation immediately return "already running".
  v0.9.29 (2026-04-29) lights up the actual NDI sender — `grandiose`
  (Streampunk's NewTek NDI® N-API binding, master @ `c350e0fb`) is
  bundled with the installer, the offscreen scoreboard `BrowserWindow`
  is wired into a real `NDIlib_send` instance named "Mat Beast
  Scoreboard", and the Options ▸ NDI submenu has a Start / Stop
  toggle. NDI Studio Monitor / OBS / vMix on the same network see
  the source within ~3 s of the toggle. v0.9.30 (2026-04-29)
  diagnoses + fixes the "source visible but no video" bug
  v0.9.29 shipped on the operator's 150 %-DPI laptop, adds the
  bracket NDI source alongside the scoreboard, and introduces a
  receiver-format-stability warmup so receivers don't latch onto a
  partially-hydrated React tree. Receiving NDI clients now show the
  actual scoreboard within ~1 s of subscription.   v1.0.1 (2026-04-29)
  is a small visual refresh: the SHOW TEAMS overlay (the two-team
  list that appears in the Overlay card) now uses a single 1344×168
  `teamsbg.png` artwork with the "MAT BEAST CHAMPIONSHIP" title
  baked in, replacing the previous bordered-rectangle + separate
  logo composition. No surrounding box, border, or shadow is drawn
  any more — only the artwork plus the team text rendered beneath
  the built-in title. Same Oswald font, same yellow click-to-glow
  highlight, same click-driven cross-window broadcast, same
  shrink-to-fit for long rosters. v1.2.0 (2026-04-30) drops the
  cloud auth requirement entirely (Mat Beast Masters is now an
  open shared workspace — no tokens, no per-user accounts) and
  adds a first-launch password gate (`Kuwy`) that blocks the
  dashboard until the operator types the access password once per
  install. v1.2.0 supersedes the brief v1.1.0 optional-registration
  experiment.
- Latest installer artifact:
  - `dist/Mat Beast Scoreboard Setup 1.2.0.exe` (2026-04-30 —
    **Open cloud (Model A) + first-launch password gate.** Operator
    request: "Can we just eliminate registration and token requirements
    altogether and allow syncing and cloud access to any user?" followed
    by a chosen architecture of "1.a;2.a;" (one shared global cloud, no
    per-user accounts) and a separate first-launch gate: "I want the
    user to enter the password 'Kuwy' before the app can launch for the
    first time." This release implements both at once, replacing the
    short-lived v1.1.0 optional-registration model.

    Cloud server (`masters/` v0.5.0):
    - `src/lib/auth.ts` — `requireUserId()` is now total. Resolution
      order is unchanged for the happy paths (Clerk session → desktop
      bearer token), but a missing/invalid/revoked credential no longer
      returns 401; instead the request is attributed to a sentinel
      userId `"shared-workspace"` and `via: "shared"`. Every existing
      route handler keeps its `if ("response" in a) return a.response;`
      guard so the type contract is preserved, but that branch is no
      longer reachable in normal traffic. Old desktop installs that
      still send a Bearer header keep their per-user audit attribution;
      everyone else writes show up under the shared sentinel.
    - No schema migration required — the various `*UserId` columns are
      already plain strings, not foreign keys, and the catalog query
      already returns every event to every signed-in user (see the
      "5-user / shared-workspace model" comment in `events/route.ts`).
      The only behavioural change is that "every signed-in user" now
      means literally everyone.
    - Deploy story: push the `masters/` package to Vercel (or trigger a
      redeploy of the existing project) BEFORE shipping the desktop
      v1.2.0 installer to operators. v1.1.x desktops keep working
      against the v0.5.0 cloud (their token still validates and they
      stay attributed to themselves); v1.2.0 desktops only work
      against the v0.5.0+ cloud.

    Desktop app (`web/` v1.2.0):
    - `src/components/FirstLaunchPasswordGate.tsx` (new file, already
      authored before this session as a work-in-progress and now
      shipped) — full-screen modal mounted by `RouteChromeShell` above
      the entire dashboard tree. On first dashboard mount it reads
      `localStorage["matbeast.firstLaunchPasswordEntered"]`; if not
      set, the dashboard chrome stays unmounted (no flash) and the
      operator must type the access password (`"Kuwy"`) before
      anything else loads. Submitting the correct password sets the
      flag and unlocks the install; incorrect submissions clear the
      field and re-focus. Overlay routes (`/overlay/*`) are never
      gated, so popped-out / NDI offscreen windows always work even
      on a freshly-installed locked machine. The password is **not** a
      security boundary — the expected value is in the shipped JS
      bundle and trivially extractable — it exists to filter casual /
      unintended launches by people who weren't given the password
      verbally.
    - `src/components/RouteChromeShell.tsx` — wraps the dashboard
      bridges + chrome + page in `<FirstLaunchPasswordGate>`. The
      `pathname?.startsWith("/overlay")` short-circuit at the top of
      the component is preserved, so the gate is enforced exactly on
      the routes a fresh-install operator would see.
    - `src/lib/cloud-config.ts` — `isCloudConfigured(cfg)` now returns
      just `cfg.syncEnabled`. The `desktopToken.length > 0` half of
      the gate is gone; the cloud no longer requires a token. The
      `desktopToken` field itself stays on the singleton row for
      backwards compatibility with old installs that have one saved.
    - `src/lib/cloud-sync.ts` + `src/lib/cloud-events.ts` — `cloudFetch`
      / `authHeaders` only attach an `Authorization: Bearer …` header
      when a non-empty token is saved locally. A blank token no longer
      sends a malformed `Bearer ` value (some intermediaries reject
      that) and the cloud's `requireUserId()` accepts the missing
      credential as the shared workspace user.
    - `src/components/HomeCloudPanel.tsx` — removed the v1.1.0
      "Registered" (emerald) / "Unregistered" (zinc) status line and
      the unregistered empty-state explainer panel. The home page
      header is back to a single line and the only remaining
      banner-style empty state is amber "Cloud sync is paused" when
      the operator has explicitly paused sync from Cloud Settings.
    - `src/components/CloudSettingsModal.tsx` — rewritten. Title is
      always "Cloud sync" (no more switching between "Register Mat
      Beast Scoreboard" / "Cloud sync"); the v1.1.0 "Registering is
      optional" explainer panel is gone; the entire Desktop token
      section (paste / save / unlink) is gone. The modal is now a
      pure status + control panel: sync enabled toggle, live-master
      pulls toggle, cloud URL display, last-pull timestamps, pending
      outbox count, last error, and a Sync Now button.
    - `src/components/CloudEventDialogs.tsx` — `NotConfiguredNotice`
      drops the "no desktop token" branch since that state can no
      longer occur. The remaining branches handle "config could not
      be read" and "sync paused".
    - `src/components/AppChrome.tsx` — removed the `<FirstRunRegisterDialog />`
      mount and import.
    - `src/components/FirstRunRegisterDialog.tsx` — deleted.
    - `src/components/NativeFileMenuBridge.tsx` — removed the
      `d.action === "register"` handler.
    - `electron/main.js` — removed the File ▸ Register… menu item and
      its trailing separator, and removed `"register"` from the
      `sendFileMenuAction` allow-list.
    - `src/lib/matbeast-dashboard-file-actions.ts` — pre-flight
      comment in `matbeastCreateNewEventTab` updated to drop the
      "registered / unregistered" framing; behaviour is unchanged
      (still blocks creation if cloud is `unreachable`, still
      proceeds locally if cloud is `not-configured`/paused).
  - `dist/Mat Beast Scoreboard Setup 1.1.0.exe` (2026-04-30 —
    Optional registration. Operator request: "Make a new version of
    the app that does not require a token when installed on a new
    computer. The token should be optional. If no token is obtained
    then the app will not have access to the master profiles names
    list and master team names lists in either training or
    production modes. The drop-down list for that will simply not
    populate. Therefore, after the user installs the app on a new
    computer, it should give the option to 'register' the app which
    means to generate and install a token and the app should
    explain the difference. The home screen should display a small
    text status line that says either 'Unregistered' or 'Registered'.
    The file menu should give the option to Register which will
    take the user to the screen to sign in and obtain a token."
    Five surfaces changed:
    (1) `src/lib/matbeast-dashboard-file-actions.ts` —
    `matbeastCreateNewEventTab`'s pre-flight cloud-online probe used
    to hard-block creation when no token was set, alerting the
    operator to configure Options ▸ CLOUD SYNC… first. That gate
    was the one place a brand-new install actually broke without a
    token, since every other flow already tolerated unconfigured
    cloud (master-list dropdowns read from local SQLite which is
    just empty without sync; `createCloudUntitledForNewTab` returns
    `{ status: "not-configured" }` and the caller already keeps the
    local tournament). The probe now only blocks when `tokenSet`
    AND the cloud is actively unreachable; `reason ===
    "not-configured"` falls through and creation proceeds locally.
    (2) `src/components/HomeCloudPanel.tsx` — added a small
    "Registered" (emerald) / "Unregistered" (zinc) status line
    under the "Mat Beast Scoreboard" title (purely informational
    per operator preference), reworked the empty-state from the
    legacy amber "Cloud not configured" warning to a calm
    informational panel that opens with "This install is
    unregistered." and explains the registration model in the
    same wording the welcome dialog uses. The Open Cloud Settings
    button on this panel is now labelled "Register this computer".
    Subtitle copy reworded from "New events are saved to the cloud
    automatically." → "New events are saved to the cloud
    automatically when this install is registered." so the
    operator's expectations match what actually happens on an
    unregistered install. The amber warning is preserved for the
    edge case where a token IS set but cloud sync is paused / down.
    (3) `src/components/CloudSettingsModal.tsx` (already on disk
    from an earlier work-in-progress patch) — modal title flips
    between "Register Mat Beast Scoreboard" (no token) and "Cloud
    sync" (token set), and the no-token state now renders an
    explainer panel above the existing Status / Sync / Token
    sections. The explainer says "Registering is optional." with
    "With registration:" / "Without registration:" bullets that
    track the same wording the home empty-state and welcome dialog
    use. (4) `electron/main.js` — added "register" to
    `sendFileMenuAction`'s allowed action set, plus a new
    "File ▸ Register…" menu item near the bottom of the File
    submenu (after Backup / Restore copy from disk) so first-time
    operators can find it without digging through Options ▸ CLOUD
    SYNC…; hidden in the demo variant since the demo never talks to
    the cloud. (5) `src/components/NativeFileMenuBridge.tsx`
    (already on disk from the same earlier patch) — translates the
    new "register" action into the existing `matbeast-native-options`
    custom event with action: "cloud" so AppChrome's existing
    listener pops `CloudSettingsModal` for free; no second listener
    surface needed. New file: `src/components/FirstRunRegisterDialog.tsx`
    — one-shot welcome dialog mounted from `AppChrome.tsx` that
    self-gates to "render only when `tokenSet === false` AND
    `localStorage["matbeast.seenRegisterPrompt"] !== "true"`" so it
    shows exactly once per fresh install, dismisses to either
    "Skip for now" or "Register now" (the latter chains into
    `CloudSettingsModal` via the same options-menu event path), and
    persists the seen-flag in localStorage on either dismiss path.
    Wording matches the operator's literal request: "This app is
    unregistered. You can use it as-is, or register this computer
    now to unlock master profile names and master team names. For
    team setup, registration is recommended. For only timer and
    scoreboard operation, registration is not needed. You can
    register anytime from File ▸ Register." Architecture note: the
    seen-flag intentionally lives in localStorage rather than
    `desktopPreferences` so the existing IPC plumbing doesn't have
    to grow another channel; localStorage is per-install on
    Electron's user-data dir, which is exactly the persistence
    domain we want for "did this install's operator already see
    the welcome?". File trail:
    `src/lib/matbeast-dashboard-file-actions.ts`,
    `src/components/HomeCloudPanel.tsx`,
    `src/components/AppChrome.tsx`,
    `src/components/FirstRunRegisterDialog.tsx` (new),
    `electron/main.js`, `package.json`. The CloudSettingsModal
    explainer + NativeFileMenuBridge "register" handler from a
    prior work-in-progress edit ship as part of this release.)
  - `dist/Mat Beast Scoreboard Setup 1.0.1.exe` (2026-04-29 —
    Team-list overlay artwork refresh. Operator request: "I want to
    replace the background for the Team names list overlay (the
    overlay that appears when you click SHOW TEAMS in the Overlay
    card). Use `teamsbg.png` (1344×168) which already includes the
    'MAT BEAST CHAMPIONSHIP' title baked into the artwork. Do not
    generate a box or background — only text using the same font
    and same highlighting functionality as before. The text should
    be centered and show as one or two lines beneath the title."
    Replaced the legacy `bgteam.png` (1920×187) + separate
    `CHAMPIONSHIP.png` logo + bordered rectangle composition with a
    single 1344×168 `teamsbg.png` rendered at native resolution and
    centered inside the same 1920 × 187 band the bordered rectangle
    used to occupy (band y 316 → 503). The bordered rectangle is
    gone entirely — no `border`, no `boxShadow`, no
    `backgroundColor` fallback, no `overflow: hidden` clipping.
    Pixels outside the 1344×168 image are now fully transparent so
    the underlying scoreboard shows through; this matches the
    decorative side-accents in the new artwork, which are designed
    to read as part of the scene rather than fenced inside a
    rectangle. The `<img src="/CHAMPIONSHIP.png">` logo element was
    removed from the DOM tree because the title is now part of the
    bg image; this also lets us drop the logo's `onLoad` re-measure
    hook (the only async image-decode dependency this overlay had).
    Team text is overlaid below the title via a clipped flexbox
    region positioned at `top: 60px, left: 64px, right: 64px,
    bottom: 8px` inside the 1344×168 image, giving an effective
    text area of 1216 × 100 px — wide enough for the 4-NBSP
    `TEAMNAME:    NAME1    NAME2…` format used since v0.8.0, tall
    enough for two stacked lines at the locked 40 px Oswald with
    20 px gap (40 + 20 + 40 = 100 exactly). Shrink-to-fit is
    preserved: the line-stack wrapper is rendered with
    `width: max-content` so its `offsetWidth` always reflects the
    true natural pre-scale width, then a uniform
    `transform: scale(min(1, 1216 / naturalW, 100 / naturalH))` is
    applied so long rosters compress instead of overflowing. Same
    `useLayoutEffect` measurement pipeline as v1.0.0 (rAF-deferred
    initial measure → `document.fonts.ready` re-measure for the
    Oswald font swap → ResizeObserver for everything else) so the
    measurement converges cleanly even when Oswald hasn't finished
    loading on the first paint. Font / color / highlight
    semantics are identical to v1.0.0: Oswald 700 at 40 px in
    `#99c5ff` for `TEAMNAME:`, Oswald 400 at 40 px in `#d9d9d9` for
    player names, click any name to toggle a yellow
    (`#ffec4d`) breathing-glow highlight driven by the
    `matbeastTeamGlow` keyframe (1 s color cross-fade + 2 s
    text-shadow pulse), keyboard-activatable via Enter / Space.
    Click forwarding still goes through the existing
    `OverlayTeamListLayer` → `onPlayerClick({team, playerIndex})`
    contract, so `overlay-client.tsx`'s broadcast-channel-driven
    selection logic is unchanged and keeps every overlay window
    on the same highlighted name. New asset committed at
    `web/public/teamsbg.png`; the old `bgteam.png` and
    `CHAMPIONSHIP.png` PNGs are no longer referenced from any
    source file but were left on disk so existing build artifacts
    continue to validate (they can be removed in a future cleanup
    pass once we're confident no off-tree consumer depends on
    them). File trail:
    `src/app/overlay/overlay-team-list-layer.tsx`,
    `web/public/teamsbg.png`, `package.json`.)
  - `dist/Mat Beast Scoreboard Setup 1.0.1.exe` (2026-04-29 —
    Team-list overlay artwork refresh. Operator request: "I want to
    replace the background for the Team names list overlay (the
    overlay that appears when you click SHOW TEAMS in the Overlay
    card). Use `teamsbg.png` (1344×168) which already includes the
    'MAT BEAST CHAMPIONSHIP' title baked into the artwork. Do not
    generate a box or background — only text using the same font
    and same highlighting functionality as before. The text should
    be centered and show as one or two lines beneath the title."
    Replaced the legacy `bgteam.png` (1920×187) + separate
    `CHAMPIONSHIP.png` logo + bordered rectangle composition with a
    single 1344×168 `teamsbg.png` rendered at native resolution and
    centered inside the same 1920 × 187 band the bordered rectangle
    used to occupy (band y 316 → 503). The bordered rectangle is
    gone entirely — no `border`, no `boxShadow`, no
    `backgroundColor` fallback, no `overflow: hidden` clipping.
    Pixels outside the 1344×168 image are now fully transparent so
    the underlying scoreboard shows through; this matches the
    decorative side-accents in the new artwork, which are designed
    to read as part of the scene rather than fenced inside a
    rectangle. The `<img src="/CHAMPIONSHIP.png">` logo element was
    removed from the DOM tree because the title is now part of the
    bg image; this also lets us drop the logo's `onLoad` re-measure
    hook (the only async image-decode dependency this overlay had).
    Team text is overlaid below the title via a clipped flexbox
    region positioned at `top: 60px, left: 64px, right: 64px,
    bottom: 8px` inside the 1344×168 image, giving an effective
    text area of 1216 × 100 px — wide enough for the 4-NBSP
    `TEAMNAME:    NAME1    NAME2…` format used since v0.8.0, tall
    enough for two stacked lines at the locked 40 px Oswald with
    20 px gap (40 + 20 + 40 = 100 exactly). Shrink-to-fit is
    preserved: the line-stack wrapper is rendered with
    `width: max-content` so its `offsetWidth` always reflects the
    true natural pre-scale width, then a uniform
    `transform: scale(min(1, 1216 / naturalW, 100 / naturalH))` is
    applied so long rosters compress instead of overflowing. Same
    `useLayoutEffect` measurement pipeline as v1.0.0 (rAF-deferred
    initial measure → `document.fonts.ready` re-measure for the
    Oswald font swap → ResizeObserver for everything else) so the
    measurement converges cleanly even when Oswald hasn't finished
    loading on the first paint. Font / color / highlight
    semantics are identical to v1.0.0: Oswald 700 at 40 px in
    `#99c5ff` for `TEAMNAME:`, Oswald 400 at 40 px in `#d9d9d9` for
    player names, click any name to toggle a yellow
    (`#ffec4d`) breathing-glow highlight driven by the
    `matbeastTeamGlow` keyframe (1 s color cross-fade + 2 s
    text-shadow pulse), keyboard-activatable via Enter / Space.
    Click forwarding still goes through the existing
    `OverlayTeamListLayer` → `onPlayerClick({team, playerIndex})`
    contract, so `overlay-client.tsx`'s broadcast-channel-driven
    selection logic is unchanged and keeps every overlay window
    on the same highlighted name. New asset committed at
    `web/public/teamsbg.png`; the old `bgteam.png` and
    `CHAMPIONSHIP.png` PNGs are no longer referenced from any
    source file but were left on disk so existing build artifacts
    continue to validate (they can be removed in a future cleanup
    pass once we're confident no off-tree consumer depends on
    them). File trail:
    `src/app/overlay/overlay-team-list-layer.tsx`,
    `web/public/teamsbg.png`, `package.json`.)
  - `dist/Mat Beast Scoreboard Setup 1.0.0.exe` (2026-04-29 — First
    stable release. v1.0.0 is a milestone marker, not a feature
    release: it captures the cumulative state of the desktop app
    after the long v0.9.x stabilisation cycle (v0.9.12 → v0.9.36)
    and is the first build the operator is comfortable shipping for
    real tournament use. No code changes from v0.9.36 — the version
    bump exists so the GitHub release surface, the installer
    filename, and the auto-update channel all start fresh at a
    semver major. Headline features that are now first-class in
    this build, in case anyone reads this entry as their first
    introduction: end-to-end NDI video output for both the
    scoreboard and bracket scenes (1920×1080 @ 30 fps, BGRA with
    alpha for the scoreboard, opaque for the bracket); end-to-end
    NDI audio for both scenes (planar Float32 @ 48 kHz captured
    via AudioWorklet in the offscreen renderer, fed to grandiose's
    `sender.audio()` after a postinstall patch enabled it);
    operator-friendly NDI network adapter binding via a private
    `ndi-config.v1.json` and an `Options ▸ NDI ▸ Network adapter`
    submenu, with a status pill on the Overlay-card header that
    shows whether NDI is currently advertising on Wi-Fi / Ethernet
    / a routable adapter at all; cloud-first event lifecycle with
    automatic catalog rows on create + best-effort silent autosave
    on every edit; cross-PC display-title healing that recovers
    events whose cloud blob was uploaded with the v0.9.35-and-
    earlier bug that wrote the FILENAME into the envelope's
    `eventName` field. v1.0.0 also locks in the 10s-warning + air
    horn cues over NDI for the scoreboard (v0.9.35) and the bracket
    music looping over NDI (v0.9.34), so receiving PCs hear
    everything the operator hears. Known limitations carried into
    v1.0.0: NDI runtime currently re-reads its config only on
    process start (rebinding requires an app relaunch — the menu
    surfaces this with a native restart-now / restart-later
    dialog); cloud catalog rows from before v0.8.4 may have a null
    `eventName` column, so the v0.9.36 healing code falls back to
    the parser's filename-stem behaviour for those (the cure is a
    one-time rename through the dialog, which patches both
    columns). File trail: `package.json`, `PROGRESS.md` only — no
    other files changed between v0.9.36 and v1.0.0.)
  - `dist/Mat Beast Scoreboard Setup 0.9.36.exe` (2026-04-29 —
    Event-name-becomes-filename bug fix. Operator report: "My event
    files have an event name but the app is occasionally changing
    the event name to the filename. I believe it is doing this upon
    closing the app and reopening it again." Tracked it down to the
    cloud-first new-event flow in
    `src/lib/matbeast-dashboard-file-actions.ts`. When the New Event
    dialog submitted, `matbeastCreateNewEventTab` immediately
    uploaded the freshly-created tournament's envelope to the cloud
    via `createCloudUntitledForNewTab` so the cloud catalog and the
    local SQLite row stayed paired from the very first save. That
    helper had `const cloudName = preferredName ?? pickNextDated…`
    holding the cloud FILENAME (e.g. `0428-1`), then called
    `buildEnvelopeTextForActiveTab(cloudName)` to produce the JSON
    that gets uploaded. `buildEnvelopeTextForActiveTab(tabName)`
    expects a DISPLAY title — it forwards `tabName` straight into
    `wrapMatBeastEventFile(eventName, …)`, which writes it as the
    envelope's `eventName` field. Net effect: the cloud blob's
    envelope had `eventName: "0428-1"` (the filename) instead of
    `eventName: "Spring Quintet 2026"` (whatever the user typed in
    the dialog). The cloud catalog ROW got the right `eventName`
    (the upload route reads `prisma.tournament.name` for that
    column), and the local SQLite tournament row also kept the
    correct name, so the tab label and homepage catalog all looked
    fine — the bug was invisible until close + reopen-from-cloud.
    On reopen, `matbeastImportOpenedEventFile` parsed the cloud
    blob, found `eventName: "0428-1"` in the envelope, and POSTed
    `/api/tournaments` with `name: "0428-1"`, creating a new local
    tournament whose display name was the filename. The bug was
    "occasional" because any subsequent autosave (literally one
    edit) ran `matbeastSaveTabById`, which builds the envelope
    using `tabMeta?.name` (the correct display title) and pushes a
    healed blob to the cloud — so events the operator touched
    before closing self-healed silently, while events created and
    closed without an edit kept the broken blob and surfaced the
    rename on next reopen. Fix is two-pronged. (1) Primary fix:
    `createCloudUntitledForNewTab` gains a `displayName` option;
    `matbeastCreateNewEventTab` passes `(j.name ?? requestedName)`
    (the tournament's display title from the
    `/api/tournaments` POST response). The function uses
    `displayName` for `buildEnvelopeTextForActiveTab` and keeps
    using `cloudName` for the upload route's `name` column, which
    is exactly what each call site needs. Falls back to `cloudName`
    when `displayName` is empty so older callers still compile and
    behave like before; the only caller is
    `matbeastCreateNewEventTab`, which now always supplies it.
    (2) Defensive fix: `matbeastImportOpenedEventFile` gains a
    `displayNameOverride?: string | null` option that, when
    non-empty, replaces the parser's resolved `eventName` before
    `POST /api/tournaments`. Both cloud open paths
    (`HomeCloudPanel.openCloudEvent` and
    `CloudEventDialogs.handleCloudOpen`) wire `meta.eventName ?? null`
    into this — the cloud catalog row's `eventName` column is
    rewritten on every rename and on every upload (from
    `prisma.tournament.name`), so it's always at least as fresh as
    the in-blob `eventName` and never carries the old filename
    fallback. This heals existing buggy events on disk for any user
    who was already affected: the next time they open one of those
    events from the cloud home, the catalog's display title wins
    over the broken blob, the new local tournament gets the right
    name, and the next autosave rewrites the cloud blob's envelope
    with the correct `eventName` (no extra migration needed). Disk
    imports (`File ▸ Open`, Open Recent, double-click the
    `.matb`/`.mat`/`.json` file) don't pass the override and keep
    the existing parser-with-filename-stem-fallback behaviour, so
    legitimately-named disk files are unaffected. The local
    `CloudEventMeta` type in `CloudEventDialogs.tsx` was outdated
    (missing `eventName` since v0.8.4); aligned it with the
    canonical type in `lib/cloud-events.ts` so both call sites can
    read the field. File trail:
    `src/lib/matbeast-dashboard-file-actions.ts`,
    `src/components/HomeCloudPanel.tsx`,
    `src/components/CloudEventDialogs.tsx`, `package.json`. No
    server / Prisma changes — the cloud catalog already had
    everything we needed; it was just being ignored on the way in.)
  - `dist/Mat Beast Scoreboard Setup 0.9.35.exe` (2026-04-29 —
    NDI scoreboard cue audio. v0.9.34 wired end-to-end NDI audio for
    the bracket scene only; the operator immediately hit the obvious
    next gap: "The Bracket overlay works correctly with the music
    file but the 10s warning sound and air horn sound does not get
    sent to the scoreboard overlay." Root cause: the timer-cue
    playback (`useTimerAlertSounds`) was only mounted in
    `src/components/ControlPanel.tsx` (operator dashboard, audible
    on the operator's selected device) — the offscreen NDI scoreboard
    `BrowserWindow` never instantiated it, so the receiving PC's NDI
    track silently received nothing on the 10-second / zero
    boundaries. Fix is the same shape as v0.9.34's bracket-music
    plumbing, but applied to the scoreboard scene's transient cues
    (`b10` = 10s warning, `b0` = air horn) instead of a long-running
    looping music graph, and with a different audio-graph topology
    because cue playback uses `BufferSource` nodes that are created
    and destroyed per cue. (1) Refactored
    `src/hooks/useTimerAlertSounds.ts` to accept an
    `options?: { tapPcmForNdi?: boolean; ndiScene?: "scoreboard" |
    "bracket" }` parameter. The standard branch (no options) is
    untouched, so the dashboard's existing `ControlPanel.tsx` mount
    keeps the operator-device routing,
    `applySelectedAudioOutputToContext`, volume slider listener, and
    cross-window dedup gates exactly as before. The new NDI-tap
    branch reorders the audio chain from
    `BufferSource → gain → destination` to
    `BufferSource → tapNode → gain → destination(silent)` so the
    `AudioWorkletNode` sees full pre-gain amplitude regardless of
    the operator's local volume slider. The `AudioKit` type gained
    an `input: AudioNode` field (gain in normal mode, tapNode in
    NDI mode) so `playBuffer` connects each per-cue `BufferSource`
    to the correct upstream node without branching on
    `tapPcmForNdi` at the play site. Local audio is silenced via
    `setSinkId({type:"none"})` first; the gain-mute fallback still
    leaves the NDI tap untouched because it sits upstream of gain.
    (2) The in-process coordinator (`shouldPlayEvent`) and the
    `localStorage` cross-window claim (`crossWindowClaim`) are
    BYPASSED in NDI tap mode. Both gates exist solely to deduplicate
    AUDIBLE playback across windows of the same origin (e.g. the
    dashboard and a visible scoreboard window competing for the
    operator's speakers); the silent NDI renderer is a separate
    playback path that must fire in parallel with whatever the
    audible mount did. Without the bypass, the dashboard mount
    would always claim the localStorage key first (it mounts
    earlier) and the NDI tap would never play, leaving the
    receiver with the same silence v0.9.34 had. The bypass is
    encapsulated in a hoisted `gateAndPlayCue(tapPcmForNdi, ...)`
    helper so each effect's `react-hooks/exhaustive-deps`
    dependency array stays stable. (3) Operator-device + volume
    listeners are also skipped in NDI mode: `onAudioOutputChanged`
    and `onAudioVolumeChanged` only matter for the audible
    dashboard mount, and rebuilding the kit on every output-device
    swap would tear down the worklet for no reason. The NDI kit's
    gain is fixed at 1.0 pre-tap; level control is the receiver's
    job. (4) `src/app/overlay/overlay-client.tsx` now mounts
    `useTimerAlertSounds` for the offscreen NDI scoreboard
    renderer. Mount predicate is
    `!isPreview && isNdi && lockedOutputScene === "scoreboard"`,
    which excludes (a) the dashboard preview iframe (visual only),
    (b) the visible scoreboard output window (silent by design —
    operator monitors via dashboard), and (c) the bracket scene
    (timer cues belong to scoreboard only). Reset key is built
    with the same shape as `ControlPanel.tsx`'s
    `timerAudioResetKey` — excluding `board.updatedAt` and
    `timerRunning` so per-poll mutations and pause toggles don't
    clear `prevSecondsRef` mid-crossing and swallow the cue. The
    two mounts (dashboard audible, NDI silent-tap) run independent
    edge detectors with `useRef` state, so each fires on identical
    board transitions without contention. (5) Reuses every existing
    piece of the v0.9.34 NDI audio pipeline: same
    `public/matbeast-ndi-pcm-tap.worklet.js` worklet (1024-sample
    planar Float32 frames, ~21 ms at 48 kHz, zero-copy
    `ArrayBuffer` transfer), same
    `window.matBeastDesktop.pushNdiAudio(scene, payload)` IPC
    bridge, same `electron/ndi-feed.js` `pushAudioForScene` fan-in,
    same patched `grandiose.sender.audio()` send path. Only
    difference is the `scene` argument — `"scoreboard"` instead of
    `"bracket"` — which routes to the matching active feed in the
    main process. Throughput at 48 kHz / 2 ch / 1024-sample frames
    is identical (~47 IPC msgs/sec, ~376 KB/sec), but in practice
    the scoreboard tap is mostly silent except for the brief 10s
    warning (~0.35 s) and air horn (~1.1 s) bursts; the worklet
    still posts continuously because the audio graph is always
    running, but those frames are near-zero amplitude. File trail:
    `src/hooks/useTimerAlertSounds.ts`,
    `src/app/overlay/overlay-client.tsx`, `package.json`. Nothing
    in the main process or preload changed — the v0.9.34 IPC
    plumbing was already scene-agnostic. Pending for v0.9.36:
    surface NDI audio counters (per-scene
    `audioFramesSent` / RMS / peak) on the Overlay-card status
    pill so the operator can verify "scoreboard NDI: audio
    streaming" without tailing `updater.log`; treat boundary
    crossings while board polling is paused as missed cues that
    fire on resume.)
  - `dist/Mat Beast Scoreboard Setup 0.9.34.exe` (2026-04-29 —
    NDI audio. Through v0.9.33 the bracket NDI source had video only;
    receivers showed `Mat Beast Bracket` but with no audio meter /
    audio track at all. Operator's reported symptom: "I am not hearing
    the audio on the receiving PC." Three pieces had to land in one
    release for end-to-end audio over NDI to work: (1) grandiose
    audio support, (2) renderer-side PCM capture, (3) main-process
    fan-in. (1) The pinned grandiose master commit ships with
    `sender.audio()` commented out — `napi_value audioFn; ...` is
    dead in `sendComplete()` and there's no `audioSend` C++ entry
    point at all. Extended `scripts/patch-grandiose.mjs` (which
    already patches MSVC string-literal conformance) to also enable
    the audio path: it replaces the commented-out function-
    registration block with active code (CRLF-tolerant regex match;
    upstream master ships LF, but Windows checkout normalisation
    flips it to CRLF and silently broke the first attempt at a plain
    `String.replaceAll` swap), adds a `napi_value audioSend(...)`
    forward declaration, and appends a full `audioSendExecute` /
    `audioSendComplete` / `audioSend` implementation at the end of
    `grandiose_send.cc`. The new `audioSend` reads
    `{ sampleRate, numChannels, numSamples, channelStrideInBytes,
    data: Buffer }` from a JS object, populates the existing
    `sendDataCarrier::audioFrame` slot (already declared in
    `grandiose_send.h`, so no header change), and invokes
    `NDIlib_send_send_audio_v2` on the async work queue with
    `timecode = NDIlib_send_timecode_synthesize`. Sentinel comment
    `MATBEAST_AUDIO_SEND_PATCH_V1` makes the script idempotent on
    re-runs. (2) Renderer-side capture: new
    `public/matbeast-ndi-pcm-tap.worklet.js` AudioWorklet processor
    sits between `source` and `gain` in the bracket music graph,
    accumulates 1024-sample channel-major Float32 frames (~21 ms at
    48 kHz), and posts them to the main thread via
    `port.postMessage({...}, [planar.buffer])` with the planar
    `ArrayBuffer` transferred (zero-copy across the worklet/main
    boundary). The processor is also a pass-through so connecting it
    inline doesn't break the visible bracket window's MONITOR=on
    audibility. `src/app/overlay/use-bracket-overlay-music.ts`
    refactored to accept `{ tapPcmForNdi: boolean }`: when true, it
    `await ctx.audioWorklet.addModule(...)`, instantiates the worklet
    node, splices it into the chain, attaches a port message
    handler that forwards each frame via
    `window.matBeastDesktop.pushNdiAudio("bracket", payload)`, and
    forces the local sink silent regardless of the operator's
    MONITOR toggle (so the offscreen NDI bracket renderer never
    plays a second audible copy on top of the visible bracket
    window). `overlay-client.tsx` mounts the music engine in BOTH
    the visible bracket window (operator monitor) and the offscreen
    NDI bracket renderer (PCM tap), so both paths are independent —
    the operator's MONITOR-on local playback isn't affected by NDI
    state, and conversely an unplugged operator audio device doesn't
    break NDI audio. (3) Main-process fan-in: new
    `electron/preload.js` exposes
    `matBeastDesktop.pushNdiAudio(scene, payload)` as a fire-and-
    forget `ipcRenderer.send("ndi-audio:push", ...)` (no
    acknowledgement so back-pressure can't stall the audio thread).
    `electron/ndi-sender.js` gains `sendNdiAudioFrame(sender,
    payload, onLog)`: validates the buffer length matches
    `numChannels * numSamples * 4` (planar Float32 is the only
    layout NDI accepts via FLTP), wraps `ArrayBuffer` / `Uint8Array`
    inputs as Buffer without copying, calls `sender.audio({...})`,
    and rate-limits a diagnostic that logs sample rate + channel
    count + per-channel RMS / peak amplitude for the first 3 audio
    frames per sender so we can verify the tap is producing real
    music (not silence) before grandiose accepts the frame.
    `electron/ndi-feed.js` gains audio counters
    (`audioFramesSent`, `audioSendFailures`, `audioFramesDropped`,
    `audioFirstFrameAt`, `lastAudioSendError`) and a
    `pushAudioForScene(scene, payload, onLog)` entry point that
    routes incoming frames to the matching active feed; if no feed
    is running for that scene, the frame is dropped silently
    (audio path comes up before video on mount; this is normal).
    `electron/main.js` adds an `ipcMain.on("ndi-audio:push", ...)`
    handler that forwards into `pushAudioForScene`. Throughput at
    48 kHz / 2 ch / 1024-sample frames: ~47 IPC messages/sec at
    ~8 KB each = ~376 KB/sec, well within Electron's IPC budget.
    File trail: `scripts/patch-grandiose.mjs`,
    `node_modules/grandiose/src/grandiose_send.cc` (regenerated by
    postinstall), `public/matbeast-ndi-pcm-tap.worklet.js`,
    `src/app/overlay/use-bracket-overlay-music.ts`,
    `src/app/overlay/overlay-client.tsx`, `electron/preload.js`,
    `electron/ndi-sender.js`, `electron/ndi-feed.js`,
    `electron/main.js`, `src/types/matbeast-desktop.d.ts`,
    `package.json`. Pending for v0.9.35: scoreboard timer-cue audio
    routing (same plumbing, just a different scene), audio
    counters surfaced in the Overlay-card NDI status pill so the
    operator can see "audio: 1234 frames, RMS 0.12" without
    tailing `updater.log`.)
  - `dist/Mat Beast Scoreboard Setup 0.9.33.exe` (2026-04-29 —
    NDI network-adapter binding + Overlay-card status pill. v0.9.32
    confirmed every layer of our content pipeline produced valid
    BGRA frames, but cross-PC NDI delivery was still failing
    intermittently. Combined with Newtek's own Test Pattern Generator
    failing the same way on the same PC, evidence pointed unambiguously
    at the multi-NIC binding problem: Windows announces NDI on every
    interface (including APIPA `169.254.*` addresses on idle Ethernet
    adapters and Wi-Fi Direct virtual adapters), and remote receivers
    latch onto a non-routable IP from the announce. Operator-side fix:
    let the user pick which NIC NDI binds to via a private
    `ndi-config.v1.json` under `<userData>/ndi-config/`, with the
    `NDI_CONFIG_DIR` env var set BEFORE `grandiose` is required so
    `NDIlib_initialize()` reads it. Three new electron-side modules:
    `electron/ndi-adapters.js` (walks `os.networkInterfaces()`,
    classifies each IPv4 address as ethernet/wifi/bluetooth/virtual/
    APIPA/loopback with friendly labels, runs the auto-binding
    selector that prefers Ethernet > Wi-Fi > any routable);
    `electron/ndi-config.js` (writes/removes the config JSON,
    points `NDI_CONFIG_DIR` at our private dir); the bootstrap call
    in `app.whenReady()` runs `applySavedNdiBinding()` immediately
    after `loadDesktopPreferences()` so the env var is set before
    any feed start triggers grandiose's lazy load. New
    `desktopPreferences.ndiBindAdapter` (default `{ kind: "auto" }`)
    persists the operator's choice across sessions. New
    `Options ▸ NDI ▸ Network adapter` submenu lists every detected
    adapter with friendly name + IP + `(APIPA)` / `(virtual)` /
    `(loopback)` decorations so the operator sees at a glance which
    entries are useless for cross-PC delivery; clicking an entry
    persists the choice, rewrites `ndi-config.v1.json`, and triggers
    a native "Restart now / Restart later" dialog (NDI runtime only
    re-reads `NDI_CONFIG_DIR` at `NDIlib_initialize()`, so live
    rebinding requires a relaunch). Three new IPC channels —
    `ndi:get-state` (initial sync read), `ndi:set-binding` (persist +
    write config + push state), `ndi:relaunch-for-binding` (clean
    `app.relaunch()` from the dashboard). State is broadcast on
    `matbeast:ndi:state` whenever a feed toggles, the operator
    rebinds, or every 5 s on a refresh timer that catches OS-level
    NIC changes (cable unplugged, Wi-Fi reconnected, DHCP changed
    the IP). Renderer side: new
    `src/components/dashboard/NdiStatusPill.tsx` renders a compact
    status pill in the Overlay-card header with a colored dot
    (green = bound to routable adapter + feed running, gray = bound
    but idle, yellow = bound to APIPA / virtual NIC, red = no
    binding at all) and a plain-English label
    ("NDI: Wi-Fi", "NDI: Ethernet", "NDI: APIPA"). Clicking the pill
    opens an inline picker mirroring the menu submenu — auto-select
    plus per-IP entries decorated with the same APIPA / loopback /
    virtual hints. The pill is fed by
    `matBeastDesktop.getNdiState()` on mount and
    `matBeastDesktop.onNdiStateChange()` for live pushes; in browser
    dev builds where the bridge is missing it degrades to a static
    "NDI: web" badge. New TypeScript types
    `NdiBindingPreference`/`NdiAdapterEntry`/`NdiStateSnapshot` in
    `src/types/matbeast-desktop.d.ts`. File trail:
    `electron/ndi-adapters.js`, `electron/ndi-config.js`,
    `electron/main.js`, `electron/preload.js`,
    `src/types/matbeast-desktop.d.ts`,
    `src/components/dashboard/NdiStatusPill.tsx`,
    `src/components/dashboard/DashboardFullWorkspace.tsx`,
    `package.json`. Pending for v0.9.34: replace the menu's "restart
    required" prompt with a tear-down + re-init path that doesn't
    need an app relaunch (requires patching grandiose to expose
    `NDIlib_destroy` / `NDIlib_initialize`), and surface
    `NDIlib_send_get_no_connections()` as a per-source receiver
    count next to the pill so the operator can see "1 receiver
    connected" without alt-tabbing to NDI Studio Monitor.)
  - `dist/Mat Beast Scoreboard Setup 0.9.30.exe` (2026-04-29 — Two
    bug fixes and one feature add on top of v0.9.29's NDI debut. (1)
    Root-cause for v0.9.29's "Studio Monitor sees \"Mat Beast
    Scoreboard\" but the preview is blank": Electron's
    `NativeImage.getSize()` returns dimensions in DIPs while
    `toBitmap()` returns physical pixels, and on the operator's
    1.5×-scale display the resized image reported `1920×1080` from
    `getSize()` but yielded an `8 294 400 × 2.25 = 18 662 400`-byte
    BGRA buffer. v0.9.29 advertised `xres=1920`, `yres=1080`,
    `lineStrideBytes=7680` to NDI, then handed it 18 MB of pixel
    data laid out at stride 11 520 — receivers saw a coherent
    NDI source announcement (mDNS worked, hence the entry in the
    source list) but couldn't decode any frame because every row
    after row 0 was misaligned. Fix in `electron/ndi-sender.js`:
    derive the true pixel dimensions from `data.length` /
    (4 × `reportedSize.height`). When the buffer agrees with
    `getSize()` (scale factor 1.0 hosts) we keep `1920×1080`; when
    it doesn't, we recompute to whatever square scale the buffer is
    actually at (`2880×1620` on the 1.5× display, which is still
    16:9 so `pictureAspectRatio` stays consistent). NDI receivers
    accept this as a coherent format and decode frames. We also
    log the first 3 frames' `reportedSize`, `bufferLength`,
    inferred dimensions and first 16 bytes of the BGRA buffer to
    `updater.log` for forensic confirmation; the diagnostic uses
    a `WeakMap<sender, count>` so a sender restart resets the
    counter automatically. The dynamic `pictureAspectRatio = xres /
    yres` falls back to `16/9` if the inference fails. (2)
    Receiver-format-stability warmup in `electron/ndi-feed.js`:
    drop the first 30 frames (1 s @ 30 fps) before submitting any
    to NDI. Two motivations — the very first frames after `did-
    finish-load` come from a mid-hydration React tree (fonts not
    loaded, scale-to-fit hasn't run, no scoreboard data fetched),
    and some NDI receivers latch onto the format of the very first
    frame they observe and drop subsequent frames whose format
    disagrees. We log the warmup completion (`warmup complete
    (skipped first 30 frames); now broadcasting to receivers.`)
    and added `framesSkipped` to `getStatus()`/the stop log so the
    operator can confirm from `updater.log`. (3) Bracket NDI feed
    is now a peer of the scoreboard: a second `Options ▸ NDI`
    menu item toggles `Start "Mat Beast Bracket"` /
    `Stop "Mat Beast Bracket"` exactly like the scoreboard one,
    reusing every line of `ndi-feed.js` / `ndi-source.js` / `ndi-
    sender.js`. The bracket source loads `/overlay?ndi=1&output
    Scene=bracket`, runs through the same 1920×1080-or-inferred-
    dimensions BGRA pipeline, and registers as an independent
    `NDIlib_send` instance — receivers see two distinct sources,
    each toggleable independently from the menu. File trail:
    `electron/ndi-sender.js`, `electron/ndi-feed.js`,
    `electron/main.js`, `package.json`. Open questions deferred
    to v0.9.31: AudioWorklet PCM tap on the bracket-music graph
    (so the bracket NDI source carries audio, not just video),
    persistent `desktopPreferences.ndiAutoStart` so feeds resume
    on app launch, source-name editor + frame-rate selector,
    "always 1920×1080 regardless of host DPI" via PNG round-trip
    or canvas-based downsample (v0.9.30 currently emits whatever
    physical resolution the host display dictates after offscreen
    capture; receivers handle the resize at their end, but the
    operator originally asked for a guaranteed 1920×1080 output —
    we'll bring that back once we have a low-cost downsample
    path that doesn't pay 10 ms/frame in PNG encode + decode).)
  - `dist/Mat Beast Scoreboard Setup 0.9.29.exe` (2026-04-29 —
    grandiose master is added under `dependencies` and pinned to
    commit `c350e0fb6e74bbf2e4b10144fee456aa1af93f47` (the published
    npm `0.0.4` was a hardcoded sine-wave audio demo, not a real
    `send` API; master is `0.1.0` with the real Sender object). The
    package ships the NewTek NDI Runtime DLL (`Processing.NDI.Lib.x64
    .dll`, 28 MB, NDI SDK v5.5.2.0 from October 2022) inside its
    `lib/win_x64/` folder and the License Agreement under `lib/`,
    so no separate redistribution gate. New
    `scripts/patch-grandiose.mjs` (postinstall) makes the binding
    compile against modern MSVC by changing two `char* file` /
    `char* methodName` parameters in `grandiose_util.h`/`.cc` to
    `const char*` (modern MSVC rejects `__FILE__` → `char*` implicit
    conversion under C++17 conformance) and adds `/permissive` +
    `/Zc:strictStrings-` AdditionalOptions to grandiose's own
    `binding.gyp`. The post-install rebuild runs once for system
    Node, then `electron-builder`'s default `installAppDeps` step
    rebuilds against Electron 37's ABI before packaging — `ndi
    :rebuild-electron` script is also exposed for manual reruns
    during dev. Three new electron-side modules: `electron/ndi-
    sender.js` (lazy-loads grandiose, returns "NDI unavailable"
    instead of crashing if the binding fails to load — exposes
    `createNdiSender`/`sendNdiVideoFrame`/`destroyNdiSender` and a
    `getStatus()` diagnostic that surfaces the SDK version + DLL
    path for menus); `electron/ndi-source.js` (lifts the offscreen
    `BrowserWindow` + `capturePage` loop out of `ndi-smoke.js`,
    scene-parameterised so the bracket source in v0.9.30 reuses
    every line); and `electron/ndi-feed.js` (combines source +
    sender, owns the lifecycle, fire-and-forget per-frame send so
    `setInterval(33ms)` keeps ticking even if a single
    `sender.video()` is mid-flight). `BGRA` FourCC = 1095911234,
    progressive frame format, 30000/1000 frame rate, 16:9 aspect
    ratio, with `clockVideo: false` so we pace ourselves rather
    than letting NDI sleep our event loop. The `NDI` submenu
    toggle is dynamic — its label flips between "Start \"Mat Beast
    Scoreboard\" NDI source" and "Stop \"Mat Beast Scoreboard\"" via
    `refreshApplicationMenu()` after each toggle. `app.before-
    quit` calls `ndiFeed.stopAllNdiFeeds()` before closing the
    overlay windows so we don't see "send to destroyed
    webContents" warnings during shutdown — receivers detect the
    dropout within ~3 s on JS GC anyway. `package.json` build
    `files` array now excludes grandiose's debug artifacts
    (`*.pdb`, `*.iobj`, `*.ipdb`, `*.exp`, `*.lib`, `obj/` — saves
    ~6 MB), the cross-platform NDI runtimes we don't ship
    (`linux_arm64/`, `linux_x64/`, `mac_universal/`, `win_x86/` —
    saves ~60 MB), and grandiose's C++ source / SDK headers (`src
    /`, `include/` — saves ~200 KB). Net installer overhead from
    NDI: ~28 MB DLL + ~200 KB native binding = ~28.2 MB. Open
    questions deferred to v0.9.30: bracket source feed, AudioWorklet
    PCM tap on the bracket-music graph, persistent `desktopPreferences
    .ndiAutoStart` so feeds resume on app launch, source-name
    editor, frame-rate selector. File trail: `electron/ndi-sender
    .js`, `electron/ndi-source.js`, `electron/ndi-feed.js`,
    `electron/main.js`, `scripts/patch-grandiose.mjs`, `package
    .json`.)
  - `dist/Mat Beast Scoreboard Setup 0.9.28.exe` (2026-04-29 — Lock
    NDI capture output to a deterministic 1920×1080 BGRA frame
    regardless of operator hardware. v0.9.27's smoke-test summary
    showed `captureSize: "2562x1529"` on the operator's
    2560×1600/150%-DPI display because the offscreen renderer's
    `devicePixelRatio` was inheriting from the host display, then
    Chromium captured at the resulting effective pixel resolution
    (1920 × 1.5 ≈ 2880, with extra adjustments). NDI receivers
    require a fixed advertised frame size — any frame that disagrees
    with the sender's announced format is treated as a format change
    and re-negotiated, causing downstream stutter. **Three layers
    of defense to pin output at 1920×1080**: (1) `BrowserWindow`
    constructor adds `useContentSize: true` and
    `webPreferences.zoomFactor: 1.0` so CSS layout matches the
    buffer dimensions exactly with no zoom drift. (2) The capture
    loop now passes an explicit `rect: {x:0,y:0,width:1920,
    height:1080}` to `webContents.capturePage(rect)` so the
    requested region is constrained to the broadcast extent. (3)
    Bulletproof safety net: every captured `NativeImage` is checked
    against 1920×1080 and `image.resize({width:1920,height:1080,
    quality:"best"})` if it doesn't match — guarantees the frame
    handed to grandiose / written as PNG is exactly the broadcast
    canonical size, irrespective of what Chromium did internally.
    Also adds a post-load `setZoomFactor(1.0)` (belt-and-suspenders
    with the constructor flag) and an `executeJavaScript` diagnostic
    that logs the renderer's `devicePixelRatio`, `innerWidth`,
    `innerHeight` so we can confirm layers 1+2 actually work or
    detect when layer 3 saved us. Summary JSON now includes
    `resizesPerformed` — when this is 0 the renderer produced
    canonical frames natively; when > 0 the resize fallback rescued
    them. File: `electron/ndi-smoke.js`.)
  - `dist/Mat Beast Scoreboard Setup 0.9.27.exe` (2026-04-29 — Drop
    paint-event capture entirely; drive offscreen frames via
    `webContents.capturePage()`. v0.9.26 confirmed the JS-injection
    paint pump fires reliably (`paintPumpTicks=208` in 7 s), but
    `document.body.dataset.matbeastNdiTick` mutations produced **0**
    additional paint events past the initial-hydration window —
    Chromium correctly elides paint for `data-*` attribute changes
    that don't affect rendering, and `show: false` offscreen windows
    may throttle the renderer's JS execution itself. After five
    versions trying to coax paint events out of an offscreen
    webContents, the right answer is to stop relying on the natural
    paint cycle and force frame production from main with
    `capturePage()`. capturePage forces Chromium to commit a fresh
    frame to a `NativeImage` regardless of compositor-invalidation
    state or renderer throttling — same code path DevTools' "Capture
    screenshot" uses. The smoke test now runs a 33 ms `setInterval`
    that calls `capturePage()`, drops the result if a previous
    capture is still in flight (no IPC pile-up on a slow tick),
    counts captures separately for warmup vs recording, and writes
    every Nth recorded capture to disk as PNG. Paint events are
    still listened to for diagnostics so we can see exactly where
    Chromium's natural cycle stalls. `summary.json` now distinguishes
    `paintEventsDuringWarmup` / `paintEventsDuringRecording` from
    `capturesDuringWarmup` / `capturesDuringRecording`. Architecture
    note for v0.9.28+: grandiose's `ndiSender.video()` takes a
    buffer; the capturePage result feeds it directly with no
    intermediate paint-event ceremony. Trade-off: capturePage
    involves an extra raster pass per call vs the paint event's
    zero-copy delivery — within budget for 30 fps × 1920×1080 on
    any operator machine that runs the dashboard, and reliability
    matters more than per-frame efficiency for live broadcast.
    File: `electron/ndi-smoke.js`.)
  - `dist/Mat Beast Scoreboard Setup 0.9.26.exe` (2026-04-29 — Drive
    offscreen renderer paints from main via DOM mutation. v0.9.25's
    diagnostic counters revealed the underlying Chromium offscreen-
    rendering reality: the renderer painted **29 frames at ~31 fps**
    (exactly the configured rate) over a ~935 ms window during initial
    load + hydration (t=395ms → t=1330ms), then **stopped completely**
    — zero paints across the full 5.4 s recording window after that.
    Cause: `setFrameRate(N)` is a *cap*, not a clock. Offscreen
    webContents only emit `paint` events when the compositor is
    invalidated by DOM/style changes; visible windows are paced by the
    OS compositor's vsync, but offscreen renderers have no such
    external clock and a quiescent React tree produces no
    invalidations. `webContents.invalidate()` is documented as
    "schedules a full repaint of the **window**" — no-op for
    offscreen webContents (no window). v0.9.23's 33 ms invalidate
    timer produced 1 frame total: same "initial-load-only" pattern
    we now understand. **Fix:** drive paints from main via
    `webContents.executeJavaScript(\`document.body.dataset.matbeastNdiTick=…\`)`
    on a 33 ms `setInterval`. Each dataset mutation invalidates the
    compositor → a paint is queued → the listener receives it. The
    interval runs in main, so it's not subject to Chromium's
    renderer-side timer throttling that would otherwise stall an
    offscreen `setInterval` on a `show: false` window. Pump starts
    inside the `did-finish-load` handler (after the paint listener is
    attached and `setFrameRate(30)` is applied) and stops when
    recording ends. Summary now includes `paintPumpTicks` so we can
    confirm the pump fired the expected ~165 times during a 5.4 s
    recording window. Comment block in `ndi-smoke.js` explains why we
    don't use `webContents.invalidate()` for offscreen rendering and
    references the v0.9.23 mistake. File: `electron/ndi-smoke.js`.)
  - `dist/Mat Beast Scoreboard Setup 0.9.25.exe` (2026-04-29 — Two
    bugs revealed by the v0.9.24 smoke-test run: (1) **`durationMs is
    not defined` thrown after summary write** — leftover reference in
    the function's return statement after I'd renamed the variable to
    `recordingDurationMs` / `totalDurationMs`. The wrapper saw the
    throw and returned `{ok:false}`, so no completion dialog appeared
    even though `summary.json` had been written. Fixed; the return
    now includes `framesCaptured`, `framesDuringWarmup`, `pngsWritten`,
    `recordingDurationMs`, `totalDurationMs`, `observedFps`, and the
    Electron dialog reader in `main.js` was updated to match. (2)
    **Zero frames produced during the entire 7 s test** — far worse
    than v0.9.22's 6 fps. v0.9.24 registered `beginFrameSubscription`
    *before* `loadURL` to avoid attaching too late; in practice
    Chromium severs the subscription when the new origin loads, so
    the listener bound to the placeholder webContents never received
    a single paint from the post-navigation renderer. Two changes
    fix it: (a) Switched from `beginFrameSubscription(false, cb)` to
    `webContents.on("paint", (event, dirty, image) => …)` — per
    Electron's offscreen-rendering docs `paint` is the canonical API
    for offscreen webContents; `beginFrameSubscription` is meant for
    visible windows and degrades poorly on offscreen. (b) Re-registered
    the listener AFTER `did-finish-load` so it binds to the correct
    post-navigation renderer, matching the v0.9.22 timing that did
    produce frames. The `setFrameRate(30)` call stays in the
    `did-finish-load` handler. Files: `electron/ndi-smoke.js`,
    `electron/main.js`.)
  - `dist/Mat Beast Scoreboard Setup 0.9.24.exe` (2026-04-29 — Revert
    the v0.9.23 `webContents.invalidate()` "force-paint" timer; it was
    actively destroying frames. Smoke-test runs on v0.9.23 produced
    **1 frame in 5 s** (0.2 fps) — vs v0.9.22's already-poor 6 fps —
    because calling `invalidate()` every 33 ms cancelled each in-flight
    paint before Chromium could commit it. Lesson: for offscreen
    rendering, `setFrameRate(N)` is the only paint-cadence control
    needed; pacing is Chromium's job. **Do not reintroduce
    `invalidate()` on a fast timer for offscreen rendering.** Other
    refinements: (1) Register `beginFrameSubscription` *before*
    `loadURL` and split frame counts into `framesDuringWarmup` (which
    are observed but not written) and `framesCaptured` (post-warmup,
    written every Nth as PNG). The pre-warmup count is a diagnostic
    so we can tell "renderer never paints" from "renderer paints but
    we missed the window." (2) Bumped total wall-clock to 7 s (warmup
    + recording) so the recording window is ~5.5 s after the 1500 ms
    warmup. (3) Summary JSON now includes `framesDuringWarmup`,
    `firstFrameRelMs`, `lastFrameRelMs`, `recordingDurationMs`,
    `totalDurationMs`, `observedFps` — enough to characterize the
    renderer behavior without re-running. (4) Comment block in
    `ndi-smoke.js` now flags the v0.9.23 invalidate mistake so a
    future change doesn't put it back. File: `electron/ndi-smoke.js`.)
  - `dist/Mat Beast Scoreboard Setup 0.9.23.exe` (2026-04-29 — Three
    offscreen-renderer fixes uncovered by the v0.9.22 smoke-test
    output: (1) **Pace frame production**. v0.9.22 produced ~6 fps
    against a 30-fps target because Chromium's offscreen renderer
    only paints when the DOM requests a frame; a static scoreboard
    between clock ticks generated almost nothing. Added a
    `setInterval(() => webContents.invalidate(), 33)` during the
    capture window so the BGRA buffer stream is paced by the main
    process, not by the renderer's intrinsic motion (matches what
    the future grandiose `ndiSender.video()` cadence will need —
    receivers drop sources that miss frames). (2) **Move
    `setFrameRate(30)` to after `did-finish-load`**. Calling it on
    the brand-new offscreen webContents was getting reset by
    Chromium's renderer init pass. Applied post-load, it sticks.
    (3) **Add a 1500 ms warmup window after `did-finish-load`
    before counting frames**. v0.9.22 frame-001 was a 20 KB
    incomplete-render PNG (the "cut off on the sides" symptom);
    frames 2 and 3 (94 KB / 128 KB) were correct. The warmup gives
    Next.js client hydration, React Query fetches, `@fontsource`
    web font loading, and the `transform: scale(s)` fit pass time
    to settle before the subscription stream is recorded. Summary
    JSON now includes `observedFps`, `warmupMs`,
    `invalidateIntervalMs` so the smoke-test artifact is
    self-describing. File: `electron/ndi-smoke.js`.)
  - `dist/Mat Beast Scoreboard Setup 0.9.22.exe` (2026-04-29 — Fix
    duplicate-guard race in `electron/ndi-smoke.js`. v0.9.21 shipped
    with two `if (activeSmokeTestRun) return` checks: one in the
    public wrapper `runOffscreenSmokeTestExclusive` (correct) and one
    in the inner `runOffscreenSmokeTest` (left over from a refactor).
    The wrapper sets `activeSmokeTestRun = { startedAt }` *before*
    calling the inner; the inner saw the freshly-set lock and
    returned `{ok:false, error:"A smoke test is already running."}`
    1 ms after every first invocation. Captured by the operator
    running **Options ▸ NDI ▸ Run offscreen smoke test (5s)** twice
    on v0.9.21 with no dialog appearing; the
    `<userData>/updater.log` showed two paired
    `ndi-smoke: starting … / ndi-smoke: finished {"ok":false,"error":
    "A smoke test is already running."}` log lines 1 ms apart.
    Removed the inner guard and the redundant
    `activeSmokeTestRun = null` reset at the bottom of the inner
    function (the wrapper's `finally` already clears it). Comment
    block in the inner function now flags that exclusivity is owned
    by the wrapper. Operator path note: Electron resolves
    `app.getPath("userData")` against `package.json` `"name"`
    (`matbeastscore`), not `productName`, so the smoke-test output
    folder is `%APPDATA%\matbeastscore\ndi-test\<timestamp>\` and
    diagnostic logs are at `%APPDATA%\matbeastscore\updater.log` —
    not `…\Mat Beast Scoreboard\…` as my chat scaffolding messages
    incorrectly stated. File: `electron/ndi-smoke.js`.)
  - `dist/Mat Beast Scoreboard Setup 0.9.21.exe` (2026-04-29 — NDI
    integration, step 1 of N. Adds the offscreen-rendering smoke-test
    scaffold the rest of the NDI work depends on. New
    `electron/ndi-smoke.js` builds an offscreen `BrowserWindow`
    (`webPreferences.offscreen: true, transparent: true, width: 1920,
    height: 1080`), loads
    `${appUrl}/overlay?ndi=1&outputScene=scoreboard`, locks the paint
    rate at 30 fps via `webContents.setFrameRate(30)`, subscribes to
    full frames via `beginFrameSubscription(false /* onlyDirty */, …)`,
    and writes every 10th `image.toPNG()` to
    `<userData>/ndi-test/<timestamp>/frame-NN.png` for ~5 seconds
    before destroying the offscreen window and revealing the output
    folder in Explorer. Fired from a new `Options ▸ NDI ▸ Run
    offscreen smoke test (5s)` menu entry; all activity is logged to
    `<userData>/updater.log` with `[ndi-smoke]` prefix so a tester can
    capture run details after the fact. Renderer
    (`src/app/overlay/overlay-client.tsx`) reads a new `ndi=1` query
    param parallel to `preview=1`: when set, it suppresses the
    operator-confidence inset teal frame
    (`OVERLAY_OUTPUT_FRAME_STYLE`) so the broadcast viewer never sees
    it, and disables `useBracketOverlayMusic` so the offscreen
    bracket renderer does not double up audio with the visible
    bracket window's existing engine (the dedicated NDI audio graph
    + AudioWorklet PCM tap arrives in v0.9.23). The visible
    scoreboard / bracket windows are unchanged. No NDI library yet —
    that lands in v0.9.22 once the offscreen rendering path is
    operator-verified end-to-end. Files: `electron/ndi-smoke.js`
    (new), `electron/main.js` (Options ▸ NDI submenu, smoke-test
    runner with dialog + log surface),
    `src/app/overlay/overlay-client.tsx` (`isNdi` flag),
    `package.json` (0.9.21).)
  - `dist/Mat Beast Scoreboard Setup 0.9.19.exe` (2026-04-28 — Hardened
    preload script. Wraps `require("electron")`, `require("./matbeast-variant.js")`,
    and `contextBridge.exposeInMainWorld("matBeastDesktop", …)` in
    independent try/catch blocks and **always** publishes a separate
    sentinel object `__matBeastPreloadStatus` (with `ran`, `hasContextBridge`,
    `hasIpcRenderer`, `preloadError`, `preloadVersion`) before doing
    anything else. Renderer-side bracket-music diagnostic now reads
    that sentinel and reports one of three actionable states: "preload
    sentinel ABSENT" (preload script never ran in this renderer →
    install / antivirus / wrong-process issue), "preload ran but
    matBeastDesktop is missing" (with the actual `preloadError` text),
    or "bridge keys (vX.Y.Z): …" (lists every method actually exposed).
    Also published as a real GitHub release with `latest.yml`,
    `Mat-Beast-Scoreboard-Setup-0.9.19.exe`, and the blockmap so
    `electron-updater` stops 404'ing on `latest.yml` from v0.9.12.
    File: `electron/preload.js`, `src/components/dashboard/DashboardFullWorkspace.tsx`.)
  - `dist/Mat Beast Scoreboard Setup 0.9.18.exe` (2026-04-28 — Bridge
    capability dump. Renderer effect now lists every key actually
    present on `window.matBeastDesktop` plus the running app version
    (via `getRuntimeInfo`) when `chooseBracketMusicFile` is missing,
    instead of guessing why. Diagnostic line on the Overlay header
    reads `bridge keys (v0.9.X): addRecentDocument, captureOverlayPreview,
    chooseBracketMusicFile, clearBracketMusicFile, …`. Surfaced a stale
    install path / running-process problem on the user's machine.)
  - `dist/Mat Beast Scoreboard Setup 0.9.17.exe` (2026-04-28 — Bracket-
    music IPC diagnostics. Browse / None / state-fetch paths now log
    every step to a visible amber-italic `musicDiag` line in the
    Overlay-card header (e.g. `Browse clicked — invoking IPC...`,
    `IPC threw: …`, `IPC returned no result`, `chooseBracketMusicFile
    is not a function on the bridge`). Main-side `bracket-music:choose-file`
    handler hardened: explicit `mainWindow` parent (instead of
    `BrowserWindow.getFocusedWindow()` which can return `null` when a
    transient popover-button click stole focus on Windows), defensive
    `app.getPath("music")` fallback, full try/catch returning structured
    `{ ok: false, error }` on any failure. Files: `electron/main.js`,
    `src/components/dashboard/DashboardFullWorkspace.tsx`.)
  - `dist/Mat Beast Scoreboard Setup 0.9.16.exe` (2026-04-28 — Removed
    the `desktopBridgePresent` render-time gate altogether. Earlier
    builds disabled the entire music control row when
    `typeof window.matBeastDesktop === "object"` evaluated false at
    SSR-then-hydrate time, then never re-flipped to enabled because
    no state change re-evaluated the predicate. The buttons now use
    optional-chaining (`window.matBeastDesktop?.foo?.()`) directly so
    they're always clickable; missing methods silently no-op. Avoids
    the SSR-vs-client predicate-mismatch class of bug entirely.)
  - `dist/Mat Beast Scoreboard Setup 0.9.15.exe` (2026-04-28 — Replaced
    the narrow `onBracketMusicStateChange`-only readiness check with a
    bridge-presence check. The action methods (`chooseBracketMusicFile`,
    `setBracketMusicPlaying`, `setBracketMusicMonitor`) work
    independently of the listener subscription, so a one-method-missing
    case shouldn't disable the entire row. Still gated on
    `typeof window.matBeastDesktop === "object"` — superseded in 0.9.16.)
  - `dist/Mat Beast Scoreboard Setup 0.9.14.exe` (2026-04-28 — Defensive
    music-row rendering plus DPI-aware overlay sizing. (1) Music control
    row in `DashboardFullWorkspace.tsx` now renders any time
    `previewScene === "bracket"`, falling back to an in-memory default
    (`{filePath:null, fileName:null, playing:true, monitor:false}`)
    until the real IPC payload arrives. Earlier builds gated the row
    behind `musicState !== null`, which silently hid all controls when
    the state IPC didn't resolve. (2) `getScoreboardAndBracketBounds`
    in `electron/main.js` now divides 1920×1080 by `display.scaleFactor`
    before passing to `BrowserWindow`, so the *physical* backing surface
    lands on broadcast-canonical 1920 × 1080 regardless of operator
    display DPI. Previously, on a 2560×1600 main display at 150% Windows
    scaling, the windows rendered at 2880 × 1620 *physical* pixels and
    overflowed the screen. The renderer's existing `transform: scale(s)`
    fits the 1920×1080 design canvas inside the smaller CSS viewport;
    Chromium re-rasterizes vector content at devicePixelRatio so visual
    quality is preserved. Files: `electron/main.js`,
    `src/components/dashboard/DashboardFullWorkspace.tsx`.)
  - `dist/Mat Beast Scoreboard Setup 0.9.13.exe` (2026-04-28 — Bracket
    overlay music feature. Operator picks a host audio file via
    Overlay-card header controls when `SHOW BRACKET` is active; file
    plays as a silent loop on the bracket overlay window so it can be
    paired with the bracket video as a single NDI source. Three new
    header buttons: PLAY/STOP MUSIC, CHOOSE MUSIC (Browse… / None
    popover), MONITOR ON/OFF. State (filePath, playing, monitor)
    persisted in `desktop-preferences.json` and pushed via
    `bracket-music:state` IPC channel. Audio engine in
    `src/app/overlay/use-bracket-overlay-music.ts` uses
    `HTMLAudioElement` + `AudioContext` with `setSinkId({ type: "none" })`
    for silent-local playback (operator doesn't hear it but PCM still
    flows for future NDI tap), `applySelectedAudioOutputToContext` when
    MONITOR is ON. Custom Electron protocol `mat-beast-asset://music/track`
    streams the configured file via `electronNet.fetch(file://…)` so
    the renderer never sees the absolute host path. `autoplayPolicy:
    'no-user-gesture-required'` on the bracket overlay BrowserWindow
    so the loop autoplays at launch when a track is configured. Files:
    `electron/main.js`, `electron/preload.js`,
    `src/lib/bracket-music-state.ts` (new),
    `src/app/overlay/use-bracket-overlay-music.ts` (new),
    `src/app/overlay/overlay-client.tsx`,
    `src/components/dashboard/DashboardFullWorkspace.tsx`,
    `src/types/matbeast-desktop.d.ts`.)
  - `dist/Mat Beast Scoreboard Setup 0.9.12.exe` (2026-04-23 — OT round
    transitions preserve secondary ELAPSED. Switching between
    overtime rounds (e.g. `OT ROUND1` → `OT ROUND 2` → `OT ROUND 3`)
    via APPLY no longer zeroes the secondary ELAPSED clock. The reset
    now only happens when entering OT from a non-OT round, or leaving
    OT entirely. `reconcileBoardStateForRoundLabelChange` in
    `src/lib/ot-round-label.ts` only resets
    `otRoundElapsedBaseSeconds` and `otRoundElapsedRunStartedAt` when
    `wasOt === false` (i.e. transitioning *into* OT mode). Transfer-
    related fields (`otRoundTransferConsumed`,
    `otRoundTransferUndo*`) still clear on every label change.
    Selecting an OT round from the Round Label dropdown still engages
    OT mode and shows the secondary timer on the next APPLY, as
    before.)
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

## 2026-04-28 Session Updates (OT round transitions, overlay sizing, bracket music, preload hardening)

### OT round transitions preserve secondary ELAPSED (v0.9.12)
- **Bug:** Tapping APPLY while in `OT ROUND1` correctly left the
  secondary ELAPSED counter alone (per the 2026-04-22 fix), but
  switching to `OT ROUND 2` and tapping APPLY zeroed it again. The
  operator expected ELAPSED to persist across all OT-to-OT round
  transitions and reset only when entering or leaving OT mode.
- **Fix:** `reconcileBoardStateForRoundLabelChange` in
  `src/lib/ot-round-label.ts` now resets
  `otRoundElapsedBaseSeconds` / `otRoundElapsedRunStartedAt` only
  when `wasOt === false` (entering OT from a non-OT round). The
  transfer-undo fields (`otRoundTransferConsumed`,
  `otRoundTransferUndoMainSeconds`, `otRoundTransferUndoElapsedTotal`)
  still clear on every label change.
- **Verification:** OT ROUND1 ←→ OT ROUND2 ←→ OT ROUND3 transitions
  via APPLY all preserve the secondary clock. Entering OT from
  ROUND 1 / ROUND 2 / ROUND 3 still resets to zero.

### Overlay output windows: pixel-accurate 1920 × 1080 across all DPI (v0.9.14)
- **Bug:** On a 2560 × 1600 main display at 150% Windows scaling, the
  scoreboard / bracket overlay windows rendered at **2880 × 1620
  physical pixels** and overflowed the screen. Operator could only
  see ~75% of the overlay; OBS / NDI capture would also receive the
  oversized frame.
- **Cause:** `BrowserWindow` `width` / `height` are **DIPs (Device
  Independent Pixels)**, not physical pixels. A naive `width: 1920` on
  a 1.5x-scaled display is 1920 × 1.5 = 2880 *physical* pixels.
- **Fix:** `getScoreboardAndBracketBounds(display)` in
  `electron/main.js` now divides `OVERLAY_NATIVE_W` / `OVERLAY_NATIVE_H`
  by `display.scaleFactor` before constructing bounds. The window's
  *physical* backing surface always lands on broadcast-canonical
  1920 × 1080 regardless of operator display DPI. Existing event
  listeners (`screen.on("display-metrics-changed")`,
  `display-added`, `display-removed`) re-run the bounds calculation
  whenever the display config changes, so the windows resize live
  if the operator changes scaling mid-session.
- **Trade-off / interaction with content:** The renderer's CSS
  viewport gets smaller (e.g. 1280 × 720 at 150%); the existing
  `transform: scale(s)` in `overlay-client.tsx` fits the 1920 × 1080
  design canvas inside it. Chromium re-rasterizes vector content
  (text, SVG) at `devicePixelRatio = scaleFactor` so visual quality
  is preserved at the physical 1920 × 1080 output.

### Bracket overlay music feature (v0.9.13)
- **Goal:** Operator pairs a looping audio file with the bracket
  overlay window so the bracket video and music can be sent as a
  single NDI source, **without** the operator hearing it locally
  (unless they explicitly enable monitoring).
- **Persistence (`electron/main.js`):** `desktopPreferences` schema
  extended with `bracketMusicFilePath`, `bracketMusicPlaying`
  (default `true`), `bracketMusicMonitor` (default `false`).
  `loadDesktopPreferences()` validates that the persisted path
  still exists on disk; otherwise treats the configured file as
  cleared. `persistDesktopPreferences()` writes the JSON marker
  whenever the operator changes any of these.
- **File serving:** Custom protocol `mat-beast-asset://music/track`
  registered in `app.whenReady` via `protocol.handle`. Streams the
  configured `bracketMusicFilePath` through `electronNet.fetch(file://…)`
  so Chromium's `<audio>` element seeks reliably for loop playback,
  Range requests work, and the renderer never sees the absolute
  host path. `protocol.registerSchemesAsPrivileged` declares
  `corsEnabled: true`, `stream: true`, `secure: true`,
  `bypassCSP: true`, `supportFetchAPI: true`.
- **IPC handlers (`bracket-music:` channel family):**
  `bracket-music:get-state`, `bracket-music:choose-file` (opens
  native `dialog.showOpenDialog` with audio-format filters),
  `bracket-music:clear-file`, `bracket-music:set-playing`,
  `bracket-music:set-monitor`. Every state-mutating handler
  persists, then broadcasts a snapshot via `webContents.send` to
  every live `BrowserWindow` on `bracket-music:state` so the
  dashboard UI and the bracket overlay's audio engine never drift.
- **Audio engine (`src/app/overlay/use-bracket-overlay-music.ts`):**
  React hook activated only when the bracket output window is on
  the bracket scene (`!isPreview && lockedOutputScene === "bracket"`).
  Builds a one-time `HTMLAudioElement` + `AudioContext` graph,
  loads `mat-beast-asset://music/track?r=<revision>` (revision
  bumped on every persisted change, cache-busts the underlying
  file). When `monitor: false`, calls `audioContext.setSinkId({
  type: "none" })` so PCM still flows through the graph (future
  NDI worklet tap) but doesn't hit any physical device. When
  `monitor: true`, applies the operator's persisted audio output
  via `applySelectedAudioOutputToContext`. Falls back to a
  gain-mute path if `setSinkId({ type: "none" })` is unsupported
  on a given Chromium build.
- **Autoplay:** Bracket overlay BrowserWindow `webPreferences` now
  includes `autoplayPolicy: "no-user-gesture-required"` so a
  configured loop starts on launch without operator interaction.
- **Dashboard controls (`DashboardFullWorkspace.tsx`):** Three
  buttons in the Overlay-card header when `previewScene === "bracket"`:
  `PLAY MUSIC` / `STOP MUSIC` (disabled until a file is chosen),
  `CHOOSE MUSIC: <filename | NONE>` with a popover containing
  `Browse...` (opens native picker) and `None` (clears),
  `MONITOR ON / OFF`.

### Bracket-music feature: SSR / preload diagnostic chase (v0.9.14 → v0.9.19)
- **Symptom:** After installing v0.9.13, the music controls did not
  appear in the Overlay-card header even after tapping SHOW BRACKET.
  v0.9.14 made them appear. v0.9.15 disabled all of them with a
  hint "Update the desktop app to enable bracket music." v0.9.16
  always-enabled them but Browse / None / Play / Monitor clicks did
  nothing — no native file picker opened. v0.9.17's diagnostic
  reported `chooseBracketMusicFile is not a function on the bridge`.
  v0.9.18's diagnostic reported `matBeastDesktop bridge not present
  at all`.
- **Root cause:** Several layered render-time bridge-presence
  predicates. The dashboard component runs under Next.js 15 App
  Router with `"use client"`, which means **the component renders
  on the server first** (where `typeof window === "undefined"` and
  `window.matBeastDesktop` is `undefined`), generates HTML with the
  predicate's negative branch baked in, ships that HTML to the
  Electron renderer, and hydrates. Hydration matches the server
  HTML, so the negative branch persists until a state change
  re-evaluates the predicate — which doesn't happen for a pure
  derived const inside the function body.
- **Fix progression:**
  - **v0.9.14:** Render music row whenever `previewScene === "bracket"`,
    use a fallback in-memory state until the IPC payload arrives.
  - **v0.9.15:** Replace the narrow `onBracketMusicStateChange`-only
    gate with a generic bridge-presence gate.
  - **v0.9.16:** Remove the gate entirely. Buttons always render
    enabled; clicks call optional-chained IPC methods that no-op
    when the bridge is absent.
  - **v0.9.17:** Add visible amber-italic `musicDiag` line that
    logs every IPC step on click; harden the main-side handler with
    explicit `mainWindow` parent (instead of
    `BrowserWindow.getFocusedWindow()` which can return `null` when
    a transient popover-button click stole focus on Windows) and
    full try/catch returning structured `{ ok: false, error }`.
  - **v0.9.18:** Renderer effect dumps `Object.keys(window.matBeastDesktop).sort()`
    plus running app version (via `getRuntimeInfo`) when the
    expected method is missing — converts "the bridge is broken"
    into "here's exactly what's actually exposed."
  - **v0.9.19 (the actual fix):** Hardened preload script.
    `electron/preload.js` now wraps `require("electron")`,
    `require("./matbeast-variant.js")`, the main-bridge expose, and
    even the sentinel-bridge expose in independent try/catch blocks.
    Always publishes a separate global
    `__matBeastPreloadStatus = { ran, hasContextBridge, hasIpcRenderer,
    preloadError, preloadVersion }` BEFORE attempting the main
    bridge. The dashboard reads that sentinel in its diagnostic
    effect and reports one of three actionable states: "preload
    sentinel ABSENT" (preload script never ran in this renderer →
    install / antivirus / wrong-process problem), "preload ran but
    matBeastDesktop is missing" (with the actual `preloadError`
    text), or "bridge keys (vX.Y.Z): …".
- **Operator workflow that resolved it:** Quit any running
  `Mat Beast Scoreboard.exe` via Task Manager → install
  `Mat Beast Scoreboard Setup 0.9.19.exe` → launch fresh. The
  amber diagnostic disappeared and Browse opened the native file
  picker as expected. Confirmed by the user: "it works now."

### Auto-update infrastructure restored (v0.9.19 GitHub release)
- **Bug:** After installing 0.9.19, the in-app update check displayed
  `Update error: Cannot find latest.yml in the latest release artifacts
  (https://github.com/ken91773/matbeast/releases/download/v0.9.12/latest.yml):
  HttpError: 404`. The latest *published* GitHub release was v0.9.12,
  uploaded earlier via a manual `gh release create` that included
  only the `.exe`; `electron-updater` requires `latest.yml` in the
  release artifacts to determine the current version.
- **Fix:** Published a proper v0.9.19 GitHub release with all three
  artifacts the auto-updater expects:
  - `latest.yml`
  - `Mat-Beast-Scoreboard-Setup-0.9.19.exe`
  - `Mat-Beast-Scoreboard-Setup-0.9.19.exe.blockmap`
  Filenames use hyphens (not spaces) to match the reference in
  `latest.yml`'s `files[].url` field. Release URL:
  `https://github.com/ken91773/matbeast/releases/tag/v0.9.19`. After
  this, the auto-updater finds `latest.yml`, sees that the running
  app is already on the same version, and stays quiet on launch.
- **Process note:** Future releases should always include all three
  artifacts. `npm run desktop:publish` does the build + upload as
  one step via electron-builder's native publisher (which gets
  this right automatically); manual `gh release create` requires
  passing all three files explicitly.

### Overlay window framing trade-offs (no code change, design clarification)
- Operator asked why the bracket overlay shows a native window frame
  / drag handle but the scoreboard overlay does not.
- **Answer:** Windows + Electron limitation —
  `BrowserWindow({ transparent: true, frame: true })` is unsupported
  on Windows; the OS won't render a native title bar on a layered
  (transparent) window. The scoreboard overlay needs `transparent: true`
  to preserve the alpha channel for OBS / NDI alpha keying, so it
  must be `frame: false` and therefore non-draggable. The bracket
  overlay is opaque (`backgroundColor: "#000000"`), so it can carry
  a normal native frame.
- The auto-positioning code already snaps both overlays back to the
  canonical 1920 × 1080 spot on every launch / display-config change,
  so manual dragging shouldn't be necessary.

### NDI capture vs minimized windows (no code change, architecture note)
- Today's behavior: external OBS / NDI Scan Converter captures the
  visible Electron windows. With `backgroundThrottling: false`
  (already set), Chromium keeps painting to the window's backing
  surface even when the operator alt-tabs away, but **minimizing**
  to the taskbar can stop frame production depending on the capture
  method (BitBlt / DXGI desktop duplication stop; Windows Graphics
  Capture / WGC keeps going).
- Long-term plan: in-app NDI senders use **offscreen webContents**
  (`webPreferences.offscreen: true`) which render at a fixed 1920 × 1080
  buffer at a configurable frame rate regardless of any operator-
  visible window. Visible scoreboard / bracket windows become pure
  confidence monitors — operator can minimize / close / move them
  freely without affecting the broadcast feed.

## 2026-04-22 Session Updates (masters migration, control card OT, Electron focus)

### Master list migration (production profiles vanishing)
- **Bug:** `migrateMastersSplitIfNeeded()` treated any non-empty
  `MasterPlayerProfile` / `MasterTeamName` after the split marker was
  recorded on an **empty** DB as legacy data: it copied rows into
  `Training*` and `deleteMany()`'d live `Master*` again. First GET
  with empty masters set the marker; the first saved profile then
  disappeared from the production list on the next API call (copy
  showed up under `TrainingMasterPlayerProfile` instead).
- **Fix:** If `AppSchemaMigration` already has `masters_live_training_split_v1`,
  return immediately — the one-time copy-and-wipe runs only before that
  marker exists. File: `src/lib/migrate-masters-split.ts`.

### Control card: amber APPLY vs OT ← (two different actions)
- **Amber APPLY** (`applyFighters` in `ControlPanel.tsx`) PATCHes fighter
  fields (and round label only when it **actually changes** the board).
  It must **not** clear the OT-round **ELAPSED** counter when the
  operator is only saving fighters.
- **← beside the match clock** (OT round mode only) sends
  `command: { type: "ot_round_transfer_elapsed_to_main" }` — moves
  accumulated OT elapsed into the main match clock and **zeros**
  `otRoundElapsedBaseSeconds` (secondary readout shows `0:00`). Undo
  still restores from `otRoundTransferUndo*`.
- **Client:** `roundLabel` is included on APPLY only when `roundDirty`
  **and** `roundLabel.trim() !== board.roundLabel.trim()`.
- **Server:** `/api/board` PATCH runs `reconcileBoardStateForRoundLabelChange`
  only when the trimmed incoming `roundLabel` differs from the stored
  value; whitespace-only normalization updates the string without
  reconcile. Files: `ControlPanel.tsx`, `src/app/api/board/route.ts`.
- **Transfer math:** `otRoundElapsedTotalFromAnchoredBase()` in
  `src/lib/ot-round-label.ts` folds `otRoundElapsedRunStartedAt` when
  computing the seconds moved to the main clock (handles a paused main
  timer with a stale run anchor).

### Electron: dead keyboard in focused window (Windows)
- Removed capture-phase `pointerdown` → `focusMainWindow()` from
  `AppChrome.tsx` (raced Chromium focus into inputs).
- `installMatbeastPanelPointerRecovery()` now defers
  `restoreWebKeyboardFocus()` (IPC → `webContents.focus()`) on editable
  `pointerdown` / `mousedown` / `focusin`, plus `window` `focus` and
  `visibilitychange` → `visible`, with one IPC coalesced per tick.
- Optional diagnostics: with `localStorage matbeastFocusDebug = "1"`,
  `matbeast-focus` console lines include **keyboard-nudge** scheduling
  / settle / reject. Files: `matbeast-panel-pointer-recovery.ts`,
  `matbeast-focus-debug.ts`, `MatBeastFocusAndInputBridge.tsx`.

### Dashboard: add-team modal input focus
- After choosing **ADD TEAM** from the native `<select>`, blur the
  select and focus the new-team name field on the next animation frame
  so Electron routes keys into the dialog. File:
  `DashboardTeamsPanel.tsx`.

### Build
Desktop `npm run desktop:build` (NSIS + signed `dist/Mat Beast Scoreboard
Setup 0.9.11.exe`) verified after these changes.

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

*Last updated: 2026-04-28 — v0.9.19 desktop build + GitHub release; OT round transitions preserve secondary ELAPSED across OT-to-OT switches (v0.9.12), overlay output windows now pixel-accurate 1920 × 1080 across all display scaling factors via `display.scaleFactor` division (v0.9.14), bracket overlay music feature with operator-PC silent playback / NDI-ready audio graph / native file picker / `mat-beast-asset://` custom protocol / autoplay (v0.9.13), hardened preload script with always-on `__matBeastPreloadStatus` sentinel for actionable bridge diagnostics (v0.9.19), and `latest.yml` artifact restored to GitHub releases so `electron-updater` no longer 404s on launch.*
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

*Last updated: 2026-04-28 — v0.9.19 desktop build + GitHub release; OT round transitions preserve secondary ELAPSED across OT-to-OT switches (v0.9.12), overlay output windows now pixel-accurate 1920 × 1080 across all display scaling factors via `display.scaleFactor` division (v0.9.14), bracket overlay music feature with operator-PC silent playback / NDI-ready audio graph / native file picker / `mat-beast-asset://` custom protocol / autoplay (v0.9.13), hardened preload script with always-on `__matBeastPreloadStatus` sentinel for actionable bridge diagnostics (v0.9.19), and `latest.yml` artifact restored to GitHub releases so `electron-updater` no longer 404s on launch.*
