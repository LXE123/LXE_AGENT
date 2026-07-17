[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CacheRoot,
    [switch]$Offline,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$WireGuardUrl = "https://download.wireguard.com/windows-client/wireguard-amd64-1.1.msi"
$WireGuardSha256 = "6daa5d37a9e2950dfb8c48b95ab8e562cb2bad1c785d020f38f97bea4c6a5566"
$wireGuardRoot = Join-Path ([System.IO.Path]::GetFullPath($CacheRoot)) "wireguard"
$msiPath = Join-Path $wireGuardRoot "wireguard-amd64-1.1.msi"

function Test-LxeWireGuardMsi([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $actualHash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $WireGuardSha256) { return $false }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    return $signature.Status -eq "Valid" -and $signature.SignerCertificate.Subject -match "WireGuard LLC"
}

New-Item -ItemType Directory -Path $wireGuardRoot -Force | Out-Null
if ($Force -and (Test-Path -LiteralPath $msiPath)) {
    Remove-Item -LiteralPath $msiPath -Force
}
if (-not (Test-LxeWireGuardMsi $msiPath)) {
    if ($Offline) {
        throw "Offline build requires the verified WireGuard 1.1 MSI at $msiPath"
    }
    $temporary = "$msiPath.download"
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    try {
        Invoke-WebRequest -Uri $WireGuardUrl -OutFile $temporary -UseBasicParsing
        if (-not (Test-LxeWireGuardMsi $temporary)) {
            throw "Downloaded WireGuard 1.1 MSI failed SHA-256 or Authenticode verification"
        }
        Move-Item -LiteralPath $temporary -Destination $msiPath -Force
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}
[Environment]::SetEnvironmentVariable("LXE_DESKTOP_WIREGUARD_MSI", $msiPath, "Process")
Write-Host "Verified WireGuard 1.1 MSI: $msiPath"
