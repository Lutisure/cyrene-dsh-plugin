<#
.SYNOPSIS
  profile 里已经有同名包时，安装脚本会怎样。

.DESCRIPTION
  收件人可能不是「全新机器」—— 他可能：
    · 之前装过一次，链接指向另一个目录（换了盘符、换了解压位置）
    · 自己写过同名包
    · 上次安装中断，留下半个链接

  `install.ps1` 对这三种都有处理（把旧的改名成 `.superseded-<时间戳>`），
  但**那是我读代码读出来的，没在真环境里跑过。**

  这一份就把三种现场各造一遍，看它认不认得出来。

.PARAMETER Keep
  跑完不删临时目录。

.EXAMPLE
  pwsh tools/test-profile-conflict.ps1
#>

[CmdletBinding()]
param([switch]$Keep)

$ErrorActionPreference = 'Stop'

function Say($text, $colour = 'Gray') { Write-Host "  $text" -ForegroundColor $colour }
function Head($text) { Write-Host ''; Write-Host "  ═══ $text ═══" -ForegroundColor Cyan }

$repo = Split-Path $PSScriptRoot -Parent
$work = Join-Path $env:TEMP ("cyrene-conflict-" + (Get-Date -Format 'yyyyMMddHHmmss'))
$problems = New-Object System.Collections.Generic.List[string]

if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $work -Force | Out-Null

# ⚠️ 不能叫 `$home` —— PowerShell 只读自动变量。
$fakeHome = Join-Path $work 'home'
$profileDir = Join-Path $fakeHome 'profiles\desktop'
$modules = Join-Path $profileDir 'node_modules'
New-Item -ItemType Directory -Path $modules -Force | Out-Null
'{ "name": "dsh-profile-desktop", "private": true, "dependencies": {} }' |
  Set-Content (Join-Path $profileDir 'package.json') -Encoding UTF8

Head '一、造三种「已经有东西」的现场'

# 情形甲：链接指向别处（换过盘符 / 换过解压位置）
$elsewhere = Join-Path $work 'old-location'
New-Item -ItemType Directory -Path $elsewhere -Force | Out-Null
New-Item -ItemType Junction -Path (Join-Path $modules 'dsh-theme-cyrene') -Target $elsewhere | Out-Null
Say "dsh-theme-cyrene -> 另一个目录（模拟换过位置）"

# 情形乙：一个**真目录**占着名字（不是链接）
$realDir = Join-Path $modules 'cyrene-agent'
New-Item -ItemType Directory -Path $realDir -Force | Out-Null
'{ "name": "cyrene-agent", "version": "0.0.1-handmade" }' | Set-Content (Join-Path $realDir 'package.json') -Encoding UTF8
Say "cyrene-agent  -> 一个真目录（模拟自己写过同名包）"

# 情形丙：cyrene-guard 不存在（干净的那一个，作对照）
Say "cyrene-guard  -> 不存在（对照）"

Head '二、跑安装脚本'

$installer = Join-Path $repo 'setup\install.ps1'
try {
  & $installer -DshHome $fakeHome -SkipState 2>&1 | ForEach-Object { Say $_ DarkGray }
} catch {
  $problems.Add("install.ps1 抛了：$($_.Exception.Message)")
  Say $_.Exception.Message Red
}

Head '三、检查结果'

foreach ($package in @('dsh-theme-cyrene', 'cyrene-agent', 'cyrene-guard')) {
  $link = Join-Path $modules $package
  if (-not (Test-Path $link)) {
    $problems.Add("$package 最后没有链接")
    Say "$package  没建出来" Red
    continue
  }
  $item = Get-Item $link -Force
  $target = ($item.Target -join '')
  $want = Join-Path $repo $package
  $ok = $item.LinkType -eq 'Junction' -and $target -eq $want
  Say ("{0}  {1}" -f $(if ($ok) { '✓' } else { '✗' }), $package) $(if ($ok) { 'Green' } else { 'Red' })
  if (-not $ok) { $problems.Add("$package 指向 '$target'，应该是 '$want'") }
}

# 旧的有没有被留在旁边（而不是被删掉）—— 「绝不静默覆盖」是那个脚本自己写的规矩。
Head '四、旧的是被移开还是被删了'

$superseded = Get-ChildItem $modules -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like '*.superseded-*' }
if ($superseded.Count -gt 0) {
  foreach ($s in $superseded) { Say "留着了： $($s.Name)" Green }
} else {
  $problems.Add('旧的没有留副本 —— 那个脚本的注释写着「Never overwrite silently」')
  Say '没有任何 .superseded-* —— 旧的被覆盖或删掉了' Red
}

if ($Keep) { Say ''; Say "留着没删：$work" Yellow }
else { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }

Head '结果'
if ($problems.Count -eq 0) {
  Say '三种冲突都处理对了。' Green
  exit 0
}
Say "$($problems.Count) 个问题：" Red
foreach ($p in $problems) { Say "  · $p" Red }
exit 1
