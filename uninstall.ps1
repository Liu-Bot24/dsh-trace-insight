[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$SourceRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

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
  $dsh = Get-Command dsh -ErrorAction SilentlyContinue
  if ($null -ne $dsh) {
    & $dsh.Source plugin --profile $Profile remove dsh-plugin-trace-insight
  } else {
    $npx = Get-Command npx -ErrorAction Stop
    & $npx.Source --yes '@deepseek-ai/dsh@0.1.0-rc.6' plugin --profile $Profile remove dsh-plugin-trace-insight
  }
}
if ($LASTEXITCODE -ne 0) { throw "卸载失败，退出码：$LASTEXITCODE" }
Write-Host '插件已从 profile 中移除。请重启 DSH。' -ForegroundColor Green
