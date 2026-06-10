param(
    [string]$RepoUrl = "https://github.com/LXE123/LXE_AGENT.git",
    [string]$Ref = "main",
    [string]$InstallDir = "",
    [switch]$NoPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$PythonVersion = "3.12.10"
$ProjectName = "lxe-agent"

function Resolve-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $expanded = [Environment]::ExpandEnvironmentVariables($Path)
    return [System.IO.Path]::GetFullPath($expanded)
}

function Invoke-PowerShellFile {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @()
    )

    $powershell = Get-Command powershell -ErrorAction SilentlyContinue
    if ($null -eq $powershell) {
        throw "powershell is not available."
    }

    & $powershell.Source -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments 2>&1 | ForEach-Object {
        Write-Host ([string]$_)
    }
    $exitCode = $LASTEXITCODE
    return $exitCode
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

    $localBin = Join-Path $env:USERPROFILE ".local\bin"
    $localUv = Join-Path $localBin "uv.exe"
    if (Test-Path -LiteralPath $localUv) {
        $env:Path = "$localBin;$env:Path"
        return $localUv
    }

    Write-Host "uv not found. Installing uv with the official installer..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $env:UV_INSTALL_DIR = $localBin

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lxe-uv-installer-" + [Guid]::NewGuid().ToString("N"))
    $uvInstaller = Join-Path $tempRoot "install-uv.ps1"
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    try {
        Invoke-WebRequest -Uri https://astral.sh/uv/install.ps1 -OutFile $uvInstaller
        $uvInstallExit = Invoke-PowerShellFile -ScriptPath $uvInstaller
        if ($uvInstallExit -ne 0) {
            throw "uv installer failed with exit code $uvInstallExit."
        }
    }
    finally {
        if (Test-Path -LiteralPath $tempRoot) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force
        }
    }

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
    }
}

function Invoke-LauncherSetup {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$UvPath
    )
    if ($NoPath) {
        $env:LXE_LAUNCHER_NO_PATH = "1"
    } else {
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
