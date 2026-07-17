param(
  [Parameter(Mandatory = $true)][string]$MsiPath,
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$ActivationPath,
  [Parameter(Mandatory = $true)][string]$ResultPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$securityModulePath = Join-Path $PSHOME "Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
Import-Module -Name $securityModulePath -Force -ErrorAction Stop
$TunnelName = "lxe-agent"
$WireGuardRoot = Join-Path $env:ProgramFiles "WireGuard"
$WireGuardExe = Join-Path $WireGuardRoot "wireguard.exe"
$ConfigurationRoot = Join-Path $WireGuardRoot "Data\Configurations"
$PlainConfiguration = Join-Path $ConfigurationRoot "$TunnelName.conf"
$SecureConfiguration = "$PlainConfiguration.dpapi"
$BackupConfiguration = "$SecureConfiguration.lxe-backup-$PID"
$managerWasInstalled = $false
$managerInstalledHere = $false
$existingTunnelWasInstalled = $false
$existingTunnelRemoved = $false
$tunnelInstalledHere = $false

function Write-Result([bool]$Ok, [string]$Message, [string]$Connection = "error") {
  $result = @{ ok = $Ok; message = $Message; tunnel = $TunnelName; connection = $Connection }
  $result | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultPath -Encoding UTF8
}

try {
  if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Version.Major -lt 10) {
    throw "Windows 10/11 x64 is required"
  }
  $requiresInstall = -not (Test-Path -LiteralPath $WireGuardExe)
  if (-not $requiresInstall) {
    $currentVersion = [version](Get-Item -LiteralPath $WireGuardExe).VersionInfo.ProductVersion
    $requiresInstall = $currentVersion -lt [version]"1.1.0"
  }
  if ($requiresInstall) {
    if (-not (Test-Path -LiteralPath $MsiPath)) {
      throw "Bundled WireGuard installer is missing"
    }
    $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $MsiPath
    if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch "WireGuard LLC") {
      throw "Bundled WireGuard installer signature is invalid"
    }
    $installer = Start-Process -FilePath "msiexec.exe" -ArgumentList @(
      "/i", "`"$MsiPath`"", "/qn", "DO_NOT_LAUNCH=1", "/norestart"
    ) -Wait -PassThru
    if ($installer.ExitCode -ne 0 -and $installer.ExitCode -ne 3010) {
      throw "WireGuard installation failed with exit code $($installer.ExitCode)"
    }
  }
  if (-not (Test-Path -LiteralPath $WireGuardExe)) {
    throw "WireGuard executable is missing after installation"
  }
  $installedVersion = [version](Get-Item -LiteralPath $WireGuardExe).VersionInfo.ProductVersion
  if ($installedVersion -lt [version]"1.1.0") {
    throw "Installed WireGuard version $installedVersion is older than 1.1.0"
  }

  $managerWasInstalled = $null -ne (Get-Service -Name "WireGuardManager" -ErrorAction SilentlyContinue)
  if (-not $managerWasInstalled) {
    & $WireGuardExe /installmanagerservice | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to start the WireGuard secure configuration service" }
    $managerInstalledHere = $true
  }
  New-Item -ItemType Directory -Path $ConfigurationRoot -Force | Out-Null
  if (Test-Path -LiteralPath $SecureConfiguration) {
    Copy-Item -LiteralPath $SecureConfiguration -Destination $BackupConfiguration -Force
  }
  Remove-Item -LiteralPath $PlainConfiguration -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $SecureConfiguration -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $ConfigPath -Destination $PlainConfiguration -Force

  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ((-not (Test-Path -LiteralPath $SecureConfiguration) -or (Test-Path -LiteralPath $PlainConfiguration))
    -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-Path -LiteralPath $SecureConfiguration) -or (Test-Path -LiteralPath $PlainConfiguration)) {
    throw "WireGuard did not secure the tunnel configuration"
  }

  $existingTunnel = Get-Service -Name "WireGuardTunnel`$$TunnelName" -ErrorAction SilentlyContinue
  $existingTunnelWasInstalled = $null -ne $existingTunnel
  if ($existingTunnelWasInstalled) {
    & $WireGuardExe /uninstalltunnelservice $TunnelName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to replace the existing WireGuard tunnel" }
    $existingTunnelRemoved = $true
  }
  & $WireGuardExe /installtunnelservice $SecureConfiguration | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to install the WireGuard tunnel service" }
  $tunnelInstalledHere = $true
  $service = Get-Service -Name "WireGuardTunnel`$$TunnelName" -ErrorAction Stop
  if ($service.Status -ne "Running") {
    Start-Service -Name $service.Name
    $service.WaitForStatus("Running", [TimeSpan]::FromSeconds(20))
  }

  $activation = Get-Content -LiteralPath $ActivationPath -Raw | ConvertFrom-Json
  $activationState = "offline"
  try {
    $activationUrl = $activation.url.TrimEnd("/") + "/api/v1/agent-data/devices/activate"
    $activationBody = @{
      machine_id = $activation.machine_id
      hostname = $activation.hostname
    } | ConvertTo-Json -Compress
    $invokeParameters = @{
      Uri = $activationUrl
      Method = "Post"
      Headers = @{ Authorization = "Bearer $($activation.api_token)" }
      ContentType = "application/json"
      Body = $activationBody
      TimeoutSec = 10
    }
    $response = Invoke-RestMethod @invokeParameters
    $activationState = "connected"
  } catch {
    $statusCode = 0
    if ($null -ne $_.Exception.Response) {
      $statusCode = [int]$_.Exception.Response.StatusCode
    }
    if ($statusCode -ge 400 -and $statusCode -lt 500) {
      if ($statusCode -eq 409) { throw "This device file is already bound to another computer" }
      throw "The cloud rejected this device credential (HTTP $statusCode)"
    }
  }
  if ($activationState -eq "connected" -and (
    $response.device_id -ne $activation.device_id -or
    $response.wireguard_ip -ne $activation.wireguard_ip -or
    $response.machine_id -ne $activation.machine_id
  )) {
    throw "The cloud returned a different device identity"
  }
  Write-Result $true "ok" $activationState
  exit 0
} catch {
  if ($tunnelInstalledHere) {
    & $WireGuardExe /uninstalltunnelservice $TunnelName | Out-Null
  }
  if (Test-Path -LiteralPath $BackupConfiguration) {
    Copy-Item -LiteralPath $BackupConfiguration -Destination $SecureConfiguration -Force
    if ($existingTunnelWasInstalled -and $existingTunnelRemoved) {
      & $WireGuardExe /installtunnelservice $SecureConfiguration | Out-Null
      if ($LASTEXITCODE -eq 0) {
        Start-Service -Name "WireGuardTunnel`$$TunnelName" -ErrorAction SilentlyContinue
      }
    }
  } else {
    Remove-Item -LiteralPath $SecureConfiguration -Force -ErrorAction SilentlyContinue
  }
  Write-Result $false $_.Exception.Message
  exit 1
} finally {
  if ($managerInstalledHere) {
    & $WireGuardExe /uninstallmanagerservice | Out-Null
  }
  Remove-Item -LiteralPath $ConfigPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $ActivationPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PlainConfiguration -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $BackupConfiguration -Force -ErrorAction SilentlyContinue
}
