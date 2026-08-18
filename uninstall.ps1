[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$SourceRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$PatchCore = Join-Path $Here 'patches\shell-patch.mjs'
$DshVersion = '0.1.0-rc.7'
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
$null = & $node.Source $PatchCore restore-active --json
if ($LASTEXITCODE -ne 0) { throw "右侧栏恢复失败，退出码：$LASTEXITCODE" }

if (-not [string]::IsNullOrWhiteSpace($SourceRoot)) {
  $resolvedRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
  $pnpm = Get-Command pnpm -ErrorAction Stop
  Push-Location $resolvedRoot
  try {
    & $pnpm.Source dsh plugin --profile $Profile remove dsh-plugin-trace-insight
  }
  finally {
    Pop-Location
  }
} else {
  $npx = Get-Command npx -ErrorAction Stop
  & $npx.Source --yes "@deepseek-ai/dsh@$DshVersion" plugin --profile $Profile remove dsh-plugin-trace-insight
}
if ($LASTEXITCODE -ne 0) { throw "卸载失败，退出码：$LASTEXITCODE" }
Write-Host 'Trace Insight 和右侧栏已卸载。请重启 DSH。' -ForegroundColor Green
