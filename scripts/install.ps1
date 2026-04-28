param(
    [string]$RepoUrl = "https://github.com/LXE123/LXE_AGENT_LOCAL.git",
    [string]$Ref = "main",
    [string]$InstallDir = "",
    [switch]$NoPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$PythonVersion = "3.12.10"
$ProjectName = "lxe-agent"
$LauncherDir = Join-Path $env:USERPROFILE ".lxe\bin"
$LauncherPath = Join-Path $LauncherDir "LXE.cmd"
$InstallDirSpecified = $PSBoundParameters.ContainsKey("InstallDir")

function Resolve-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $expanded = [Environment]::ExpandEnvironmentVariables($Path)
    return [System.IO.Path]::GetFullPath($expanded)
}

function Test-LxeProjectRoot {
    param([Parameter(Mandatory = $true)][string]$Path)
    $pyproject = Join-Path $Path "pyproject.toml"
    $lockfile = Join-Path $Path "uv.lock"
    if (-not (Test-Path -LiteralPath $pyproject)) {
        return $false
    }
    if (-not (Test-Path -LiteralPath $lockfile)) {
        return $false
    }
    $content = Get-Content -LiteralPath $pyproject -Raw
    return $content -match 'name\s*=\s*"lxe-agent"'
}

function Resolve-Uv {
    $command = Get-Command uv -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }

    Write-Host "uv not found. Installing uv with the official installer..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression

    $localBin = Join-Path $HOME ".local\bin"
    if (Test-Path -LiteralPath $localBin) {
        $env:Path = "$localBin;$env:Path"
    }

    $command = Get-Command uv -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "uv installation finished, but uv is still not available on PATH."
    }
    return $command.Source
}

function Ensure-Python {
    param(
        [Parameter(Mandatory = $true)][string]$UvPath,
        [Parameter(Mandatory = $true)][string]$Version
    )

    & $UvPath python install $Version
    if ($LASTEXITCODE -eq 0) {
        return
    }

    $installExit = $LASTEXITCODE
    Write-Host "uv python install failed with exit code $installExit. Checking whether Python $Version is already usable..."
    & $UvPath run --python $Version --no-sync python -c "import sys; assert sys.version.startswith('$Version'), sys.version; print(sys.version)"
    if ($LASTEXITCODE -ne 0) {
        throw "uv python install failed with exit code $installExit, and Python $Version is not usable."
    }
}

function Get-ZipUrl {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryUrl,
        [Parameter(Mandatory = $true)][string]$RepositoryRef
    )
    $trimmed = $RepositoryUrl.TrimEnd("/")
    if ($trimmed.EndsWith(".git")) {
        $trimmed = $trimmed.Substring(0, $trimmed.Length - 4)
    }
    return "$trimmed/archive/refs/heads/$RepositoryRef.zip"
}

function Download-SourceZip {
    param(
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$ZipUrl
    )
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lxe-agent-" + [Guid]::NewGuid().ToString("N"))
    $zipPath = Join-Path $tempRoot "source.zip"
    $extractRoot = Join-Path $tempRoot "extract"
    New-Item -ItemType Directory -Path $tempRoot, $extractRoot -Force | Out-Null
    try {
        Invoke-WebRequest -Uri $ZipUrl -OutFile $zipPath
        Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot
        $sourceDir = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
        if ($null -eq $sourceDir) {
            throw "Downloaded zip did not contain a source directory."
        }
        Move-Item -LiteralPath $sourceDir.FullName -Destination $Destination
    }
    finally {
        if (Test-Path -LiteralPath $tempRoot) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force
        }
    }
}

function Get-ProjectRoot {
    $scriptProjectRoot = Resolve-FullPath (Join-Path $PSScriptRoot "..")
    if (-not $script:InstallDirSpecified -and (Test-LxeProjectRoot -Path $scriptProjectRoot)) {
        return @{
            Path = $scriptProjectRoot
            SourceAlreadyPresent = $true
        }
    }

    $target = $InstallDir
    if ([string]::IsNullOrWhiteSpace($target)) {
        $target = Join-Path $env:USERPROFILE ".lxe_agent"
    }
    $target = Resolve-FullPath $target
    if (Test-Path -LiteralPath $target) {
        throw "Install directory already exists: $target. This installer does not support repeated installation. Delete it manually and run again."
    }

    $parent = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($null -ne $git) {
        Write-Host "Cloning $RepoUrl ($Ref) to $target..."
        & $git.Source clone --branch $Ref --single-branch $RepoUrl $target
        if ($LASTEXITCODE -ne 0) {
            throw "git clone failed with exit code $LASTEXITCODE."
        }
    }
    else {
        $zipUrl = Get-ZipUrl -RepositoryUrl $RepoUrl -RepositoryRef $Ref
        Write-Host "git not found. Downloading source zip: $zipUrl"
        Download-SourceZip -Destination $target -ZipUrl $zipUrl
    }

    if (-not (Test-LxeProjectRoot -Path $target)) {
        throw "Downloaded source is not a valid $ProjectName project: $target"
    }
    return @{
        Path = $target
        SourceAlreadyPresent = $false
    }
}

function Write-Launcher {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    New-Item -ItemType Directory -Path $LauncherDir -Force | Out-Null
    $content = @"
@echo off
setlocal
set "LXE_ROOT=$ProjectRoot"

if /I "%~1"=="start" goto start
if /I "%~1"=="doctor" goto doctor
if /I "%~1"=="update" goto update

echo Usage: LXE ^<start^|doctor^|update^>
exit /b 2

:start
cd /d "%LXE_ROOT%" || exit /b 1
uv run --frozen python .\main.py
exit /b %ERRORLEVEL%

:doctor
cd /d "%LXE_ROOT%" || exit /b 1
powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
exit /b %ERRORLEVEL%

:update
cd /d "%LXE_ROOT%" || exit /b 1
powershell -ExecutionPolicy Bypass -File .\scripts\update.ps1
exit /b %ERRORLEVEL%
"@
    Set-Content -LiteralPath $LauncherPath -Value $content -Encoding ASCII
}

function Add-LauncherPath {
    if ($NoPath) {
        Write-Host "Skipping user PATH update because -NoPath was provided."
        return
    }

    $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @()
    if (-not [string]::IsNullOrWhiteSpace($currentUserPath)) {
        $parts = $currentUserPath.Split(";") | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    }
    $exists = $false
    foreach ($part in $parts) {
        if ([string]::Equals($part.TrimEnd("\"), $LauncherDir.TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) {
            $exists = $true
            break
        }
    }
    if (-not $exists) {
        $newPath = if ([string]::IsNullOrWhiteSpace($currentUserPath)) { $LauncherDir } else { "$currentUserPath;$LauncherDir" }
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    }
    if (-not ($env:Path.Split(";") | Where-Object { [string]::Equals($_.TrimEnd("\"), $LauncherDir.TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase) })) {
        $env:Path = "$LauncherDir;$env:Path"
    }
}

$uv = Resolve-Uv
$project = Get-ProjectRoot
$ProjectRoot = [string]$project["Path"]

Set-Location $ProjectRoot
Write-Host "Using uv: $uv"
Write-Host "Project root: $ProjectRoot"

Ensure-Python -UvPath $uv -Version $PythonVersion

& $uv sync --frozen --all-groups --python $PythonVersion
if ($LASTEXITCODE -ne 0) {
    throw "uv sync failed with exit code $LASTEXITCODE."
}

& $uv run --frozen python -m playwright install chromium
if ($LASTEXITCODE -ne 0) {
    throw "Playwright Chromium installation failed with exit code $LASTEXITCODE."
}

Write-Launcher -ProjectRoot $ProjectRoot
Add-LauncherPath

powershell -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot "scripts\doctor.ps1")
if ($LASTEXITCODE -ne 0) {
    throw "doctor.ps1 failed with exit code $LASTEXITCODE."
}

Write-Host "Install completed."
Write-Host "Start the agent with: LXE start"
