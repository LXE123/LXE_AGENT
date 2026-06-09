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

function Require-Path {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Required path missing: $Path"
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][scriptblock]$Command
    )
    Write-Host "Checking: $Label"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

$uv = Resolve-Uv

Require-Path (Join-Path $ProjectRoot "pyproject.toml")
Require-Path (Join-Path $ProjectRoot "uv.lock")
Require-Path (Join-Path $ProjectRoot ".env.example")

Invoke-Checked "uv lock" { & $uv lock --check }
Invoke-Checked "uv sync" { & $uv sync --frozen --all-groups --python $PythonVersion --check }

Invoke-Checked "Python version" {
    & $uv run --frozen python -c "import sys; assert sys.version.startswith('$PythonVersion'), sys.version; print(sys.version)"
}

Invoke-Checked "critical imports" {
    & $uv run --frozen python -c "import psycopg, pandas, playwright; print('imports ok')"
}

$playwrightCheck = @'
from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    browser.close()

print("playwright chromium ok")
'@

Write-Host "Checking: Playwright Chromium"
$playwrightCheck | & $uv run --frozen python -
if ($LASTEXITCODE -ne 0) {
    throw "Playwright Chromium check failed with exit code $LASTEXITCODE."
}

Invoke-Checked "Dashboard UI" {
    powershell -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot "scripts\webui.ps1") -EnsureBuilt
}

Write-Host "Doctor checks passed."
