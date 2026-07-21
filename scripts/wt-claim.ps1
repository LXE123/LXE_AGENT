[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Command,
    [Parameter(Position = 1)][string]$TaskSlug
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-LxeGit {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$AllowFailure
    )

    $output = @(& git -C $WorkingDirectory @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
    }
    return [PSCustomObject]@{ ExitCode = $exitCode; Output = $output }
}

function Get-LxeSlotSlug([string]$Directory) {
    $claimPath = "$Directory.claim"
    if (-not (Test-Path -LiteralPath $claimPath -PathType Leaf)) { return "" }
    return (Get-Content -LiteralPath $claimPath -Raw -Encoding UTF8).Trim()
}

function Get-LxeSlotBranch([string]$Directory) {
    $result = Invoke-LxeGit -WorkingDirectory $Directory -Arguments @("branch", "--show-current") -AllowFailure
    if ($result.ExitCode -ne 0) { return "" }
    return ([string]($result.Output -join "")).Trim()
}

function Test-LxeSlotDirty([string]$Directory) {
    $result = Invoke-LxeGit -WorkingDirectory $Directory -Arguments @("status", "--porcelain")
    return -not [string]::IsNullOrWhiteSpace([string]($result.Output -join ""))
}

function Sync-LxeWorktreeDependencies([string]$Directory) {
    $started = [DateTime]::UtcNow
    Push-Location $Directory
    try {
        & bun install --frozen-lockfile | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "bun install --frozen-lockfile failed with exit code $LASTEXITCODE" }
        & uv sync --frozen | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "uv sync --frozen failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }
    $seconds = [math]::Round(([DateTime]::UtcNow - $started).TotalSeconds, 1)
    Write-Output "deps synced in ${seconds}s (bun install + uv sync, warm caches)"
}

try {
    $commonResult = @(& git rev-parse --path-format=absolute --git-common-dir 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "not inside a Git repository: $($commonResult -join [Environment]::NewLine)" }
    $mainRoot = Split-Path -Parent ([string]($commonResult -join "")).Trim()
    $poolRoot = Join-Path $mainRoot ".worktrees"
    $maxSlots = if ([string]::IsNullOrWhiteSpace($env:WT_POOL_MAX)) { 4 } else { [int]$env:WT_POOL_MAX }

    if ($Command -eq "status") {
        for ($index = 1; $index -le $maxSlots; $index += 1) {
            $directory = Join-Path $poolRoot "pool-$index"
            if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
                Write-Output "pool-$index  (not created)"
                continue
            }
            $slug = Get-LxeSlotSlug $directory
            $branch = Get-LxeSlotBranch $directory
            $state = if ($slug) { "claimed: $slug" } else { "idle" }
            if (Test-LxeSlotDirty $directory) { $state = "$state, dirty" }
            if (-not $branch) { $branch = "detached" }
            Write-Output "pool-$index  $branch  $state"
        }
        exit 0
    }

    if ($Command -eq "release") {
        if ([string]::IsNullOrWhiteSpace($TaskSlug)) { throw "usage: wt-claim release <task-slug>" }
        for ($index = 1; $index -le $maxSlots; $index += 1) {
            $directory = Join-Path $poolRoot "pool-$index"
            if (-not (Test-Path -LiteralPath $directory -PathType Container)) { continue }
            if ((Get-LxeSlotSlug $directory) -ne $TaskSlug) { continue }
            if (Test-LxeSlotDirty $directory) { throw "pool-$index has uncommitted changes; commit or discard them first" }
            $branch = Get-LxeSlotBranch $directory
            Invoke-LxeGit -WorkingDirectory $directory -Arguments @("checkout", "--quiet", "--detach", "main") | Out-Null
            Remove-Item -LiteralPath "$directory.claim" -Force
            if ($branch) {
                $deleteResult = Invoke-LxeGit -WorkingDirectory $mainRoot -Arguments @("branch", "-d", $branch) -AllowFailure
                if ($deleteResult.ExitCode -ne 0) {
                    Write-Output "note: branch $branch is not merged into main; kept (delete manually once merged)"
                }
            }
            Write-Output "released pool-$index"
            exit 0
        }
        throw "no slot claimed by: $TaskSlug"
    }

    $slug = $Command
    if ([string]::IsNullOrWhiteSpace($slug)) { throw "usage: wt-claim <task-slug> | release <task-slug> | status" }
    if ($slug -notmatch "^[a-z0-9][a-z0-9-]*$") { throw "task slug must be kebab-case: $slug" }
    $branchName = "codex/$slug"

    for ($index = 1; $index -le $maxSlots; $index += 1) {
        $directory = Join-Path $poolRoot "pool-$index"
        if ((Test-Path -LiteralPath $directory -PathType Container) -and (Get-LxeSlotSlug $directory) -eq $slug) {
            Sync-LxeWorktreeDependencies $directory
            Write-Output "resumed pool-$index on $(Get-LxeSlotBranch $directory)"
            Write-Output $directory
            exit 0
        }
    }

    $branchResult = Invoke-LxeGit -WorkingDirectory $mainRoot -Arguments @("show-ref", "--verify", "--quiet", "refs/heads/$branchName") -AllowFailure
    if ($branchResult.ExitCode -eq 0) { throw "branch $branchName already exists; pick a new slug or release/finish the old task" }

    for ($index = 1; $index -le $maxSlots; $index += 1) {
        $directory = Join-Path $poolRoot "pool-$index"
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            Invoke-LxeGit -WorkingDirectory $mainRoot -Arguments @("worktree", "add", "--detach", $directory, "main") | Out-Null
        }
        elseif (Get-LxeSlotSlug $directory) {
            continue
        }
        elseif (Test-LxeSlotDirty $directory) {
            Write-Warning "skipping pool-$index (dirty but unclaimed - inspect manually)"
            continue
        }
        Invoke-LxeGit -WorkingDirectory $directory -Arguments @("checkout", "--quiet", "-b", $branchName, "main") | Out-Null
        [System.IO.File]::WriteAllText("$directory.claim", "$slug`n", [System.Text.UTF8Encoding]::new($false))
        Sync-LxeWorktreeDependencies $directory
        Write-Output "claimed pool-$index on $branchName"
        Write-Output $directory
        exit 0
    }
    throw "no idle slot (max $maxSlots); release a finished task or raise WT_POOL_MAX"
}
catch {
    [Console]::Error.WriteLine("wt-claim: $($_.Exception.Message)")
    exit 1
}
