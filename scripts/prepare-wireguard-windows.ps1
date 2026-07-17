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
$securityModulePath = Join-Path $PSHOME "Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
Import-Module -Name $securityModulePath -Force -ErrorAction Stop

function Get-LxeFileSha256([string]$Path) {
    $stream = $null
    $sha256 = $null
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        if ($null -ne $sha256) { $sha256.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Test-LxeWireGuardMsi([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $actualHash = Get-LxeFileSha256 -Path $Path
    if ($actualHash -ne $WireGuardSha256) { return $false }
    $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $Path
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
