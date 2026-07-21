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

function Get-LxeCachedArchive {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )

    $uri = New-Object System.Uri -ArgumentList $Url
    $fileName = [System.IO.Path]::GetFileName($uri.AbsolutePath)
    $downloadRoot = Join-Path $script:ResolvedCacheRoot "downloads"
    $destination = Join-Path $downloadRoot $fileName
    New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null

    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        $actualHash = Get-LxeFileSha256 -Path $destination
        if ([string]::Equals($actualHash, $ExpectedSha256, [StringComparison]::OrdinalIgnoreCase)) {
            return $destination
        }
        if ($Offline) {
            throw "$Label cache is damaged in offline mode: $destination"
        }
        Remove-Item -LiteralPath $destination -Force
    }
    elseif ($Offline) {
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
            $actualHash = Get-LxeFileSha256 -Path $temporary
            if (-not [string]::Equals($actualHash, $ExpectedSha256, [StringComparison]::OrdinalIgnoreCase)) {
                throw "$Label SHA-256 mismatch. Expected $ExpectedSha256, found $actualHash."
            }
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
}

function Get-LxeLockFingerprint {
    $relativePaths = @(
        "config/desktop-runtime/windows-x64/runtime.lock.json",
        "config/desktop-runtime/windows-x64/node/package.json",
        "config/desktop-runtime/windows-x64/node/package-lock.json",
        "pyproject.toml",
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
    if ([int]$markerValue.schema_version -ne 1 -or [string]$markerValue.platform -ne "win32-x64") {
        throw "Refusing to replace a directory with an incompatible LXE marker: $Destination"
    }
}

function Resolve-LxeNodePackageBin {
    param([Parameter(Mandatory = $true)][string]$PackageRoot)

    $manifestPath = Join-Path $PackageRoot "package.json"
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.bin -is [string]) {
        return Join-Path $PackageRoot ([string]$manifest.bin)
    }
    $firstBin = @($manifest.bin.PSObject.Properties | Select-Object -First 1)
    if ($firstBin.Count -eq 0) {
        throw "Node package does not declare a CLI bin: $PackageRoot"
    }
    return Join-Path $PackageRoot ([string]$firstBin[0].Value)
}

function Test-LxeNodeRuntime {
    param([Parameter(Mandatory = $true)][string]$NodeRoot)

    $node = Join-Path $NodeRoot "node.exe"
    $npmCli = Join-Path $NodeRoot "node_modules\npm\bin\npm-cli.js"
    $nodeVersion = Invoke-LxeNative -Label "managed Node version" -FilePath $node -Arguments @("--version") -Quiet
    if ($nodeVersion.Stdout.Trim() -ne "v$($script:RuntimeLock.node.version)") {
        throw "Managed Node version mismatch: $($nodeVersion.Stdout)"
    }
    $npmVersion = Invoke-LxeNative -Label "managed npm version" -FilePath $node -Arguments @($npmCli, "--version") -Quiet
    if ($npmVersion.Stdout.Trim() -ne [string]$script:RuntimeLock.node.npm_version) {
        throw "Managed npm version mismatch: $($npmVersion.Stdout)"
    }

    $packages = @(
        @{ Label = "DingTalk dws"; Name = "dingtalk-workspace-cli"; Root = Join-Path $NodeRoot "node_modules\dingtalk-workspace-cli" },
        @{ Label = "Lark CLI"; Name = "@larksuite/cli"; Root = Join-Path $NodeRoot "node_modules\@larksuite\cli" },
        @{ Label = "Lark whiteboard CLI"; Name = "@larksuite/whiteboard-cli"; Root = Join-Path $NodeRoot "node_modules\@larksuite\whiteboard-cli" }
    )
    foreach ($package in $packages) {
        $manifest = Get-Content -LiteralPath (Join-Path $package.Root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
        $expectedVersion = [string](Get-LxeJsonProperty -Object $script:RuntimeLock.node.packages -Name $package.Name)
        if ([string]$manifest.version -ne $expectedVersion) {
            throw "$($package.Label) version mismatch: $($manifest.version)"
        }
        $bin = Resolve-LxeNodePackageBin -PackageRoot $package.Root
        Invoke-LxeNative -Label "$($package.Label) smoke" -FilePath $node -Arguments @($bin, "--help") -TimeoutSeconds 60 -Quiet | Out-Null
    }

    foreach ($required in @("npm.cmd", "npx.cmd", "npm-cache")) {
        if (-not (Test-Path -LiteralPath (Join-Path $NodeRoot $required))) {
            throw "Managed Node runtime is missing $required."
        }
    }
}

function Test-LxePythonRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$PythonRoot,
        [Parameter(Mandatory = $true)][string]$UvExecutable,
        [Parameter(Mandatory = $true)][string]$PlaywrightRoot
    )

    $python = Join-Path $PythonRoot "python.exe"
    $version = Invoke-LxeNative -Label "managed Python version" -FilePath $python -Arguments @("--version") -Quiet
    $versionText = ($version.Stdout + " " + $version.Stderr).Trim()
    if ($versionText -ne "Python $($script:RuntimeLock.python.version)") {
        throw "Managed Python version mismatch: $versionText"
    }
    $imports = "import importlib.metadata as m; import aiohttp, bs4, openpyxl, pandas, PIL, playwright, requests, selenium, urllib3, xlrd, yaml; assert m.version('playwright') == '$($script:RuntimeLock.playwright.version)'"
    Invoke-LxeNative -Label "managed Python imports" -FilePath $python -Arguments @("-I", "-c", $imports) -TimeoutSeconds 120 -Quiet | Out-Null
    Invoke-LxeNative -Label "managed Python dependency check" -FilePath $UvExecutable -Arguments @("pip", "check", "--python", $python) -TimeoutSeconds 120 -Quiet | Out-Null

    $previousBrowserRoot = $env:PLAYWRIGHT_BROWSERS_PATH
    try {
        $env:PLAYWRIGHT_BROWSERS_PATH = $PlaywrightRoot
        $browserSmoke = "from playwright.sync_api import sync_playwright; p=sync_playwright().start(); b=p.chromium.launch(channel='chromium', headless=True); page=b.new_page(); page.goto('data:text/html,<title>LXE</title>'); assert page.title() == 'LXE'; b.close(); p.stop()"
        Invoke-LxeNative -Label "Playwright Chromium smoke" -FilePath $python -Arguments @("-I", "-c", $browserSmoke) -TimeoutSeconds 120 -Quiet | Out-Null
    }
    finally {
        $env:PLAYWRIGHT_BROWSERS_PATH = $previousBrowserRoot
    }
}

function Assert-LxeRuntimeHasNoCredentials {
    param([Parameter(Mandatory = $true)][string]$Root)

    $forbiddenNames = @(".env", ".env.local", ".npmrc", "auth.json", "credentials.json")
    foreach ($file in @(Get-ChildItem -LiteralPath $Root -File -Recurse -Force)) {
        if ($forbiddenNames -contains $file.Name) {
            throw "Refusing to use a runtime containing a credential file: $($file.FullName)"
        }
    }
    $npmLogs = Join-Path $Root "node\npm-cache\_logs"
    if (Test-Path -LiteralPath $npmLogs) {
        throw "Refusing to use a runtime containing npm download logs: $npmLogs"
    }
}

function Test-LxeRuntimeImage {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [switch]$RequireMarker
    )

    if ($RequireMarker) {
        $markerPath = Join-Path $Root ".lxe-desktop-runtime.json"
        if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
            throw "Managed runtime marker is missing: $markerPath"
        }
        $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([int]$marker.schema_version -ne 1 -or [string]$marker.platform -ne "win32-x64") {
            throw "Managed runtime marker is incompatible: $markerPath"
        }
        if ([string]$marker.lock_sha256 -ne $script:LockSha256) {
            throw "Managed runtime lock fingerprint is stale: $markerPath"
        }
    }

    $smokeHome = Join-Path ([System.IO.Path]::GetTempPath()) ("lxe-desktop-runtime-smoke-" + [Guid]::NewGuid().ToString("N"))
    $isolatedEnvironmentNames = @("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME")
    $previousEnvironment = @{}
    New-Item -ItemType Directory -Path $smokeHome -Force | Out-Null
    foreach ($name in $isolatedEnvironmentNames) {
        $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
        [Environment]::SetEnvironmentVariable($name, $smokeHome, "Process")
    }
    try {
        $nodeRoot = Join-Path $Root "node"
        $pythonRoot = Join-Path $Root "python"
        $uvExecutable = Join-Path $Root "uv\uv.exe"
        $ripgrepExecutable = Join-Path $Root "tools\rg.exe"
        $playwrightRoot = Join-Path $Root "playwright"
        Test-LxeNodeRuntime -NodeRoot $nodeRoot
        Test-LxePythonRuntime -PythonRoot $pythonRoot -UvExecutable $uvExecutable -PlaywrightRoot $playwrightRoot
        $uvVersion = Invoke-LxeNative -Label "managed uv version" -FilePath $uvExecutable -Arguments @("--version") -Quiet
        if ($uvVersion.Stdout -notmatch "^uv $([regex]::Escape([string]$script:RuntimeLock.uv.version))(?:\s|$)") {
            throw "Managed uv version mismatch: $($uvVersion.Stdout)"
        }
        $rgVersion = Invoke-LxeNative -Label "managed ripgrep version" -FilePath $ripgrepExecutable -Arguments @("--version") -Quiet
        $rgFirstLine = @($rgVersion.Stdout -split "`r?`n")[0].Trim()
        $expectedRgVersion = [regex]::Escape([string]$script:RuntimeLock.ripgrep.version)
        if ($rgFirstLine -notmatch "^ripgrep $expectedRgVersion(?: \(rev [0-9a-f]+\))?$") {
            throw "Managed ripgrep version mismatch: $rgFirstLine"
        }
        $rgHash = Get-LxeFileSha256 -Path $ripgrepExecutable
        if ($rgHash -ne [string]$script:RuntimeLock.ripgrep.executable_sha256) {
            throw "Managed ripgrep SHA-256 mismatch: $rgHash"
        }
        Assert-LxeRuntimeHasNoCredentials -Root $Root
    }
    finally {
        foreach ($name in $isolatedEnvironmentNames) {
            [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
        }
        Remove-Item -LiteralPath $smokeHome -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Find-LxeManagedPython {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)

    if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) { return $null }
    foreach ($candidate in @(Get-ChildItem -LiteralPath $InstallRoot -Filter "python.exe" -File -Recurse)) {
        try {
            $version = Invoke-LxeNative -Label "managed Python candidate" -FilePath $candidate.FullName -Arguments @("--version") -Quiet
            $versionText = ($version.Stdout + " " + $version.Stderr).Trim()
            if ($versionText -eq "Python $($script:RuntimeLock.python.version)") {
                return $candidate.FullName
            }
        }
        catch {}
    }
    return $null
}

function Install-LxeNodeRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$WorkRoot
    )

    $archive = Get-LxeCachedArchive -Label "Node $($script:RuntimeLock.node.version)" -Url $script:RuntimeLock.node.archive_url -ExpectedSha256 $script:RuntimeLock.node.archive_sha256
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
    Write-LxeUtf8NoBom -Path (Join-Path $Destination "npm.cmd") -Value "@echo off`r`n`"%~dp0node.exe`" `"%~dp0node_modules\npm\bin\npm-cli.js`" %*`r`n"
    Write-LxeUtf8NoBom -Path (Join-Path $Destination "npx.cmd") -Value "@echo off`r`n`"%~dp0node.exe`" `"%~dp0node_modules\npm\bin\npx-cli.js`" %*`r`n"

    foreach ($cacheArtifact in @("_logs", "_cacache\tmp", "_update-notifier-last-checked", "_timing.json")) {
        $artifactPath = Join-Path $npmCache $cacheArtifact
        if (Test-Path -LiteralPath $artifactPath) {
            Remove-Item -LiteralPath $artifactPath -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Copy-LxeDirectoryContents -Source $npmCache -Destination (Join-Path $Destination "npm-cache")
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
            "--format", "requirements-txt", "--output-file", $requirements
        ) -WorkingDirectory $script:RepositoryRoot -TimeoutSeconds 300 | Out-Null
        $env:UV_PYTHON_DOWNLOADS = "never"
        Invoke-LxeNative -Label "locked Python dependency installation" -FilePath $UvExecutable -Arguments @(
            "pip", "install", "--python", $stagedPython, "--break-system-packages",
            "--require-hashes", "--requirements", $requirements
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

function Install-LxeUvAndRipgrep {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$WorkRoot
    )

    $uvArchive = Get-LxeCachedArchive -Label "uv $($script:RuntimeLock.uv.version)" -Url $script:RuntimeLock.uv.archive_url -ExpectedSha256 $script:RuntimeLock.uv.archive_sha256
    $uvExtract = Join-Path $WorkRoot "uv"
    Expand-LxeArchiveFresh -Archive $uvArchive -Destination $uvExtract
    $uvCandidate = @(Get-ChildItem -LiteralPath $uvExtract -Filter "uv.exe" -File -Recurse | Select-Object -First 1)
    if ($uvCandidate.Count -eq 0) { throw "The pinned uv archive did not contain uv.exe." }
    $uvDestination = Join-Path $Root "uv\uv.exe"
    New-Item -ItemType Directory -Path (Split-Path -Parent $uvDestination) -Force | Out-Null
    Copy-Item -LiteralPath $uvCandidate[0].FullName -Destination $uvDestination -Force

    $rgArchive = Get-LxeCachedArchive -Label "ripgrep $($script:RuntimeLock.ripgrep.version)" -Url $script:RuntimeLock.ripgrep.archive_url -ExpectedSha256 $script:RuntimeLock.ripgrep.archive_sha256
    $rgExtract = Join-Path $WorkRoot "ripgrep"
    Expand-LxeArchiveFresh -Archive $rgArchive -Destination $rgExtract
    $rgCandidate = @(Get-ChildItem -LiteralPath $rgExtract -Filter "rg.exe" -File -Recurse | Select-Object -First 1)
    if ($rgCandidate.Count -eq 0) { throw "The pinned ripgrep archive did not contain rg.exe." }
    $rgHash = Get-LxeFileSha256 -Path $rgCandidate[0].FullName
    if ($rgHash -ne [string]$script:RuntimeLock.ripgrep.executable_sha256) {
        throw "The pinned ripgrep executable SHA-256 is invalid: $rgHash"
    }
    $rgDestination = Join-Path $Root "tools\rg.exe"
    New-Item -ItemType Directory -Path (Split-Path -Parent $rgDestination) -Force | Out-Null
    Copy-Item -LiteralPath $rgCandidate[0].FullName -Destination $rgDestination -Force
}

function Write-LxeRuntimeMarker {
    param([Parameter(Mandatory = $true)][string]$Root)

    $marker = [ordered]@{
        schema_version = 1
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
        Test-LxeRuntimeImage -Root $script:ResolvedRuntimeRoot -RequireMarker
        Write-LxeRuntimeMarker -Root $script:ResolvedRuntimeRoot
        Write-LxeRuntimeDescriptor -Root $script:ResolvedRuntimeRoot
        Write-Host "Reusing validated desktop runtime: $script:ResolvedRuntimeRoot"
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
            Test-LxeRuntimeImage -Root $stagedRoot -RequireMarker
            $usedCachedImage = $true
            Write-Host "Reusing validated cached runtime image: $runtimeImageCache"
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
        Install-LxeUvAndRipgrep -Root $stagedRoot -WorkRoot $workRoot
        Install-LxeNodeRuntime -Destination (Join-Path $stagedRoot "node") -WorkRoot $workRoot
        Install-LxePythonRuntime -Destination (Join-Path $stagedRoot "python") -UvExecutable (Join-Path $stagedRoot "uv\uv.exe") -WorkRoot $workRoot
        Install-LxePlaywrightBrowser -PythonRoot (Join-Path $stagedRoot "python") -Destination (Join-Path $stagedRoot "playwright")
        Test-LxeRuntimeImage -Root $stagedRoot
        Write-LxeRuntimeMarker -Root $stagedRoot
        Test-LxeRuntimeImage -Root $stagedRoot -RequireMarker
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
