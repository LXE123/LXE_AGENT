param(
    [switch]$Build,
    [switch]$CheckOnly,
    [switch]$EnsureBuilt
)

. (Join-Path $PSScriptRoot "_dependencies.ps1")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$BunVersion = "1.3.14"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$DashboardDir = Join-Path $ProjectRoot "apps\dashboard"
$DistIndexPath = Join-Path $DashboardDir "dist\index.html"

function Test-DashboardSource {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "package.json") -PathType Leaf)) {
        throw "Root package.json is missing: $ProjectRoot"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "bun.lock") -PathType Leaf)) {
        throw "Root bun.lock is missing: $ProjectRoot"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $DashboardDir "package.json") -PathType Leaf)) {
        throw "Dashboard package.json is missing: $DashboardDir"
    }
}

function Test-DashboardDist {
    if (-not (Test-Path -LiteralPath $DistIndexPath -PathType Leaf)) {
        throw "Dashboard UI is not built: $DistIndexPath"
    }
}

function Build-Dashboard {
    $bun = Resolve-Bun -Version $BunVersion -InstallIfMissing
    Write-Host "Using Bun ${BunVersion}: $bun"
    Test-DashboardSource

    $previousLocation = Get-Location
    try {
        Set-Location $ProjectRoot
        Invoke-NativeChecked -Label "Bun frozen workspace install" -FilePath $bun -Arguments @("install", "--frozen-lockfile")
        Invoke-NativeChecked -Label "Dashboard Bun build" -FilePath $bun -Arguments @("run", "dashboard:build")
    }
    finally {
        Set-Location $previousLocation
    }

    Test-DashboardDist
    Write-Host "Dashboard UI build completed: $DistIndexPath"
}

function Check-Dashboard {
    $bun = Resolve-Bun -Version $BunVersion
    Write-Host "Using Bun ${BunVersion}: $bun"
    Test-DashboardSource
    Test-DashboardDist
    Write-Host "Dashboard UI checks passed."
}

function Ensure-DashboardBuilt {
    if (Test-Path -LiteralPath $DistIndexPath -PathType Leaf) {
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
