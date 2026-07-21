[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CacheRoot,
    [switch]$Offline,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$WireGuardUrl = "https://download.wireguard.com/windows-client/wireguard-amd64-1.1.msi"
$wireGuardRoot = Join-Path ([System.IO.Path]::GetFullPath($CacheRoot)) "wireguard"
$msiPath = Join-Path $wireGuardRoot "wireguard-amd64-1.1.msi"

New-Item -ItemType Directory -Path $wireGuardRoot -Force | Out-Null
if ($Force -and (Test-Path -LiteralPath $msiPath)) {
    Remove-Item -LiteralPath $msiPath -Force
}
if (-not (Test-Path -LiteralPath $msiPath -PathType Leaf)) {
    if ($Offline) {
        throw "Offline build requires the cached WireGuard 1.1 MSI at $msiPath"
    }
    $temporary = "$msiPath.download"
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    try {
        Invoke-WebRequest -Uri $WireGuardUrl -OutFile $temporary -UseBasicParsing
        Move-Item -LiteralPath $temporary -Destination $msiPath -Force
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}
[Environment]::SetEnvironmentVariable("LXE_DESKTOP_WIREGUARD_MSI", $msiPath, "Process")
Write-Host "Prepared WireGuard 1.1 MSI: $msiPath"
