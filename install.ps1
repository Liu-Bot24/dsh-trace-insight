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

$PluginVersion = '1.3.0'
$SupportedDshVersions = @('0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.1', '0.1.1-rc.2')
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$PatchCore = Join-Path $Here 'patches\shell-patch.mjs'
if ([string]::IsNullOrWhiteSpace($PackagePath)) {
  $PackagePath = Join-Path $Here "dsh-plugin-trace-insight-$PluginVersion.tgz"
}
$PackagePath = [System.IO.Path]::GetFullPath($PackagePath)

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
      FilePath = $pnpm.Source
      Prefix = @('dsh')
      Display = "pnpm dsh（$resolvedRoot）"
      WorkingDirectory = $resolvedRoot
    }
  }

  $dsh = Get-Command dsh -ErrorAction SilentlyContinue
  if ($null -eq $dsh) {
    throw '未找到全局 dsh。请先全局安装受支持的 DeepSeek Harness，再运行本安装程序。'
  }
  return [pscustomobject]@{
    FilePath = $dsh.Source
    Prefix = @()
    Display = "$($dsh.Source)"
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

if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) {
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if ($null -eq $npm) { throw '未找到 npm，无法生成 Trace Insight 安装包。' }
  Write-Step '生成 Trace Insight 安装包'
  Push-Location $Here
  try { $null = Invoke-Checked -FilePath $npm.Source -Arguments @('pack', '--ignore-scripts', '--silent') -Capture }
  finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) {
  throw "无法生成安装包：$PackagePath"
}

if (-not [string]::IsNullOrWhiteSpace($SourceRoot)) {
  $null = Ensure-Pnpm
}
$runner = Resolve-DshRunner
Write-Host "使用：$($runner.Display)" -ForegroundColor DarkGray

if (-not (Test-Path -LiteralPath $PatchCore -PathType Leaf)) {
  throw "缺少右侧栏安装组件：$PatchCore"
}
$versionOutput = Invoke-Dsh -Runner $runner -Arguments @('--version') -Capture
$versionText = ($versionOutput -join ' ').Trim()
if ($SupportedDshVersions -notcontains $versionText) {
  throw "当前 DSH 是 $versionText；支持的版本是 $($SupportedDshVersions -join '、')。"
}

if ([string]::IsNullOrWhiteSpace($DshRoot)) {
  if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
    $DshRoot = $runner.FilePath
  } else {
    throw '使用 -SourceRoot 时必须同时提供 -DshRoot。'
  }
}

$patchRootArguments = @()
if (-not [string]::IsNullOrWhiteSpace($DshRoot)) {
  $patchRootArguments = @('--dsh-root', [System.IO.Path]::GetFullPath($DshRoot))
}
$statusOutput = Invoke-Checked -FilePath $node.Source -Arguments (@($PatchCore, 'status') + $patchRootArguments + @('--json')) -Capture
$patchStatus = (($statusOutput -join [Environment]::NewLine) | ConvertFrom-Json)
if ($patchStatus.state -ne 'original' -and $patchStatus.state -ne 'patched') {
  throw '当前 DSH 壳层不是可安全安装的状态。'
}
$patchWasOriginal = $patchStatus.state -eq 'original'

Write-Step '安装右侧栏'
$null = Invoke-Checked -FilePath $node.Source -Arguments (@($PatchCore, 'apply') + $patchRootArguments + @('--json')) -Capture

try {
  Write-Step "安装到 DSH profile：$Profile"
  Invoke-Dsh -Runner $runner -Arguments @('plugin', '--profile', $Profile, 'add', $PackagePath)

  Write-Step '检查安装结果'
  $dump = Invoke-Dsh -Runner $runner -Arguments @('--profile', $Profile, '--dump-config') -Capture
  $dumpText = $dump -join [Environment]::NewLine
  if ($dumpText -notmatch 'dsh-plugin-trace-insight') {
    throw 'Trace Insight 没有进入 DSH web profile。'
  }
} catch {
  $installError = $_
  try { Invoke-Dsh -Runner $runner -Arguments @('plugin', '--profile', $Profile, 'remove', 'dsh-plugin-trace-insight') } catch {}
  if ($patchWasOriginal) {
    try { $null = Invoke-Checked -FilePath $node.Source -Arguments (@($PatchCore, 'restore-active') + $patchRootArguments + @('--json')) -Capture } catch {}
  }
  throw $installError
}
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
  Write-Host "`n插件已经安装，但检测到 DSH 正在运行。请关闭当前 DSH 终端并用原来的 dsh web 命令重新启动一次；客户端插件清单只在启动时扫描。" -ForegroundColor Yellow
} else {
  Write-Host "`n安装完成。重新运行 dsh web 后即可使用右侧 Trace Insight。" -ForegroundColor Green
}

Write-Host "`n卸载命令：powershell -ExecutionPolicy Bypass -File `"$(Join-Path $Here 'uninstall.ps1')`"" -ForegroundColor DarkGray
