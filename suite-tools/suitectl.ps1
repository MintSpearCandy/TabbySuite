param(
  [string]$Command = 'info',                       # info | check | apply | rollback | doctor
  [string]$Dest,                                   # 套件安装根（默认脚本所在目录的上一级）
  [string]$ChannelUrl,                             # channel.json 地址（默认取安装态 suite.json 内记录）
  [string]$Proxy,                                  # 例 http://127.0.0.1:7892
  [switch]$Force                                   # apply 时跳过进程占用检查（自担风险）
)
# TabbySuite 随包更新器（单一实现：suitectl CLI 的 update/doctor 子命令也转调本脚本）
# 语义：core 版本变 → 整包换（rename dance，data/ 保留）；否则 → 插件级换目录（备份可回滚）。
# treeHash 算法与 tools/suitectl/lib/hash.js 严格一致：文件按 posix 相对路径 ordinal 排序，
#   每文件一行 "<sha256 小写>  <相对路径>" 以 \n 结尾，整体 utf8 文本再 sha256。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'          # IWR 进度条会让大文件下载慢一个数量级

if (-not $Dest) { $Dest = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$DataDir    = Join-Path $Dest 'data'
$SuiteDir   = Join-Path $DataDir 'suite'
$SpecPath   = Join-Path $SuiteDir 'suite.json'
$NmDir      = Join-Path (Join-Path $DataDir 'plugins') 'node_modules'
$BackupDir  = Join-Path $SuiteDir '.backup'
$OldDir     = "$Dest.old"                          # core 级换包的旧树（dest 的兄弟目录）

function Read-Spec {
  if (-not (Test-Path $SpecPath)) { Write-Error "suite.json 缺失: $SpecPath（不是套件安装目录?）"; exit 1 }
  Get-Content $SpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
function Save-Spec ($spec) {
  $json = $spec | ConvertTo-Json -Depth 10
  [IO.File]::WriteAllText($SpecPath, $json + "`n", (New-Object Text.UTF8Encoding $false))
}
function Get-TreeHash ([string]$dir, [string[]]$ExcludeTop = @()) {
  $root = (Resolve-Path $dir).Path.TrimEnd('\','/')
  $files = New-Object 'System.Collections.Generic.List[string]'
  Get-ChildItem $root -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length + 1) -replace '\\','/'
    if ($ExcludeTop -notcontains ($rel -split '/')[0]) { $files.Add("$rel`t$($_.FullName)") }
  }
  $files.Sort([StringComparer]::Ordinal)
  $sb = New-Object Text.StringBuilder
  foreach ($line in $files) {
    $abs = $line -replace '^[^\t]+\t', ''
    $rel = $line -replace '\t[^\t]+$', ''
    $sha = (Get-FileHash -LiteralPath $abs -Algorithm SHA256).Hash.ToLower()
    [void]$sb.Append($sha); [void]$sb.Append('  '); [void]$sb.Append($rel); [void]$sb.Append("`n")
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes($sb.ToString())
  ([Security.Cryptography.SHA256]::Create()).ComputeHash($bytes) | ForEach-Object -Begin { $h = '' } -Process { $h += $_.ToString('x2') } -End { $h }
}
function Invoke-Download ([string]$url, [string]$to) {
  New-Item -ItemType Directory -Force -Path (Split-Path $to -Parent) | Out-Null
  $p = @{ Uri = $url; OutFile = $to; UseBasicParsing = $true }
  if ($Proxy) { $p.Proxy = $Proxy }
  Invoke-WebRequest @p
}
function Get-Channel ([string]$url) {
  if (Test-Path $url) { return (Get-Content $url -Raw -Encoding UTF8 | ConvertFrom-Json) }
  $tmp = Join-Path $env:TEMP ("channel-" + [IO.Path]::GetRandomFileName() + '.json')
  Invoke-Download $url $tmp
  try { Get-Content $tmp -Raw -Encoding UTF8 | ConvertFrom-Json } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}
function Assert-NotRunning {
  $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Dest\*" })
  if ($procs.Count -and -not $Force) {
    Write-Error "Tabby 正在从该目录运行（$($procs.Count) 进程）—— 请先退出，或 -Force 强制（更新前会杀进程）"
    exit 1
  }
  if ($procs.Count) { $procs | Stop-Process -Force; Start-Sleep -Seconds 2 }
}
function Backup-Spec ([string]$ts) {
  $dir = Join-Path $BackupDir $ts; New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Copy-Item $SpecPath (Join-Path $dir 'suite.json') -Force
}
# 插件级更新：下载→sha256 校验→解包（zip 内带顶层 <pkg>/）→备份旧件→换名→回写 spec
function Apply-Plugin ($spec, $chanRel, [string]$ts) {
  $changed = @($chanRel.plugins.PSObject.Properties | Where-Object {
    $name = $_.Name; $new = $_.Value; $old = $spec.plugins.$name
    -not $old -or $old.zipSha256 -ne $new.sha256
  })
  if (-not $changed.Count) { Write-Host '  插件无变化'; return }
  foreach ($p in $changed) {
    $name = $p.Name; $meta = $p.Value
    $url = "$($chanRel.baseUrl)/suite/$($chanRel.suiteVersion)/$($meta.zip)"
    $dl  = Join-Path (Join-Path $SuiteDir '.download') $meta.zip
    Write-Host "  ↓ $name $($meta.version)"
    Invoke-Download $url $dl
    $sha = (Get-FileHash -LiteralPath $dl -Algorithm SHA256).Hash.ToLower()
    if ($sha -ne $meta.sha256) { Write-Error "$name sha256 不符（期望 $($meta.sha256)，实得 $sha）—— 已中止，安装态未动"; exit 1 }
    $tmp = Join-Path (Join-Path $SuiteDir '.download') ($name + '.x')
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -LiteralPath $dl -DestinationPath $tmp -Force
    $inner = Join-Path $tmp $name                       # zip 顶层目录 = 包名
    if (-not (Test-Path (Join-Path $inner 'dist'))) { Write-Error "$name 解包异常（缺 dist/）—— 已中止"; exit 1 }
    $dst = Join-Path $NmDir $name
    if (Test-Path $dst) {
      $bk = Join-Path $BackupDir $ts; New-Item -ItemType Directory -Force -Path $bk | Out-Null
      Move-Item $dst (Join-Path $bk $name)
    }
    Move-Item $inner $dst
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    if (-not $spec.plugins.$name) { $spec.plugins | Add-Member -MemberType NoteProperty -Name $name -Value $null }
    $spec.plugins.$name = [pscustomobject]@{
      version = $meta.version; commit = $meta.commit; zip = $meta.zip
      zipSha256 = $meta.sha256; treeSha256 = $meta.treeSha256
    }
    Write-Host "  ✓ $name → $($meta.version)（旧件在 .backup/$ts/）"
  }
  $spec.suiteVersion = $chanRel.suiteVersion
  $spec.core.version = $chanRel.core
  Save-Spec $spec
}
# core 级更新：全量 zip → .staging 解包 → rename dance（旧树→ .old，staging 就位，data/ 原地保留）
function Apply-Core ($chanRel, [string]$ts) {
  $url = "$($chanRel.baseUrl)/suite/$($chanRel.suiteVersion)/$($chanRel.zip)"
  $staging = "$Dest.staging"
  foreach ($d in @($OldDir, $staging)) { if (Test-Path $d) { Remove-Item $d -Recurse -Force } }
  Write-Host "  ↓ 全量包 $($chanRel.zip)"
  $dl = Join-Path (Join-Path $SuiteDir '.download') $chanRel.zip
  Invoke-Download $url $dl
  $sha = (Get-FileHash -LiteralPath $dl -Algorithm SHA256).Hash.ToLower()
  if ($sha -ne $chanRel.sha256) { Write-Error "全量包 sha256 不符 —— 已中止，安装态未动"; exit 1 }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  Expand-Archive -LiteralPath $dl -DestinationPath $staging -Force
  $inner = Join-Path $staging 'tabby-suite'
  if (-not (Test-Path (Join-Path $inner (Split-Path $chanRel.exe -Leaf))) -and $chanRel.exe) {
    Write-Error "全量包解包异常（未见 $($chanRel.exe)）—— 已中止"; exit 1
  }
  New-Item -ItemType Directory -Force -Path $OldDir | Out-Null
  Get-ChildItem $Dest -Force | Where-Object { $_.Name -ne 'data' } | ForEach-Object {
    Move-Item $_.FullName (Join-Path $OldDir $_.Name)
  }
  Copy-Item $SpecPath (Join-Path $OldDir '_suite.json') -Force       # 回滚锚点
  Get-ChildItem $inner -Force | ForEach-Object {
    Move-Item $_.FullName (Join-Path $Dest $_.Name)
  }
  Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
  # 新安装态：以 channel 条目为基，保留本机 data 语义
  $spec = [pscustomobject]@{
    suiteVersion = $chanRel.suiteVersion; exe = $chanRel.exe; channel = $chanRel.channel
    core = $chanRel.core
    plugins = $chanRel.plugins
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  Save-Spec $spec
  Write-Host "  ✓ core → $($chanRel.core.version)（旧树在 $(Split-Path $OldDir -Leaf)/，确认正常后可手动删除）"
}

$spec = Read-Spec
switch ($Command) {
  'info' {
    Write-Host "suiteVersion: $($spec.suiteVersion)"
    Write-Host "core:         $($spec.core.version)"
    Write-Host "channel:      $($spec.channel)"
    foreach ($p in $spec.plugins.PSObject.Properties) { Write-Host "plugin:       $($p.Name) $($p.Value.version)" }
  }
  'check' {
    $url = if ($ChannelUrl) { $ChannelUrl } else { $spec.channel }
    if (-not $url) { Write-Error '无 channel 地址（suite.json 未记录且未传 -ChannelUrl）'; exit 1 }
    $chan = Get-Channel $url
    $latest = $chan.releases.($chan.latest)
    Write-Host "本机 $($spec.suiteVersion)  ·  channel 最新 $($chan.latest)"
    if ($latest.core -ne $spec.core.version) {
      Write-Host "▶ core $($spec.core.version) → $($latest.core)（整包更新）"
    }
    foreach ($p in $latest.plugins.PSObject.Properties) {
      $old = $spec.plugins.($p.Name)
      if (-not $old) { Write-Host "+ $($p.Name) $($p.Value.version)（新增）" }
      elseif ($old.zipSha256 -ne $p.Value.sha256) { Write-Host "▶ $($p.Name) $($old.version) → $($p.Value.version)" }
    }
    if ($latest.core -eq $spec.core.version -and -not (@($latest.plugins.PSObject.Properties | Where-Object { $old = $spec.plugins.($_.Name); -not $old -or $old.zipSha256 -ne $_.Value.sha256 }).Count)) {
      Write-Host '✓ 已是最新'
    }
  }
  'apply' {
    Assert-NotRunning
    $url = if ($ChannelUrl) { $ChannelUrl } else { $spec.channel }
    $chan = Get-Channel $url
    $rel = $chan.releases.($chan.latest)
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    Backup-Spec $ts
    if ($rel.core -ne $spec.core.version) {
      Write-Host "[apply] core 级更新 → $($chan.latest)"
      $rel | Add-Member -MemberType NoteProperty -Name suiteVersion -Value $chan.latest -Force
      $rel | Add-Member -MemberType NoteProperty -Name exe -Value $spec.exe -Force
      $rel | Add-Member -MemberType NoteProperty -Name channel -Value $url -Force
      $rel | Add-Member -MemberType NoteProperty -Name baseUrl -Value $chan.baseUrl -Force
      $rel.core = [pscustomobject]@{ version = $rel.core; zipSha256 = $rel.sha256; treeSha256 = $null }
      Apply-Core $rel $ts
      # core 包内自带插件已就位，无需再走插件级
    } else {
      Write-Host "[apply] 插件级更新 → $($chan.latest)"
      $rel | Add-Member -MemberType NoteProperty -Name suiteVersion -Value $chan.latest -Force
      $rel | Add-Member -MemberType NoteProperty -Name baseUrl -Value $chan.baseUrl -Force
      Apply-Plugin $spec $rel $ts
    }
    Write-Host '[apply] 完成 —— 重启 Tabby 生效'
  }
  'rollback' {
    Assert-NotRunning
    if (Test-Path $OldDir) {
      Write-Host '[rollback] core 级回滚（.old → 就位）'
      $staging = "$Dest.staging-rollback"
      if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
      Get-ChildItem $Dest -Force | Where-Object { $_.Name -ne 'data' } | ForEach-Object {
        New-Item -ItemType Directory -Force -Path $staging | Out-Null
        Move-Item $_.FullName (Join-Path $staging $_.Name)
      }
      Get-ChildItem $OldDir -Force | Where-Object { $_.Name -ne '_suite.json' } | ForEach-Object {
        Move-Item $_.FullName (Join-Path $Dest $_.Name)
      }
      $snap = Join-Path $OldDir '_suite.json'
      if (Test-Path $snap) { Copy-Item $snap $SpecPath -Force }
      Remove-Item $OldDir -Recurse -Force -ErrorAction SilentlyContinue
      Write-Host '[rollback] ✓ 完成（被回滚的失败树保留在 dest.staging-rollback/，确认后可删）'
    } elseif (Test-Path $BackupDir) {
      $ts = (Get-ChildItem $BackupDir -Directory | Sort-Object Name -Descending | Select-Object -First 1).Name
      Write-Host "[rollback] 插件级回滚（.backup/$ts/）"
      $snap = Join-Path (Join-Path $BackupDir $ts) 'suite.json'
      if (Test-Path $snap) { Copy-Item $snap $SpecPath -Force }
      Get-ChildItem (Join-Path $BackupDir $ts) -Directory | ForEach-Object {
        $dst = Join-Path $NmDir $_.Name
        if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
        Move-Item $_.FullName $dst
        Write-Host "  ✓ $($_.Name)"
      }
      Write-Host '[rollback] ✓ 完成'
    } else {
      Write-Host '[rollback] 无可回滚项（.old 与 .backup 均不存在）'
    }
  }
  'doctor' {
    $bad = 0
    foreach ($p in $spec.plugins.PSObject.Properties) {
      $dir = Join-Path $NmDir $p.Name
      if (-not (Test-Path $dir)) { Write-Host "✗ $($p.Name) 目录缺失"; $bad++; continue }
      if ($p.Value.treeSha256) {
        $h = Get-TreeHash $dir
        if ($h -eq $p.Value.treeSha256) { Write-Host "✓ $($p.Name) $($p.Value.version)" }
        else { Write-Host "✗ $($p.Name) 树 hash 不符（篡改/残留?）"; $bad++ }
      } else { Write-Host "? $($p.Name)（安装态无 treeSha256，跳过）" }
    }
    if ($spec.core.treeSha256) {
      $h = Get-TreeHash $Dest -ExcludeTop @('data')
      if ($h -eq $spec.core.treeSha256) { Write-Host "✓ core $($spec.core.version)" }
      else { Write-Host "✗ core 树 hash 不符"; $bad++ }
    }
    if ($bad) { Write-Host "[doctor] ✗ $bad 项异常"; exit 1 }
    Write-Host '[doctor] ✓ 完整性全部通过'
  }
  default { Write-Host "未知命令 $Command（info | check | apply | rollback | doctor）" }
}
