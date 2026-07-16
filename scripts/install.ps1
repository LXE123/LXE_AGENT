param(
    [string]$RepoUrl = "https://github.com/LXE123/LXE_AGENT.git",
    [string]$Ref = "lxe-agent-TUI",
    [string]$InstallDir = "",
    [switch]$NoPath,
    [switch]$AllowZipFallback,
    [switch]$SkipDws
)

$ErrorActionPreference = "Stop"

# Compatibility entrypoint for historical raw URLs. The source-installed
# product now lives exclusively on lxe-agent-TUI; desktop main has no CLI.
if ($Ref -eq "main") {
    throw "The main branch is desktop-only. Use -Ref lxe-agent-TUI for source installation."
}

$repository = $RepoUrl.Trim().TrimEnd([char[]]"/")
if ($repository.EndsWith(".git")) {
    $repository = $repository.Substring(0, $repository.Length - 4)
}
$match = [regex]::Match($repository, "^https://github\.com/(?<owner>[^/]+)/(?<repo>[^/]+)$")
if (-not $match.Success) {
    $match = [regex]::Match($repository, "^git@github\.com:(?<owner>[^/]+)/(?<repo>[^/]+)$")
}
if (-not $match.Success) {
    throw "Unsupported GitHub repository URL: $RepoUrl"
}

$url = "https://raw.githubusercontent.com/{0}/{1}/{2}/scripts/install.ps1" -f `
    $match.Groups["owner"].Value, $match.Groups["repo"].Value, $Ref
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("lxe-tui-install-" + [Guid]::NewGuid().ToString("N") + ".ps1")
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $temporary
    $forward = @("-RepoUrl", $RepoUrl, "-Ref", $Ref)
    if ($InstallDir) { $forward += @("-InstallDir", $InstallDir) }
    if ($NoPath) { $forward += "-NoPath" }
    if ($AllowZipFallback) { $forward += "-AllowZipFallback" }
    if ($SkipDws) { $forward += "-SkipDws" }
    & powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $temporary @forward
    exit $LASTEXITCODE
}
finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}
