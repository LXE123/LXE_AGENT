[CmdletBinding()]
param(
    [string]$RuntimeRoot,
    [string]$CacheRoot,
    [switch]$Offline,
    [switch]$Force
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
$prepareParameters = @{}
if (-not [string]::IsNullOrWhiteSpace($RuntimeRoot)) { $prepareParameters.RuntimeRoot = $RuntimeRoot }
if (-not [string]::IsNullOrWhiteSpace($CacheRoot)) { $prepareParameters.CacheRoot = $CacheRoot }
if ($Offline) { $prepareParameters.Offline = $true }
if ($Force) { $prepareParameters.Force = $true }
& $prepareScript @prepareParameters

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

$bunCommand = Get-Command bun -ErrorAction SilentlyContinue
if ($null -eq $bunCommand) {
    throw "Bun 1.3.14 is required to build the Windows desktop package."
}
$bunVersion = (& $bunCommand.Source --version).Trim()
if ($LASTEXITCODE -ne 0 -or $bunVersion -ne "1.3.14") {
    throw "Bun 1.3.14 is required; found '$bunVersion' at $($bunCommand.Source)."
}

function Invoke-LxeDesktopBuildStep {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "==> $Label"
    & $bunCommand.Source @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

Push-Location $repositoryRoot
try {
    Invoke-LxeDesktopBuildStep -Label "Build frozen lxeskill" -Arguments @("run", "lxeskill:bundle")
    Invoke-LxeDesktopBuildStep -Label "Compile private agent-cli" -Arguments @("run", "agent-cli:compile")
    Invoke-LxeDesktopBuildStep -Label "Build Dashboard and Electron" -Arguments @("run", "desktop:build")
    Invoke-LxeDesktopBuildStep -Label "Stage desktop resources" -Arguments @("run", "desktop:resources")
    Invoke-LxeDesktopBuildStep -Label "Build NSIS installer" -Arguments @("run", "--cwd", "apps/desktop", "dist:win")
}
finally {
    Pop-Location
}
