param(
    [switch]$Build,
    [switch]$CheckOnly,
    [switch]$EnsureBuilt
)

. (Join-Path $PSScriptRoot "_console_encoding.ps1")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$DashboardDir = Join-Path $ProjectRoot "web\agent-dashboard"
$DistIndexPath = Join-Path $DashboardDir "dist\index.html"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][scriptblock]$Command
    )
    Write-Host "Running: $Label"
    & $Command 2>&1 | ForEach-Object {
        Write-Host ([string]$_)
    }
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "$Label failed with exit code $exitCode."
    }
}

function Add-PathEntry {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    $parts = @($env:Path.Split([System.IO.Path]::PathSeparator) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    foreach ($part in $parts) {
        if ([string]::Equals($part.TrimEnd([char[]]"\/"), $Path.TrimEnd([char[]]"\/"), [StringComparison]::OrdinalIgnoreCase)) {
            return
        }
    }
    $env:Path = "$Path$([System.IO.Path]::PathSeparator)$env:Path"
}

function Get-CommandSource {
    param([Parameter(Mandatory = $true)][string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        return ""
    }
    return [string]$command.Source
}

function Find-NodePair {
    $nodePath = Get-CommandSource "node"
    $npmPath = Get-CommandSource "npm"

    $programFiles = [string]$env:ProgramFiles
    if ($programFiles) {
        $nodeDir = Join-Path $programFiles "nodejs"
        $nodeExe = Join-Path $nodeDir "node.exe"
        $npmCmd = Join-Path $nodeDir "npm.cmd"
        if ((-not $nodePath) -and (Test-Path -LiteralPath $nodeExe)) {
            Add-PathEntry $nodeDir
            $nodePath = $nodeExe
        }
        if (Test-Path -LiteralPath $npmCmd) {
            Add-PathEntry $nodeDir
            $npmPath = $npmCmd
        }
    }

    return @{
        Node = $nodePath
        Npm = $npmPath
    }
}

function Test-SupportedNodeVersion {
    param([Parameter(Mandatory = $true)][string]$VersionText)
    $safeText = [string]$VersionText
    $match = [regex]::Match($safeText.Trim(), '^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)')
    if (-not $match.Success) {
        return $false
    }
    $major = [int]$match.Groups["major"].Value
    $minor = [int]$match.Groups["minor"].Value
    if ($major -eq 20) {
        return $minor -ge 19
    }
    if ($major -eq 22) {
        return $minor -ge 12
    }
    return $major -gt 22
}

function Install-NodeLts {
    if ($env:OS -ne "Windows_NT") {
        throw "Automatic Node.js installation from webui.ps1 is only supported on Windows."
    }
    $winget = Get-CommandSource "winget"
    if (-not $winget) {
        throw "Node.js is missing or too old, and winget is not available. Install Node.js LTS from https://nodejs.org/ and rerun this script."
    }

    Invoke-Checked "Node.js LTS install" {
        & $winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements
    }

    Add-PathEntry (Join-Path $env:ProgramFiles "nodejs")
}

function Resolve-Node {
    param([Parameter(Mandatory = $true)][bool]$InstallIfMissing)

    $pair = Find-NodePair
    $nodePath = [string]$pair["Node"]
    $npmPath = [string]$pair["Npm"]

    if ($nodePath -and $npmPath) {
        $version = (& $nodePath --version).Trim()
        if ((Test-SupportedNodeVersion -VersionText $version)) {
            Write-Host "Using Node.js $version"
            Write-Host "Using npm: $npmPath"
            return @{
                Node = $nodePath
                Npm = $npmPath
                Version = $version
            }
        }
        Write-Host "Node.js $version is too old for Dashboard UI build."
    }
    else {
        Write-Host "Node.js or npm is not available."
    }

    if (-not $InstallIfMissing) {
        throw "Node.js 20.19+, 22.12+, or 23+ with npm is required for Dashboard UI."
    }

    Install-NodeLts

    $pair = Find-NodePair
    $nodePath = [string]$pair["Node"]
    $npmPath = [string]$pair["Npm"]
    if (-not $nodePath -or -not $npmPath) {
        throw "Node.js installation finished, but node/npm is still unavailable."
    }
    $version = (& $nodePath --version).Trim()
    if (-not (Test-SupportedNodeVersion -VersionText $version)) {
        throw "Installed Node.js version is not supported: $version"
    }

    Write-Host "Using Node.js $version"
    Write-Host "Using npm: $npmPath"
    return @{
        Node = $nodePath
        Npm = $npmPath
        Version = $version
    }
}

function Test-DashboardSource {
    if (-not (Test-Path -LiteralPath (Join-Path $DashboardDir "package.json"))) {
        throw "Dashboard package.json is missing: $DashboardDir"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $DashboardDir "package-lock.json"))) {
        throw "Dashboard package-lock.json is missing: $DashboardDir"
    }
}

function Test-DashboardDist {
    if (-not (Test-Path -LiteralPath $DistIndexPath)) {
        throw "Dashboard UI is not built: $DistIndexPath"
    }
}

function Get-ResolvedNpmPath {
    param([Parameter(Mandatory = $true)]$NodeResolution)

    if ($NodeResolution -is [array]) {
        if ($NodeResolution.Count -eq 1) {
            $NodeResolution = $NodeResolution[0]
        }
        else {
            throw "Failed to resolve Node/npm paths: command output leaked into the resolver result."
        }
    }
    if ($null -eq $NodeResolution -or -not ($NodeResolution -is [System.Collections.IDictionary])) {
        throw "Failed to resolve Node/npm paths: resolver returned an unexpected result."
    }
    if (-not $NodeResolution.Contains("Npm")) {
        throw "Failed to resolve Node/npm paths: npm path is missing."
    }

    $npmPath = [string]$NodeResolution["Npm"]
    if (-not $npmPath) {
        throw "Failed to resolve Node/npm paths: npm path is empty."
    }
    return $npmPath
}

function Build-Dashboard {
    $node = Resolve-Node -InstallIfMissing:($true)
    $npm = Get-ResolvedNpmPath -NodeResolution $node
    Test-DashboardSource

    $previousLocation = Get-Location
    try {
        Set-Location $DashboardDir
        Invoke-Checked "Dashboard npm ci" { & $npm ci }
        Invoke-Checked "Dashboard npm run build" { & $npm run build }
    }
    finally {
        Set-Location $previousLocation
    }

    Test-DashboardDist
    Write-Host "Dashboard UI build completed: $DistIndexPath"
}

function Check-Dashboard {
    Resolve-Node -InstallIfMissing:($false) | Out-Null
    Test-DashboardSource
    Test-DashboardDist
    Write-Host "Dashboard UI checks passed."
}

function Ensure-DashboardBuilt {
    if (Test-Path -LiteralPath $DistIndexPath) {
        Check-Dashboard
        return
    }

    Write-Host "Dashboard UI is not built. Building now: $DistIndexPath"
    Build-Dashboard
}

$selectedModeCount = @($Build, $CheckOnly, $EnsureBuilt | Where-Object { $_ }).Count
if ($selectedModeCount -gt 1) {
    throw "Choose only one Dashboard UI mode: -Build, -CheckOnly, or -EnsureBuilt."
}

if ($Build) {
    Build-Dashboard
}
elseif ($CheckOnly) {
    Check-Dashboard
}
elseif ($EnsureBuilt) {
    Ensure-DashboardBuilt
}
else {
    Build-Dashboard
}
