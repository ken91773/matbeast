# Mat Beast Score — Progress Summary

This document captures the current state of the **Mat Beast Score** web app (Next.js + Prisma + SQLite), key product and technical decisions, what is implemented, and sensible next steps.

---

## Product overview

- **Purpose:** Run **quintet-style** (5 primary + 2 alternate) team rosters, mat control, and a **broadcast overlay** (e.g. OBS Browser Source at 1920×1080).
- **Stack:** Next.js (App Router), Prisma ORM, SQLite (`dev.db`), client UI with Tailwind-style classes.

---

## Key decisions

| Area | Decision |
|------|----------|
| **Events** | Two logical divisions — **Blue belt** vs **Purple/Brown** — modeled as separate `Event` rows (`EventKind`: `BLUE_BELT`, `PURPLE_BROWN`) under one default `Tournament`. Teams belong to an **`eventId`**, not directly to the tournament. |
| **Rosters** | Fully **separate** rosters and entry flows per division: distinct routes and UI shells (blue- vs brown-tinted backgrounds) so operators cannot confuse divisions. |
| **Team limits** | Up to **8 teams per event**, with bootstrap logic to ensure eight team rows exist per event. |
| **Belt ranks** | Stored as enum `BeltRank`: `WHITE`, `BLUE`, `PURPLE`, `BROWN`, `BLACK`. API enforces allowed belts **per event** (e.g. blue-belt event: white/blue only; purple/brown event: purple/brown/black). The roster UI can expose all five for entry where appropriate. |
| **Profile text** | User-entered profile text (names, academy, etc.) is normalized to **ALL CAPS** on save via shared helpers (e.g. `profileUpper` in `src/lib/profile-text.ts`). |
| **Height** | Stored as **`heightFeet`** + **`heightInches`** (inches 0–11), not a single free-text field. |
| **Photos** | **Uploaded** files saved under `public/uploads/`, with URLs stored on the player (`profilePhotoUrl`, `headShotUrl`). |
| **Roster grid display** | Grid cells show **last name only** (not nickname). Alternates labeled `ALT · {LAST}`. |
| **Roster files** | Roster pages support **NEW / SAVE / SAVE AS / LOAD** to JSON files, with visible active filename (`UNTITLED` default). |
| **Overlay/control names** | Control and overlay use board payload display names, with support for **custom fighter + custom team** overrides (ALL CAPS) when needed. |
| **Final results** | FINAL actions are recorded in a persisted `ResultLog` and tagged with the **current roster filename** from board state (`currentRosterFileName`). |
| **Desktop workflow** | **Electron** desktop app (`npm run desktop:dev` / `desktop:build`) wraps the Next.js UI; packaged builds bundle a **standalone** Next server and optional **matbeast-node.exe** runtime. See *Desktop packaging* below. |

---

## Implemented features

### Data & persistence

- Prisma models for `Tournament`, `Event`, `Team`, `Player`, live scoreboard, `ResultLog`, bracket/quintet session scaffolding (submission-only bout logging).
- **`Player`:** weights (unofficial/official), height, age, belt, lineup order (1–7), photo URLs, **`lineupConfirmed`** (SEED) and **`weighedConfirmed`** (WEIGHED) flags.
- **`Team`:** `eventId`, `seedOrder`, name; unique `(eventId, seedOrder)`.
- **`LiveScoreboardState`:** stores round/timer state plus custom fighter/team overrides, current roster filename, and final-result metadata used by FINAL/UNSAVE flow.

### API (representative)

- **`GET /api/teams?eventKind=…`** — Load teams + players for one division; bootstraps eight teams when needed.
- **`PATCH /api/teams/[id]`** — Team name / seed.
- **`POST /api/teams/[id]/lineup`** — Persist a 7-slot lineup for one team (shared implementation in `src/lib/team-lineup.ts`).
- **`POST /api/players/move-slot`** — Move or swap players **within or across teams** in one transaction (same event only).
- **`POST` / `PATCH /api/players`** — Create/update players; belt validation vs event; uppercase normalization for text fields where applied.
- **`POST /api/upload`** — Multipart image upload to `public/uploads/`.
- **`POST /api/tournament/reorder-teams`** — Reorder team seeds for a given `eventKind`.
- **`GET` / `PATCH /api/board`** — Live overlay payload and mat commands, including timer adjustments (`+/-` seconds), FINAL save/unsave, clear fields, custom names/teams, and results log feed.

### Roster UI (`RosterClient`)

- **Hub** at `/roster`; division pages at `/roster/blue-belt` and `/roster/purple-brown`.
- **Team setup** (8 seeds, editable names).
- **Roster grid:** drag team rows to re-seed; drag players between slots and **other teams**; **SEED** and **WEIGHED** checkboxes per occupied player cell; green styling when **both** are checked (and green accents on checked boxes).
- **Aggregate columns:** end-of-row totals for **unofficial** and **official** weight = sum of **S1–S5** primary slots for that team.
- **Player profile** form: height dropdowns, photo uploads, belt selection, confirmation checkboxes aligned with grid behavior.
- **Roster file actions:** top-bar `NEW / SAVE / SAVE AS / LOAD`, active filename display, and roster-file name sync into board state for result attribution.

### Other pages

- **Home** — Links to rosters, control, overlay; setup instructions.
- **Control / Overlay** — Scoreboard/timer integration for broadcast (see `public/scoreboard.svg`, layout helpers), with:
  - control-side fighter selectors (last-name list) + optional custom fighter/team inputs,
  - round presets (including OT presets + custom text),
  - expanded timer controls (reset 4:00 / reset 1:00 / +/- 1:00 / +/- 0:10 / +/- 0:01),
  - FINAL one-click result buttons, UNSAVE, and persisted results log,
  - winner text/green styling and draw/no-contest status display.

### Repository / ops

- **`public/uploads/`** with `.gitkeep`; uploaded files gitignored.
- **`next.config`** — `output: "standalone"` for Electron; experimental `serverActions.bodySizeLimit` raised for larger payloads.
- **Windows:** If `npx prisma generate` hits **EPERM**, stop processes locking `query_engine-windows.dll.node` (e.g. `npm run dev`), then regenerate.

### Desktop packaging (Electron) — in progress

**Multiphase plan (desktop):**

| Phase | Scope | Status |
|-------|--------|--------|
| **1 — Shell & parity** | Electron wraps existing Next app; **Windows-style** tabbed navigation; **overlay** output window (normal bordered window, draggable — **Goal A:** screen/window capture for NDI tools, not a native NDI encoder); app icon + **version** (beta **0.1.x**); main + overlay behavior. | Largely done; verify in packaged build. |
| **2 — Install & updates** | **NSIS** x64 installer (`electron-builder`); **GitHub Releases** feed for **electron-updater** (public repo); desktop/Start Menu shortcuts; prompt/clean **previous install**; in-app update UI + debug. | Implemented; validate end-to-end after a successful build. |
| **3 — Reliable bundled runtime** | Next **standalone** + bundled **Node** (`matbeast-node.exe`); **writable SQLite** in userData; startup **diagnostics** / logs; **dynamic port**, **single-instance**; strip standalone `.env`; harden Windows env. | In progress — **full `desktop:build` must complete** and app must start **without Startup Fallback**. |
| **4 — Polish & ops (optional)** | Code signing; CI for `desktop:build`; upload folder location policy under AppData; docs for operators; any remaining overlay/menu quirks. | Not started. |

- **Goal:** Windows x64 **NSIS** installer (`electron-builder`), in-app **GitHub Releases** updates (`electron-updater`), tabbed shell UI, separate **overlay** window, version in title + UI.
- **Bundled Next server:** Packaged app spawns **`matbeast-node.exe`** (copy of system Node) with `resources/standalone/server.js`; **`HOSTNAME=0.0.0.0`**, UI loads **`http://127.0.0.1:<dynamic-port>`** (avoids fixed-port conflicts and TIME_WAIT races). Readiness: **TCP** then **HTTP** to `/`, up to ~90s; **`bundled-server.log`** under Electron **userData** captures child stdout/stderr.
- **SQLite:** Build step **`desktop:prepare-db`** creates **`build/default-data/matbeast-template.db`**; runtime copies to **`%AppData%/…/matbeast.db`** (writable; avoids Program Files read-only). **`strip-standalone-dotenv.mjs`** removes `.next/standalone/.env` after build so Electron-provided **`DATABASE_URL`** wins.
- **Node runtime copy:** Script **`prepare-node-runtime.mjs`** copies Node into **`build/node-runtime/matbeast-node.exe`** (renamed from `node.exe` to avoid **EBUSY/EPERM** when a previous `node.exe` in that folder is locked). Retries + read/write fallback for flaky copies.
- **Single instance:** `requestSingleInstanceLock()` so a second launch focuses the first window instead of spawning another server.
- **Open issue (2026-04-06):** Full **`npm run desktop:build`** was **stopped after ~30 minutes**; it appeared **stalled** during **`next build`** (long compile with little console output). **Next:** retry build when the machine is idle; close other heavy Node processes; if it stalls again, run `npm run build` alone to see full Next output, then `npx cross-env CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --win --x64` after `strip-standalone-dotenv`.

---

## Progress log

### 2026-04-06 — Desktop packaging session

- Hardened bundled-server startup (dynamic port, bind `0.0.0.0`, TCP+HTTP wait, child exit detection, `NO_PROXY` for localhost, log tail on errors).
- Fixed **`prepare-node-runtime`**: EBUSY on copying `node.exe` → ship **`matbeast-node.exe`**; updated `electron/main.js` and `package.json` `extraResources`.
- User ran **`desktop:build`**; process **cancelled after ~30 min** with no clear completion — treat as **incomplete build** until a full run finishes and **`dist/`** contains a fresh **`Mat Beast Scoreboard Setup *.exe`**.

---

## Next steps (suggested)

1. **Production hardening:** Environment-specific DB (Postgres), migrations (not only `db push`), backups, and file upload limits/security (auth, virus scan if needed).
2. **Bracket / matches:** Wire `Event` → `BracketMatch` / `QuintetSession` flows if full tournament progression is required beyond roster + live board.
3. **Result workflows:** Add filtering/export for `ResultLog` (by roster file, event, date), and optional lock/confirm rules around FINAL save.
4. **Testing:** API route tests for `move-slot`, lineup constraints, board timer/final commands, and roster file import/export; smoke tests for roster/control UI.
5. **Deployment:** Host Next.js app, persist `public/uploads` on durable storage, and validate database choice/backups for production result history.
6. **Desktop installer:** Complete a full **`desktop:build`** without timeout; confirm bundled server starts (no Startup Fallback); optionally split CI into **`next build`** then **electron-builder** for clearer failure points.

---

## Local setup (reminder)

```bash
cd web
cp .env.example .env   # if needed
npm install
npx prisma generate
npx prisma db push
npm run dev
```

Open [http://localhost:3000](http://localhost:3000); use `/overlay` in OBS as a Browser Source when ready.

---

*Last updated: 2026-04-06 — multiphase desktop plan table + stalled-build note.*
