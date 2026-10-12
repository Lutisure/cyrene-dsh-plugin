<#
.SYNOPSIS
  Collect the pieces that live outside the repository into deploy/, so git can
  carry them.

.DESCRIPTION
  The two plugin packages are already in this repo. What is not — and what cannot
  be regenerated — is five files under ~/.dsh:

    skills/cyrene/SKILL.md          her, as the /cyrene path sees her
    profiles/<profile>/cordis.patch.yml   the preset: the six plugin rows
    cyrene-agent/memory.md          what she remembers about you
    cyrene-agent/corrections.md     how she has been told to speak
    theme-cyrene/state.json         wallpaper, volume, collapsed state

  Two of those are written by talking to her. Losing them means she wakes up
  without knowing you, which is exactly what this script exists to prevent.

  Run this before committing. It is safe to run repeatedly.

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
Write-Host '  next: git add -A ; git commit -m "sync state"' -ForegroundColor Yellow
