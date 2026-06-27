param([switch]$SkipDws)

. (Join-Path $PSScriptRoot "_dependencies.ps1")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$PythonVersion = "3.12.10"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Set-Location $ProjectRoot

$git = Resolve-Git
$uv = Resolve-Uv
$powershell = Resolve-PowerShell

function Invoke-DwsSetup {
    if ($SkipDws) {
        Write-Host "Skipping DingTalk CLI dws setup because -SkipDws was provided."
        return
    }

    try {
        $dws = Resolve-Dws -InstallIfMissing
        Write-Host "Using dws: $dws"
        Write-LxeDwsStatusWarnings -DwsPath $dws -ProjectRoot $ProjectRoot
    }
    catch {
        Write-Warning "DingTalk CLI dws setup failed: $($_.Exception.Message)"
        Write-Warning "DingTalk CLI skills will be unavailable until dws is installed and authenticated with: dws auth login"
    }
}

Invoke-NativeChecked -Label "git repository check" -FilePath $git -Arguments @("rev-parse", "--is-inside-work-tree")
$topLevelResult = Invoke-LxeNativeCapture -FilePath $git -Arguments @("rev-parse", "--show-toplevel")
if ($topLevelResult.ExitCode -ne 0) {
    Write-LxeNativeResultOutput -Result $topLevelResult
    throw "git rev-parse --show-toplevel failed with exit code $($topLevelResult.ExitCode)."
}
foreach ($line in @($topLevelResult.Stderr)) {
    Write-Host $line
}
$topLevel = ($topLevelResult.Stdout -join "`n").Trim()
if (-not [string]::Equals([System.IO.Path]::GetFullPath($topLevel).TrimEnd("\"), $ProjectRoot.TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) {
    throw "update.ps1 must be run from the project repository root. Git root: $topLevel"
}

$trackedStatusResult = Invoke-LxeNativeCapture -FilePath $git -Arguments @("status", "--porcelain", "--untracked-files=no")
if ($trackedStatusResult.ExitCode -ne 0) {
    Write-LxeNativeResultOutput -Result $trackedStatusResult
    throw "git status failed with exit code $($trackedStatusResult.ExitCode)."
}
foreach ($line in @($trackedStatusResult.Stderr)) {
    Write-Host $line
}
$trackedStatus = @($trackedStatusResult.Stdout)
if (-not [string]::IsNullOrWhiteSpace(($trackedStatus -join ""))) {
    Write-Host "Tracked local changes detected:"
    foreach ($line in $trackedStatus) {
        Write-Host "  $line"
    }
    throw "Tracked local changes detected. Commit or stash them before running LXE update."
}

$untrackedFilesResult = Invoke-LxeNativeCapture -FilePath $git -Arguments @("ls-files", "--others", "--exclude-standard")
if ($untrackedFilesResult.ExitCode -ne 0) {
    Write-LxeNativeResultOutput -Result $untrackedFilesResult
    throw "git ls-files failed with exit code $($untrackedFilesResult.ExitCode)."
}
foreach ($line in @($untrackedFilesResult.Stderr)) {
    Write-Host $line
}
$untrackedFiles = @($untrackedFilesResult.Stdout)
if ($untrackedFiles.Count -gt 0) {
    Write-Host "Untracked files detected and ignored for update:"
    foreach ($path in $untrackedFiles) {
        Write-Host "  $path"
    }
}

Invoke-NativeChecked -Label "git pull" -FilePath $git -Arguments @("pull", "--ff-only")
Invoke-DwsSetup
Invoke-NativeChecked -Label "launcher setup" -FilePath $powershell -Arguments @(
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    (Join-Path $ProjectRoot "scripts\launcher.ps1"),
    "-ProjectRoot",
    $ProjectRoot,
    "-UvPath",
    $uv
)
Invoke-NativeChecked -Label "uv sync" -FilePath $uv -Arguments @("sync", "--frozen", "--all-groups", "--python", $PythonVersion)
Invoke-NativeChecked -Label "Playwright Chromium install" -FilePath $uv -Arguments @("run", "--frozen", "python", "-m", "playwright", "install", "chromium")
Invoke-NativeChecked -Label "Dashboard UI build" -FilePath $powershell -Arguments @(
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    (Join-Path $ProjectRoot "scripts\webui.ps1"),
    "-Build"
)
Invoke-NativeChecked -Label "doctor" -FilePath $powershell -Arguments @(
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    (Join-Path $ProjectRoot "scripts\doctor.ps1")
)

Write-Host "Update completed."
