param(
    [string]$ProjectRoot = "",
    [string]$UvPath = "",
    [switch]$NoPath
)

. (Join-Path $PSScriptRoot "_console_encoding.ps1")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$NewLauncherDir = Join-Path $env:USERPROFILE ".lxe\bin"
$NewLauncherPath = Join-Path $NewLauncherDir "LXE.cmd"
$NewPowerShellLauncherPath = Join-Path $NewLauncherDir "LXE.launcher.ps1"
$LegacyPowerShellLauncherPath = Join-Path $NewLauncherDir "LXE.ps1"
$OldLauncherDir = Join-Path $env:USERPROFILE ".lxefba\bin"
$OldLauncherPath = Join-Path $OldLauncherDir "LXEFBA.cmd"

function Resolve-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $expanded = [Environment]::ExpandEnvironmentVariables($Path)
    return [System.IO.Path]::GetFullPath($expanded)
}

function Resolve-ProjectRoot {
    if (-not [string]::IsNullOrWhiteSpace($ProjectRoot)) {
        return Resolve-FullPath $ProjectRoot
    }
    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
}

function Resolve-UvPath {
    if (-not [string]::IsNullOrWhiteSpace($UvPath)) {
        return Resolve-FullPath $UvPath
    }
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

function Normalize-PathForCompare {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }
    try {
        return (Resolve-FullPath $Path).TrimEnd([char[]]'\/')
    }
    catch {
        return $Path.Trim().TrimEnd([char[]]'\/')
    }
}

function Test-SamePath {
    param(
        [string]$Left,
        [string]$Right
    )
    return [string]::Equals(
        (Normalize-PathForCompare $Left),
        (Normalize-PathForCompare $Right),
        [StringComparison]::OrdinalIgnoreCase
    )
}

function ConvertTo-PowerShellSingleQuotedLiteral {
    param([AllowNull()][string]$Value)
    return "'" + ([string]$Value).Replace("'", "''") + "'"
}

function Write-Utf8BomFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Value
    )
    $utf8Bom = New-Object System.Text.UTF8Encoding -ArgumentList $true
    [System.IO.File]::WriteAllText($Path, $Value, $utf8Bom)
}

function Write-LxeLauncher {
    param(
        [Parameter(Mandatory = $true)][string]$ResolvedProjectRoot,
        [Parameter(Mandatory = $true)][string]$ResolvedUvPath
    )
    New-Item -ItemType Directory -Path $NewLauncherDir -Force | Out-Null
    $cmdContent = @"
@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0LXE.launcher.ps1" %*
exit /b %ERRORLEVEL%
"@
    $projectRootLiteral = ConvertTo-PowerShellSingleQuotedLiteral $ResolvedProjectRoot
    $uvPathLiteral = ConvertTo-PowerShellSingleQuotedLiteral $ResolvedUvPath
    $psContent = @"
`$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

`$LxeRoot = $projectRootLiteral
`$UvPath = $uvPathLiteral

function Exit-LxeNativeCommand {
    if (`$LASTEXITCODE -is [int]) {
        exit `$LASTEXITCODE
    }
    exit 1
}

function Invoke-LxeStart {
    Set-Location -LiteralPath `$LxeRoot
    & `$UvPath run --frozen python .\main.py
    Exit-LxeNativeCommand
}

function Invoke-LxeStop {
    Set-Location -LiteralPath `$LxeRoot
    & `$UvPath run --frozen python .\main.py stop
    Exit-LxeNativeCommand
}

function Invoke-LxeDoctor {
    Set-Location -LiteralPath `$LxeRoot
    & powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
    Exit-LxeNativeCommand
}

function Invoke-LxeUpdate {
    Set-Location -LiteralPath `$LxeRoot
    & powershell -ExecutionPolicy Bypass -File .\scripts\update.ps1
    Exit-LxeNativeCommand
}

`$Command = ""
if (`$args.Count -gt 0) {
    `$Command = [string]`$args[0]
}

switch (`$Command.ToLowerInvariant()) {
    "start" { Invoke-LxeStart }
    "stop" { Invoke-LxeStop }
    "doctor" { Invoke-LxeDoctor }
    "update" { Invoke-LxeUpdate }
    default {
        Write-Host "Usage: LXE <start|stop|doctor|update>"
        exit 2
    }
}
"@
    Set-Content -LiteralPath $NewLauncherPath -Value $cmdContent -Encoding ASCII
    Write-Utf8BomFile -Path $NewPowerShellLauncherPath -Value $psContent
    if (Test-Path -LiteralPath $LegacyPowerShellLauncherPath -PathType Leaf) {
        Remove-Item -LiteralPath $LegacyPowerShellLauncherPath -Force
    }
}

function Update-UserPath {
    $skipPathEnv = [string]($env:LXE_LAUNCHER_NO_PATH)
    if ($NoPath -or $skipPathEnv.Trim() -eq "1") {
        Write-Host "Skipping user PATH update."
        return
    }

    $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @()
    if (-not [string]::IsNullOrWhiteSpace($currentUserPath)) {
        $parts = $currentUserPath.Split(";") | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    }

    $filtered = @()
    $hasNew = $false
    foreach ($part in $parts) {
        if (Test-SamePath $part $OldLauncherDir) {
            continue
        }
        if (Test-SamePath $part $NewLauncherDir) {
            $hasNew = $true
        }
        $filtered += $part
    }
    if (-not $hasNew) {
        $filtered += $NewLauncherDir
    }
    $updatedUserPath = $filtered -join ";"
    if (-not [string]::Equals($updatedUserPath, $currentUserPath, [StringComparison]::Ordinal)) {
        [Environment]::SetEnvironmentVariable("Path", $updatedUserPath, "User")
    }

    $processParts = @($env:Path.Split(";") | Where-Object { -not (Test-SamePath $_ $OldLauncherDir) })
    if (-not ($processParts | Where-Object { Test-SamePath $_ $NewLauncherDir })) {
        $processParts = @($NewLauncherDir) + $processParts
    }
    $updatedProcessPath = $processParts -join ";"
    if (-not [string]::Equals($updatedProcessPath, $env:Path, [StringComparison]::Ordinal)) {
        $env:Path = $updatedProcessPath
    }
}

function Remove-OldLauncher {
    if (Test-Path -LiteralPath $OldLauncherPath) {
        try {
            Remove-Item -LiteralPath $OldLauncherPath -Force
            Write-Host "Removed old launcher: $OldLauncherPath"
        }
        catch {
            Write-Warning "Could not remove old launcher: $OldLauncherPath. $($_.Exception.Message)"
            return
        }
    }
    if (Test-Path -LiteralPath $OldLauncherDir) {
        try {
            $remaining = @(Get-ChildItem -LiteralPath $OldLauncherDir -Force -ErrorAction SilentlyContinue)
            if ($remaining.Count -eq 0) {
                Remove-Item -LiteralPath $OldLauncherDir -Force
            }
        }
        catch {
            Write-Warning "Could not remove old launcher directory: $OldLauncherDir. $($_.Exception.Message)"
        }
    }
}

function Repair-OriginRemote {
    param([Parameter(Mandatory = $true)][string]$ResolvedProjectRoot)
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($null -eq $git) {
        return
    }
    Push-Location $ResolvedProjectRoot
    try {
        $workTreeResult = Invoke-LxeNativeCapture -FilePath $git.Source -Arguments @("rev-parse", "--is-inside-work-tree")
        if ($workTreeResult.ExitCode -ne 0) {
            return
        }
        $originResult = Invoke-LxeNativeCapture -FilePath $git.Source -Arguments @("remote", "get-url", "origin")
        if ($originResult.ExitCode -ne 0) {
            return
        }
        $originUrl = ($originResult.Stdout -join "`n").Trim()
        if ([string]::IsNullOrWhiteSpace($originUrl)) {
            return
        }
        if ($originUrl -notmatch "LXE_AGENT_LOCAL_FBA") {
            return
        }
        $newUrl = $originUrl -replace "LXE_AGENT_LOCAL_FBA", "LXE_AGENT"
        $setUrlExit = Invoke-LxeNativeCommand -FilePath $git.Source -Arguments @("remote", "set-url", "origin", $newUrl)
        if ($setUrlExit -ne 0) {
            throw "git remote set-url failed with exit code $setUrlExit."
        }
        Write-Host "Updated origin remote: $newUrl"
    }
    finally {
        Pop-Location
    }
}

$resolvedProjectRoot = Resolve-ProjectRoot
$resolvedUvPath = Resolve-UvPath

Write-LxeLauncher -ResolvedProjectRoot $resolvedProjectRoot -ResolvedUvPath $resolvedUvPath
Update-UserPath
Remove-OldLauncher
Repair-OriginRemote -ResolvedProjectRoot $resolvedProjectRoot
Write-Host "LXE launcher ready: $NewLauncherPath"
