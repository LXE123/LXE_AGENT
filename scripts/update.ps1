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
    $localUv = Join-Path $HOME ".local\bin\uv.exe"
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

$status = & $git status --porcelain
if (-not [string]::IsNullOrWhiteSpace(($status -join ""))) {
    throw "Local changes detected. Commit or stash them before running LXE update."
}

Invoke-Checked "git pull" { & $git pull --ff-only }
Invoke-Checked "uv sync" { & $uv sync --frozen --all-groups --python $PythonVersion }
Invoke-Checked "Playwright Chromium install" { & $uv run --frozen python -m playwright install chromium }
Invoke-Checked "doctor" { powershell -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot "scripts\doctor.ps1") }

Write-Host "Update completed."
