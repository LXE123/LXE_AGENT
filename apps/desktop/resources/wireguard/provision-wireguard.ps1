param(
  [Parameter(Mandatory = $true)][string]$MsiPath,
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$ActivationPath,
  [Parameter(Mandatory = $true)][string]$ResultPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
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
$originalConfigurationPresent = $false
$replacementCommitted = $false
$Stage = "validate_host"

function Write-Result(
  [bool]$Ok,
  [string]$Message,
  [string]$Connection = "error",
  [string]$FailedStage = ""
) {
  $result = @{ ok = $Ok; message = $Message; tunnel = $TunnelName; connection = $Connection }
  if (-not [string]::IsNullOrWhiteSpace($FailedStage)) {
    $result.failed_stage = $FailedStage
  }
  $result | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultPath -Encoding UTF8
}

function Test-WireGuardVersionSupported([string]$VersionText) {
  if ($VersionText -notmatch '^\s*(\d+)\.(\d+)') {
    return $false
  }
  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  return $major -gt 1 -or ($major -eq 1 -and $minor -ge 1)
}

try {
  if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Version.Major -lt 10) {
    throw "Windows 10/11 x64 is required"
  }
  $Stage = "inspect_installation"
  $requiresInstall = -not (Test-Path -LiteralPath $WireGuardExe)
  if (-not $requiresInstall) {
    $currentVersion = (Get-Item -LiteralPath $WireGuardExe).VersionInfo.ProductVersion
    $requiresInstall = -not (Test-WireGuardVersionSupported $currentVersion)
  }
  if ($requiresInstall) {
    $Stage = "install_wireguard"
    if (-not (Test-Path -LiteralPath $MsiPath)) {
      throw "Bundled WireGuard installer is missing"
    }
    $installer = Start-Process -FilePath "msiexec.exe" -ArgumentList @(
      "/i", "`"$MsiPath`"", "/qn", "DO_NOT_LAUNCH=1", "/norestart"
    ) -Wait -PassThru
    if ($installer.ExitCode -ne 0 -and $installer.ExitCode -ne 3010) {
      throw "WireGuard installation failed with exit code $($installer.ExitCode)"
    }
  }
  $Stage = "inspect_installation"
  if (-not (Test-Path -LiteralPath $WireGuardExe)) {
    throw "WireGuard executable is missing after installation"
  }
  $installedVersion = (Get-Item -LiteralPath $WireGuardExe).VersionInfo.ProductVersion
  if (-not (Test-WireGuardVersionSupported $installedVersion)) {
    throw "Installed WireGuard version $installedVersion is older than 1.1 or could not be parsed"
  }

  $Stage = "ensure_manager"
  $managerWasInstalled = $null -ne (Get-Service -Name "WireGuardManager" -ErrorAction SilentlyContinue)
  if (-not $managerWasInstalled) {
    & $WireGuardExe /installmanagerservice | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to start the WireGuard secure configuration service" }
    $managerInstalledHere = $true
  }
  $Stage = "prepare_replacement"
  New-Item -ItemType Directory -Path $ConfigurationRoot -Force | Out-Null
  $originalConfigurationPresent = Test-Path -LiteralPath $SecureConfiguration
  if ($originalConfigurationPresent) {
    # WireGuard deliberately denies administrators read access to .conf.dpapi files,
    # while granting the delete permission required to rename them in this directory.
    Move-Item -LiteralPath $SecureConfiguration -Destination $BackupConfiguration -Force
  }
  $existingTunnel = Get-Service -Name "WireGuardTunnel`$$TunnelName" -ErrorAction SilentlyContinue
  $existingTunnelWasInstalled = $null -ne $existingTunnel
  if ($existingTunnelWasInstalled) {
    & $WireGuardExe /uninstalltunnelservice $TunnelName | Out-Null
    $uninstallExitCode = $LASTEXITCODE
    $existingTunnelRemoved = $null -eq (Get-Service -Name "WireGuardTunnel`$$TunnelName" -ErrorAction SilentlyContinue)
    if ($uninstallExitCode -ne 0 -or -not $existingTunnelRemoved) {
      throw "Unable to replace the existing WireGuard tunnel"
    }
  }

  $Stage = "stage_configuration"
  Remove-Item -LiteralPath $PlainConfiguration -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $SecureConfiguration -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $ConfigPath -Destination $PlainConfiguration -Force

  $Stage = "secure_configuration"
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (((-not (Test-Path -LiteralPath $SecureConfiguration)) -or (Test-Path -LiteralPath $PlainConfiguration)) -and ([DateTime]::UtcNow -lt $deadline)) {
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-Path -LiteralPath $SecureConfiguration) -or (Test-Path -LiteralPath $PlainConfiguration)) {
    throw "WireGuard did not secure the tunnel configuration"
  }

  $Stage = "install_tunnel"
  & $WireGuardExe /installtunnelservice $SecureConfiguration | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to install the WireGuard tunnel service" }
  $tunnelInstalledHere = $true
  $Stage = "start_tunnel"
  $service = Get-Service -Name "WireGuardTunnel`$$TunnelName" -ErrorAction Stop
  if ($service.Status -ne "Running") {
    Start-Service -Name $service.Name
    $service.WaitForStatus("Running", [TimeSpan]::FromSeconds(20))
  }

  $Stage = "activate_device"
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
  $replacementCommitted = $true
  exit 0
} catch {
  $failedStage = $Stage
  $failureMessage = $_.Exception.Message
  if ($failureMessage.Length -gt 500) {
    $failureMessage = $failureMessage.Substring(0, 500)
  }
  Write-Result $false $failureMessage "error" $failedStage
  if ($tunnelInstalledHere) {
    & $WireGuardExe /uninstalltunnelservice $TunnelName | Out-Null
  }
  if (Test-Path -LiteralPath $BackupConfiguration) {
    Remove-Item -LiteralPath $SecureConfiguration -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $BackupConfiguration -Destination $SecureConfiguration -Force
    if ($existingTunnelWasInstalled -and $existingTunnelRemoved) {
      & $WireGuardExe /installtunnelservice $SecureConfiguration | Out-Null
      if ($LASTEXITCODE -eq 0) {
        Start-Service -Name "WireGuardTunnel`$$TunnelName" -ErrorAction SilentlyContinue
      }
    }
  } elseif (-not $originalConfigurationPresent) {
    Remove-Item -LiteralPath $SecureConfiguration -Force -ErrorAction SilentlyContinue
  }
  exit 1
} finally {
  if ($managerInstalledHere) {
    & $WireGuardExe /uninstallmanagerservice | Out-Null
  }
  Remove-Item -LiteralPath $ConfigPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $ActivationPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PlainConfiguration -Force -ErrorAction SilentlyContinue
  if ($replacementCommitted) {
    Remove-Item -LiteralPath $BackupConfiguration -Force -ErrorAction SilentlyContinue
  }
}
