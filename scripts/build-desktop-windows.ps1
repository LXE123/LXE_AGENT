[CmdletBinding()]
param(
    [string]$RuntimeRoot,
    [string]$CacheRoot,
    [switch]$Offline,
    [switch]$Force,
    [ValidateSet("Nsis", "Unpacked")]
    [string]$PackageTarget = "Nsis"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$consoleEncodingHelper = Join-Path $PSScriptRoot "_console_encoding.ps1"
if (Test-Path -LiteralPath $consoleEncodingHelper -PathType Leaf) {
    . $consoleEncodingHelper
}

if ($env:OS -ne "Windows_NT" -or -not [Environment]::Is64BitProcess) {
    throw "The Windows desktop package must be built in a 64-bit PowerShell process on Windows x64."
}

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$prepareScript = Join-Path $PSScriptRoot "prepare-desktop-runtime.ps1"
$prepareWireGuardScript = Join-Path $PSScriptRoot "prepare-wireguard-windows.ps1"
$buildTimings = [System.Collections.Generic.List[object]]::new()

function Add-LxeDesktopBuildTiming {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][System.Diagnostics.Stopwatch]$Stopwatch
    )

    $Stopwatch.Stop()
    $elapsedSeconds = [Math]::Round($Stopwatch.Elapsed.TotalSeconds, 2)
    $script:buildTimings.Add([pscustomobject]@{
        Stage = $Label
        Seconds = $elapsedSeconds
    })
    Write-Host ("<== {0} completed in {1:N2}s" -f $Label, $elapsedSeconds)
}

function Invoke-LxeDesktopTimedAction {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][scriptblock]$Action
    )

    Write-Host "==> $Label"
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & $Action
    }
    finally {
        Add-LxeDesktopBuildTiming -Label $Label -Stopwatch $stopwatch
    }
}

function Write-LxeDesktopBuildTimingSummary {
    $totalSeconds = ($script:buildTimings | Measure-Object -Property Seconds -Sum).Sum
    Write-Host "==> Desktop $PackageTarget build timings"
    foreach ($timing in $script:buildTimings) {
        Write-Host ("    {0,-42} {1,8:N2}s" -f $timing.Stage, $timing.Seconds)
    }
    Write-Host ("    {0,-42} {1,8:N2}s" -f "Total", $totalSeconds)
}

$bunCommand = Get-Command bun -ErrorAction SilentlyContinue
if ($null -eq $bunCommand) {
    throw "Bun 1.3.14 is required to build the Windows desktop package."
}
$bunVersion = (& $bunCommand.Source --version).Trim()
if ($LASTEXITCODE -ne 0 -or $bunVersion -ne "1.3.14") {
    throw "Bun 1.3.14 is required; found '$bunVersion' at $($bunCommand.Source)."
}

Invoke-LxeDesktopTimedAction -Label "Validate electron-builder configuration" -Action {
    Push-Location $repositoryRoot
    try {
        & $bunCommand.Source run desktop:validate:config
        if ($LASTEXITCODE -ne 0) {
            throw "electron-builder configuration validation failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

$prepareParameters = @{}
if (-not [string]::IsNullOrWhiteSpace($RuntimeRoot)) { $prepareParameters.RuntimeRoot = $RuntimeRoot }
if (-not [string]::IsNullOrWhiteSpace($CacheRoot)) { $prepareParameters.CacheRoot = $CacheRoot }
if ($Offline) { $prepareParameters.Offline = $true }
if ($Force) { $prepareParameters.Force = $true }
Invoke-LxeDesktopTimedAction -Label "Prepare managed desktop runtime" -Action {
    & $prepareScript @prepareParameters
}

$descriptorPath = [Environment]::GetEnvironmentVariable("LXE_DESKTOP_RUNTIME_DESCRIPTOR")
if ([string]::IsNullOrWhiteSpace($descriptorPath)) {
    $descriptorPath = Join-Path $repositoryRoot "build\desktop-runtime-inputs.json"
}
else {
    $descriptorPath = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($descriptorPath))
}
$descriptor = Get-Content -LiteralPath $descriptorPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([int]$descriptor.schema_version -ne 1 -or [string]$descriptor.platform -ne "win32-x64") {
    throw "Desktop runtime descriptor is incompatible: $descriptorPath"
}

$runtimeEnvironment = @{
    LXE_DESKTOP_NODE_ROOT = [string]$descriptor.inputs.node_root
    LXE_DESKTOP_PYTHON_ROOT = [string]$descriptor.inputs.python_root
    LXE_DESKTOP_UV_PATH = [string]$descriptor.inputs.uv_path
    LXE_DESKTOP_RG_PATH = [string]$descriptor.inputs.rg_path
    LXE_DESKTOP_PLAYWRIGHT_ROOT = [string]$descriptor.inputs.playwright_root
}
foreach ($entry in $runtimeEnvironment.GetEnumerator()) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($entry.Key))) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
    }
}

$effectiveNodeRoot = [Environment]::GetEnvironmentVariable("LXE_DESKTOP_NODE_ROOT")
$effectivePythonRoot = [Environment]::GetEnvironmentVariable("LXE_DESKTOP_PYTHON_ROOT")
$effectiveUvPath = [Environment]::GetEnvironmentVariable("LXE_DESKTOP_UV_PATH")
$effectiveRipgrepPath = [Environment]::GetEnvironmentVariable("LXE_DESKTOP_RG_PATH")
$effectivePlaywrightRoot = [Environment]::GetEnvironmentVariable("LXE_DESKTOP_PLAYWRIGHT_ROOT")
foreach ($requiredPath in @(
    $effectiveNodeRoot,
    $effectivePythonRoot,
    $effectiveUvPath,
    $effectiveRipgrepPath,
    $effectivePlaywrightRoot
)) {
    if ([string]::IsNullOrWhiteSpace($requiredPath) -or -not (Test-Path -LiteralPath $requiredPath)) {
        throw "Desktop runtime build input is missing: $requiredPath"
    }
}

$managedPath = @(
    $effectiveNodeRoot,
    $effectivePythonRoot,
    (Join-Path $effectivePythonRoot "Scripts"),
    (Split-Path -Parent $effectiveUvPath),
    (Split-Path -Parent $effectiveRipgrepPath),
    (Join-Path $effectiveNodeRoot "node_modules\.bin"),
    [string]$env:Path
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
$env:Path = $managedPath -join [System.IO.Path]::PathSeparator
$env:UV_PYTHON = Join-Path $effectivePythonRoot "python.exe"
$env:UV_PYTHON_DOWNLOADS = "never"
$env:PLAYWRIGHT_BROWSERS_PATH = $effectivePlaywrightRoot

$configuredCacheRoot = $CacheRoot
if ([string]::IsNullOrWhiteSpace($configuredCacheRoot)) {
    $configuredCacheRoot = [Environment]::GetEnvironmentVariable("LXE_DESKTOP_CACHE_ROOT")
}
if ([string]::IsNullOrWhiteSpace($configuredCacheRoot)) {
    $configuredCacheRoot = Join-Path $repositoryRoot "build\desktop-runtime-cache\win32-x64"
}
$effectiveCacheRoot = [System.IO.Path]::GetFullPath(
    [Environment]::ExpandEnvironmentVariables($configuredCacheRoot)
)
$env:UV_CACHE_DIR = Join-Path $effectiveCacheRoot "uv-cache"
$env:UV_OFFLINE = if ($Offline) { "1" } else { "0" }
New-Item -ItemType Directory -Path $env:UV_CACHE_DIR -Force | Out-Null

$wireGuardParameters = @{ CacheRoot = $effectiveCacheRoot }
if ($Offline) { $wireGuardParameters.Offline = $true }
if ($Force) { $wireGuardParameters.Force = $true }
Invoke-LxeDesktopTimedAction -Label "Prepare WireGuard resources" -Action {
    & $prepareWireGuardScript @wireGuardParameters
}

$wheelRoot = Join-Path $repositoryRoot "build\desktop-wheel"
if (Test-Path -LiteralPath $wheelRoot) {
    Remove-Item -LiteralPath $wheelRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $wheelRoot -Force | Out-Null

function Invoke-LxeDesktopBuildStep {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Invoke-LxeDesktopTimedAction -Label $Label -Action {
        & $bunCommand.Source @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Label failed with exit code $LASTEXITCODE."
        }
    }
}

function Build-LxeDesktopProjectWheel {
    $arguments = @(
        "build",
        "--wheel",
        "--out-dir",
        $wheelRoot,
        "--clear",
        "--no-create-gitignore",
        "--python",
        $env:UV_PYTHON
    )
    if ($Offline) {
        $arguments = @("--offline") + $arguments
    }
    & $effectiveUvPath @arguments
    if ($LASTEXITCODE -ne 0) {
        $mode = if ($Offline) { "offline; ensure the persistent uv cache contains the build backend" } else { "online" }
        throw "LXE project wheel build failed in $mode mode with exit code $LASTEXITCODE."
    }

    $wheels = @(Get-ChildItem -LiteralPath $wheelRoot -File -Filter "lxe_agent-*.whl")
    if ($wheels.Count -ne 1) {
        throw "Expected exactly one LXE project wheel in $wheelRoot; found $($wheels.Count)."
    }
    $env:LXE_DESKTOP_PROJECT_WHEEL = $wheels[0].FullName
}

Push-Location $repositoryRoot
try {
    Invoke-LxeDesktopTimedAction -Label "Build current LXE project wheel" -Action {
        Build-LxeDesktopProjectWheel
    }
    Invoke-LxeDesktopBuildStep -Label "Compile private agent-cli" -Arguments @("run", "agent-cli:compile")
    Invoke-LxeDesktopBuildStep -Label "Build Dashboard and Electron" -Arguments @("run", "desktop:build")
    Invoke-LxeDesktopBuildStep -Label "Stage desktop resources" -Arguments @("run", "desktop:resources")

    if ($PackageTarget -eq "Unpacked") {
        $packageOutputRoot = Join-Path $repositoryRoot "dist\desktop-unpacked"
        if (Test-Path -LiteralPath $packageOutputRoot) {
            Remove-Item -LiteralPath $packageOutputRoot -Recurse -Force
        }
        Invoke-LxeDesktopBuildStep -Label "Build unpacked Electron application" -Arguments @(
            "run",
            "--cwd",
            "apps/desktop",
            "pack:win"
        )
        $packagedExecutable = Join-Path $packageOutputRoot "win-unpacked\LXE Agent.exe"
        $sizeReport = Join-Path $packageOutputRoot "desktop-resource-sizes.json"
        $unexpectedArtifacts = @(Get-ChildItem -LiteralPath $packageOutputRoot -File -ErrorAction SilentlyContinue | Where-Object {
            $_.Extension -in @(".exe", ".blockmap")
        })
        if ($unexpectedArtifacts.Count -gt 0) {
            throw "Unpacked build unexpectedly produced installer artifacts: $($unexpectedArtifacts.FullName -join ', ')"
        }
    }
    else {
        $packageOutputRoot = Join-Path $repositoryRoot "dist\desktop"
        if (Test-Path -LiteralPath $packageOutputRoot) {
            Remove-Item -LiteralPath $packageOutputRoot -Recurse -Force
        }
        Invoke-LxeDesktopBuildStep -Label "Build NSIS installer" -Arguments @(
            "run",
            "--cwd",
            "apps/desktop",
            "dist:win"
        )
        $packagedExecutable = Join-Path $packageOutputRoot "win-unpacked\LXE Agent.exe"
        $sizeReport = Join-Path $packageOutputRoot "desktop-resource-sizes.json"
    }

    if (-not (Test-Path -LiteralPath $packagedExecutable -PathType Leaf)) {
        throw "Packaged desktop executable is missing: $packagedExecutable"
    }
    Invoke-LxeDesktopBuildStep -Label "Audit packaged desktop resource scope" -Arguments @(
        "scripts/audit-packaged-desktop.ts",
        (Join-Path (Split-Path -Parent $packagedExecutable) "resources")
    )
    Invoke-LxeDesktopBuildStep -Label "Enforce desktop resource size budgets" -Arguments @(
        "scripts/report-desktop-resource-sizes.ts",
        (Split-Path -Parent $packagedExecutable),
        $sizeReport
    )
    Invoke-LxeDesktopBuildStep -Label "Smoke packaged Electron preload and IPC" -Arguments @(
        "apps/desktop/scripts/smoke-packaged-app.ts",
        $packagedExecutable
    )
    Invoke-LxeDesktopBuildStep -Label "Re-audit packaged desktop resources after smoke" -Arguments @(
        "scripts/audit-packaged-desktop.ts",
        (Join-Path (Split-Path -Parent $packagedExecutable) "resources")
    )
    Write-LxeDesktopBuildTimingSummary
}
finally {
    Pop-Location
}
