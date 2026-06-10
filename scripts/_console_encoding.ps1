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
