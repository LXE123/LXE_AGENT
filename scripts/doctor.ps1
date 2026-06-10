. (Join-Path $PSScriptRoot "_console_encoding.ps1")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$PythonVersion = "3.12.10"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Set-Location $ProjectRoot
$LauncherScript = Join-Path $ProjectRoot "scripts\launcher.ps1"

function Resolve-PowerShell {
    $command = Get-Command powershell -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "powershell is not available on PATH."
    }
    return $command.Source
}

if (Test-Path -LiteralPath $LauncherScript) {
    $launcherExit = Invoke-LxeNativeCommand -FilePath (Resolve-PowerShell) -Arguments @(
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $LauncherScript,
        "-ProjectRoot",
        $ProjectRoot
    )
    if ($launcherExit -ne 0) {
        throw "launcher setup failed with exit code $launcherExit."
    }
}

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

function Warn-LocalBusinessDataFile {
    param([Parameter(Mandatory = $true)][string]$RelativePath)
    $absolutePath = Join-Path $ProjectRoot $RelativePath
    if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
        Write-Warning "Optional local business data file missing: $RelativePath. FBA-related skills that use this file will be unavailable until it is copied from the internal business data package."
    }
}

function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )
    Write-Host "Checking: $Label"
    $exitCode = Invoke-LxeNativeCommand -FilePath $FilePath -Arguments $Arguments
    if ($exitCode -ne 0) {
        throw "$Label failed with exit code $exitCode."
    }
}

$uv = Resolve-Uv
$powershell = Resolve-PowerShell

Require-Path (Join-Path $ProjectRoot "pyproject.toml")
Require-Path (Join-Path $ProjectRoot "uv.lock")
Require-Path (Join-Path $ProjectRoot ".env.example")

Warn-LocalBusinessDataFile "data\customs_declaration\custom_declaration_documents.xlsx"
Warn-LocalBusinessDataFile "data\export_tax\export_tax_products.xlsx"
Warn-LocalBusinessDataFile "data\invoice_Template\invoice_Template.xlsx"

Invoke-NativeChecked "uv lock" $uv @("lock", "--check")
Invoke-NativeChecked "uv sync" $uv @("sync", "--frozen", "--all-groups", "--python", $PythonVersion, "--check")

Invoke-NativeChecked "Python version" $uv @(
    "run",
    "--frozen",
    "python",
    "-c",
    "import sys; assert sys.version.startswith('$PythonVersion'), sys.version; print(sys.version)"
)

Invoke-NativeChecked "critical imports" $uv @(
    "run",
    "--frozen",
    "python",
    "-c",
    "import psycopg, pandas, playwright; print('imports ok')"
)

$playwrightCheck = @'
from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    browser.close()

print("playwright chromium ok")
'@

Write-Host "Checking: Playwright Chromium"
$playwrightCheckPath = Join-Path ([System.IO.Path]::GetTempPath()) ("lxe-playwright-check-" + [Guid]::NewGuid().ToString("N") + ".py")
try {
    Set-Content -LiteralPath $playwrightCheckPath -Value $playwrightCheck -Encoding UTF8
    $playwrightExit = Invoke-LxeNativeCommand -FilePath $uv -Arguments @(
        "run",
        "--frozen",
        "python",
        $playwrightCheckPath
    )
    if ($playwrightExit -ne 0) {
        throw "Playwright Chromium check failed with exit code $playwrightExit."
    }
}
finally {
    if (Test-Path -LiteralPath $playwrightCheckPath) {
        Remove-Item -LiteralPath $playwrightCheckPath -Force -ErrorAction SilentlyContinue
    }
}

Invoke-NativeChecked "Dashboard UI" $powershell @(
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    (Join-Path $ProjectRoot "scripts\webui.ps1"),
    "-EnsureBuilt"
)

Write-Host "Doctor checks passed."
