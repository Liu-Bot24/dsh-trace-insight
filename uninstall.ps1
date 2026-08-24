[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$SourceRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$PatchCore = Join-Path $Here 'patches\shell-patch.mjs'
$SupportedDshVersions = @('0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.1', '0.1.1-rc.2')

function Test-DshRunning {
  try {
    $processes = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $_.CommandLine -and $_.CommandLine -match '(?i)(?:dsh(?:\.cmd)?|@deepseek-ai/dsh).*?(?:\sweb(?:\s|$)|--profile\s+web)'
    }
    if (@($processes).Count -gt 0) { return $true }
  } catch {}
  try {
    $listeners = Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction Stop
    if (@($listeners).Count -gt 0) { return $true }
  } catch {}
  return $false
}

if (-not (Test-Path -LiteralPath $PatchCore -PathType Leaf)) {
  throw "缺少右侧栏卸载组件：$PatchCore"
}
if (Test-DshRunning) {
  throw 'DSH 正在运行。请先关闭 DSH，再重新运行卸载程序。'
}

$node = Get-Command node -ErrorAction Stop
$patchRootArguments = @()

if (-not [string]::IsNullOrWhiteSpace($SourceRoot)) {
  $resolvedRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
  $pnpm = Get-Command pnpm -ErrorAction Stop
  Push-Location $resolvedRoot
  try {
    $versionText = ((& $pnpm.Source dsh --version) -join ' ').Trim()
    if ($LASTEXITCODE -ne 0) { throw "无法读取 DSH 版本，退出码：$LASTEXITCODE" }
  }
  finally {
    Pop-Location
  }
} else {
  $dsh = Get-Command dsh -ErrorAction SilentlyContinue
  if ($null -eq $dsh) { throw '未找到全局 dsh。' }
  $versionText = ((& $dsh.Source --version) -join ' ').Trim()
  if ($LASTEXITCODE -ne 0) { throw "无法读取 DSH 版本，退出码：$LASTEXITCODE" }
  $patchRootArguments = @('--dsh-root', $dsh.Source)
}

if ($SupportedDshVersions -notcontains $versionText) {
  throw "当前 DSH 是 $versionText；支持的版本是 $($SupportedDshVersions -join '、')。"
}

$null = & $node.Source $PatchCore restore-active @patchRootArguments --json
if ($LASTEXITCODE -ne 0) { throw "右侧栏恢复失败，退出码：$LASTEXITCODE" }

if (-not [string]::IsNullOrWhiteSpace($SourceRoot)) {
  Push-Location $resolvedRoot
  try {
    & $pnpm.Source dsh plugin --profile $Profile remove dsh-plugin-trace-insight
  }
  finally {
    Pop-Location
  }
} else {
  & $dsh.Source plugin --profile $Profile remove dsh-plugin-trace-insight
}
if ($LASTEXITCODE -ne 0) { throw "卸载失败，退出码：$LASTEXITCODE" }
Write-Host 'Trace Insight 和右侧栏已卸载。请重启 DSH。' -ForegroundColor Green
