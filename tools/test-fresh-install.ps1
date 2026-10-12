<#
.SYNOPSIS
  在「一台干净机器」上装一遍，看会出什么问题。

.DESCRIPTION
  模拟另一台电脑：造一个空的 DSH_HOME，把**给朋友的那份导出物**装进去，
  然后检查装完是什么样。

  ## 为什么要走导出物，不走本仓库

  本仓库里有 `dist/`、`deploy/`、`node_modules`、游戏素材 —— 收件人一个都没有。
  **从本仓库装能过，证明不了从导出物装能过。** 这两件事差得很远，
  而差的那部分正是「移植到别的电脑」会踩的坑。

  ## 它造什么

    <临时目录>/home/                     当作另一台机器的 ~/.dsh
    <临时目录>/home/profiles/desktop/     DSH 启动一次之后会有的样子
    <临时目录>/share/                     make-share.mjs 的导出物

  最后一样是「发给朋友的那个压缩包解压之后」。

  ## 它验什么

    1. install.ps1 能不能在干净的 home 上跑通
    2. 两个 junction 建出来没有、指向对不对
    3. profile 的 package.json 有没有被正确改写
    4. 装完之后，缺什么（收件人得自己做的那些）
    5. 从导出物跑 agent 的校验：check-presets、verify-real-prompt

.PARAMETER Keep
  跑完不删临时目录，留着看。

.EXAMPLE
  pwsh tools/test-fresh-install.ps1
  pwsh tools/test-fresh-install.ps1 -Keep
#>

[CmdletBinding()]
param(
  [switch]$Keep,
  [string]$Work
)

$ErrorActionPreference = 'Stop'

function Say($text, $colour = 'Gray') { Write-Host "  $text" -ForegroundColor $colour }
function Head($text) { Write-Host ''; Write-Host "  ═══ $text ═══" -ForegroundColor Cyan }

$repo = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $Work) {
  $Work = Join-Path $env:TEMP ("cyrene-fresh-" + (Get-Date -Format 'yyyyMMddHHmmss'))
}
# ⚠️ 不能叫 `$home` —— 那是 PowerShell 的**只读自动变量**，赋值会抛
#     "Cannot overwrite variable HOME because it is read-only or constant."
#     （和以前踩过的 `$HOME` 是同一类。工具文档里也点了名。）
$fakeHome = Join-Path $Work 'home'
$share = Join-Path $Work 'share'

$problems = New-Object System.Collections.Generic.List[string]

if (Test-Path $Work) { Remove-Item $Work -Recurse -Force }
New-Item -ItemType Directory -Path $Work -Force | Out-Null

Head '一、造一台干净的机器'
New-Item -ItemType Directory -Path (Join-Path $fakeHome 'profiles\desktop') -Force | Out-Null

# DSH 启动一次之后，profile 目录里会有一个 package.json。这里照最小形态造一个 ——
# **没有它 install.ps1 会跳过「改写 profile 依赖」那一步，而那一处正是要测的。**
@'
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {}
}
'@ | Set-Content -Path (Join-Path $fakeHome 'profiles\desktop\package.json') -Encoding UTF8

Say "临时 home : $fakeHome"
Say "（profile 是空的，依赖里什么都没有 —— 就是刚装完 DSH 的样子）"

Head '二、导出给朋友的那份'

$packOk = $true
Push-Location $repo
try {
  & $node (Join-Path $repo 'tools\make-share.mjs') $share 2>&1 | ForEach-Object { Say $_ DarkGray }
  if ($LASTEXITCODE -ne 0) { $packOk = $false }
} finally {
  Pop-Location
}

if (-not $packOk) {
  Say '导出失败，后面的测试没有意义' Red
  exit 1
}

$pkgCount = (Get-ChildItem $share -Directory | Measure-Object).Count
$fileCount = (Get-ChildItem $share -Recurse -File | Measure-Object).Count
Say "导出物：$pkgCount 个目录，$fileCount 个文件" Green

Head '三、从导出物装'

$installer = Join-Path $share 'setup\install.ps1'
if (-not (Test-Path $installer)) {
  $problems.Add('导出物里没有 setup\install.ps1 —— 收件人没有安装脚本')
  Say '导出物里没有 setup\install.ps1' Red
} else {
  try {
    & $installer -DshHome $fakeHome -Repo $share -SkipState 2>&1 | ForEach-Object { Say $_ DarkGray }
    if ($LASTEXITCODE -ne 0) { $problems.Add("install.ps1 退出码 $LASTEXITCODE") }
  } catch {
    $problems.Add("install.ps1 抛了：$($_.Exception.Message)")
    Say $_.Exception.Message Red
  }
}

Head '四、装完是什么样'

$modules = Join-Path $fakeHome 'profiles\desktop\node_modules'
foreach ($package in @('cyrene-agent', 'dsh-theme-cyrene')) {
  $link = Join-Path $modules $package
  if (-not (Test-Path $link)) {
    $problems.Add("没建出 $package 的链接")
    Say "$package  没建出来" Red
    continue
  }
  $item = Get-Item $link -Force
  $target = ($item.Target -join '')
  $ok = $item.LinkType -eq 'Junction' -and $target -eq (Join-Path $share $package)
  Say ("{0}  {1}  ->  {2}" -f $(if ($ok) { '✓' } else { '✗' }), $package, $target) $(if ($ok) { 'Green' } else { 'Red' })
  if (-not $ok) { $problems.Add("$package 的链接不对：$target") }
}

$profileJson = Join-Path $fakeHome 'profiles\desktop\package.json'
if (Test-Path $profileJson) {
  $json = Get-Content $profileJson -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($package in @('cyrene-agent', 'dsh-theme-cyrene')) {
    $dep = $json.dependencies.$package
    $ok = $dep -like 'link:*'
    Say ("{0}  profile 依赖 {1} = {2}" -f $(if ($ok) { '✓' } else { '✗' }), $package, $dep) $(if ($ok) { 'Green' } else { 'Red' })
    if (-not $ok) { $problems.Add("profile 依赖里 $package 是「$dep」，不是 link:") }
  }
}

Head '五、收件人还得自己做什么'

$needBuild = -not (Test-Path (Join-Path $share 'cyrene-agent\dist\system-prompt.md'))
Say ("{0}  cyrene-agent 要自己 build（导出物里没有 dist）" -f $(if ($needBuild) { '需要' } else { '不需要' })) $(if ($needBuild) { 'Yellow' } else { 'Green' })

$hasMemory = Test-Path (Join-Path $fakeHome 'cyrene-agent\memory.md')
Say ("{0}  记忆是空的（新装的本来就该是空的）" -f $(if (-not $hasMemory) { '✓' } else { '✗' })) $(if (-not $hasMemory) { 'Green' } else { 'Red' })
if ($hasMemory) { $problems.Add('新装的 home 里出现了 memory.md —— 不该有') }

$hasState = Test-Path (Join-Path $fakeHome 'theme-cyrene\state.json')
Say ("{0}  主题没有预设状态（收件人装上就是出厂默认）" -f $(if (-not $hasState) { '✓' } else { '✗' })) $(if (-not $hasState) { 'Green' } else { 'Red' })

Head '六、从导出物跑校验'

Push-Location (Join-Path $share 'cyrene-agent')
try {
  if ($needBuild) {
    Say '先 build（收件人的第一步）' DarkGray
    & $node 'build.mjs' 2>&1 | Select-Object -Last 2 | ForEach-Object { Say $_ DarkGray }
  }
  $builtOk = Test-Path (Join-Path $share 'cyrene-agent\dist\system-prompt.md')
  Say ("{0}  build 产出了 dist/system-prompt.md" -f $(if ($builtOk) { '✓' } else { '✗' })) $(if ($builtOk) { 'Green' } else { 'Red' })
  if (-not $builtOk) { $problems.Add('收件人 build 之后没有 dist/system-prompt.md') }

  # ⚠️ 有些工具**有意不在导出物里** —— `check-presets.mjs` 属于 modes/presets 那套，
  #    那是他明确说「不要推送」的几个功能之一。**所以这里不能硬期待它。**
  #    （第一版就写错了：拿它当必经一步，于是导出物明明是对的、测试却报失败。）
  #
  # ⚠️ `verify-real-prompt.mjs` 要知道 DSH 装在哪（它读 `DSH_ASAR`）。
  #    导出物里那个默认值**被洗成了 `<DSH 安装目录>`** —— 那是对的，
  #    它不该带作者的真实路径。这里把本机的传进去，模拟「收件人指到他自己的那份」。
  #
  #    第一版想从 `$repo` 推出来，**算错了**：`Split-Path` 两次之后是空串，
  #    于是 `Join-Path '' …` 直接抛。**DSH 的安装目录和仓库不在同一条路径上，推不出来。**
  #    改成参数 / 环境变量。
  $savedAsar = $env:DSH_ASAR
  if (-not $env:DSH_ASAR -and $DshAsar) { $env:DSH_ASAR = $DshAsar }
  if (-not $env:DSH_ASAR) { Say 'DSH_ASAR not set - verify-real-prompt will be skipped' Yellow }

  foreach ($check in @('tools\verify-real-prompt.mjs', 'tools\check-eol.mjs', 'tools\check-entry-shape.mjs')) {
    if (-not (Test-Path $check)) { Say "$check 没随包（对某些工具是预期的）" DarkGray; continue }
    if ($check -like '*verify-real-prompt*' -and -not $env:DSH_ASAR) { Say "$check 跳过（没有 DSH_ASAR）" Yellow; continue }
    $out = & $node $check 2>&1
    $ok = $LASTEXITCODE -eq 0
    Say ("{0}  {1}" -f $(if ($ok) { '✓' } else { '✗' }), (Split-Path $check -Leaf)) $(if ($ok) { 'Green' } else { 'Red' })
    if (-not $ok) { $problems.Add("从导出物跑 $check 失败"); $out | Select-Object -Last 8 | ForEach-Object { Say $_ Red } }
  }
  if ($savedAsar) { $env:DSH_ASAR = $savedAsar } else { Remove-Item Env:\DSH_ASAR -ErrorAction SilentlyContinue }
} finally {
  Pop-Location
}

Head '结果'

if ($problems.Count -eq 0) {
  Say '干净机器上装得通，没发现问题。' Green
} else {
  Say "$($problems.Count) 个问题：" Red
  foreach ($p in $problems) { Say "  · $p" Red }
}

if ($Keep) {
  Say ''
  Say "留着没删：$Work" Yellow
} else {
  Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
}

exit $(if ($problems.Count -eq 0) { 0 } else { 1 })
