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
$LegacyBackupPrefix = "$TunnelName.conf.dpapi.lxe-backup-"
$managerWasInstalled = $false
$managerInstalledHere = $false
$existingTunnelWasInstalled = $false
$existingTunnelRemoved = $false
$tunnelInstalledHere = $false
$previousRemoved = $false
$previousRemovalStarted = $false
$Stage = "validate_host"

function Write-Result(
  [bool]$Ok,
  [string]$Message,
  [string]$Connection = "error",
  [string]$FailedStage = "",
  [bool]$PreviousRemoved = $false
) {
  $result = @{
    ok = $Ok
    message = $Message
    tunnel = $TunnelName
    connection = $Connection
    previous_removed = $PreviousRemoved
  }
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

function Assert-ManagedConfigurationPath([string]$Path, [bool]$AllowLegacyBackup) {
  $resolvedRoot = [IO.Path]::GetFullPath($ConfigurationRoot).TrimEnd('\')
  $resolvedPath = [IO.Path]::GetFullPath($Path)
  $parent = [IO.Path]::GetDirectoryName($resolvedPath).TrimEnd('\')
  $name = [IO.Path]::GetFileName($resolvedPath)
  if (-not $parent.Equals($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a configuration outside the WireGuard configuration directory"
  }
  $fixedName = $name.Equals("$TunnelName.conf", [StringComparison]::OrdinalIgnoreCase) -or
    $name.Equals("$TunnelName.conf.dpapi", [StringComparison]::OrdinalIgnoreCase)
  $legacyName = $AllowLegacyBackup -and
    $name.StartsWith($LegacyBackupPrefix, [StringComparison]::OrdinalIgnoreCase)
  if (-not $fixedName -and -not $legacyName) {
    throw "Refusing to modify an unmanaged WireGuard configuration"
  }
}

function Test-ManagedConfigurationPresent([string]$Path, [bool]$AllowLegacyBackup = $false) {
  Assert-ManagedConfigurationPath $Path $AllowLegacyBackup
  if (-not (Test-Path -LiteralPath $ConfigurationRoot -PathType Container)) {
    return $false
  }
  $name = [IO.Path]::GetFileName($Path)
  return @(
    Get-ChildItem -LiteralPath $ConfigurationRoot -Force -File -Name |
      Where-Object { $_.Equals($name, [StringComparison]::OrdinalIgnoreCase) }
  ).Count -gt 0
}

function Format-NativeDiagnostic([object[]]$Output) {
  $detail = (($Output | ForEach-Object { "$_" }) -join " ").Trim()
  if ($detail.Length -gt 300) {
    return $detail.Substring(0, 300)
  }
  return $detail
}

function Remove-ManagedConfiguration(
  [string]$Path,
  [bool]$AllowAclRepair,
  [bool]$AllowLegacyBackup = $false
) {
  Assert-ManagedConfigurationPath $Path $AllowLegacyBackup
  $removeDiagnostic = ""
  try {
    if (-not (Test-ManagedConfigurationPresent $Path $AllowLegacyBackup)) {
      return
    }
    Remove-Item -LiteralPath $Path -Force
    return
  } catch {
    if (-not $AllowAclRepair) {
      throw
    }
    $removeDiagnostic = $_.Exception.Message
  }
  $takeownOutput = @(& takeown.exe /F $Path /A 2>&1)
  $takeownExitCode = $LASTEXITCODE
  if ($takeownExitCode -ne 0) {
    $detail = Format-NativeDiagnostic $takeownOutput
    throw "takeown failed with exit code $takeownExitCode after delete was denied: $removeDiagnostic $detail"
  }
  $aclResetOutput = @(& icacls.exe $Path /reset 2>&1)
  $aclResetExitCode = $LASTEXITCODE
  if ($aclResetExitCode -ne 0) {
    $detail = Format-NativeDiagnostic $aclResetOutput
    throw "icacls reset failed with exit code $aclResetExitCode after delete was denied: $removeDiagnostic $detail"
  }
  $icaclsOutput = @(
    & icacls.exe $Path /inheritance:r /grant:r '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' 2>&1
  )
  $icaclsExitCode = $LASTEXITCODE
  if ($icaclsExitCode -ne 0) {
    $detail = Format-NativeDiagnostic $icaclsOutput
    throw "icacls failed with exit code $icaclsExitCode after delete was denied: $removeDiagnostic $detail"
  }
  try {
    Remove-Item -LiteralPath $Path -Force
  } catch {
    throw "delete failed after ACL repair: $($_.Exception.Message)"
  }
}

function Wait-TunnelServiceRemoved {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    $service = Get-Service -Name "WireGuardTunnel`$$TunnelName" -ErrorAction SilentlyContinue
    if ($null -eq $service) {
      return $true
    }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
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

  $Stage = "uninstall_previous_tunnel"
  New-Item -ItemType Directory -Path $ConfigurationRoot -Force | Out-Null
  $existingTunnel = Get-Service -Name "WireGuardTunnel`$$TunnelName" -ErrorAction SilentlyContinue
  $existingTunnelWasInstalled = $null -ne $existingTunnel
  if ($existingTunnelWasInstalled) {
    & $WireGuardExe /uninstalltunnelservice $TunnelName | Out-Null
    $uninstallExitCode = $LASTEXITCODE
    $existingTunnelRemoved = Wait-TunnelServiceRemoved
    if ($uninstallExitCode -ne 0 -or -not $existingTunnelRemoved) {
      throw "Unable to uninstall the previous WireGuard tunnel service"
    }
  }

  $Stage = "remove_previous_configuration"
  $previousRemovalStarted = $true
  Remove-ManagedConfiguration $PlainConfiguration $false
  Remove-ManagedConfiguration $SecureConfiguration $true
  if ($null -ne (Get-Service -Name "WireGuardTunnel`$$TunnelName" -ErrorAction SilentlyContinue)) {
    throw "The previous WireGuard tunnel was not completely removed"
  }
  $previousRemoved = $true

  $Stage = "remove_legacy_backups"
  foreach ($entryName in @(Get-ChildItem -LiteralPath $ConfigurationRoot -Force -File -Name)) {
    if ($entryName.StartsWith($LegacyBackupPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-ManagedConfiguration (Join-Path $ConfigurationRoot $entryName) $true $true
    }
  }

  $Stage = "stage_configuration"
  Copy-Item -LiteralPath $ConfigPath -Destination $PlainConfiguration -Force

  $Stage = "secure_configuration"
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (((-not (Test-ManagedConfigurationPresent $SecureConfiguration)) -or
    (Test-ManagedConfigurationPresent $PlainConfiguration)) -and ([DateTime]::UtcNow -lt $deadline)) {
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-ManagedConfigurationPresent $SecureConfiguration) -or
    (Test-ManagedConfigurationPresent $PlainConfiguration)) {
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
  Write-Result $true "ok" $activationState "" $previousRemoved
  exit 0
} catch {
  $failedStage = $Stage
  $failureMessage = $_.Exception.Message
  $recoveryDiagnostics = @()
  if (-not $previousRemoved -and $previousRemovalStarted) {
    try {
      $previousRemoved = $null -eq (
        Get-Service -Name "WireGuardTunnel`$$TunnelName" -ErrorAction SilentlyContinue
      ) -and -not (Test-ManagedConfigurationPresent $PlainConfiguration) -and
        -not (Test-ManagedConfigurationPresent $SecureConfiguration)
    } catch {
      $recoveryDiagnostics += "previous tunnel removal could not be verified: $($_.Exception.Message)"
    }
  }
  if ($tunnelInstalledHere) {
    & $WireGuardExe /uninstalltunnelservice $TunnelName | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Wait-TunnelServiceRemoved)) {
      $recoveryDiagnostics += "new tunnel service cleanup failed"
    }
  }
  if ($previousRemoved) {
    try {
      Remove-ManagedConfiguration $PlainConfiguration $false
      Remove-ManagedConfiguration $SecureConfiguration $true
    } catch {
      $recoveryDiagnostics += "new configuration cleanup failed: $($_.Exception.Message)"
    }
  } elseif ($existingTunnelWasInstalled -and $existingTunnelRemoved) {
    try {
      if (-not (Test-ManagedConfigurationPresent $SecureConfiguration)) {
        throw "the previous secure configuration is no longer present"
      }
      & $WireGuardExe /installtunnelservice $SecureConfiguration | Out-Null
      if ($LASTEXITCODE -ne 0) {
        throw "WireGuard returned exit code $LASTEXITCODE"
      }
      $restoredService = Get-Service -Name "WireGuardTunnel`$$TunnelName" -ErrorAction Stop
      Start-Service -Name $restoredService.Name
      $restoredService.WaitForStatus("Running", [TimeSpan]::FromSeconds(20))
    } catch {
      $recoveryDiagnostics += "previous tunnel recovery failed: $($_.Exception.Message)"
    }
  }
  if ($recoveryDiagnostics.Count -gt 0) {
    $failureMessage = "$failureMessage; $($recoveryDiagnostics -join '; ')"
  }
  if ($failureMessage.Length -gt 500) {
    $failureMessage = $failureMessage.Substring(0, 500)
  }
  Write-Result $false $failureMessage "error" $failedStage $previousRemoved
  exit 1
} finally {
  if ($managerInstalledHere) {
    & $WireGuardExe /uninstallmanagerservice | Out-Null
  }
  Remove-Item -LiteralPath $ConfigPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $ActivationPath -Force -ErrorAction SilentlyContinue
  if ($previousRemoved) {
    Remove-Item -LiteralPath $PlainConfiguration -Force -ErrorAction SilentlyContinue
  }
}
