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

function Write-LxeProcessOutputFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return
    }
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        Write-Host $line
    }
}

function Invoke-LxeNativeCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )

    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()
    try {
        & $FilePath @Arguments 1> $stdoutPath 2> $stderrPath
        $exitCode = $LASTEXITCODE
        Write-LxeProcessOutputFile -Path $stdoutPath
        Write-LxeProcessOutputFile -Path $stderrPath
        return $exitCode
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
