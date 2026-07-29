[CmdletBinding()]
param(
    [string]$RuntimeRoot,
    [string]$CacheRoot,
    [switch]$Offline,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$consoleEncodingHelper = Join-Path $PSScriptRoot "_console_encoding.ps1"
if (Test-Path -LiteralPath $consoleEncodingHelper -PathType Leaf) {
    . $consoleEncodingHelper
}

function Resolve-LxeAbsolutePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $expanded = [Environment]::ExpandEnvironmentVariables($Path)
    return [System.IO.Path]::GetFullPath($expanded)
}

function Get-LxeConfiguredPath {
    param(
        [AllowEmptyString()][string]$ParameterValue,
        [Parameter(Mandatory = $true)][string]$EnvironmentName,
        [Parameter(Mandatory = $true)][string]$DefaultValue
    )

    if (-not [string]::IsNullOrWhiteSpace($ParameterValue)) {
        return Resolve-LxeAbsolutePath -Path $ParameterValue
    }
    $environmentValue = [Environment]::GetEnvironmentVariable($EnvironmentName)
    if (-not [string]::IsNullOrWhiteSpace($environmentValue)) {
        return Resolve-LxeAbsolutePath -Path $environmentValue
    }
    return Resolve-LxeAbsolutePath -Path $DefaultValue
}

function Test-LxePathWithin {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    $candidatePath = (Resolve-LxeAbsolutePath -Path $Candidate).TrimEnd([char[]]'\/')
    $parentPath = (Resolve-LxeAbsolutePath -Path $Parent).TrimEnd([char[]]'\/')
    if ([string]::Equals($candidatePath, $parentPath, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    return $candidatePath.StartsWith(
        $parentPath + [System.IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Get-LxeFileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = $null
    $sha256 = $null
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        if ($null -ne $sha256) {
            $sha256.Dispose()
        }
        if ($null -ne $stream) {
            $stream.Dispose()
        }
    }
}

function Get-LxeTextSha256 {
    param([Parameter(Mandatory = $true)][string]$Value)

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
        return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

function Write-LxeUtf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowEmptyString()][Parameter(Mandatory = $true)][string]$Value
    )

    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $encoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

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
            for ($index = 0; $index -lt ($backslashCount * 2 + 1); $index++) {
                [void]$builder.Append('\')
            }
            [void]$builder.Append('"')
            $backslashCount = 0
            continue
        }
        for ($index = 0; $index -lt $backslashCount; $index++) {
            [void]$builder.Append('\')
        }
        $backslashCount = 0
        [void]$builder.Append($character)
    }
    for ($index = 0; $index -lt ($backslashCount * 2); $index++) {
        [void]$builder.Append('\')
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Invoke-LxeNative {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = $script:RepositoryRoot,
        [int]$TimeoutSeconds = 0,
        [switch]$Quiet
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        throw "$Label executable is missing: $FilePath"
    }

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = (@($Arguments | ForEach-Object { Format-LxeNativeArgument -Argument $_ }) -join " ")
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw "$Label failed to start."
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if ($TimeoutSeconds -gt 0) {
            if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
                try {
                    & taskkill.exe /PID $process.Id /T /F > $null 2> $null
                }
                catch {
                    try { $process.Kill() } catch {}
                }
                throw "$Label timed out after $TimeoutSeconds seconds."
            }
        }
        else {
            $process.WaitForExit()
        }
        $process.WaitForExit()
        $stdout = $stdoutTask.Result.Trim()
        $stderr = $stderrTask.Result.Trim()
        if (-not $Quiet) {
            if (-not [string]::IsNullOrWhiteSpace($stdout)) { Write-Host $stdout }
            if (-not [string]::IsNullOrWhiteSpace($stderr)) { Write-Host $stderr }
        }
        if ($process.ExitCode -ne 0) {
            $detail = if (-not [string]::IsNullOrWhiteSpace($stderr)) { $stderr } else { $stdout }
            throw "$Label failed with exit code $($process.ExitCode): $detail"
        }
        return [PSCustomObject]@{
            ExitCode = $process.ExitCode
            Stdout = $stdout
            Stderr = $stderr
        }
    }
    finally {
        $process.Dispose()
    }
}

function Copy-LxeDirectoryContents {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Directory to copy is missing: $Source"
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($entry in @(Get-ChildItem -LiteralPath $Source -Force)) {
        Copy-Item -LiteralPath $entry.FullName -Destination $Destination -Recurse -Force
    }
}

function Assert-LxeZipArchive {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Archive
    )

    $zipArchive = $null
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
        $zipArchive = [System.IO.Compression.ZipFile]::OpenRead($Archive)
        if ($zipArchive.Entries.Count -eq 0) {
            throw "The ZIP archive contains no entries."
        }
    }
    catch {
        throw "$Label is not a valid ZIP archive: $Archive. $($_.Exception.Message)"
    }
    finally {
        if ($null -ne $zipArchive) {
            $zipArchive.Dispose()
        }
    }
}

function Get-LxeCachedArchive {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Url
    )

    $uri = New-Object System.Uri -ArgumentList $Url
    $fileName = [System.IO.Path]::GetFileName($uri.AbsolutePath)
    $downloadRoot = Join-Path $script:ResolvedCacheRoot "downloads"
    $destination = Join-Path $downloadRoot $fileName
    New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null

    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        try {
            Assert-LxeZipArchive -Label $Label -Archive $destination
            return $destination
        }
        catch {
            $cacheFailure = $_.Exception.Message
            if ($Offline) {
                throw "Cached $Label archive is invalid and cannot be repaired offline: $cacheFailure"
            }
            Write-Warning "Discarding invalid cached $Label archive: $cacheFailure"
            Remove-Item -LiteralPath $destination -Force
        }
    }
    if ($Offline) {
        throw "$Label is not available in the offline cache: $destination"
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $proxy = [Environment]::GetEnvironmentVariable("HTTPS_PROXY")
    if ([string]::IsNullOrWhiteSpace($proxy)) {
        $proxy = [Environment]::GetEnvironmentVariable("HTTP_PROXY")
    }
    $waitSeconds = @(2, 5, 10)
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $temporary = "$destination.download-$([Guid]::NewGuid().ToString('N'))"
        try {
            Write-Host "Downloading $Label (attempt $attempt/3)..."
            if ($uri.Host.EndsWith(".sourceforge.net", [StringComparison]::OrdinalIgnoreCase)) {
                $curlCommand = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue
                if ($null -eq $curlCommand) {
                    throw "$Label requires curl.exe to download from SourceForge."
                }
                $curlArguments = @(
                    "--fail",
                    "--location",
                    "--silent",
                    "--show-error",
                    "--connect-timeout", "30",
                    "--max-time", "120",
                    "--output", $temporary,
                    $Url
                )
                if (-not [string]::IsNullOrWhiteSpace($proxy)) {
                    $curlArguments = @("--proxy", $proxy) + $curlArguments
                }
                Invoke-LxeNative `
                    -Label "$Label download" `
                    -FilePath $curlCommand.Source `
                    -Arguments $curlArguments `
                    -TimeoutSeconds 130 `
                    -Quiet | Out-Null
            }
            else {
                $requestParameters = @{
                    Uri = $Url
                    OutFile = $temporary
                    UseBasicParsing = $true
                    TimeoutSec = 120
                }
                if (-not [string]::IsNullOrWhiteSpace($proxy)) {
                    $requestParameters.Proxy = $proxy
                }
                Invoke-WebRequest @requestParameters
            }
            Assert-LxeZipArchive -Label $Label -Archive $temporary
            Move-Item -LiteralPath $temporary -Destination $destination -Force
            return $destination
        }
        catch {
            if (Test-Path -LiteralPath $temporary) {
                Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
            }
            if ($attempt -eq 3) { throw }
            Write-Warning "$Label download failed: $($_.Exception.Message)"
            Start-Sleep -Seconds $waitSeconds[$attempt - 1]
        }
    }
    throw "$Label download did not produce an archive."
}

function Expand-LxeArchiveFresh {
    param(
        [Parameter(Mandatory = $true)][string]$Archive,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
}

function Get-LxeJsonProperty {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        throw "JSON object is missing property: $Name"
    }
    return $property.Value
}

function Assert-LxeLockConfiguration {
    $nodeManifest = Get-Content -LiteralPath $script:NodeManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $dependencies = $nodeManifest.dependencies
    if ([string](Get-LxeJsonProperty -Object $dependencies -Name "npm") -ne [string]$script:RuntimeLock.node.npm_version) {
        throw "The Node runtime manifest npm version does not match runtime.lock.json."
    }
    foreach ($package in $script:RuntimeLock.node.packages.PSObject.Properties) {
        if ([string](Get-LxeJsonProperty -Object $dependencies -Name $package.Name) -ne [string]$package.Value) {
            throw "The Node runtime package $($package.Name) does not match runtime.lock.json."
        }
    }
    if ([string]$script:RuntimeLock.python.version -ne "3.12.10") {
        throw "The desktop Python runtime must remain pinned to 3.12.10."
    }
    if ([string]$script:RuntimeLock.exiftool.version -ne "13.59") {
        throw "The desktop ExifTool runtime must remain pinned to 13.59."
    }
}

function Get-LxeLockFingerprint {
    $relativePaths = @(
        "config/desktop-runtime/windows-x64/runtime.lock.json",
        "config/desktop-runtime/windows-x64/node/package.json",
        "config/desktop-runtime/windows-x64/node/package-lock.json",
        "pyproject.toml",
        "scripts/prepare-desktop-runtime.ps1",
        "uv.lock"
    )
    $lines = @()
    foreach ($relativePath in $relativePaths) {
        $nativePath = $relativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $absolutePath = Join-Path $script:RepositoryRoot $nativePath
        if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
            throw "Runtime lock input is missing: $absolutePath"
        }
        $lines += "$relativePath=$(Get-LxeFileSha256 -Path $absolutePath)"
    }
    $lines += "desktop-runtime-publish-layout=2"
    return Get-LxeTextSha256 -Value (($lines -join "`n") + "`n")
}

function Assert-LxeManagedDestination {
    param([Parameter(Mandatory = $true)][string]$Destination)

    if ((Test-Path -LiteralPath $Destination) -and
        -not (Test-Path -LiteralPath $Destination -PathType Container)) {
        throw "Refusing to replace a file with the managed runtime: $Destination"
    }
    if (-not (Test-Path -LiteralPath $Destination -PathType Container)) { return }
    $entries = @(Get-ChildItem -LiteralPath $Destination -Force)
    if ($entries.Count -eq 0) { return }
    $marker = Join-Path $Destination ".lxe-desktop-runtime.json"
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        throw "Refusing to replace a non-empty directory not managed by LXE: $Destination"
    }
    try {
        $markerValue = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw "Refusing to replace a directory with an unreadable LXE marker: $Destination"
    }
    if ([int]$markerValue.schema_version -notin @(1, 2) -or [string]$markerValue.platform -ne "win32-x64") {
        throw "Refusing to replace a directory with an incompatible LXE marker: $Destination"
    }
}

function Assert-LxeRuntimeMarker {
    param([Parameter(Mandatory = $true)][string]$Root)

    $markerPath = Join-Path $Root ".lxe-desktop-runtime.json"
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        throw "Managed runtime marker is missing: $markerPath"
    }
    $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$marker.schema_version -ne 2 -or [string]$marker.platform -ne "win32-x64") {
        throw "Managed runtime marker is incompatible: $markerPath"
    }
    if ([string]$marker.lock_sha256 -ne $script:LockSha256) {
        throw "Managed runtime lock fingerprint is stale: $markerPath"
    }
    foreach ($requiredPath in @(
        "node\node.exe",
        "python\python.exe",
        "uv\uv.exe",
        "tools\rg.exe",
        "tools\exiftool\exiftool.exe"
    )) {
        $absolutePath = Join-Path $Root $requiredPath
        if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
            throw "Managed runtime file is missing: $absolutePath"
        }
    }
    $exifToolFiles = Join-Path $Root "tools\exiftool\exiftool_files"
    if (-not (Test-Path -LiteralPath $exifToolFiles -PathType Container)) {
        throw "Managed ExifTool support directory is missing: $exifToolFiles"
    }
}

function Find-LxeManagedPython {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)

    if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) { return $null }
    $pattern = "cpython-$($script:RuntimeLock.python.version)-windows-*"
    foreach ($directory in @(Get-ChildItem -LiteralPath $InstallRoot -Filter $pattern -Directory)) {
        $candidate = Join-Path $directory.FullName "python.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }
    return $null
}

function Install-LxeNodeRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$WorkRoot
    )

    $archive = Get-LxeCachedArchive -Label "Node $($script:RuntimeLock.node.version)" -Url $script:RuntimeLock.node.archive_url
    $extractRoot = Join-Path $WorkRoot "node-bootstrap"
    Expand-LxeArchiveFresh -Archive $archive -Destination $extractRoot
    $bootstrapRoot = Join-Path $extractRoot ([string]$script:RuntimeLock.node.archive_root)
    $bootstrapNode = Join-Path $bootstrapRoot "node.exe"
    $bootstrapNpm = Join-Path $bootstrapRoot "node_modules\npm\bin\npm-cli.js"
    if (-not (Test-Path -LiteralPath $bootstrapNode -PathType Leaf) -or -not (Test-Path -LiteralPath $bootstrapNpm -PathType Leaf)) {
        throw "The pinned Node archive is incomplete: $bootstrapRoot"
    }

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Copy-Item -LiteralPath $script:NodeManifestPath -Destination (Join-Path $Destination "package.json") -Force
    Copy-Item -LiteralPath $script:NodePackageLockPath -Destination (Join-Path $Destination "package-lock.json") -Force

    $npmCache = Join-Path $script:ResolvedCacheRoot "npm\$($script:RuntimeLock.node.npm_version)"
    New-Item -ItemType Directory -Path $npmCache -Force | Out-Null
    $emptyNpmConfig = Join-Path $WorkRoot "empty.npmrc"
    Write-LxeUtf8NoBom -Path $emptyNpmConfig -Value ""
    $previousPath = $env:Path
    $previousUserConfig = $env:npm_config_userconfig
    $previousCache = $env:npm_config_cache
    $previousAudit = $env:npm_config_audit
    $previousFund = $env:npm_config_fund
    $previousUpdateNotifier = $env:npm_config_update_notifier
    $previousRegistry = $env:npm_config_registry
    try {
        $env:Path = "$bootstrapRoot$([System.IO.Path]::PathSeparator)$previousPath"
        $env:npm_config_userconfig = $emptyNpmConfig
        $env:npm_config_cache = $npmCache
        $env:npm_config_audit = "false"
        $env:npm_config_fund = "false"
        $env:npm_config_update_notifier = "false"
        $env:npm_config_registry = "https://registry.npmjs.org/"
        $arguments = @(
            $bootstrapNpm,
            "ci",
            "--prefix", $Destination,
            "--cache", $npmCache,
            "--omit", "dev",
            "--no-audit",
            "--no-fund"
        )
        Invoke-LxeNative -Label "pinned Node runtime npm ci" -FilePath $bootstrapNode -Arguments $arguments -WorkingDirectory $script:RepositoryRoot -TimeoutSeconds 900 | Out-Null
    }
    finally {
        $env:Path = $previousPath
        $env:npm_config_userconfig = $previousUserConfig
        $env:npm_config_cache = $previousCache
        $env:npm_config_audit = $previousAudit
        $env:npm_config_fund = $previousFund
        $env:npm_config_update_notifier = $previousUpdateNotifier
        $env:npm_config_registry = $previousRegistry
    }

    Copy-Item -LiteralPath $bootstrapNode -Destination (Join-Path $Destination "node.exe") -Force
    foreach ($cacheArtifact in @("_logs", "_cacache\tmp", "_update-notifier-last-checked", "_timing.json")) {
        $artifactPath = Join-Path $npmCache $cacheArtifact
        if (Test-Path -LiteralPath $artifactPath) {
            Remove-Item -LiteralPath $artifactPath -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Install-LxePythonRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$UvExecutable,
        [Parameter(Mandatory = $true)][string]$WorkRoot
    )

    $uvCache = Join-Path $script:ResolvedCacheRoot "uv-cache"
    $pythonInstallRoot = Join-Path $script:ResolvedCacheRoot "python-installations"
    New-Item -ItemType Directory -Path $uvCache, $pythonInstallRoot -Force | Out-Null
    $previousUvCache = $env:UV_CACHE_DIR
    $previousUvInstall = $env:UV_PYTHON_INSTALL_DIR
    $previousUvDownloads = $env:UV_PYTHON_DOWNLOADS
    $previousUvOffline = $env:UV_OFFLINE
    $previousUvNoProgress = $env:UV_NO_PROGRESS
    try {
        $env:UV_CACHE_DIR = $uvCache
        $env:UV_PYTHON_INSTALL_DIR = $pythonInstallRoot
        $env:UV_NO_PROGRESS = "1"
        if ($Offline) {
            $env:UV_OFFLINE = "1"
            $env:UV_PYTHON_DOWNLOADS = "never"
        }
        else {
            $env:UV_OFFLINE = "0"
            $env:UV_PYTHON_DOWNLOADS = "automatic"
        }

        $managedPython = Find-LxeManagedPython -InstallRoot $pythonInstallRoot
        if ([string]::IsNullOrWhiteSpace($managedPython)) {
            if ($Offline) {
                throw "Python $($script:RuntimeLock.python.version) is missing from the offline cache: $pythonInstallRoot"
            }
            Invoke-LxeNative -Label "managed Python installation" -FilePath $UvExecutable -Arguments @("python", "install", [string]$script:RuntimeLock.python.version) -TimeoutSeconds 900 | Out-Null
            $managedPython = Find-LxeManagedPython -InstallRoot $pythonInstallRoot
            if ([string]::IsNullOrWhiteSpace($managedPython)) {
                throw "uv did not install Python $($script:RuntimeLock.python.version) under $pythonInstallRoot"
            }
        }

        Copy-LxeDirectoryContents -Source (Split-Path -Parent $managedPython) -Destination $Destination
        $stagedPython = Join-Path $Destination "python.exe"
        if (-not (Test-LxePathWithin -Candidate $stagedPython -Parent $Destination)) {
            throw "Refusing to install packages outside the staged Python runtime: $stagedPython"
        }
        if (-not (Test-Path -LiteralPath $stagedPython -PathType Leaf)) {
            throw "Copied Python runtime is missing python.exe: $Destination"
        }

        $requirements = Join-Path $WorkRoot "desktop-runtime-requirements.txt"
        Invoke-LxeNative -Label "locked Python dependency export" -FilePath $UvExecutable -Arguments @(
            "export", "--frozen", "--no-dev", "--no-emit-project",
            "--no-hashes", "--format", "requirements-txt", "--output-file", $requirements
        ) -WorkingDirectory $script:RepositoryRoot -TimeoutSeconds 300 | Out-Null
        $env:UV_PYTHON_DOWNLOADS = "never"
        Invoke-LxeNative -Label "locked Python dependency installation" -FilePath $UvExecutable -Arguments @(
            "pip", "install", "--python", $stagedPython, "--break-system-packages",
            "--requirements", $requirements
        ) -WorkingDirectory $script:RepositoryRoot -TimeoutSeconds 1800 | Out-Null
    }
    finally {
        $env:UV_CACHE_DIR = $previousUvCache
        $env:UV_PYTHON_INSTALL_DIR = $previousUvInstall
        $env:UV_PYTHON_DOWNLOADS = $previousUvDownloads
        $env:UV_OFFLINE = $previousUvOffline
        $env:UV_NO_PROGRESS = $previousUvNoProgress
    }
}

function Install-LxePlaywrightBrowser {
    param(
        [Parameter(Mandatory = $true)][string]$PythonRoot,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $python = Join-Path $PythonRoot "python.exe"
    $browserCache = Join-Path $script:ResolvedCacheRoot "playwright\$($script:RuntimeLock.playwright.cache_key)"
    if ($Offline) {
        if (-not (Test-Path -LiteralPath $browserCache -PathType Container)) {
            throw "Playwright Chromium is missing from the offline cache: $browserCache"
        }
        Copy-LxeDirectoryContents -Source $browserCache -Destination $Destination
        return
    }

    $attempts = [int]$script:RuntimeLock.playwright.download_attempts
    $waitSeconds = @(2, 5, 10)
    $previousBrowserRoot = $env:PLAYWRIGHT_BROWSERS_PATH
    $previousConnectionTimeout = $env:PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT
    try {
        $env:PLAYWRIGHT_BROWSERS_PATH = $browserCache
        $env:PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT = [string]$script:RuntimeLock.playwright.download_connection_timeout_ms
        for ($attempt = 1; $attempt -le $attempts; $attempt++) {
            try {
                Write-Host "Preparing Playwright Chromium (attempt $attempt/$attempts)..."
                Invoke-LxeNative -Label "Playwright Chromium installation" -FilePath $python -Arguments @(
                    "-I", "-m", "playwright", "install", "--no-shell", [string]$script:RuntimeLock.playwright.browser
                ) -TimeoutSeconds 900 | Out-Null
                if (Test-Path -LiteralPath $Destination) {
                    Remove-Item -LiteralPath $Destination -Recurse -Force
                }
                Copy-LxeDirectoryContents -Source $browserCache -Destination $Destination
                return
            }
            catch {
                if (Test-Path -LiteralPath $browserCache) {
                    Remove-Item -LiteralPath $browserCache -Recurse -Force -ErrorAction SilentlyContinue
                }
                if (Test-Path -LiteralPath $Destination) {
                    Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction SilentlyContinue
                }
                if ($attempt -eq $attempts) { throw }
                Write-Warning "Playwright Chromium preparation failed: $($_.Exception.Message)"
                Start-Sleep -Seconds $waitSeconds[$attempt - 1]
            }
        }
    }
    finally {
        $env:PLAYWRIGHT_BROWSERS_PATH = $previousBrowserRoot
        $env:PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT = $previousConnectionTimeout
    }
}

function Install-LxeUvRipgrepAndExifTool {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$WorkRoot
    )

    $uvArchive = Get-LxeCachedArchive -Label "uv $($script:RuntimeLock.uv.version)" -Url $script:RuntimeLock.uv.archive_url
    $uvExtract = Join-Path $WorkRoot "uv"
    Expand-LxeArchiveFresh -Archive $uvArchive -Destination $uvExtract
    $uvCandidate = @(Get-ChildItem -LiteralPath $uvExtract -Filter "uv.exe" -File -Recurse | Select-Object -First 1)
    if ($uvCandidate.Count -eq 0) { throw "The pinned uv archive did not contain uv.exe." }
    $uvDestination = Join-Path $Root "uv\uv.exe"
    New-Item -ItemType Directory -Path (Split-Path -Parent $uvDestination) -Force | Out-Null
    Copy-Item -LiteralPath $uvCandidate[0].FullName -Destination $uvDestination -Force

    $rgArchive = Get-LxeCachedArchive -Label "ripgrep $($script:RuntimeLock.ripgrep.version)" -Url $script:RuntimeLock.ripgrep.archive_url
    $rgExtract = Join-Path $WorkRoot "ripgrep"
    Expand-LxeArchiveFresh -Archive $rgArchive -Destination $rgExtract
    $rgCandidate = @(Get-ChildItem -LiteralPath $rgExtract -Filter "rg.exe" -File -Recurse | Select-Object -First 1)
    if ($rgCandidate.Count -eq 0) { throw "The pinned ripgrep archive did not contain rg.exe." }
    $rgDestination = Join-Path $Root "tools\rg.exe"
    New-Item -ItemType Directory -Path (Split-Path -Parent $rgDestination) -Force | Out-Null
    Copy-Item -LiteralPath $rgCandidate[0].FullName -Destination $rgDestination -Force

    $exifToolArchive = Get-LxeCachedArchive -Label "ExifTool $($script:RuntimeLock.exiftool.version)" -Url $script:RuntimeLock.exiftool.archive_url
    $exifToolExtract = Join-Path $WorkRoot "exiftool"
    Expand-LxeArchiveFresh -Archive $exifToolArchive -Destination $exifToolExtract
    $exifToolCandidates = @(Get-ChildItem -LiteralPath $exifToolExtract -File -Recurse | Where-Object {
        $_.Name -in @("exiftool(-k).exe", "exiftool.exe")
    } | Select-Object -First 1)
    if ($exifToolCandidates.Count -eq 0) {
        throw "The pinned ExifTool archive did not contain exiftool(-k).exe."
    }
    $exifToolSourceRoot = $exifToolCandidates[0].Directory.FullName
    $exifToolFilesSource = Join-Path $exifToolSourceRoot "exiftool_files"
    if (-not (Test-Path -LiteralPath $exifToolFilesSource -PathType Container)) {
        throw "The pinned ExifTool archive did not contain exiftool_files."
    }
    $exifToolDestination = Join-Path $Root "tools\exiftool"
    New-Item -ItemType Directory -Path $exifToolDestination -Force | Out-Null
    Copy-Item -LiteralPath $exifToolCandidates[0].FullName -Destination (Join-Path $exifToolDestination "exiftool.exe") -Force
    Copy-LxeDirectoryContents -Source $exifToolFilesSource -Destination (Join-Path $exifToolDestination "exiftool_files")
}

function Write-LxeRuntimeMarker {
    param([Parameter(Mandatory = $true)][string]$Root)

    $marker = [ordered]@{
        schema_version = 2
        platform = "win32-x64"
        lock_sha256 = $script:LockSha256
    }
    Remove-Item -LiteralPath (Join-Path $Root "runtime-manifest.json") -Force -ErrorAction SilentlyContinue
    Write-LxeUtf8NoBom -Path (Join-Path $Root ".lxe-desktop-runtime.json") -Value (($marker | ConvertTo-Json -Depth 4) + "`n")
}

function Write-LxeRuntimeDescriptor {
    param([Parameter(Mandatory = $true)][string]$Root)

    $descriptor = [ordered]@{
        schema_version = 1
        platform = "win32-x64"
        lock_sha256 = $script:LockSha256
        inputs = [ordered]@{
            node_root = Join-Path $Root "node"
            python_root = Join-Path $Root "python"
            uv_path = Join-Path $Root "uv\uv.exe"
            rg_path = Join-Path $Root "tools\rg.exe"
            exiftool_root = Join-Path $Root "tools\exiftool"
            playwright_root = Join-Path $Root "playwright"
        }
    }
    $descriptorJson = ($descriptor | ConvertTo-Json -Depth 6) + "`n"
    $descriptorParent = Split-Path -Parent $script:DescriptorPath
    New-Item -ItemType Directory -Path $descriptorParent -Force | Out-Null
    $temporary = "$($script:DescriptorPath).new-$([Guid]::NewGuid().ToString('N'))"
    try {
        Write-LxeUtf8NoBom -Path $temporary -Value $descriptorJson
        Move-Item -LiteralPath $temporary -Destination $script:DescriptorPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Publish-LxeRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$StagedRoot,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $backup = "$Destination.backup-$([Guid]::NewGuid().ToString('N'))"
    $hadExisting = Test-Path -LiteralPath $Destination
    try {
        if ($hadExisting) {
            Move-Item -LiteralPath $Destination -Destination $backup
        }
        Move-Item -LiteralPath $StagedRoot -Destination $Destination
        if (Test-Path -LiteralPath $backup) {
            Remove-Item -LiteralPath $backup -Recurse -Force
        }
    }
    catch {
        if (-not (Test-Path -LiteralPath $Destination) -and (Test-Path -LiteralPath $backup)) {
            Move-Item -LiteralPath $backup -Destination $Destination
        }
        throw
    }
}

function Save-LxeRuntimeImageCache {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $parent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temporary = "$Destination.new-$([Guid]::NewGuid().ToString('N'))"
    try {
        Copy-LxeDirectoryContents -Source $Source -Destination $temporary
        if (Test-Path -LiteralPath $Destination) {
            Remove-Item -LiteralPath $Destination -Recurse -Force
        }
        Move-Item -LiteralPath $temporary -Destination $Destination
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

$script:RepositoryRoot = Resolve-LxeAbsolutePath -Path (Join-Path $PSScriptRoot "..")
if ($env:OS -ne "Windows_NT" -or -not [Environment]::Is64BitProcess) {
    throw "The desktop runtime preparer must run in a 64-bit PowerShell process on Windows x64."
}

$script:RuntimeLockPath = Join-Path $script:RepositoryRoot "config\desktop-runtime\windows-x64\runtime.lock.json"
$script:NodeManifestPath = Join-Path $script:RepositoryRoot "config\desktop-runtime\windows-x64\node\package.json"
$script:NodePackageLockPath = Join-Path $script:RepositoryRoot "config\desktop-runtime\windows-x64\node\package-lock.json"
$script:RuntimeLock = Get-Content -LiteralPath $script:RuntimeLockPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([int]$script:RuntimeLock.schema_version -ne 1 -or [string]$script:RuntimeLock.platform -ne "win32-x64") {
    throw "Unsupported desktop runtime lock: $script:RuntimeLockPath"
}
Assert-LxeLockConfiguration
$script:LockSha256 = Get-LxeLockFingerprint

$script:ResolvedRuntimeRoot = Get-LxeConfiguredPath -ParameterValue $RuntimeRoot -EnvironmentName "LXE_DESKTOP_RUNTIME_ROOT" -DefaultValue (Join-Path $script:RepositoryRoot "build\desktop-runtime\win32-x64")
$script:ResolvedCacheRoot = Get-LxeConfiguredPath -ParameterValue $CacheRoot -EnvironmentName "LXE_DESKTOP_CACHE_ROOT" -DefaultValue (Join-Path $script:RepositoryRoot "build\desktop-runtime-cache\win32-x64")
$descriptorEnvironment = [Environment]::GetEnvironmentVariable("LXE_DESKTOP_RUNTIME_DESCRIPTOR")
if ([string]::IsNullOrWhiteSpace($descriptorEnvironment)) {
    $script:DescriptorPath = Join-Path $script:RepositoryRoot "build\desktop-runtime-inputs.json"
}
else {
    $script:DescriptorPath = Resolve-LxeAbsolutePath -Path $descriptorEnvironment
}

if ((Test-LxePathWithin -Candidate $script:ResolvedRuntimeRoot -Parent $script:ResolvedCacheRoot) -or
    (Test-LxePathWithin -Candidate $script:ResolvedCacheRoot -Parent $script:ResolvedRuntimeRoot)) {
    throw "RuntimeRoot and CacheRoot must be separate, non-nested directories."
}
if ([string]::Equals($script:ResolvedRuntimeRoot, $script:RepositoryRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "RuntimeRoot cannot be the repository root."
}
Assert-LxeManagedDestination -Destination $script:ResolvedRuntimeRoot
New-Item -ItemType Directory -Path (Split-Path -Parent $script:ResolvedRuntimeRoot) -Force | Out-Null
New-Item -ItemType Directory -Path $script:ResolvedCacheRoot -Force | Out-Null

if ((Test-Path -LiteralPath $script:ResolvedRuntimeRoot -PathType Container) -and -not $Force) {
    try {
        Assert-LxeRuntimeMarker -Root $script:ResolvedRuntimeRoot
        Write-LxeRuntimeMarker -Root $script:ResolvedRuntimeRoot
        Write-LxeRuntimeDescriptor -Root $script:ResolvedRuntimeRoot
        Write-Host "Reusing managed desktop runtime: $script:ResolvedRuntimeRoot"
        return
    }
    catch {
        Write-Warning "Existing desktop runtime will be rebuilt: $($_.Exception.Message)"
    }
}

$runtimeParent = Split-Path -Parent $script:ResolvedRuntimeRoot
$runtimeLeaf = Split-Path -Leaf $script:ResolvedRuntimeRoot
$stagedRoot = Join-Path $runtimeParent (".$runtimeLeaf.staging-" + [Guid]::NewGuid().ToString("N"))
$workRoot = Join-Path $runtimeParent (".$runtimeLeaf.work-" + [Guid]::NewGuid().ToString("N"))
$runtimeImageCache = Join-Path $script:ResolvedCacheRoot ("runtime-images\" + $script:LockSha256)

try {
    New-Item -ItemType Directory -Path $stagedRoot, $workRoot -Force | Out-Null
    $usedCachedImage = $false
    if (Test-Path -LiteralPath $runtimeImageCache -PathType Container) {
        try {
            Copy-LxeDirectoryContents -Source $runtimeImageCache -Destination $stagedRoot
            Assert-LxeRuntimeMarker -Root $stagedRoot
            $usedCachedImage = $true
            Write-Host "Reusing managed cached runtime image: $runtimeImageCache"
        }
        catch {
            Remove-Item -LiteralPath $stagedRoot -Recurse -Force -ErrorAction SilentlyContinue
            New-Item -ItemType Directory -Path $stagedRoot -Force | Out-Null
            if ($Offline) {
                throw "The cached runtime image is damaged and cannot be repaired offline: $($_.Exception.Message)"
            }
            Write-Warning "Discarding damaged runtime image cache: $($_.Exception.Message)"
            Remove-Item -LiteralPath $runtimeImageCache -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    elseif ($Offline) {
        throw "No complete runtime image is available for offline reconstruction: $runtimeImageCache"
    }

    if (-not $usedCachedImage) {
        Install-LxeUvRipgrepAndExifTool -Root $stagedRoot -WorkRoot $workRoot
        Install-LxeNodeRuntime -Destination (Join-Path $stagedRoot "node") -WorkRoot $workRoot
        Install-LxePythonRuntime -Destination (Join-Path $stagedRoot "python") -UvExecutable (Join-Path $stagedRoot "uv\uv.exe") -WorkRoot $workRoot
        Install-LxePlaywrightBrowser -PythonRoot (Join-Path $stagedRoot "python") -Destination (Join-Path $stagedRoot "playwright")
        Write-LxeRuntimeMarker -Root $stagedRoot
        Save-LxeRuntimeImageCache -Source $stagedRoot -Destination $runtimeImageCache
    }

    Publish-LxeRuntime -StagedRoot $stagedRoot -Destination $script:ResolvedRuntimeRoot
    Write-LxeRuntimeDescriptor -Root $script:ResolvedRuntimeRoot
    Write-Host "Prepared Windows x64 desktop runtime: $script:ResolvedRuntimeRoot"
    Write-Host "Runtime descriptor: $script:DescriptorPath"
}
finally {
    if (Test-Path -LiteralPath $stagedRoot) {
        Remove-Item -LiteralPath $stagedRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $workRoot) {
        Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
