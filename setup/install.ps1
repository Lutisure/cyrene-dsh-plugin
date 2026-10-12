<#
.SYNOPSIS
  Install the 昔涟 plugin pair on this machine, from this repository.

.DESCRIPTION
  Three jobs, in order, each one declining to run if the ground is not ready:

    1. link the two packages into the DSH profile, by junction
    2. copy the packed ~/.dsh state back into place
    3. report what still needs doing by hand

  ## Why junctions and not `dsh plugin add`

  That is what this install already uses, and it is the only route that works
  without the desktop CLI, which ships packed inside app.asar and cannot be
  invoked from a shell. A junction is a directory link: the profile sees a normal
  package, and edits in the repository take effect immediately with no copy step.

  ## What it will not do

  It does not start DSH, and it does not know where DSH is installed. After this
  runs, restart DSH once — plugin *source* is read at boot, unlike the client half
  and the preset YAML.

.EXAMPLE
  pwsh <本仓库>\setup\install.ps1
  pwsh <本仓库>\setup\install.ps1 -DshHome '%USERPROFILE%\.dsh'
#>

[CmdletBinding()]
param(
  [string]$DshHome,
  [string]$Repo,
  [string]$Profile = 'desktop',
  [switch]$SkipState
)

# See pack.ps1: $PSScriptRoot is not bound yet while parameter defaults evaluate.
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
if (-not $Repo) { $Repo = Split-Path $PSScriptRoot -Parent }

$ErrorActionPreference = 'Stop'

function Say($text, $colour = 'Gray') { Write-Host "  $text" -ForegroundColor $colour }

$profileDir = Join-Path $DshHome "profiles\$Profile"
$modules = Join-Path $profileDir 'node_modules'
$stamp = Get-Date -Format 'yyyyMMddHHmmss'

Say 'checking the ground' Cyan

foreach ($package in @('dsh-theme-cyrene', 'cyrene-agent', 'cyrene-guard')) {
  $path = Join-Path $Repo $package
  if (-not (Test-Path (Join-Path $path 'package.json'))) {
    Say "missing package: $path" Red
    Say 'run this from inside the repository, or pass -Repo <path>' Red
    exit 1
  }
}

if (-not (Test-Path $profileDir)) {
  Say "no DSH profile at $profileDir" Red
  Say 'install and start DSH once on this machine first - it creates the profile.' Red
  Say 'then run this again.' Red
  exit 1
}

Say "repository : $Repo"
Say "dsh home   : $DshHome"
Say "profile    : $Profile"

# --- 1. the links --------------------------------------------------------
Say ''
Say 'linking the packages' Cyan

if (-not (Test-Path $modules)) { New-Item -ItemType Directory -Path $modules -Force | Out-Null }

foreach ($package in @('dsh-theme-cyrene', 'cyrene-agent', 'cyrene-guard')) {
  $link = Join-Path $modules $package
  $target = Join-Path $Repo $package

  if (Test-Path $link) {
    $existing = Get-Item $link -Force
    if ($existing.LinkType -eq 'Junction' -and ($existing.Target -join '') -eq $target) {
      Say "$package already points here" Green
      continue
    }
    Say "$package exists and points elsewhere - moving it aside" Yellow
    Rename-Item $link "$package.superseded-$stamp"
  }

  # -ItemType Junction needs no elevation, unlike SymbolicLink.
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
  Say "$package -> $target" Green
}

# --- 2. the profile's own dependency record ------------------------------
#
# ⚠️ 这里原来写的是 `$json.dependencies.$package = $want` —— **那句在干净的机器上必崩。**
#
# 2026-10-11 在临时 home 上实测：
#
#     Exception setting "dsh-theme-cyrene":
#     "The property 'dsh-theme-cyrene' cannot be found on this object."
#
# `ConvertFrom-Json` 出来的是定型的 PSCustomObject，**给不存在的属性直接赋值会抛**，
# 而新机器的 profile 里这两个包一个都不在（`dependencies` 是空的）。
# 本机没崩过，只因为它的 profile 里早就有了 —— **这正是「在这台机器上好好的，
# 到别人那台就装不上」的典型形状。**
#
# `Add-Member -Force` 两种情况下都对：没有就加，有就覆盖。
$profileJson = Join-Path $profileDir 'package.json'
if (Test-Path $profileJson) {
  $json = Get-Content $profileJson -Raw -Encoding UTF8 | ConvertFrom-Json
  $changed = $false
  # 全新的 profile 可能连 `dependencies` 这个键都没有 —— 那 `$json.dependencies` 是 $null，
  # 下面第一次读它就会炸。先补一个空的，并记下「改过」。
  if ($null -eq $json.dependencies) {
    $json | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([PSCustomObject]@{}) -Force
    $changed = $true
  }
  foreach ($package in @('dsh-theme-cyrene', 'cyrene-agent', 'cyrene-guard')) {
    $want = 'link:' + ((Join-Path $Repo $package) -replace '\\', '/')
    if ($json.dependencies.$package -ne $want) {
      $json.dependencies | Add-Member -NotePropertyName $package -NotePropertyValue $want -Force
      $changed = $true
    }
  }
  if ($changed) {
    Copy-Item $profileJson "$profileJson.superseded-$stamp" -Force
    # 不写 BOM：profile 的 package.json 是给 node 读的，而 node 会拒绝带 BOM 的 JSON。
    # （PowerShell 5.1 的 `Set-Content -Encoding UTF8` **会**写 BOM —— 所以这里绕开它。）
    $text = $json | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($profileJson, $text, (New-Object System.Text.UTF8Encoding $false))
    Say 'updated the profile package.json paths (previous kept as .superseded-*)' Green
  } else {
    Say 'profile package.json already correct' Green
  }
}

# --- 2.5 install each package's own dependencies ---------------------------
#
# ⚠️ 这一步原来是缺的，而缺了它**收件人根本 build 不了**。
#
# 2026-10-11 在干净机器上实测：装完之后跑 `node build.mjs` 直接抛
#
#     Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'js-yaml'
#     imported from .../cyrene-agent/build.mjs
#
# 因为导出物里**没有 `node_modules`**（那是对的 —— 依赖不该随包分发），
# 而 `js-yaml` 是 `dependencies` 里的真依赖，`build.mjs` 要读 `entries.yaml` 就得有它。
#
# **而 `dist/` 也是不随包的**，所以收件人的第一步必然是 build ——
# 于是这一处漏掉就是「装完看起来成功，其实用不了」。**这正是这一趟要抓的形状。**
Say ''
Say 'installing package dependencies' Cyan

foreach ($package in @('dsh-theme-cyrene', 'cyrene-agent', 'cyrene-guard')) {
  $dir = Join-Path $Repo $package
  $manifest = Join-Path $dir 'package.json'

  $deps = $null
  try {
    $deps = (Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).dependencies
  } catch { }

  if ($null -eq $deps -or @($deps.PSObject.Properties).Count -eq 0) {
    Say "$package has no runtime dependencies" DarkGray
    continue
  }

  if (Test-Path (Join-Path $dir 'node_modules')) {
    Say "$package already installed" Green
    continue
  }

  $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source
  if (-not $npm) {
    Say "$package needs its dependencies but npm is not on PATH" Yellow
    Say "  run this by hand, in $dir :  npm install --omit=dev" Yellow
    continue
  }

  # 会联网。装不上不致命 —— 报出来，让人自己补。
  Push-Location $dir
  try {
    & $npm install --omit=dev --no-audit --no-fund 2>&1 | ForEach-Object { Say "  $_" DarkGray }
    if ($LASTEXITCODE -eq 0) { Say "$package dependencies installed" Green }
    else { Say "$package npm install exited $LASTEXITCODE - run it by hand" Yellow }
  } catch {
    Say "$package npm install failed: $($_.Exception.Message)" Yellow
  } finally {
    Pop-Location
  }
}

# --- 2.6 build the story index ---------------------------------------------
#
# ⚠️ 少了这一步，**收件人拿到的是一个叫得应但答不上话的 RAG。**
#
# 他 2026-10-11 问：「我们的 RAG 不是基于游戏剧情文本吗，那么这一块是要跟着分发吗。」
# 问得对 —— 那时候不分发，于是 `story.mjs` 要读的 `dist/story-chunks.jsonl` 根本不存在。
#
# 现在 `corpus-src/`（剧情原文，10.8 MB）随包发，这一步把它变成索引。
#
# **只需要 node** —— 那个脚本只 import `node:fs` / `node:url` / `node:path`，
# 不联网、不要游戏数据转储。
Say ''
Say 'building the story index' Cyan

$agentDir = Join-Path $Repo 'cyrene-agent'
$indexAt = Join-Path $agentDir 'dist\story-chunks.jsonl'
$corpusAt = Join-Path $agentDir 'corpus-src'

if (Test-Path $indexAt) {
  Say 'story index already built' Green
} elseif (-not (Test-Path $corpusAt)) {
  Say 'no corpus-src/ - the story index cannot be built' Yellow
  Say '  story retrieval will return nothing. See SHARING.zh.md' Yellow
} else {
  Push-Location $agentDir
  try {
    & node 'tools\build-story-index.mjs' 2>&1 | ForEach-Object { Say "  $_" DarkGray }
    if ($LASTEXITCODE -eq 0 -and (Test-Path $indexAt)) {
      $kb = [math]::Round((Get-Item $indexAt).Length / 1KB)
      Say "story index built ($kb KB)" Green
    } else {
      Say "build-story-index.mjs exited $LASTEXITCODE - story retrieval will return nothing" Yellow
    }
  } catch {
    Say "story index build failed: $($_.Exception.Message)" Yellow
  } finally {
    Pop-Location
  }
}

# --- 3. the state that cannot be regenerated -----------------------------
if (-not $SkipState) {
  Say ''
  Say 'restoring memory, corrections, skill and settings' Cyan

  $stateMap = [ordered]@{
    'skills\cyrene\SKILL.md'             = "skills\cyrene\SKILL.md"
    "profile\cordis.patch.yml"           = "profiles\$Profile\cordis.patch.yml"
    'cyrene-agent\memory.md'             = 'cyrene-agent\memory.md'
    'cyrene-agent\corrections.md'        = 'cyrene-agent\corrections.md'
    'theme-cyrene\state.json'            = 'theme-cyrene\state.json'
  }

  foreach ($entry in $stateMap.GetEnumerator()) {
    $from = Join-Path $Repo "deploy\$($entry.Key)"
    $to = Join-Path $DshHome $entry.Value

    if (-not (Test-Path $from)) { Say "not in the repo, skipped: $($entry.Key)" DarkGray; continue }

    $dir = Split-Path $to -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

    # Never overwrite silently. The memory file on this machine may have entries
    # the repository does not, and it is the one thing here that cannot be rebuilt.
    if (Test-Path $to) {
      $same = (Get-FileHash $from).Hash -eq (Get-FileHash $to).Hash
      if ($same) { Say "identical, left alone: $($entry.Value)" DarkGray; continue }

      # The profile patch is replaced whole, and the copy in the repo can lag
      # behind the one on this machine. 2026-10-13 was exactly that: the live
      # preset had seven plugin rows (story among them), the repo copy had six,
      # and one install would have put the six back. A preset losing a row
      # changes nothing on screen, so name the rows before the swap.
      if ($entry.Key -eq 'profile\cordis.patch.yml') {
        $rowIds = {
          param([string]$path)
          $ids = @()
          foreach ($line in (Get-Content -LiteralPath $path -Encoding UTF8)) {
            if ($line -match '^\s*-\s*id:\s*(\S+)\s*$') { $ids += $Matches[1] }
          }
          return $ids
        }
        $before = @(& $rowIds $to)
        $after = @(& $rowIds $from)
        $lost = @($before | Where-Object { $after -notcontains $_ })
        if ($lost.Count -gt 0) {
          Say "  the copy being installed has no row for $($lost.Count) entry/entries that are live now:" Red
          foreach ($row in $lost) { Say "    - $row" Red }
          Say '  the live file is kept below - restore it, or add those rows to the repo copy first.' Yellow
        }
      }

      Copy-Item $to "$to.superseded-$stamp" -Force
      Say "existing file kept as $(Split-Path $to -Leaf).superseded-$stamp" Yellow
    }

    Copy-Item $from $to -Force
    Say "restored $($entry.Value)" Green
  }
}

# --- what is left for a person to do -------------------------------------
Say ''
Say 'done. two things left, both by hand:' Yellow
Say '  1. restart DSH once - plugin source is read at boot'
Say '  2. ffmpeg is NOT part of this repo. The music converter needs it:'
Say '     https://github.com/BtbN/FFmpeg-Builds/releases  ->  unzip under <工具目录>\ffmpeg'
Say ''
Say 'the theme and the preset YAML hot-apply; only .js changes need the restart.' DarkGray
