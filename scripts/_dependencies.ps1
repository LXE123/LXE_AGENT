$consoleEncodingHelper = Join-Path $PSScriptRoot "_console_encoding.ps1"
if (Test-Path -LiteralPath $consoleEncodingHelper -PathType Leaf) {
    . $consoleEncodingHelper
}
else {
    $utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
    try {
        [Console]::OutputEncoding = $utf8NoBom
    }
    catch {
    }
    try {
        [Console]::InputEncoding = $utf8NoBom
    }
    catch {
    }
    $OutputEncoding = $utf8NoBom
    if ($env:OS -eq "Windows_NT") {
        try {
            & chcp.com 65001 > $null 2> $null
        }
        catch {
        }
    }
    $env:PYTHONUTF8 = "1"
    $env:PYTHONIOENCODING = "utf-8"
}

function Get-LxeUserHome {
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        return $env:USERPROFILE
    }
    if (-not [string]::IsNullOrWhiteSpace($HOME)) {
        return $HOME
    }
    return [Environment]::GetFolderPath("UserProfile")
}

function Resolve-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $expanded = [Environment]::ExpandEnvironmentVariables($Path)
    return [System.IO.Path]::GetFullPath($expanded)
}

function Add-LxePathEntry {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return
    }
    $separator = [System.IO.Path]::PathSeparator
    $currentPath = [string]$env:Path
    $parts = @()
    if (-not [string]::IsNullOrWhiteSpace($currentPath)) {
        $parts = @($currentPath.Split($separator) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }
    $normalizedNew = (Resolve-FullPath $Path).TrimEnd([char[]]'\/')
    foreach ($part in $parts) {
        try {
            $normalizedPart = (Resolve-FullPath $part).TrimEnd([char[]]'\/')
        }
        catch {
            $normalizedPart = $part.Trim().TrimEnd([char[]]'\/')
        }
        if ([string]::Equals($normalizedPart, $normalizedNew, [StringComparison]::OrdinalIgnoreCase)) {
            return
        }
    }
    if ([string]::IsNullOrWhiteSpace($currentPath)) {
        $env:Path = $Path
    }
    else {
        $env:Path = "$Path$separator$currentPath"
    }
}

if (-not (Get-Command Read-LxeProcessOutputFile -CommandType Function -ErrorAction SilentlyContinue)) {
    function Read-LxeProcessOutputFile {
        param([Parameter(Mandatory = $true)][string]$Path)
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            return @()
        }
        return @(Get-Content -LiteralPath $Path -Encoding UTF8)
    }
}

if (-not (Get-Command Write-LxeProcessOutputFile -CommandType Function -ErrorAction SilentlyContinue)) {
    function Write-LxeProcessOutputFile {
        param([Parameter(Mandatory = $true)][string]$Path)
        foreach ($line in (Read-LxeProcessOutputFile -Path $Path)) {
            Write-Host $line
        }
    }
}

if (-not (Get-Command Add-LxeQuotedBackslashes -CommandType Function -ErrorAction SilentlyContinue)) {
    function Add-LxeQuotedBackslashes {
        param(
            [Parameter(Mandatory = $true)][System.Text.StringBuilder]$Builder,
            [Parameter(Mandatory = $true)][int]$Count
        )
        for ($index = 0; $index -lt $Count; $index++) {
            [void]$Builder.Append('\')
        }
    }
}

if (-not (Get-Command Format-LxeNativeArgument -CommandType Function -ErrorAction SilentlyContinue)) {
    function Format-LxeNativeArgument {
        param([AllowNull()][string]$Argument)

        $value = [string]$Argument
        if ($value.Length -eq 0) {
            return '""'
        }
        if ($value -notmatch '[\s"]') {
            return $value
        }

        $builder = New-Object System.Text.StringBuilder
        [void]$builder.Append('"')
        $backslashCount = 0
        foreach ($character in $value.ToCharArray()) {
            if ($character -eq '\') {
                $backslashCount += 1
                continue
            }
            if ($character -eq '"') {
                Add-LxeQuotedBackslashes -Builder $builder -Count ($backslashCount * 2 + 1)
                [void]$builder.Append('"')
                $backslashCount = 0
                continue
            }
            if ($backslashCount -gt 0) {
                Add-LxeQuotedBackslashes -Builder $builder -Count $backslashCount
                $backslashCount = 0
            }
            [void]$builder.Append($character)
        }
        if ($backslashCount -gt 0) {
            Add-LxeQuotedBackslashes -Builder $builder -Count ($backslashCount * 2)
        }
        [void]$builder.Append('"')
        return $builder.ToString()
    }
}

if (-not (Get-Command Write-LxeNativeResultOutput -CommandType Function -ErrorAction SilentlyContinue)) {
    function Write-LxeNativeResultOutput {
        param([Parameter(Mandatory = $true)]$Result)
        foreach ($line in @($Result.Stdout)) {
            Write-Host $line
        }
        foreach ($line in @($Result.Stderr)) {
            Write-Host $line
        }
    }
}

if (-not (Get-Command Invoke-LxeNativeCapture -CommandType Function -ErrorAction SilentlyContinue)) {
    function Invoke-LxeNativeCapture {
        param(
            [Parameter(Mandatory = $true)][string]$FilePath,
            [string[]]$Arguments = @()
        )

        $stdoutPath = [System.IO.Path]::GetTempFileName()
        $stderrPath = [System.IO.Path]::GetTempFileName()
        try {
            $startParams = @{
                FilePath = $FilePath
                RedirectStandardOutput = $stdoutPath
                RedirectStandardError = $stderrPath
                Wait = $true
                PassThru = $true
                NoNewWindow = $true
            }
            $formattedArguments = @($Arguments | ForEach-Object { Format-LxeNativeArgument -Argument $_ })
            if ($formattedArguments.Count -gt 0) {
                $startParams["ArgumentList"] = ($formattedArguments -join " ")
            }

            $process = Start-Process @startParams
            return [pscustomobject]@{
                ExitCode = [int]$process.ExitCode
                Stdout = @(Read-LxeProcessOutputFile -Path $stdoutPath)
                Stderr = @(Read-LxeProcessOutputFile -Path $stderrPath)
            }
        }
        finally {
            if (Test-Path -LiteralPath $stdoutPath) {
                Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
            }
            if (Test-Path -LiteralPath $stderrPath) {
                Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

if (-not (Get-Command Invoke-LxeNativeCommand -CommandType Function -ErrorAction SilentlyContinue)) {
    function Invoke-LxeNativeCommand {
        param(
            [Parameter(Mandatory = $true)][string]$FilePath,
            [string[]]$Arguments = @()
        )

        $result = Invoke-LxeNativeCapture -FilePath $FilePath -Arguments $Arguments
        Write-LxeNativeResultOutput -Result $result
        return $result.ExitCode
    }
}

function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$Verb = "Running"
    )
    Write-Host "${Verb}: $Label"
    $exitCode = Invoke-LxeNativeCommand -FilePath $FilePath -Arguments $Arguments
    if ($exitCode -ne 0) {
        throw "$Label failed with exit code $exitCode."
    }
}

function Resolve-PowerShell {
    $command = Get-Command powershell -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }
    $command = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }
    throw "powershell is not available on PATH."
}

function Invoke-PowerShellFile {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @()
    )

    $powershell = Resolve-PowerShell
    $invokeArgs = @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $ScriptPath
    ) + $Arguments
    return Invoke-LxeNativeCommand -FilePath $powershell -Arguments $invokeArgs
}

function Resolve-Uv {
    param([switch]$InstallIfMissing)

    $command = Get-Command uv -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }

    $userHome = Get-LxeUserHome
    $localBin = Join-Path $userHome ".local\bin"
    $localUv = Join-Path $localBin "uv.exe"
    if (Test-Path -LiteralPath $localUv) {
        Add-LxePathEntry -Path $localBin
        return $localUv
    }

    if (-not $InstallIfMissing) {
        throw "uv is not available on PATH."
    }

    Write-Host "uv not found. Installing uv with the official installer..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $env:UV_INSTALL_DIR = $localBin

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lxe-uv-installer-" + [Guid]::NewGuid().ToString("N"))
    $uvInstaller = Join-Path $tempRoot "install-uv.ps1"
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    try {
        Invoke-WebRequest -Uri https://astral.sh/uv/install.ps1 -OutFile $uvInstaller
        $uvInstallExit = Invoke-PowerShellFile -ScriptPath $uvInstaller
        if ($uvInstallExit -ne 0) {
            throw "uv installer failed with exit code $uvInstallExit."
        }
    }
    finally {
        if (Test-Path -LiteralPath $tempRoot) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force
        }
    }

    Add-LxePathEntry -Path $localBin
    $command = Get-Command uv -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "uv installation finished, but uv is still not available on PATH."
    }
    return $command.Source
}

function Find-LxeGit {
    $command = Get-Command git -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }

    $candidateDirs = @()
    $programFiles = [string]$env:ProgramFiles
    if (-not [string]::IsNullOrWhiteSpace($programFiles)) {
        $candidateDirs += (Join-Path $programFiles "Git\cmd")
    }
    $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
    if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) {
        $candidateDirs += (Join-Path $programFilesX86 "Git\cmd")
    }

    foreach ($dir in $candidateDirs) {
        $gitPath = Join-Path $dir "git.exe"
        if (Test-Path -LiteralPath $gitPath -PathType Leaf) {
            Add-LxePathEntry -Path $dir
            return $gitPath
        }
    }

    return ""
}

function Resolve-Git {
    param([switch]$InstallIfMissing)

    $gitPath = Find-LxeGit
    if (-not [string]::IsNullOrWhiteSpace($gitPath)) {
        return $gitPath
    }

    if (-not $InstallIfMissing) {
        throw "git is not available on PATH."
    }
    if ($env:OS -ne "Windows_NT") {
        throw "git is not available. Install Git with your system package manager and rerun this script."
    }

    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($null -eq $winget) {
        throw "git is not available, and winget is not available. Install Git for Windows from https://git-scm.com/download/win and rerun this script."
    }

    Write-Host "git not found. Installing Git for Windows with winget..."
    $installExit = Invoke-LxeNativeCommand -FilePath $winget.Source -Arguments @(
        "install",
        "--id",
        "Git.Git",
        "--exact",
        "--source",
        "winget",
        "--accept-package-agreements",
        "--accept-source-agreements"
    )
    if ($installExit -ne 0) {
        throw "Git for Windows installation failed with exit code $installExit. Install Git manually and rerun this script."
    }

    Add-LxePathEntry -Path (Join-Path $env:ProgramFiles "Git\cmd")
    $gitPath = Find-LxeGit
    if ([string]::IsNullOrWhiteSpace($gitPath)) {
        throw "Git installation finished, but git is still not available on PATH."
    }

    $versionExit = Invoke-LxeNativeCommand -FilePath $gitPath -Arguments @("--version")
    if ($versionExit -ne 0) {
        throw "Git was found but failed verification with exit code $versionExit."
    }
    return $gitPath
}

function Find-LxeDws {
    param([switch]$NoPathUpdate)

    $command = Get-Command dws -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }

    $userHome = Get-LxeUserHome
    $localBin = Join-Path $userHome ".local\bin"
    foreach ($fileName in @("dws.exe", "dws")) {
        $candidate = Join-Path $localBin $fileName
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            if (-not $NoPathUpdate) {
                Add-LxePathEntry -Path $localBin
            }
            return $candidate
        }
    }

    return ""
}

function ConvertTo-LxeVersion {
    param([AllowNull()][string]$Text)

    $match = [regex]::Match([string]$Text, '(?<version>\d+(?:\.\d+){1,3})')
    if (-not $match.Success) {
        return $null
    }
    try {
        return [version]$match.Groups["version"].Value
    }
    catch {
        return $null
    }
}

function Test-LxeVersionAtLeast {
    param(
        [AllowNull()][string]$VersionText,
        [AllowNull()][string]$MinimumVersion
    )

    if ([string]::IsNullOrWhiteSpace($MinimumVersion)) {
        return $true
    }

    $current = ConvertTo-LxeVersion -Text $VersionText
    $minimum = ConvertTo-LxeVersion -Text $MinimumVersion
    if ($null -eq $current -or $null -eq $minimum) {
        return $false
    }
    return ($current -ge $minimum)
}

function Get-LxeDwsMinimumVersion {
    param([string]$ProjectRoot = "")

    if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
        $ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
    }

    $skillPath = Join-Path $ProjectRoot "skills\dws\SKILL.md"
    if (-not (Test-Path -LiteralPath $skillPath -PathType Leaf)) {
        return ""
    }

    $content = Get-Content -LiteralPath $skillPath -Raw -Encoding UTF8
    $match = [regex]::Match($content, '(?m)^\s*cli_version\s*:\s*["'']?\s*>=\s*(?<version>\d+(?:\.\d+){1,3})')
    if (-not $match.Success) {
        return ""
    }
    return $match.Groups["version"].Value
}

function Write-LxeDwsStatusWarnings {
    param(
        [Parameter(Mandatory = $true)][string]$DwsPath,
        [string]$ProjectRoot = ""
    )

    if ([string]::IsNullOrWhiteSpace($DwsPath)) {
        Write-Warning "DingTalk CLI dws is not installed. DingTalk CLI skills will be unavailable, but LXE core and the Feishu bot can still run."
        return
    }

    $versionResult = Invoke-LxeNativeCapture -FilePath $DwsPath -Arguments @("--version")
    $versionText = ((@($versionResult.Stdout) + @($versionResult.Stderr)) -join " ").Trim()
    if ($versionResult.ExitCode -ne 0) {
        Write-Warning "DingTalk CLI dws was found but failed version check with exit code $($versionResult.ExitCode). DingTalk CLI skills may be unavailable."
    }
    else {
        $minimumVersion = Get-LxeDwsMinimumVersion -ProjectRoot $ProjectRoot
        if (-not [string]::IsNullOrWhiteSpace($minimumVersion) -and -not (Test-LxeVersionAtLeast -VersionText $versionText -MinimumVersion $minimumVersion)) {
            Write-Warning "DingTalk CLI dws version may be too old: $versionText. LXE skills/dws requires >= $minimumVersion. Run dws upgrade -y if DingTalk CLI operations fail."
        }
    }

    $authResult = Invoke-LxeNativeCapture -FilePath $DwsPath -Arguments @("auth", "status")
    if ($authResult.ExitCode -ne 0) {
        Write-Warning "DingTalk CLI dws is installed but not authenticated. DingTalk CLI skills will be unavailable until you run: dws auth login"
    }
}

function Resolve-Dws {
    param([switch]$InstallIfMissing)

    $dwsPath = Find-LxeDws
    if (-not [string]::IsNullOrWhiteSpace($dwsPath)) {
        return $dwsPath
    }

    if (-not $InstallIfMissing) {
        throw "dws is not available on PATH."
    }
    if ($env:OS -ne "Windows_NT") {
        throw "dws is not available. Install DingTalk Workspace CLI manually and rerun this script."
    }

    $userHome = Get-LxeUserHome
    $localBin = Join-Path $userHome ".local\bin"
    if (-not (Test-Path -LiteralPath $localBin)) {
        New-Item -ItemType Directory -Path $localBin -Force | Out-Null
    }

    Write-Host "dws not found. Installing DingTalk Workspace CLI without bundled skills..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lxe-dws-installer-" + [Guid]::NewGuid().ToString("N"))
    $dwsInstaller = Join-Path $tempRoot "install-dws.ps1"
    $previousNoSkills = [Environment]::GetEnvironmentVariable("DWS_NO_SKILLS", "Process")
    $previousInstallDir = [Environment]::GetEnvironmentVariable("DWS_INSTALL_DIR", "Process")
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    try {
        $env:DWS_NO_SKILLS = "1"
        $env:DWS_INSTALL_DIR = $localBin
        Invoke-WebRequest -Uri https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.ps1 -OutFile $dwsInstaller
        $dwsInstallExit = Invoke-PowerShellFile -ScriptPath $dwsInstaller
        if ($dwsInstallExit -ne 0) {
            throw "dws installer failed with exit code $dwsInstallExit."
        }
    }
    finally {
        if ($null -eq $previousNoSkills) {
            Remove-Item Env:DWS_NO_SKILLS -ErrorAction SilentlyContinue
        }
        else {
            $env:DWS_NO_SKILLS = $previousNoSkills
        }
        if ($null -eq $previousInstallDir) {
            Remove-Item Env:DWS_INSTALL_DIR -ErrorAction SilentlyContinue
        }
        else {
            $env:DWS_INSTALL_DIR = $previousInstallDir
        }
        if (Test-Path -LiteralPath $tempRoot) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force
        }
    }

    Add-LxePathEntry -Path $localBin
    $dwsPath = Find-LxeDws
    if ([string]::IsNullOrWhiteSpace($dwsPath)) {
        throw "dws installation finished, but dws is still not available on PATH."
    }

    $versionExit = Invoke-LxeNativeCommand -FilePath $dwsPath -Arguments @("--version")
    if ($versionExit -ne 0) {
        throw "dws was found but failed verification with exit code $versionExit."
    }
    return $dwsPath
}
