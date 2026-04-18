# Mat Beast Masters

Cloud service for the [Mat Beast Scoreboard](../web) desktop app.

Live at: **<https://matbeast-masters.vercel.app>**

## What this is

A small Next.js service that holds the shared cloud state for the desktop app:

- **Master player profiles** — the shared athlete roster (lives in cloud,
  not in the per-event SQLite DB).
- **Master team names** — the shared team-name list.
- **Event files** *(planned)* — the `.matb` files themselves, so any
  operator can open any event from any laptop.
- **Auth** — sign-in with Google or email verification code (via Clerk) so
  every save is attributed to a real person.

The desktop app continues to work fully offline. Cloud reads fall back to
a local cache, writes queue in an outbox, and nothing at cage-side depends
on being online.

## What's live right now (v0.2.0)

| Endpoint                                  | Method | Auth | What it does                       |
| ----------------------------------------- | ------ | ---- | ---------------------------------- |
| `/api/health`                             | GET    | no   | uptime check, returns service info |
| `/api/me`                                 | GET    | yes  | returns the signed-in user info    |
| `/api/master-team-names`                  | GET    | yes  | list all master team names         |
| `/api/master-team-names`                  | POST   | yes  | create a new master team name      |
| `/api/master-team-names/[id]`             | PATCH  | yes  | rename a master team name          |
| `/api/master-team-names/[id]`             | DELETE | yes  | delete a master team name          |
| `/api/master-player-profiles`             | GET    | yes  | list all master player profiles    |
| `/api/master-player-profiles`             | POST   | yes  | create a new master profile        |
| `/api/master-player-profiles/[id]`        | GET    | yes  | get a single profile               |
| `/api/master-player-profiles/[id]`        | PATCH  | yes  | update a master profile            |
| `/api/master-player-profiles/[id]`        | DELETE | yes  | delete a master profile            |

> **Note**: Clerk's `auth.protect()` returns **404** (not 401) for
> unauthenticated requests to protected endpoints. This is intentional —
> it hides the existence of protected routes from anonymous probes.

## Running it locally

```powershell
Set-Location c:\Users\USER\Documents\matbeastscore\masters
npm install
npm run dev
```

Then open <http://localhost:3100> in a browser. Port **3100** is used so
this never collides with the desktop app (which uses 3000).

You'll need a populated `.env.local` (see `.env.example`) with:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` from Clerk
- `DATABASE_URL` from Neon (Postgres connection string)

For Prisma CLI commands (`npx prisma db push`, `npx prisma studio`), the
same `DATABASE_URL` also needs to be in `.env` (Prisma CLI does not read
`.env.local`). The `masters/.env` file is gitignored.

## Database

PostgreSQL on Neon. Schema is in `prisma/schema.prisma`. After editing the
schema:

```powershell
npx prisma db push          # apply schema changes to Neon
npx prisma studio           # GUI to browse the live data
```

## Deploying

The first deploy linked this folder to a Vercel project named
`matbeast-masters`. Subsequent deploys:

```powershell
vercel --prod               # deploy current working tree to production
```

Environment variables on Vercel (set with `vercel env add`):

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — production + preview + development
- `CLERK_SECRET_KEY` — production + preview + development
- `DATABASE_URL` — production + development (preview skipped)

## Layout

```
masters/
├── package.json
├── tsconfig.json
├── next.config.ts
├── next-env.d.ts
├── .env.example          # template (committed)
├── .env.local            # Next.js runtime secrets (gitignored)
├── .env                  # Prisma CLI secrets, just DATABASE_URL (gitignored)
├── .gitignore
├── prisma/
│   └── schema.prisma     # Postgres schema (master profiles, team names)
└── src/
    ├── middleware.ts     # Clerk auth middleware
    ├── lib/
    │   ├── prisma.ts     # PrismaClient singleton
    │   └── auth.ts       # requireUserId() helper
    └── app/
        ├── layout.tsx
        ├── page.tsx
        ├── auth-panel.tsx
        ├── sign-in/[[...sign-in]]/page.tsx
        ├── sign-up/[[...sign-up]]/page.tsx
        └── api/
            ├── health/route.ts
            ├── me/route.ts
            ├── master-team-names/
            │   ├── route.ts          # GET, POST
            │   └── [id]/route.ts     # PATCH, DELETE
            └── master-player-profiles/
                ├── route.ts          # GET, POST
                └── [id]/route.ts     # GET, PATCH, DELETE
```

## Stack

- **Hosting**: Vercel (free tier)
- **Database**: Neon Postgres (free tier)
- **Auth**: Clerk (free tier, Google + email code)
- **File storage** *(planned)*: Cloudflare R2 (free tier)

## Rolling back the desktop app

This service is a separate folder from the desktop app. Nothing in
`../web/` has been touched. To roll the whole repo back to the pre-cloud
baseline:

```powershell
git -C c:\Users\USER\Documents\matbeastscore checkout v0.6.0
```
