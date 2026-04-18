<#
.SYNOPSIS
  Publish a Mat Beast Scoreboard GitHub release from a pre-built web/dist/.

.DESCRIPTION
  Uploads the current web/dist build to the GitHub repository configured in
  web/package.json's "publish" block, using the GitHub CLI (gh). Handles the
  latest.yml / asset filename mismatch quirk automatically: GitHub substitutes
  spaces in uploaded filenames with dots, but electron-builder generates
  latest.yml with hyphens, which breaks auto-updates. This script inspects
  the uploaded asset names and rewrites latest.yml in place (then re-uploads
  it) if a mismatch is detected.

  By default this script ONLY publishes. It does NOT touch git. Use -Commit
  to also stage, commit, and push the source snapshot before creating the
  release.

.PARAMETER Title
  Release title (shown on the GitHub releases page). Defaults to
  "v<version> - Mat Beast Scoreboard".

.PARAMETER NotesFile
  Path to a Markdown file with release notes (used as the release body and,
  if -Commit is set, as the commit message body).

.PARAMETER Notes
  Inline release notes string. Ignored when -NotesFile is provided.

.PARAMETER Commit
  If set, run `git add -A && git commit && git push` before creating the
  release. The commit message subject is "v<version>: release snapshot" and
  the body is -NotesFile / -Notes if provided.

.PARAMETER Draft
  Create the release as a draft (won't be visible to users / auto-update).

.PARAMETER Clobber
  Overwrite an existing release at this tag. Without this flag, the script
  aborts if the tag already exists.

.PARAMETER DryRun
  Show every step and every command, but do not execute the git push or the
  gh release create / upload calls.

.PARAMETER Repo
  Override the GitHub repo (owner/repo). Defaults to the "publish" block in
  web/package.json.

.EXAMPLE
  .\scripts\publish-release.ps1 -NotesFile ..\CHANGELOG-v0.9.12.md

.EXAMPLE
  .\scripts\publish-release.ps1 -Commit -NotesFile release-notes.md

.EXAMPLE
  .\scripts\publish-release.ps1 -DryRun

.NOTES
  Prereqs: gh CLI installed and authenticated (gh auth login). Run after
  a successful `npm run desktop:build` so web/dist/ contains the artifacts.
#>

[CmdletBinding()]
param(
    [string]$Title,
    [string]$Notes,
    [string]$NotesFile,
    [switch]$Commit,
    [switch]$Draft,
    [switch]$Clobber,
    [switch]$DryRun,
    [string]$Repo
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info {
    param([string]$Message)
    Write-Host "    $Message" -ForegroundColor Gray
}

function Write-Ok {
    param([string]$Message)
    Write-Host "    $Message" -ForegroundColor Green
}

function Fail {
    param([string]$Message)
    Write-Host ""
    Write-Host "xx  $Message" -ForegroundColor Red
    Write-Host ""
    exit 1
}

function Resolve-Gh {
    $cmd = Get-Command gh -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidate = "C:\Program Files\GitHub CLI\gh.exe"
    if (Test-Path $candidate) { return $candidate }
    Fail "GitHub CLI (gh) not found. Install with 'winget install --id GitHub.cli' and run 'gh auth login'."
}

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$webDir    = Split-Path -Parent $scriptDir
$repoRoot  = Split-Path -Parent $webDir
$distDir   = Join-Path $webDir "dist"
$pkgPath   = Join-Path $webDir "package.json"

if (-not (Test-Path $pkgPath)) { Fail "Cannot find web/package.json at $pkgPath" }

$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$version = [string]$pkg.version
if (-not $version) { Fail "package.json has no version field." }

if (-not $Repo) {
    $publish = $pkg.build.publish
    if ($publish -and $publish.owner -and $publish.repo) {
        $Repo = "$($publish.owner)/$($publish.repo)"
    } else {
        Fail "No -Repo provided and web/package.json has no build.publish.owner/repo."
    }
}

$tag = "v$version"
if (-not $Title) { $Title = "$tag - Mat Beast Scoreboard" }

$installerName = "Mat Beast Scoreboard Setup $version.exe"
$installerPath = Join-Path $distDir $installerName
$blockmapPath  = "$installerPath.blockmap"
$latestYmlPath = Join-Path $distDir "latest.yml"

Write-Step "Release plan"
Write-Info "Repo       : $Repo"
Write-Info "Tag        : $tag"
Write-Info "Title      : $Title"
Write-Info "Installer  : $installerPath"
Write-Info "Blockmap   : $blockmapPath"
Write-Info "latest.yml : $latestYmlPath"
if ($Draft)   { Write-Info "Mode       : DRAFT" }
if ($DryRun)  { Write-Info "Mode       : DRY RUN (no writes)" }
if ($Clobber) { Write-Info "Mode       : CLOBBER existing release" }

# ---------------------------------------------------------------------------
# Verify artifacts
# ---------------------------------------------------------------------------

Write-Step "Verifying build artifacts in web/dist/"
foreach ($p in @($installerPath, $blockmapPath, $latestYmlPath)) {
    if (-not (Test-Path $p)) {
        Fail "Missing artifact: $p`n    Did you run 'npm run desktop:build' for version $version?"
    }
    $f = Get-Item $p
    $age = (Get-Date) - $f.LastWriteTime
    $ageStr = if ($age.TotalHours -lt 1) { "{0:N0}m ago" -f $age.TotalMinutes } else { "{0:N1}h ago" -f $age.TotalHours }
    Write-Ok ("{0,-50} {1,10:N0} bytes   modified {2}" -f $f.Name, $f.Length, $ageStr)
    if ($age.TotalHours -gt 24) {
        Write-Host "    WARNING: $($f.Name) is more than 24 hours old. Rebuild?" -ForegroundColor Yellow
    }
}

# Quick sanity: version in latest.yml matches package.json
$latestYmlText = Get-Content $latestYmlPath -Raw
if ($latestYmlText -notmatch "(?m)^version:\s*$([regex]::Escape($version))\s*$") {
    Fail "latest.yml version does not match package.json ($version). Rebuild web/dist."
}
Write-Ok "latest.yml version matches package.json ($version)."

# ---------------------------------------------------------------------------
# Verify gh CLI
# ---------------------------------------------------------------------------

Write-Step "Verifying GitHub CLI"
$gh = Resolve-Gh
Write-Info "gh at $gh"
& $gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Fail "gh is installed but not authenticated. Run: gh auth login"
}
$ghVersion = (& $gh --version 2>&1 | Select-Object -First 1)
Write-Ok $ghVersion

# ---------------------------------------------------------------------------
# Check for existing release
# ---------------------------------------------------------------------------

Write-Step "Checking for existing release at $tag"
& $gh release view $tag --repo $Repo 2>&1 | Out-Null
$releaseExists = ($LASTEXITCODE -eq 0)
if ($releaseExists) {
    if ($Clobber) {
        Write-Info "Existing release found. -Clobber set, will delete and recreate."
        if (-not $DryRun) {
            & $gh release delete $tag --repo $Repo --yes --cleanup-tag 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { Fail "Failed to delete existing release $tag." }
        }
        Write-Ok "Old release removed."
    } else {
        Fail "Release $tag already exists on $Repo. Pass -Clobber to overwrite."
    }
} else {
    Write-Ok "No existing release at $tag."
}

# ---------------------------------------------------------------------------
# Optional: commit + push
# ---------------------------------------------------------------------------

# Prepare notes text (used for both commit body and release body)
$notesText = $null
if ($NotesFile) {
    $resolvedNotesFile = Resolve-Path $NotesFile -ErrorAction SilentlyContinue
    if (-not $resolvedNotesFile) { Fail "NotesFile not found: $NotesFile" }
    $notesText = Get-Content $resolvedNotesFile -Raw
} elseif ($Notes) {
    $notesText = $Notes
}

if ($Commit) {
    Write-Step "Committing and pushing source snapshot"

    Push-Location $repoRoot
    try {
        # Dirty-tree check (exclude the artifact we don't want to stage)
        $status = (& git status --porcelain 2>&1)
        if (-not $status) {
            Write-Info "Working tree clean, nothing to commit."
        } else {
            # Scan for accidentally-staged secrets before committing
            & git add -A 2>&1 | Out-Null
            $staged = & git diff --cached --name-only
            $bad = $staged | Where-Object {
                $_ -match "(^|/)\.env($|\.)" -or
                $_ -match "\.env\.local$" -or
                $_ -match "(^|/)electron-builder\.env$" -or
                $_ -match "\.db$" -or
                $_ -match "(?i)clerkskey|clerkpkey|desktop-token.*\.txt$"
            }
            if ($bad) {
                Fail ("Refusing to commit: secret-looking files staged:`n    " + ($bad -join "`n    "))
            }

            $subject = "v${version}: release snapshot"
            $msgFile = Join-Path $repoRoot ".git-commit-msg.tmp"
            if ($notesText) {
                "$subject`n`n$notesText" | Set-Content -Path $msgFile -Encoding UTF8
            } else {
                $subject | Set-Content -Path $msgFile -Encoding UTF8
            }

            Write-Info "Staging $($staged.Count) file(s) and committing as: $subject"
            if (-not $DryRun) {
                & git commit -F $msgFile 2>&1 | Write-Host
                if ($LASTEXITCODE -ne 0) { Remove-Item $msgFile -ErrorAction SilentlyContinue; Fail "git commit failed." }
            }
            Remove-Item $msgFile -ErrorAction SilentlyContinue
            Write-Ok "Commit created."
        }

        Write-Info "Pushing to origin..."
        if (-not $DryRun) {
            & git push origin HEAD 2>&1 | Write-Host
            if ($LASTEXITCODE -ne 0) { Fail "git push failed." }
        }
        Write-Ok "Pushed."
    }
    finally { Pop-Location }
} else {
    # Informational-only check when -Commit is not used
    Push-Location $repoRoot
    try {
        $status = (& git status --porcelain 2>&1)
        if ($status) {
            Write-Host ""
            Write-Host "    NOTE: working tree has uncommitted changes. The tagged release will" -ForegroundColor Yellow
            Write-Host "          not match any committed source. Re-run with -Commit to also" -ForegroundColor Yellow
            Write-Host "          commit and push the source snapshot." -ForegroundColor Yellow
        }
    }
    finally { Pop-Location }
}

# ---------------------------------------------------------------------------
# Create release
# ---------------------------------------------------------------------------

Write-Step "Creating GitHub release"

$notesFileForGh = $null
if ($notesText) {
    $notesFileForGh = Join-Path $env:TEMP "matbeast-release-notes-$version.md"
    $notesText | Set-Content -Path $notesFileForGh -Encoding UTF8
}

$createArgs = @(
    "release", "create", $tag,
    "--repo", $Repo,
    "--title", $Title,
    "--target", "main"
)
if ($Draft)           { $createArgs += "--draft" }
if ($notesFileForGh)  { $createArgs += @("--notes-file", $notesFileForGh) }
elseif (-not $notesFileForGh) { $createArgs += @("--notes", "Mat Beast Scoreboard $tag") }
$createArgs += @($installerPath, $blockmapPath, $latestYmlPath)

Write-Info ("gh " + ($createArgs -join " "))
if ($DryRun) {
    Write-Ok "DRY RUN: would have created release now."
} else {
    & $gh @createArgs
    if ($LASTEXITCODE -ne 0) {
        if ($notesFileForGh) { Remove-Item $notesFileForGh -ErrorAction SilentlyContinue }
        Fail "gh release create failed."
    }
}
if ($notesFileForGh) { Remove-Item $notesFileForGh -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------------------
# Reconcile latest.yml with GitHub's stored filename
# ---------------------------------------------------------------------------

Write-Step "Reconciling latest.yml with uploaded asset names"

if ($DryRun) {
    Write-Ok "DRY RUN: skipping reconciliation."
} else {
    $assetsJson = & $gh api "repos/$Repo/releases/tags/$tag" --jq ".assets[].name"
    if ($LASTEXITCODE -ne 0) { Fail "Could not list release assets for reconciliation." }
    $assetNames = $assetsJson -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }

    $installerAsset = $assetNames | Where-Object { $_ -like "*.exe" -and $_ -notlike "*.blockmap*" } | Select-Object -First 1
    if (-not $installerAsset) { Fail "No .exe asset found on release $tag after upload." }
    Write-Info "GitHub stored the installer as: $installerAsset"

    # What does latest.yml currently reference?
    $ymlText = Get-Content $latestYmlPath -Raw
    $urlLineMatch = [regex]::Match($ymlText, "(?m)^\s*-\s*url:\s*(?<n>\S+)\s*$")
    if (-not $urlLineMatch.Success) { Fail "Could not find 'url:' line in latest.yml." }
    $referenced = $urlLineMatch.Groups["n"].Value

    if ($referenced -eq $installerAsset) {
        Write-Ok "latest.yml already references $installerAsset -- no patch needed."
    } else {
        Write-Info "latest.yml references:  $referenced"
        Write-Info "Rewriting latest.yml to reference $installerAsset ..."
        $patched = $ymlText `
            -replace [regex]::Escape($referenced), $installerAsset
        Set-Content -Path $latestYmlPath -Value $patched -Encoding UTF8 -NoNewline:$false

        Write-Info "Re-uploading patched latest.yml..."
        & $gh release upload $tag $latestYmlPath --repo $Repo --clobber
        if ($LASTEXITCODE -ne 0) { Fail "Re-upload of latest.yml failed." }
        Write-Ok "latest.yml patched and re-uploaded."
    }
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

Write-Step "Done"
Write-Host ""
Write-Host "    https://github.com/$Repo/releases/tag/$tag" -ForegroundColor Green
Write-Host ""
