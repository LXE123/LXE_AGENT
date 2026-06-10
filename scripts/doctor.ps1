. (Join-Path $PSScriptRoot "_dependencies.ps1")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$PythonVersion = "3.12.10"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Set-Location $ProjectRoot

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

function Test-PathListContains {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([string]::IsNullOrWhiteSpace($env:Path)) {
        return $false
    }
    $separator = [System.IO.Path]::PathSeparator
    $target = (Resolve-FullPath $Path).TrimEnd([char[]]'\/')
    foreach ($part in $env:Path.Split($separator)) {
        if ([string]::IsNullOrWhiteSpace($part)) {
            continue
        }
        try {
            $normalizedPart = (Resolve-FullPath $part).TrimEnd([char[]]'\/')
        }
        catch {
            $normalizedPart = $part.Trim().TrimEnd([char[]]'\/')
        }
        if ([string]::Equals($normalizedPart, $target, [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Warn-LauncherStatus {
    $userHome = Get-LxeUserHome
    if ([string]::IsNullOrWhiteSpace($userHome)) {
        Write-Warning "Could not resolve user home; skipping LXE launcher status warning."
        return
    }
    $launcherDir = Join-Path $userHome ".lxe\bin"
    $launcherPath = Join-Path $launcherDir "LXE.cmd"
    if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
        Write-Warning "LXE launcher is not installed: $launcherPath. Run scripts\launcher.ps1 from the project root to repair it."
        return
    }
    if (-not (Test-PathListContains -Path $launcherDir)) {
        Write-Warning "LXE launcher directory is not on the current PATH: $launcherDir. Run scripts\launcher.ps1 or open a new terminal after installation."
    }
}

function Write-ProbeLines {
    param([object[]]$Lines)
    $warningPrefix = "WARN`t"
    foreach ($line in $Lines) {
        $text = [string]$line
        if ($text.StartsWith($warningPrefix, [StringComparison]::Ordinal)) {
            Write-Warning $text.Substring($warningPrefix.Length)
        }
        elseif (-not [string]::IsNullOrWhiteSpace($text)) {
            Write-Host $text
        }
    }
}

function Invoke-RuntimeWarningProbe {
    param([Parameter(Mandatory = $true)][string]$UvPath)

    $runtimeCheck = @'
from pathlib import Path


def warn(message: str) -> None:
    print("WARN\t" + str(message))


root = Path.cwd()

if not (root / ".env").is_file():
    warn("Optional .env is missing; runtime will rely on system environment variables. LXE start may fail if required values are not configured.")

try:
    from platforms.feishu.config import feishu_missing_required_config

    missing = feishu_missing_required_config()
    if missing:
        warn("Feishu runtime config missing: " + ", ".join(missing) + ". LXE start will fail until these values are configured.")
except Exception as exc:
    warn(f"Could not inspect Feishu runtime config: {exc}")

try:
    from shared.llm.agent_planner import active_agent_planner_descriptor

    try:
        active_agent_planner_descriptor()
    except Exception as exc:
        warn(f"Agent LLM runtime config warning: {exc}")
except Exception as exc:
    warn(f"Could not inspect agent LLM runtime config: {exc}")

try:
    from services.mabang import config as mabang_config

    missing = [
        name
        for name in ("MABANG_ACCOUNT", "MABANG_PASSWORD")
        if not str(getattr(mabang_config, name, "") or "").strip()
    ]
    if missing:
        warn("Mabang runtime config missing: " + ", ".join(missing) + ". Mabang ERP auth features may fail until configured.")
except Exception as exc:
    warn(f"Could not inspect Mabang runtime config: {exc}")

try:
    from services.browser.store import ziniao_config

    missing = [
        name
        for name in ("ZINIAO_COMPANY", "ZINIAO_USERNAME", "ZINIAO_PASSWORD")
        if not str(getattr(ziniao_config, name, "") or "").strip()
    ]
    if missing:
        warn("Ziniao runtime config missing: " + ", ".join(missing) + ". Ziniao browser features may fail until configured.")

    for name in ("ZINIAO_CLIENT_PATH", "ZINIAO_WEBDRIVER_PATH"):
        value = str(getattr(ziniao_config, name, "") or "").strip()
        if value and not Path(value).expanduser().exists():
            warn(f"{name} points to a missing path: {value}")
except Exception as exc:
    warn(f"Could not inspect Ziniao runtime config: {exc}")
'@

    Write-Host "Checking: runtime configuration warnings"
    $runtimeCheckPath = Join-Path ([System.IO.Path]::GetTempPath()) ("lxe-runtime-warning-check-" + [Guid]::NewGuid().ToString("N") + ".py")
    try {
        Set-Content -LiteralPath $runtimeCheckPath -Value $runtimeCheck -Encoding UTF8
        $probeLines = @(& $UvPath run --frozen python $runtimeCheckPath 2>&1)
        $probeExit = $LASTEXITCODE
        Write-ProbeLines -Lines $probeLines
        if ($probeExit -ne 0) {
            Write-Warning "Runtime configuration warning probe failed with exit code $probeExit."
        }
    }
    finally {
        if (Test-Path -LiteralPath $runtimeCheckPath) {
            Remove-Item -LiteralPath $runtimeCheckPath -Force -ErrorAction SilentlyContinue
        }
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
Warn-LauncherStatus

Invoke-NativeChecked -Label "uv lock" -FilePath $uv -Arguments @("lock", "--check") -Verb "Checking"
Invoke-NativeChecked -Label "uv sync" -FilePath $uv -Arguments @("sync", "--frozen", "--all-groups", "--python", $PythonVersion, "--check") -Verb "Checking"

Invoke-NativeChecked -Label "Python version" -FilePath $uv -Arguments @(
    "run",
    "--frozen",
    "python",
    "-c",
    "import sys; assert sys.version.startswith('$PythonVersion'), sys.version; print(sys.version)"
) -Verb "Checking"

Invoke-NativeChecked -Label "critical imports" -FilePath $uv -Arguments @(
    "run",
    "--frozen",
    "python",
    "-c",
    "import psycopg, pandas, playwright; print('imports ok')"
) -Verb "Checking"

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

Invoke-NativeChecked -Label "Dashboard UI" -FilePath $powershell -Arguments @(
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    (Join-Path $ProjectRoot "scripts\webui.ps1"),
    "-CheckOnly"
) -Verb "Checking"

Invoke-RuntimeWarningProbe -UvPath $uv

Write-Host "Doctor checks passed."
