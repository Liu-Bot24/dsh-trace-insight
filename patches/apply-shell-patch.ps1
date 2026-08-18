[CmdletBinding()]
param(
  [string]$DshRoot = '',
  [string]$RestoreBackup = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TestedDshVersion = '0.1.0-rc.6'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$PatchDir = Join-Path $Here 'dsh-client-ui-layout'
$OriginalHashes = @{
  'client.js'     = '8807EE56F56F8FBF6F6704A3A5E8AA6B45E9BD1A73B34F4D314C64D9E37D26FE'
  'index.d.ts'    = 'A7F4AFB8867746BBDD4B92A98263A16641D61D1F462A49251A462396610C8074'
  'service.d.ts'  = '4FEB499BA08D174BEDF9F6266F86B444931E1E3D5BB1B79A34A8BCA306BE50CF'
  'stores.d.ts'   = '4577E8391513AEC24705C4EBDC6531D5020E8A8D45C0347C35823A524EA3F084'
  'AppFrame.d.ts' = 'EF1CBCAF436971EB1FE5F4E24300072F80537343B38763A7A6BE9861F5F3D7FF'
}

function Resolve-DshRoot {
  if (-not [string]::IsNullOrWhiteSpace($DshRoot)) { return (Resolve-Path -LiteralPath $DshRoot).Path }
  $running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and $_.CommandLine -match '(?i)@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js' -and $_.CommandLine -match '(?i)\sweb(?:\s|$)'
  } | Select-Object -First 1
  if ($running -and $running.CommandLine -match '"([^"]*\\dsh\\lib\\bin\.js)"') {
    $root = [System.IO.Path]::GetFullPath($matches[1])
    1..5 | ForEach-Object { $root = Split-Path -Parent $root }
    return $root
  }
  $npxRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
  $candidates = @()
  if (Test-Path -LiteralPath $npxRoot) {
    foreach ($entry in Get-ChildItem -LiteralPath $npxRoot -Directory) {
      $dshManifest = Join-Path $entry.FullName 'node_modules\@deepseek-ai\dsh\package.json'
      $layoutManifest = Join-Path $entry.FullName 'node_modules\@deepseek-ai\dsh-client-ui-layout\package.json'
      if (-not (Test-Path -LiteralPath $dshManifest -PathType Leaf) -or -not (Test-Path -LiteralPath $layoutManifest -PathType Leaf)) { continue }
      $dshVersion = (Get-Content -Raw -LiteralPath $dshManifest | ConvertFrom-Json).version
      $layoutVersion = (Get-Content -Raw -LiteralPath $layoutManifest | ConvertFrom-Json).version
      if ($dshVersion -eq $TestedDshVersion -and $layoutVersion -eq $TestedDshVersion) { $candidates += $entry.FullName }
    }
  }
  if ($candidates.Count -eq 1) { return $candidates[0] }
  if ($candidates.Count -gt 1) { throw "检测到多个 DSH $TestedDshVersion 安装。请用 -DshRoot 明确指定正在使用的安装根。" }
  throw "无法定位受支持的 DSH $TestedDshVersion。请用 -DshRoot 指定安装根。"
}

function Assert-Version([string]$Root) {
  $dshManifest = Join-Path $Root 'node_modules\@deepseek-ai\dsh\package.json'
  $layoutManifest = Join-Path $Root 'node_modules\@deepseek-ai\dsh-client-ui-layout\package.json'
  if (-not (Test-Path -LiteralPath $dshManifest -PathType Leaf) -or -not (Test-Path -LiteralPath $layoutManifest -PathType Leaf)) { throw "指定目录不是完整的 DSH 安装：$Root" }
  $dshVersion = (Get-Content -Raw -LiteralPath $dshManifest | ConvertFrom-Json).version
  $layoutVersion = (Get-Content -Raw -LiteralPath $layoutManifest | ConvertFrom-Json).version
  if ($dshVersion -ne $TestedDshVersion -or $layoutVersion -ne $TestedDshVersion) {
    throw "shell 补丁只支持 DSH/layout $TestedDshVersion；当前是 DSH $dshVersion / layout $layoutVersion。未修改任何文件。"
  }
}

function Target-Records([string]$Root) {
  $layoutLib = Join-Path $Root 'node_modules\@deepseek-ai\dsh-client-ui-layout\lib'
  return @(
    [pscustomobject]@{ Name = 'client.js'; Source = Join-Path $PatchDir 'client.js'; Target = Join-Path $layoutLib 'client.js' },
    [pscustomobject]@{ Name = 'index.d.ts'; Source = Join-Path $PatchDir 'index.d.ts'; Target = Join-Path $layoutLib 'types\client\index.d.ts' },
    [pscustomobject]@{ Name = 'service.d.ts'; Source = Join-Path $PatchDir 'service.d.ts'; Target = Join-Path $layoutLib 'types\client\service.d.ts' },
    [pscustomobject]@{ Name = 'stores.d.ts'; Source = Join-Path $PatchDir 'stores.d.ts'; Target = Join-Path $layoutLib 'types\client\stores.d.ts' },
    [pscustomobject]@{ Name = 'AppFrame.d.ts'; Source = Join-Path $PatchDir 'AppFrame.d.ts'; Target = Join-Path $layoutLib 'types\client\AppFrame.d.ts' }
  )
}

function File-Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant() }
function Move-Replace([string]$Source, [string]$Target) { [System.IO.File]::Move($Source, $Target, $true) }

function Restore-Backup([string]$BackupPath) {
  $backupRoot = (Resolve-Path -LiteralPath $BackupPath).Path
  $manifestPath = Join-Path $backupRoot 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "备份缺少 manifest.json：$backupRoot" }
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  $root = if (-not [string]::IsNullOrWhiteSpace($DshRoot)) { (Resolve-Path -LiteralPath $DshRoot).Path } else { [string]$manifest.root }
  Assert-Version $root
  $records = Target-Records $root
  foreach ($record in $records) {
    $item = @($manifest.files | Where-Object name -eq $record.Name)[0]
    if ($null -eq $item) { throw "备份 manifest 缺少 $($record.Name)。未修改任何文件。" }
    $currentHash = File-Hash $record.Target
    if ($currentHash -ne [string]$item.patchHash -and $currentHash -ne [string]$item.originalHash) { throw "$($record.Name) 已被其他修改覆盖；拒绝自动恢复。未修改任何文件。" }
    if ((File-Hash (Join-Path $backupRoot $record.Name)) -ne [string]$item.originalHash) { throw "$($record.Name) 的备份 hash 不匹配。未修改任何文件。" }
  }
  $staged = @()
  try {
    foreach ($record in $records) {
      $stage = "$($record.Target).trace-insight-restore-$([guid]::NewGuid().ToString('N')).tmp"
      Copy-Item -LiteralPath (Join-Path $backupRoot $record.Name) -Destination $stage
      $staged += [pscustomobject]@{ Record = $record; Stage = $stage }
    }
    foreach ($item in $staged) { Move-Replace $item.Stage $item.Record.Target }
  } catch {
    foreach ($record in $records) { if (Test-Path -LiteralPath $record.Source -PathType Leaf) { Copy-Item -LiteralPath $record.Source -Destination $record.Target -Force } }
    throw
  } finally {
    foreach ($item in $staged) { if (Test-Path -LiteralPath $item.Stage) { Remove-Item -LiteralPath $item.Stage -Force } }
  }
  Write-Host "已从完整备份恢复 shell 文件：$backupRoot" -ForegroundColor Green
}

if (-not [string]::IsNullOrWhiteSpace($RestoreBackup)) { Restore-Backup $RestoreBackup; exit 0 }

$root = Resolve-DshRoot
Assert-Version $root
$records = Target-Records $root
foreach ($record in $records) {
  if (-not (Test-Path -LiteralPath $record.Source -PathType Leaf)) { throw "补丁文件不存在：$($record.Source)" }
  if (-not (Test-Path -LiteralPath $record.Target -PathType Leaf)) { throw "目标文件不存在：$($record.Target)" }
  Add-Member -InputObject $record -NotePropertyName OriginalHash -NotePropertyValue $OriginalHashes[$record.Name]
  Add-Member -InputObject $record -NotePropertyName PatchHash -NotePropertyValue (File-Hash $record.Source)
  Add-Member -InputObject $record -NotePropertyName CurrentHash -NotePropertyValue (File-Hash $record.Target)
}

if (@($records | Where-Object { $_.CurrentHash -eq $_.PatchHash }).Count -eq $records.Count) { Write-Host "shell 补丁已经完整应用到 DSH $TestedDshVersion。" -ForegroundColor Green; exit 0 }
$unexpected = @($records | Where-Object { $_.CurrentHash -ne $_.OriginalHash })
if ($unexpected.Count -gt 0) {
  $names = ($unexpected | ForEach-Object Name) -join ', '
  throw "目标不是已验证的 DSH $TestedDshVersion 原文件（$names）。为避免覆盖其他修改，未写入任何文件。"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $root ".trace-insight-shell-backups\$stamp"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
$manifestFiles = @()
foreach ($record in $records) {
  Copy-Item -LiteralPath $record.Target -Destination (Join-Path $backupRoot $record.Name)
  $manifestFiles += [pscustomobject]@{ name = $record.Name; originalHash = $record.OriginalHash; patchHash = $record.PatchHash }
}
[pscustomobject]@{ schemaVersion = 1; root = $root; dshVersion = $TestedDshVersion; createdAt = (Get-Date).ToUniversalTime().ToString('o'); files = $manifestFiles } |
  ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $backupRoot 'manifest.json') -Encoding UTF8

$staged = @()
try {
  foreach ($record in $records) {
    $stage = "$($record.Target).trace-insight-$([guid]::NewGuid().ToString('N')).tmp"
    Copy-Item -LiteralPath $record.Source -Destination $stage
    if ((File-Hash $stage) -ne $record.PatchHash) { throw "补丁 staging hash 不匹配：$($record.Name)" }
    $staged += [pscustomobject]@{ Record = $record; Stage = $stage }
  }
  foreach ($item in $staged) { Move-Replace $item.Stage $item.Record.Target }
} catch {
  foreach ($record in $records) { Copy-Item -LiteralPath (Join-Path $backupRoot $record.Name) -Destination $record.Target -Force }
  throw
} finally {
  foreach ($item in $staged) { if (Test-Path -LiteralPath $item.Stage) { Remove-Item -LiteralPath $item.Stage -Force } }
}

Write-Host "shell 检查器补丁已安全应用到 DSH $TestedDshVersion。" -ForegroundColor Green
Write-Host "完整备份：$backupRoot" -ForegroundColor DarkGray
Write-Host "恢复命令：pwsh -File `"$($MyInvocation.MyCommand.Path)`" -DshRoot `"$root`" -RestoreBackup `"$backupRoot`"" -ForegroundColor DarkGray
