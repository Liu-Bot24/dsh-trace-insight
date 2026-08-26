[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$PackagePath = '',
  [string]$SourceRoot = '',
  [string]$DshRoot = '',
  [switch]$StartAfterInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PluginVersion = '1.3.3'
$DshPackage = '@deepseek-ai/dsh'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$PatchCore = Join-Path $Here 'patches\shell-patch.mjs'
$PackageCore = Join-Path $Here 'scripts\managed-package.mjs'
$NpxFinder = Join-Path $Here 'scripts\find-npx-dsh.mjs'
if (-not [string]::IsNullOrWhiteSpace($PackagePath)) {
  $PackagePath = [System.IO.Path]::GetFullPath($PackagePath)
}

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
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

function Ensure-Pnpm {
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($null -ne $pnpm) { return $pnpm.Source }

  Write-Step '未找到 pnpm，正在启用 pnpm 11.7.0'
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

function Resolve-DshRunner {
  if (-not [string]::IsNullOrWhiteSpace($SourceRoot)) {
    $resolvedRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
    $rootManifest = Join-Path $resolvedRoot 'package.json'
    if (-not (Test-Path -LiteralPath $rootManifest -PathType Leaf)) {
      throw "SourceRoot 不是有效的 DeepSeek Harness 源码根目录：$resolvedRoot"
    }
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($null -eq $pnpm) {
      throw '使用 -SourceRoot 需要 pnpm。请先安装 pnpm 11.7.0。'
    }
    return [pscustomobject]@{
      Kind = 'source'
      FilePath = $pnpm.Source
      Prefix = @('dsh')
      Display = "pnpm dsh（$resolvedRoot）"
      WorkingDirectory = $resolvedRoot
    }
  }

  $globalDsh = Get-Command dsh -ErrorAction SilentlyContinue
  if ($null -ne $globalDsh) {
    return [pscustomobject]@{
      Kind = 'global'
      FilePath = $globalDsh.Source
      Prefix = @()
      Display = $globalDsh.Source
      WorkingDirectory = $null
    }
  }

  $npx = Get-Command npx -ErrorAction SilentlyContinue
  if ($null -eq $npx) {
    throw '未找到 npx。请先安装 Node.js 22.19 或更高版本。'
  }
  return [pscustomobject]@{
    Kind = 'npx'
    FilePath = $npx.Source
    Prefix = @('--yes', "--package=$DshPackage", 'dsh')
    Display = "npx --yes --package=$DshPackage dsh"
    WorkingDirectory = $null
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

Write-Step '检查 Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
  throw '未找到 Node.js。DeepSeek Harness 需要 Node.js 22.19 或更高版本。'
}
$nodeVersionText = (& $node.Source --version).Trim().TrimStart('v')
try {
  $nodeVersion = [version]($nodeVersionText -replace '-.*$', '')
  if ($nodeVersion -lt [version]'22.19.0') {
    throw "当前 Node.js 是 $nodeVersionText；需要 22.19.0 或更高版本。"
  }
} catch [System.Management.Automation.RuntimeException] {
  throw
} catch {
  Write-Host "无法解析 Node.js 版本 $nodeVersionText，将继续尝试安装。" -ForegroundColor Yellow
}
Write-Host "Node.js $nodeVersionText" -ForegroundColor Green

if (Test-DshRunning) {
  throw 'DSH 正在运行。请先关闭 DSH，再重新运行安装程序。'
}

$availableGlobalDsh = Get-Command dsh -ErrorAction SilentlyContinue
$availableNpx = Get-Command npx -ErrorAction SilentlyContinue
if ([string]::IsNullOrWhiteSpace($SourceRoot) -and $null -eq $availableGlobalDsh -and $null -eq $availableNpx) {
  throw '未找到全局 dsh 或 npx。'
}
$null = Ensure-Pnpm
$runner = Resolve-DshRunner
Write-Host "使用：$($runner.Display)" -ForegroundColor DarkGray

if (-not (Test-Path -LiteralPath $PatchCore -PathType Leaf)) {
  throw "缺少右侧栏安装组件：$PatchCore"
}
if (-not (Test-Path -LiteralPath $PackageCore -PathType Leaf)) {
  throw "缺少持久包安装组件：$PackageCore"
}
if (-not (Test-Path -LiteralPath $NpxFinder -PathType Leaf) -and $runner.Kind -eq 'npx') {
  throw "缺少 npx DSH 定位组件：$NpxFinder"
}
$versionOutput = Invoke-Dsh -Runner $runner -Arguments @('--version') -Capture
$versionText = ($versionOutput -join ' ').Trim()

if ([string]::IsNullOrWhiteSpace($DshRoot)) {
  if ($runner.Kind -eq 'npx') {
    $rootOutput = Invoke-Checked -FilePath $runner.FilePath -Arguments @('--yes', "--package=$DshPackage", 'node', $NpxFinder, $versionText) -Capture
    $DshRoot = ($rootOutput -join [Environment]::NewLine).Trim()
    $env:DSH_PACKAGE_ROOT = $DshRoot
  } elseif ($runner.Kind -eq 'source') {
    throw '使用 -SourceRoot 时必须同时提供 -DshRoot。'
  }
}

$patchRootArguments = @()
if (-not [string]::IsNullOrWhiteSpace($DshRoot)) {
  $patchRootArguments = @('--dsh-root', [System.IO.Path]::GetFullPath($DshRoot))
}

$temporaryPackageDirectory = $null
try {
  if ([string]::IsNullOrWhiteSpace($PackagePath)) {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if ($null -eq $npm) { throw '未找到 npm，无法生成 Trace Insight 安装包。' }
    $temporaryPackageDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "trace-insight-pack-$([guid]::NewGuid().ToString('N'))"
    $null = New-Item -ItemType Directory -Path $temporaryPackageDirectory -Force
    Write-Step '生成 Trace Insight 安装包'
    Push-Location $Here
    try {
      $null = Invoke-Checked -FilePath $npm.Source -Arguments @('pack', '--ignore-scripts', '--silent', '--pack-destination', $temporaryPackageDirectory) -Capture
    }
    finally {
      Pop-Location
    }
    $PackagePath = Join-Path $temporaryPackageDirectory "dsh-plugin-trace-insight-$PluginVersion.tgz"
  }
  if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) {
    throw "无法生成安装包：$PackagePath"
  }
  $managedPackageOutput = Invoke-Checked -FilePath $node.Source -Arguments @($PackageCore, 'stage', '--source', $PackagePath, '--version', $PluginVersion) -Capture
  $managedPackagePath = ($managedPackageOutput -join [Environment]::NewLine).Trim()
  if ([string]::IsNullOrWhiteSpace($managedPackagePath)) { throw '持久插件包路径为空。' }
}
finally {
  if ($null -ne $temporaryPackageDirectory -and (Test-Path -LiteralPath $temporaryPackageDirectory)) {
    Remove-Item -LiteralPath $temporaryPackageDirectory -Recurse -Force
  }
}

$statusOutput = Invoke-Checked -FilePath $node.Source -Arguments (@($PatchCore, 'status-all') + $patchRootArguments + @('--json')) -Capture
$patchStatus = (($statusOutput -join [Environment]::NewLine) | ConvertFrom-Json)

Write-Step '安装右侧栏'
$applyOutput = Invoke-Checked -FilePath $node.Source -Arguments (@($PatchCore, 'apply-all') + $patchRootArguments + @('--json')) -Capture
$applyResult = (($applyOutput -join [Environment]::NewLine) | ConvertFrom-Json)
$newlyPatchedRoots = @($applyResult.installations | Where-Object { $_.previousState -eq 'original' } | ForEach-Object { $_.dshRoot })
$migrationOutput = Invoke-Checked -FilePath $node.Source -Arguments @($PackageCore, 'migrate', '--profile', $Profile, '--package', $managedPackagePath, '--json') -Capture
$migration = (($migrationOutput -join [Environment]::NewLine) | ConvertFrom-Json)
$pluginWasInstalled = $migration.state -ne 'profile-not-created' -and $migration.state -ne 'not-installed'

try {
  Write-Step "安装到 DSH profile：$Profile"
  Invoke-Dsh -Runner $runner -Arguments @('plugin', '--profile', $Profile, 'add', $managedPackagePath)

  Write-Step '检查安装结果'
  $dump = Invoke-Dsh -Runner $runner -Arguments @('--profile', $Profile, '--dump-config') -Capture
  $dumpText = $dump -join [Environment]::NewLine
  if ($dumpText -notmatch 'dsh-plugin-trace-insight') {
    throw 'Trace Insight 没有进入 DSH web profile。'
  }
} catch {
  $installError = $_
  $rollbackErrors = [System.Collections.Generic.List[string]]::new()
  if (-not $pluginWasInstalled) {
    try {
      Invoke-Dsh -Runner $runner -Arguments @('plugin', '--profile', $Profile, 'remove', 'dsh-plugin-trace-insight')
      $null = Invoke-Checked -FilePath $node.Source -Arguments @($PackageCore, 'cleanup', '--profile', $Profile) -Capture
    } catch {
      $rollbackErrors.Add("插件回滚失败：$($_.Exception.Message)")
    }
  }
  if (-not $pluginWasInstalled -and $newlyPatchedRoots.Count -gt 0) {
    try {
      $restoreArguments = @($PatchCore, 'restore-all')
      foreach ($root in $newlyPatchedRoots) { $restoreArguments += @('--dsh-root', $root) }
      $restoreArguments += '--json'
      $null = Invoke-Checked -FilePath $node.Source -Arguments $restoreArguments -Capture
    } catch {
      $rollbackErrors.Add("右侧栏回滚失败：$($_.Exception.Message)")
    }
  }
  if ($rollbackErrors.Count -gt 0) {
    throw "安装失败：$($installError.Exception.Message)`n$($rollbackErrors -join [Environment]::NewLine)"
  }
  throw $installError
}
$null = Invoke-Checked -FilePath $node.Source -Arguments @($PackageCore, 'finalize', '--profile', $Profile, '--package', $managedPackagePath) -Capture
Write-Host 'Trace Insight 和右侧栏已安装。' -ForegroundColor Green

$alreadyRunning = Test-DshRunning
if ($StartAfterInstall -and -not $alreadyRunning) {
  Write-Step '启动 DSH Web'
  $startArguments = @($runner.Prefix) + @('web')
  if ($runner.WorkingDirectory) {
    Start-Process -FilePath $runner.FilePath -ArgumentList $startArguments -WorkingDirectory $runner.WorkingDirectory | Out-Null
  } else {
    Start-Process -FilePath $runner.FilePath -ArgumentList $startArguments | Out-Null
  }
  Write-Host 'DSH 已在新窗口启动。打开会话后即可使用右侧 Trace Insight。' -ForegroundColor Green
} elseif ($alreadyRunning) {
  Write-Host "`n插件已经安装，但检测到 DSH 正在运行。请关闭当前 DSH 后重新启动一次；客户端插件清单只在启动时扫描。" -ForegroundColor Yellow
} else {
  Write-Host "`n安装完成。重新启动 DSH 后即可使用右侧 Trace Insight。" -ForegroundColor Green
}

Write-Host "`n卸载命令：powershell -ExecutionPolicy Bypass -File `"$(Join-Path $Here 'uninstall.ps1')`"" -ForegroundColor DarkGray
