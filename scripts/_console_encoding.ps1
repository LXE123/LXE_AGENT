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
    foreach ($line in (Read-LxeProcessOutputFile -Path $Path)) {
        Write-Host $line
    }
}

function Read-LxeProcessOutputFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @()
    }
    return @(Get-Content -LiteralPath $Path -Encoding UTF8)
}

function Add-LxeQuotedBackslashes {
    param(
        [Parameter(Mandatory = $true)][System.Text.StringBuilder]$Builder,
        [Parameter(Mandatory = $true)][int]$Count
    )
    for ($index = 0; $index -lt $Count; $index++) {
        [void]$Builder.Append('\')
    }
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

function Write-LxeNativeResultOutput {
    param([Parameter(Mandatory = $true)]$Result)
    foreach ($line in @($Result.Stdout)) {
        Write-Host $line
    }
    foreach ($line in @($Result.Stderr)) {
        Write-Host $line
    }
}

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

function Invoke-LxeNativeCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )

    $result = Invoke-LxeNativeCapture -FilePath $FilePath -Arguments $Arguments
    Write-LxeNativeResultOutput -Result $result
    return $result.ExitCode
}
