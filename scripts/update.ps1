$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$PythonVersion = "3.12.10"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Set-Location $ProjectRoot

function Resolve-Uv {
    $command = Get-Command uv -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }
    $localUv = Join-Path $env:USERPROFILE ".local\bin\uv.exe"
    if (Test-Path -LiteralPath $localUv) {
        $env:Path = "$(Split-Path -Parent $localUv);$env:Path"
        return $localUv
    }
    throw "uv is not available on PATH."
}

function Resolve-Git {
    $command = Get-Command git -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "git is required for LXE update."
    }
    return $command.Source
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][scriptblock]$Command
    )
    Write-Host "Running: $Label"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

$git = Resolve-Git
$uv = Resolve-Uv

Invoke-Checked "git repository check" { & $git rev-parse --is-inside-work-tree | Out-Null }
$topLevel = (& $git rev-parse --show-toplevel).Trim()
if (-not [string]::Equals([System.IO.Path]::GetFullPath($topLevel).TrimEnd("\"), $ProjectRoot.TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) {
    throw "update.ps1 must be run from the project repository root. Git root: $topLevel"
}

$trackedStatus = @(& $git status --porcelain --untracked-files=no)
if ($LASTEXITCODE -ne 0) {
    throw "git status failed with exit code $LASTEXITCODE."
}
if (-not [string]::IsNullOrWhiteSpace(($trackedStatus -join ""))) {
    Write-Host "Tracked local changes detected:"
    foreach ($line in $trackedStatus) {
        Write-Host "  $line"
    }
    throw "Tracked local changes detected. Commit or stash them before running LXE update."
}

$untrackedFiles = @(& $git ls-files --others --exclude-standard)
if ($LASTEXITCODE -ne 0) {
    throw "git ls-files failed with exit code $LASTEXITCODE."
}
if ($untrackedFiles.Count -gt 0) {
    Write-Host "Untracked files detected and ignored for update:"
    foreach ($path in $untrackedFiles) {
        Write-Host "  $path"
    }
}

Invoke-Checked "git pull" { & $git pull --ff-only }
Invoke-Checked "launcher setup" { powershell -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot "scripts\launcher.ps1") -ProjectRoot $ProjectRoot -UvPath $uv }
Invoke-Checked "uv sync" { & $uv sync --frozen --all-groups --python $PythonVersion }
Invoke-Checked "Playwright Chromium install" { & $uv run --frozen python -m playwright install chromium }
Invoke-Checked "Dashboard UI build" { powershell -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot "scripts\webui.ps1") -Build }
Invoke-Checked "doctor" { powershell -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot "scripts\doctor.ps1") }

Write-Host "Update completed."
