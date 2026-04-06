# Mat Beast Scoreboard Desktop Updates

This app uses `electron-updater` with **GitHub Releases**.

**Default release repository:** `ken91773/matbeast` (baked into the Electron main process).  
You can override at runtime with `MAT_BEAST_GH_OWNER` and `MAT_BEAST_GH_REPO` if needed.

## 1) Build a release

From `web/`:

```bash
npm run desktop:build
```

Release artifacts are created in `web/dist/`, including:

- `Mat Beast Scoreboard Setup <version>.exe`
- `Mat Beast Scoreboard Setup <version>.exe.blockmap`
- `latest.yml`

## 2) Publish updates

1. Create a GitHub personal access token with permission to create releases (classic token: `repo` scope is typical).
2. Set `GH_TOKEN` in your environment to that token.
3. Run:

```bash
npm run desktop:publish
```

`package.json` → `build.publish` targets **ken91773/matbeast**.  
`electron-builder` uploads the Windows artifacts to a **GitHub Release** for the current `version` in `package.json`.

## 3) Installed app

The packaged app checks **ken91773/matbeast** on GitHub for newer releases.  
Optional: set system/user env `MAT_BEAST_GH_OWNER` / `MAT_BEAST_GH_REPO` to point at a different repo.

## 4) In-app update flow

- Home → **Application Updates** → **Check for Updates**
- If a newer release exists, the update downloads
- **Install Update and Restart**

## Notes

- Updater only runs in **packaged** desktop builds.
- Bump `version` in `package.json` for each release (`0.1.0` → `0.1.1`, etc.).
- **Private repos:** GitHub Releases are not anonymously readable; public repos (or a public releases-only repo) are simplest for end-user auto-updates.
