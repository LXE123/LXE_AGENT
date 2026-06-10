param(
    [string]$RepoUrl = "https://github.com/LXE123/LXE_AGENT.git",
    [string]$Ref = "main",
    [string]$InstallDir = "",
    [switch]$NoPath,
    [switch]$AllowZipFallback
)

$ErrorActionPreference = "Stop"

function Get-RawGitHubFileUrl {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryUrl,
        [Parameter(Mandatory = $true)][string]$RepositoryRef,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $trimmed = $RepositoryUrl.Trim().TrimEnd([char[]]"/")
    if ($trimmed.EndsWith(".git")) {
        $trimmed = $trimmed.Substring(0, $trimmed.Length - 4)
    }

    $match = [regex]::Match($trimmed, "^https://github\.com/(?<owner>[^/]+)/(?<repo>[^/]+)$")
    if (-not $match.Success) {
        $match = [regex]::Match($trimmed, "^git@github\.com:(?<owner>[^/]+)/(?<repo>[^/]+)$")
    }
    if (-not $match.Success) {
        throw "Cannot resolve raw GitHub file URL from RepoUrl: $RepositoryUrl"
    }

    $owner = $match.Groups["owner"].Value
    $repo = $match.Groups["repo"].Value
    $path = $RelativePath.TrimStart([char[]]"\/")
    return "https://raw.githubusercontent.com/$owner/$repo/$RepositoryRef/$path"
}

$dependencyHelper = ""
$dependencyTempRoot = ""
if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    $candidate = Join-Path $PSScriptRoot "_dependencies.ps1"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $dependencyHelper = $candidate
    }
}
if (-not $dependencyHelper) {
    $dependencyTempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lxe-dependencies-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $dependencyTempRoot -Force | Out-Null
    $dependencyHelper = Join-Path $dependencyTempRoot "_dependencies.ps1"
    $dependencyUrl = Get-RawGitHubFileUrl -RepositoryUrl $RepoUrl -RepositoryRef $Ref -RelativePath "scripts/_dependencies.ps1"
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    }
    catch {
    }
    Invoke-WebRequest -Uri $dependencyUrl -OutFile $dependencyHelper
}
. $dependencyHelper
if ($dependencyTempRoot -and (Test-Path -LiteralPath $dependencyTempRoot)) {
    Remove-Item -LiteralPath $dependencyTempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Set-StrictMode -Version Latest

$PythonVersion = "3.12.10"
$ProjectName = "lxe-agent"

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

function Ensure-Python {
    param(
        [Parameter(Mandatory = $true)][string]$UvPath,
        [Parameter(Mandatory = $true)][string]$Version
    )

    $installExit = Invoke-LxeNativeCommand -FilePath $UvPath -Arguments @("python", "install", $Version)
    if ($installExit -eq 0) {
        return
    }

    Write-Host "uv python install failed with exit code $installExit. Checking whether Python $Version is already usable..."
    $probeExit = Invoke-LxeNativeCommand -FilePath $UvPath -Arguments @(
        "run",
        "--python",
        $Version,
        "--no-sync",
        "python",
        "-c",
        "import sys; assert sys.version.startswith('$Version'), sys.version; print(sys.version)"
    )
    if ($probeExit -ne 0) {
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
    param([string]$GitPath = "")

    $target = $InstallDir
    if ([string]::IsNullOrWhiteSpace($target)) {
        $target = Join-Path (Get-LxeUserHome) ".lxe_agent"
    }
    $target = Resolve-FullPath $target
    if (Test-Path -LiteralPath $target) {
        throw "Install directory already exists: $target. This installer does not support repeated installation. Delete it manually or run LXE update from the existing installation."
    }

    $parent = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    if (-not [string]::IsNullOrWhiteSpace($GitPath)) {
        Write-Host "Cloning $RepoUrl ($Ref) to $target..."
        $cloneExit = Invoke-LxeNativeCommand -FilePath $GitPath -Arguments @(
            "clone",
            "--branch",
            $Ref,
            "--single-branch",
            $RepoUrl,
            $target
        )
        if ($cloneExit -ne 0) {
            if (-not $AllowZipFallback) {
                throw "git clone failed with exit code $cloneExit."
            }
            Write-Warning "git clone failed with exit code $cloneExit. Falling back to source zip because -AllowZipFallback was provided."
            if (Test-Path -LiteralPath $target) {
                Remove-Item -LiteralPath $target -Recurse -Force
            }
        }
    }

    if (-not (Test-Path -LiteralPath $target)) {
        if (-not $AllowZipFallback) {
            throw "Git is required for installation so LXE update can work later. Install Git and rerun this script, or pass -AllowZipFallback for a non-updatable zip install."
        }
        $zipUrl = Get-ZipUrl -RepositoryUrl $RepoUrl -RepositoryRef $Ref
        Write-Warning "Installing from source zip. This installation will not support LXE update until it is replaced with a git clone."
        Write-Host "Downloading source zip: $zipUrl"
        Download-SourceZip -Destination $target -ZipUrl $zipUrl
    }

    if (-not (Test-LxeProjectRoot -Path $target)) {
        throw "Downloaded source is not a valid $ProjectName project: $target"
    }
    if (-not $AllowZipFallback -and -not (Test-Path -LiteralPath (Join-Path $target ".git"))) {
        throw "Installed source is not a git repository: $target"
    }
    return @{
        Path = $target
    }
}

function Invoke-LauncherSetup {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$UvPath
    )
    if ($NoPath) {
        $env:LXE_LAUNCHER_NO_PATH = "1"
    }
    else {
        $env:LXE_LAUNCHER_NO_PATH = "0"
    }
    $launcherArgs = @("-ProjectRoot", $ProjectRoot, "-UvPath", $UvPath)
    if ($NoPath) {
        $launcherArgs += "-NoPath"
    }
    $launcherExit = Invoke-PowerShellFile -ScriptPath (Join-Path $ProjectRoot "scripts\launcher.ps1") -Arguments $launcherArgs
    if ($launcherExit -ne 0) {
        throw "launcher setup failed with exit code $launcherExit."
    }
}

$git = ""
try {
    $git = Resolve-Git -InstallIfMissing
}
catch {
    if (-not $AllowZipFallback) {
        throw
    }
    Write-Warning "$($_.Exception.Message) Falling back to source zip because -AllowZipFallback was provided."
}

$uv = Resolve-Uv -InstallIfMissing
$project = Get-ProjectRoot -GitPath $git
$ProjectRoot = [string]$project["Path"]

Set-Location $ProjectRoot
Write-Host "Using uv: $uv"
if (-not [string]::IsNullOrWhiteSpace($git)) {
    Write-Host "Using git: $git"
}
Write-Host "Project root: $ProjectRoot"

Ensure-Python -UvPath $uv -Version $PythonVersion

Invoke-NativeChecked -Label "uv sync" -FilePath $uv -Arguments @("sync", "--frozen", "--all-groups", "--python", $PythonVersion)
Invoke-NativeChecked -Label "Playwright Chromium installation" -FilePath $uv -Arguments @("run", "--frozen", "python", "-m", "playwright", "install", "chromium")

$webuiExit = Invoke-PowerShellFile -ScriptPath (Join-Path $ProjectRoot "scripts\webui.ps1") -Arguments @("-Build")
if ($webuiExit -ne 0) {
    throw "Dashboard UI build failed with exit code $webuiExit."
}

Invoke-LauncherSetup -ProjectRoot $ProjectRoot -UvPath $uv

$doctorExit = Invoke-PowerShellFile -ScriptPath (Join-Path $ProjectRoot "scripts\doctor.ps1")
if ($doctorExit -ne 0) {
    throw "doctor.ps1 failed with exit code $doctorExit."
}

Write-Host "Install completed."
Write-Host "Start the agent with: LXE start"
