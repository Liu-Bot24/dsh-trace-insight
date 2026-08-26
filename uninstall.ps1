[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$SourceRoot = '',
  [string]$DshRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$PatchCore = Join-Path $Here 'patches\shell-patch.mjs'
$PackageCore = Join-Path $Here 'scripts\managed-package.mjs'
$NpxFinder = Join-Path $Here 'scripts\find-npx-dsh.mjs'
$DshPackage = '@deepseek-ai/dsh'

function Test-DshRunning {
  try {
    $commandPattern = '(?i)(?:^|[\s"''])(?:(?:[^\s"'']*[\\/])?dsh(?:\.cmd)?|[^\s"'']*@deepseek-ai[\\/]dsh[\\/][^\s"'']+)(?=\s|["'']|$).*?(?:\sweb(?=\s|["'']|$)|--profile\s+web(?=\s|["'']|$))'
    $processes = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $_.CommandLine -and $_.CommandLine -match $commandPattern
    }
    if (@($processes).Count -gt 0) { return $true }
  } catch {}
  try {
    $listeners = Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction Stop
    if (@($listeners).Count -gt 0) { return $true }
  } catch {}
  return $false
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [switch]$Capture
  )
  if ($Capture) {
    $output = & $FilePath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      throw "命令失败（退出码 $exitCode）：$FilePath $($Arguments -join ' ')`n$($output -join [Environment]::NewLine)"
    }
    return @($output | ForEach-Object { $_.ToString() })
  }
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "命令失败（退出码 $LASTEXITCODE）：$FilePath $($Arguments -join ' ')"
  }
}

function Invoke-Dsh {
  param(
    [Parameter(Mandatory = $true)]$Runner,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [switch]$Capture
  )
  $allArguments = @($Runner.Prefix) + @($Arguments)
  if ($Runner.WorkingDirectory) {
    Push-Location $Runner.WorkingDirectory
    try {
      return Invoke-Checked -FilePath $Runner.FilePath -Arguments $allArguments -Capture:$Capture
    }
    finally {
      Pop-Location
    }
  }
  return Invoke-Checked -FilePath $Runner.FilePath -Arguments $allArguments -Capture:$Capture
}

function Ensure-Pnpm {
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($null -ne $pnpm) { return $pnpm.Source }

  $corepack = Get-Command corepack -ErrorAction SilentlyContinue
  if ($null -ne $corepack) {
    try {
      Invoke-Checked -FilePath $corepack.Source -Arguments @('enable')
      Invoke-Checked -FilePath $corepack.Source -Arguments @('prepare', 'pnpm@11.7.0', '--activate')
    } catch {
      Write-Host "Corepack 启用失败，将改用 npm 安装 pnpm：$($_.Exception.Message)" -ForegroundColor Yellow
    }
  }

  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($null -eq $pnpm) {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if ($null -eq $npm) {
      throw '未找到 pnpm、corepack 或 npm。请先安装 Node.js 22.19 或更高版本。'
    }
    Invoke-Checked -FilePath $npm.Source -Arguments @('install', '--global', 'pnpm@11.7.0')
  }

  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($null -eq $pnpm) {
    throw 'pnpm 安装完成后仍未进入 PATH。请关闭当前终端，重新打开后再次运行本脚本。'
  }
  return $pnpm.Source
}

if (-not (Test-Path -LiteralPath $PatchCore -PathType Leaf)) {
  throw "缺少右侧栏卸载组件：$PatchCore"
}
if (-not (Test-Path -LiteralPath $PackageCore -PathType Leaf)) {
  throw "缺少持久包卸载组件：$PackageCore"
}
if (Test-DshRunning) {
  throw 'DSH 正在运行。请先关闭 DSH，再重新运行卸载程序。'
}

$node = Get-Command node -ErrorAction Stop
$availableGlobalDsh = Get-Command dsh -ErrorAction SilentlyContinue
$availableNpx = Get-Command npx -ErrorAction SilentlyContinue
if ([string]::IsNullOrWhiteSpace($SourceRoot) -and $null -eq $availableGlobalDsh -and $null -eq $availableNpx) {
  throw '未找到全局 dsh 或 npx。'
}
$null = Ensure-Pnpm
$patchRootArguments = @()

if (-not [string]::IsNullOrWhiteSpace($SourceRoot)) {
  $resolvedRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
  $pnpm = Get-Command pnpm -ErrorAction Stop
  $runner = [pscustomobject]@{
    Kind = 'source'
    FilePath = $pnpm.Source
    Prefix = @('dsh')
    WorkingDirectory = $resolvedRoot
  }
  if ([string]::IsNullOrWhiteSpace($DshRoot)) {
    throw '使用 -SourceRoot 时必须同时提供 -DshRoot。'
  }
} else {
  $globalDsh = Get-Command dsh -ErrorAction SilentlyContinue
  if ($null -ne $globalDsh) {
    $runner = [pscustomobject]@{
      Kind = 'global'
      FilePath = $globalDsh.Source
      Prefix = @()
      WorkingDirectory = $null
    }
  } else {
    if (-not (Test-Path -LiteralPath $NpxFinder -PathType Leaf)) { throw "缺少 npx DSH 定位组件：$NpxFinder" }
    $npx = Get-Command npx -ErrorAction SilentlyContinue
    if ($null -eq $npx) { throw '未找到全局 dsh 或 npx。' }
    $runner = [pscustomobject]@{
      Kind = 'npx'
      FilePath = $npx.Source
      Prefix = @('--yes', "--package=$DshPackage", 'dsh')
      WorkingDirectory = $null
    }
  }
}

$versionText = ((Invoke-Dsh -Runner $runner -Arguments @('--version') -Capture) -join ' ').Trim()
if ($runner.Kind -eq 'npx' -and [string]::IsNullOrWhiteSpace($DshRoot)) {
  $rootOutput = Invoke-Checked -FilePath $runner.FilePath -Arguments @('--yes', "--package=$DshPackage", 'node', $NpxFinder, $versionText) -Capture
  $DshRoot = ($rootOutput -join [Environment]::NewLine).Trim()
  if ([string]::IsNullOrWhiteSpace($DshRoot)) { throw '无法定位当前 npx DSH。' }
  $env:DSH_PACKAGE_ROOT = $DshRoot
}
if (-not [string]::IsNullOrWhiteSpace($DshRoot)) {
  $patchRootArguments = @('--dsh-root', [System.IO.Path]::GetFullPath($DshRoot))
}

$restoreOutput = Invoke-Checked -FilePath $node.Source -Arguments (@($PatchCore, 'restore-all') + $patchRootArguments + @('--json')) -Capture
$restoreResult = (($restoreOutput -join [Environment]::NewLine) | ConvertFrom-Json)
$restoredRoots = @($restoreResult.installations | Where-Object { $_.state -eq 'restored' } | ForEach-Object { $_.dshRoot })
try {
  Invoke-Dsh -Runner $runner -Arguments @('plugin', '--profile', $Profile, 'remove', 'dsh-plugin-trace-insight')
} catch {
  $removeError = $_
  if ($restoredRoots.Count -gt 0) {
    $reapplyArguments = @($PatchCore, 'apply-all')
    foreach ($root in $restoredRoots) { $reapplyArguments += @('--dsh-root', $root) }
    $reapplyArguments += '--json'
    try {
      $null = Invoke-Checked -FilePath $node.Source -Arguments $reapplyArguments -Capture
    } catch {
      throw "卸载插件失败：$($removeError.Exception.Message)`n右侧栏回到卸载前状态也失败：$($_.Exception.Message)"
    }
  }
  throw $removeError
}
$null = Invoke-Checked -FilePath $node.Source -Arguments @($PackageCore, 'cleanup', '--profile', $Profile)
Write-Host 'Trace Insight 和右侧栏已卸载。请重启 DSH。' -ForegroundColor Green
