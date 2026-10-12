<#
.SYNOPSIS
  Collect the pieces that live outside the repository into deploy/, so they can
  be put back.

.DESCRIPTION
  The two plugin packages are already in this repo. What is not — and what cannot
  be regenerated — is five files under ~/.dsh:

    skills/cyrene/SKILL.md          her, as the /cyrene path sees her
    profiles/<profile>/cordis.patch.yml   the two presets and their plugin rows
    cyrene-agent/memory.md          what she remembers about you
    cyrene-agent/corrections.md     how she has been told to speak
    theme-cyrene/state.json         wallpaper, volume, collapsed state

  Two of those are written by talking to her. Losing them means she wakes up
  without knowing you, which is exactly what this script exists to prevent.

  ⚠️ `deploy/` is gitignored on purpose (see .gitignore): it holds memory, so it
  never travels with the repository, and nothing here reaches GitHub or npm. The
  pair is about *this* machine — pack takes the snapshot, install.ps1 reads it
  back. Worth running before anything that rewrites ~/.dsh, and before letting
  install.ps1 run, so that what it reads back is not older than what is live.

  Safe to run repeatedly.

.EXAMPLE
  pwsh <本仓库>\setup\pack.ps1
#>

[CmdletBinding()]
param(
  [string]$DshHome,
  [string]$Repo,
  [string]$Profile = 'desktop'
)

# Resolved in the body, not as parameter defaults: $PSScriptRoot is empty while
# the param block is being bound under `-File`, so a default that reads it throws
# before the script runs a single line.
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
if (-not $Repo) { $Repo = Split-Path $PSScriptRoot -Parent }

$ErrorActionPreference = 'Stop'
$deploy = Join-Path $Repo 'deploy'

# source under ~/.dsh  ->  path inside deploy/
$map = [ordered]@{
  "skills\cyrene\SKILL.md"                 = 'skills\cyrene\SKILL.md'
  "profiles\$Profile\cordis.patch.yml"     = "profile\cordis.patch.yml"
  'cyrene-agent\memory.md'                 = 'cyrene-agent\memory.md'
  'cyrene-agent\corrections.md'            = 'cyrene-agent\corrections.md'
  "theme-cyrene\state.json"                = 'theme-cyrene\state.json'
}

Write-Host '  packing ~/.dsh state into deploy/' -ForegroundColor Cyan
$copied = 0
$missing = @()

foreach ($entry in $map.GetEnumerator()) {
  $from = Join-Path $DshHome $entry.Key
  $to = Join-Path $deploy $entry.Value

  if (-not (Test-Path $from)) {
    $missing += $entry.Key
    continue
  }

  $dir = Split-Path $to -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Copy-Item $from $to -Force
  $size = (Get-Item $to).Length
  Write-Host ("    {0,-46} {1,8:N0} B" -f $entry.Value, $size)
  $copied += 1
}

Write-Host ''
Write-Host ("  copied {0} file(s) into deploy/" -f $copied) -ForegroundColor Green

if ($missing.Count -gt 0) {
  # Not an error. A machine where she has never been told anything has no memory
  # file, and that is a legitimate state to pack.
  Write-Host '  not present yet (fine — nothing to carry):' -ForegroundColor DarkGray
  foreach ($name in $missing) { Write-Host "    $name" -ForegroundColor DarkGray }
}

Write-Host ''
Write-Host '  deploy/ is gitignored, so there is nothing to commit from this.'
Write-Host '  install.ps1 reads these five files back; run this again after she has been told new things.' -ForegroundColor Yellow
