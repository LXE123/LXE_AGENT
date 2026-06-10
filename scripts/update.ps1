. (Join-Path $PSScriptRoot "_dependencies.ps1")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$PythonVersion = "3.12.10"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Set-Location $ProjectRoot

$git = Resolve-Git
$uv = Resolve-Uv
$powershell = Resolve-PowerShell

Invoke-NativeChecked -Label "git repository check" -FilePath $git -Arguments @("rev-parse", "--is-inside-work-tree")
$topLevel = (& $git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "git rev-parse --show-toplevel failed with exit code $LASTEXITCODE."
}
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

Invoke-NativeChecked -Label "git pull" -FilePath $git -Arguments @("pull", "--ff-only")
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
