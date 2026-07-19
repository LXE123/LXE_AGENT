param(
  [Parameter(Mandatory = $true)][string]$ResultPath,
  [switch]$Elevated
)

$ErrorActionPreference = "Stop"
$TunnelName = "lxe-agent"
$ServiceName = "WireGuardTunnel`$$TunnelName"
$WireGuardRoot = Join-Path $env:ProgramFiles "WireGuard"
$WireGuardExe = Join-Path $WireGuardRoot "wireguard.exe"
$ConfigurationRoot = Join-Path $WireGuardRoot "Data\Configurations"
$PlainConfiguration = Join-Path $ConfigurationRoot "$TunnelName.conf"
$SecureConfiguration = "$PlainConfiguration.dpapi"

function Write-Result([string]$Message) {
  $parent = Split-Path -Parent $ResultPath
  if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  [IO.File]::WriteAllText($ResultPath, $Message, [Text.Encoding]::UTF8)
}

try {
  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($null -eq $service -and
    -not (Test-Path -LiteralPath $PlainConfiguration) -and
    -not (Test-Path -LiteralPath $SecureConfiguration)) {
    Write-Result "ok"
    exit 0
  }

  if (-not $Elevated) {
    $arguments = @(
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", "`"$PSCommandPath`"", "-ResultPath", "`"$ResultPath`"", "-Elevated"
    )
    try {
      $process = Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -Verb RunAs -Wait -PassThru
    } catch {
      Write-Result "管理员授权失败或已取消：$($_.Exception.Message)"
      exit 1223
    }
    if ($process.ExitCode -ne 0 -and -not (Test-Path -LiteralPath $ResultPath)) {
      Write-Result "WireGuard 隧道清理失败，退出代码：$($process.ExitCode)"
    }
    exit $process.ExitCode
  }

  if ($null -ne $service) {
    if (-not (Test-Path -LiteralPath $WireGuardExe)) {
      throw "WireGuard executable is missing: $WireGuardExe"
    }
    & $WireGuardExe /uninstalltunnelservice $TunnelName | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "WireGuard tunnel removal failed with exit code $LASTEXITCODE"
    }
  }
  Remove-Item -LiteralPath $PlainConfiguration -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $SecureConfiguration -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $ConfigurationRoot -Filter "$TunnelName.conf.dpapi.lxe-backup-*" -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
  Write-Result "ok"
  exit 0
} catch {
  Write-Result $_.Exception.Message
  exit 1
}
