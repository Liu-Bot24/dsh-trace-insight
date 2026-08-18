[CmdletBinding()]
param(
  [string]$DshRoot = '',
  [string]$RestoreBackup = '',
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Core = Join-Path $Here 'shell-patch.mjs'
if (-not (Test-Path -LiteralPath $Core -PathType Leaf)) {
  throw "跨平台 shell 补丁核心不存在：$Core"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 22.19.0 或更高版本是必需的。'
}

# A running npx DSH is the strongest Windows signal. Pass its installation
# root explicitly so the shared core never guesses between multiple caches.
if ([string]::IsNullOrWhiteSpace($DshRoot)) {
  $running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and $_.CommandLine -match '(?i)@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js' -and $_.CommandLine -match '(?i)\sweb(?:\s|$)'
  })
  $roots = @()
  foreach ($process in $running) {
    if ($process.CommandLine -match '"([^\"]*[/\\]@deepseek-ai[/\\]dsh[/\\]lib[/\\]bin\.js)"') {
      $binPath = [System.IO.Path]::GetFullPath($matches[1])
      $packageRoot = Split-Path -Parent (Split-Path -Parent $binPath)
      $nodeModulesRoot = Split-Path -Parent (Split-Path -Parent $packageRoot)
      $installRoot = Split-Path -Parent $nodeModulesRoot
      $roots += [System.IO.Path]::GetFullPath($installRoot)
    }
  }
  $roots = @($roots | Select-Object -Unique)
  if ($roots.Count -eq 1) { $DshRoot = $roots[0] }
  elseif ($roots.Count -gt 1) { throw '检测到多个正在运行的 DSH Web 安装；请用 -DshRoot 明确指定。' }
}

$arguments = @($Core)
if (-not [string]::IsNullOrWhiteSpace($RestoreBackup)) {
  $arguments += @('restore', $RestoreBackup)
} elseif ($Status) {
  $arguments += 'status'
} else {
  $arguments += 'apply'
}
if (-not [string]::IsNullOrWhiteSpace($DshRoot)) {
  $arguments += @('--dsh-root', $DshRoot)
}

& node @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
