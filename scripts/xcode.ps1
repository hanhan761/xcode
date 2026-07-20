[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)][string[]]$Command = @(),
    [string]$RepositoryRoot = '',
    [ValidateSet('auto', 'main', 'office')][string]$Role = 'auto'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $RepositoryRoot) { $RepositoryRoot = Split-Path -Parent $PSCommandPath }
$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
. (Join-Path $PSScriptRoot 'XcodeRemote.Common.ps1')

function Show-XcodeUsage {
    Write-Host @"
xcode - collaborative Codex sessions

First run from this repository:
  xcode main                 Set up this main PC and open office pairing
  xcode office               Set up this office laptop and complete pairing

After setup:
  codex                 Main PC: start or resume a collaborative Codex session
  xcode                 Office laptop: observe and send messages to a Codex session
  xcode -aa             Office laptop: open every active main-PC conversation
  xcode pair [host]     Create (main) or join (office) a one-time pairing
  xcode status          Show this machine's xcode role and pairing state
  xcode doctor          Verify an office laptop's secure connection
  xcode unpair          Remove an office-laptop key from the main PC
  xcode update          Install the latest xcode release from GitHub
"@
}

function Get-XcodeInstalledRole {
    if ($Role -ne 'auto') { return $Role }

    $installRoot = Join-Path $env:LOCALAPPDATA 'XcodeRemote'
    $mainState = Join-Path $installRoot 'host-user.json'
    $officeSetupState = Join-Path $installRoot 'office-setup.json'
    $officeClientState = Join-Path $installRoot 'client.json'
    # A machine explicitly prepared as an office laptop must not be shadowed
    # by a stale user-level main-PC marker from an earlier mistaken setup.
    if ((Test-Path -LiteralPath $officeClientState -PathType Leaf) -or (Test-Path -LiteralPath $officeSetupState -PathType Leaf)) { return 'office' }
    if (Test-Path -LiteralPath $mainState -PathType Leaf) { return 'main' }
    throw 'This PC has not been prepared for xcode. From the repository run .\xcode setup main or .\xcode setup office.'
}

function Get-XcodeOfficeState {
    $statePath = Join-Path (Join-Path $env:LOCALAPPDATA 'XcodeRemote') 'client.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw 'This office laptop is prepared but not paired. Run xcode pair after the main PC runs xcode pair.'
    }
    return (Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json)
}

function Start-XcodeManagedCodex {
    param([string[]]$CodexArguments = @())
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js is unavailable. Reinstall Codex and xcode with npm, then open a new PowerShell window.' }
    $runner = Join-Path $RepositoryRoot 'bin\managed-codex.js'
    if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw 'The managed Codex runner is missing. Run xcode update.' }
    & $node.Source $runner @CodexArguments
    exit $LASTEXITCODE
}

function Connect-XcodeOfficeSharedTerminal {
    param(
        [switch]$AttachAll,
        [string]$SessionId = '',
        [string]$AttachmentToken = ''
    )
    [void](Get-XcodeOfficeState)
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js is unavailable. Reinstall xcode with npm, then open a new PowerShell window.' }
    $client = Join-Path $RepositoryRoot 'bin\session-client.js'
    if (-not (Test-Path -LiteralPath $client -PathType Leaf)) { throw 'The collaborative session client is missing. Run xcode update.' }
    $sshConfig = Join-Path $env:LOCALAPPDATA 'XcodeRemote\ssh_config'
    if (-not (Test-Path -LiteralPath $sshConfig -PathType Leaf)) { throw 'This office laptop is not paired. Run xcode pair first.' }
    $arguments = @('--ssh-config', $sshConfig)
    if ($AttachAll) { $arguments += '--attach-all' }
    if ($SessionId) { $arguments += @('--session-id', $SessionId) }
    if ($AttachmentToken) { $arguments += @('--attachment-token', $AttachmentToken) }
    & $node.Source $client @arguments
}

function Invoke-XcodeOfficeDoctor {
    $installRoot = Join-Path $env:LOCALAPPDATA 'XcodeRemote'
    $state = Get-XcodeOfficeState
    $tailscale = Get-XcodeTailscaleExecutable
    $ssh = Get-XcodeOpenSshExecutable -Name 'ssh.exe'
    if (-not $tailscale -or -not $ssh) { throw 'The office prerequisites are missing. Run xcode setup office.' }
    $sshConfig = Join-Path $installRoot 'ssh_config'
    if (-not (Test-Path -LiteralPath $sshConfig -PathType Leaf)) { throw 'The pinned office SSH configuration is missing.' }

    Write-Host '[1/3] Tailscale status'
    & $tailscale status
    if ($LASTEXITCODE -ne 0) { throw 'Tailscale status failed.' }
    Write-Host "`n[2/3] Pinned xcode gateway"
    & $ssh -F $sshConfig -o BatchMode=yes xcode-main xcode-gateway probe
    if ($LASTEXITCODE -ne 0) { throw 'Pinned SSH verification failed.' }
    Write-Host "`n[3/3] Managed Codex sessions"
    & $ssh -F $sshConfig -o BatchMode=yes xcode-main xcode-gateway list
    if ($LASTEXITCODE -ne 0) { throw 'Managed-session availability verification failed.' }
}

function Get-XcodeActiveManagedSessionProcesses {
    try {
        return @(
            Get-CimInstance Win32_Process -ErrorAction Stop |
                Where-Object {
                    $_.Name -ieq 'node.exe' -and
                    [string]$_.CommandLine -match '(?i)xcode-remote[\\/]bin[\\/](?:managed-codex|session-client)\.js'
                } |
                ForEach-Object {
                    [pscustomobject]@{
                        ProcessId = [int]$_.ProcessId
                        CommandLine = [string]$_.CommandLine
                    }
                }
        )
    }
    catch { return @() }
}

function Get-XcodeReleaseInstallation {
    param([string]$InstallationRoot = $RepositoryRoot)

    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js is unavailable. Reinstall xcode with npm, then open a new PowerShell window.' }
    $reporter = Join-Path $InstallationRoot 'bin\codex-installation.js'
    if (-not (Test-Path -LiteralPath $reporter -PathType Leaf)) { throw 'The Codex installation verifier is missing. Run xcode update.' }

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = (& $node.Source $reporter --json 2>&1 | Out-String)
        $exitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousErrorActionPreference }
    if ($exitCode -ne 0) {
        $detail = $output.Trim()
        $message = 'xcode could not verify its official Codex installation'
        if ($detail) { $message += ': ' + $detail }
        else { $message += '.' }
        throw $message
    }
    try { $report = $output | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'xcode received an invalid official Codex installation report. Run xcode update.' }
    if (-not $report.xcodeVersion -or -not $report.codex -or -not $report.codex.version -or
        [string]$report.codex.source -notin @('release-payload', 'explicit-override')) {
        throw 'xcode received an incomplete official Codex installation report. Run xcode update.'
    }
    return $report
}

function Write-XcodeReleaseStatus {
    param([string]$InstallationRoot = $RepositoryRoot)

    $report = Get-XcodeReleaseInstallation -InstallationRoot $InstallationRoot
    Write-Host "xcode version : $($report.xcodeVersion)"
    Write-Host "Codex version : $($report.codex.version)"
    Write-Host "Codex source  : $($report.codex.source)"
    return $report
}

function Get-XcodeGlobalPackageRoot {
    param([Parameter(Mandatory = $true)]$Npm)

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = (& $Npm.Source root --global | Out-String)
        $exitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousErrorActionPreference }
    if ($exitCode -ne 0 -or -not $output.Trim()) {
        throw 'npm could not locate the globally installed xcode release after updating it.'
    }
    $packageRoot = Join-Path $output.Trim() 'xcode-remote'
    if (-not (Test-Path -LiteralPath $packageRoot -PathType Container)) {
        throw 'npm updated xcode but its global xcode-remote package directory is unavailable.'
    }
    return (Resolve-Path -LiteralPath $packageRoot).Path
}

function Update-XcodePackage {
    $activeManagedSessions = @(Get-XcodeActiveManagedSessionProcesses)
    if ($activeManagedSessions.Count -gt 0) {
        $processIds = ($activeManagedSessions.ProcessId -join ', ')
        throw "xcode update is paused because $($activeManagedSessions.Count) xcode-managed Codex session(s) are active (Node PID: $processIds). Save them if needed, close their terminal tabs so the local xcode session exits, then rerun xcode update. Windows cannot replace node-pty while those sessions are open."
    }

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { throw 'npm is required for xcode update. Install Node.js 18 or newer, then run the command again.' }

    $currentReleaseRoot = Get-XcodeGlobalPackageRoot -Npm $npm
    $backupRoot = Join-Path (Split-Path -Parent $currentReleaseRoot) ('.xcode-remote-backup-' + [guid]::NewGuid().ToString('N'))
    $preserveBackup = $false
    Copy-Item -LiteralPath $currentReleaseRoot -Destination $backupRoot -Recurse -Force -ErrorAction Stop

    Write-XcodeStep 'Updating xcode from GitHub'
    try {
        # The package version can remain unchanged between GitHub main commits.
        # Force npm to fetch the remote Git source instead of retaining a cached
        # global package with the same manifest version.
        & $npm.Source install --global --force 'github:hanhan761/xcode#main'
        if ($LASTEXITCODE -ne 0) { throw "npm could not update xcode (exit $LASTEXITCODE)." }
        $updatedReleaseRoot = Get-XcodeGlobalPackageRoot -Npm $npm
        $report = Write-XcodeReleaseStatus -InstallationRoot $updatedReleaseRoot
    }
    catch {
        $updateFailure = $_
        try {
            if (Test-Path -LiteralPath $currentReleaseRoot) { Remove-Item -LiteralPath $currentReleaseRoot -Recurse -Force -ErrorAction Stop }
            Move-Item -LiteralPath $backupRoot -Destination $currentReleaseRoot -ErrorAction Stop
            $backupRoot = $null
        }
        catch {
            $preserveBackup = $true
            throw "xcode update failed: $($updateFailure.Exception.Message) The previous release could not be restored; its backup remains at $backupRoot."
        }
        throw $updateFailure
    }
    finally {
        if (-not $preserveBackup -and $backupRoot -and (Test-Path -LiteralPath $backupRoot)) {
            Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    # Versions before the npm package placed a WezTerm-only xcode.cmd in this
    # directory. It can shadow the npm command in older user PATHs.
    Remove-XcodePathEntry -Directory (Join-Path $env:LOCALAPPDATA 'XcodeRemote\bin')
    Write-Host "xcode is updated with verified Codex $($report.codex.version) ($($report.codex.source)). The legacy local launcher was removed from your PATH; open a new PowerShell window before your next xcode command." -ForegroundColor Green
}

$verb = if ($Command.Count -eq 0) { '' } else { $Command[0].ToLowerInvariant() }
if ($verb -in @('help', '--help', '-h', '/?')) {
    Show-XcodeUsage
    exit 0
}

if ($verb -eq 'update') {
    if ($Command.Count -ne 1) { throw 'Usage: xcode update' }
    Update-XcodePackage
    exit 0
}

if ($verb -eq 'main') {
    if ($Command.Count -ne 1) { throw 'Usage: xcode main' }
    & (Join-Path $PSScriptRoot 'install-main.ps1')
    exit $LASTEXITCODE
}

if ($verb -eq 'office') {
    if ($Command.Count -ne 1) { throw 'Usage: xcode office' }
    & (Join-Path $PSScriptRoot 'install-office.ps1')
    exit $LASTEXITCODE
}

if ($verb -eq 'setup') {
    if ($Command.Count -ne 2 -or $Command[1].ToLowerInvariant() -notin @('main', 'office')) {
        throw 'Usage: .\xcode setup main  or  .\xcode setup office'
    }
    if ($Command[1].ToLowerInvariant() -eq 'main') {
        & (Join-Path $PSScriptRoot 'install-main.ps1') -SkipPairing
    }
    else {
        & (Join-Path $PSScriptRoot 'install-office.ps1') -SetupOnly
    }
    exit $LASTEXITCODE
}

$installedRole = Get-XcodeInstalledRole
switch ($installedRole) {
    'main' {
        switch ($verb) {
            '' {
                Write-Host 'This is the main PC. Start or resume your normal Codex conversation with: codex' -ForegroundColor Cyan
            }
            'share' { Write-Host 'Managed Codex sessions are shared automatically. Start one with: codex' -ForegroundColor Cyan }
            'session' {
                if ($Command.Count -lt 2 -or $Command[1].ToLowerInvariant() -ne 'run') { throw 'Usage: xcode session run [codex arguments]' }
                # Upgrading replaces this dispatcher before it can replace the
                # already-loaded 1.4.11 profile wrapper. Repair it on the first
                # post-update Codex launch without requiring setup or UAC.
                $profileRepair = Install-XcodeManagedCodexProfileEntrypoint -ProfilePath $PROFILE.CurrentUserAllHosts
                $arguments = @($Command | Select-Object -Skip 2)
                if ($arguments.Count -and $arguments[0] -eq '--') { $arguments = @($arguments | Select-Object -Skip 1) }
                $arguments = @(Resolve-XcodeManagedCodexArguments -Arguments $arguments -HadLegacyZeroArgumentBug:$profileRepair.HadLegacyZeroArgumentBug)
                Start-XcodeManagedCodex -CodexArguments $arguments
            }
            'pair' {
                if ($Command.Count -ne 1) { throw 'The main PC pairing command takes no host argument: xcode pair' }
                & (Join-Path $PSScriptRoot 'pair-office.ps1')
            }
            'status' {
                Get-Content -Raw -LiteralPath (Join-Path $env:LOCALAPPDATA 'XcodeRemote\host-user.json')
                Write-XcodeReleaseStatus | Out-Null
            }
            'unpair' {
                & (Join-Path $PSScriptRoot 'unpair-office.ps1')
            }
            default { throw "Unknown main-PC xcode command: $verb. Run xcode help." }
        }
    }
    'office' {
        switch ($verb) {
            '' { Connect-XcodeOfficeSharedTerminal }
            'attach' { Connect-XcodeOfficeSharedTerminal }
            '-aa' {
                if ($Command.Count -ne 1) { throw 'Usage: xcode -aa' }
                Connect-XcodeOfficeSharedTerminal -AttachAll
            }
            '-a' {
                if ($Command.Count -ne 3) { throw 'Usage: xcode -a <session-id> <attachment-token>' }
                Connect-XcodeOfficeSharedTerminal -SessionId $Command[1] -AttachmentToken $Command[2]
            }
            'pair' {
                if ($Command.Count -gt 2) { throw 'Usage: xcode pair [main-host]' }
                $mainHost = if ($Command.Count -eq 2) { $Command[1] } else { 'xcode-main' }
                & (Join-Path $PSScriptRoot 'install-office.ps1') -PairOnly -MainHost $mainHost
            }
            'status' {
                $statePath = Join-Path $env:LOCALAPPDATA 'XcodeRemote\client.json'
                if (Test-Path -LiteralPath $statePath -PathType Leaf) { Get-Content -Raw -LiteralPath $statePath }
                else { Write-Host 'Office role: prepared; pairing: not yet completed.' -ForegroundColor Yellow }
                Write-XcodeReleaseStatus | Out-Null
            }
            'doctor' { Invoke-XcodeOfficeDoctor }
            'unpair' { throw 'Run xcode unpair on the main PC to revoke this office laptop.' }
            default { throw "Unknown office-laptop xcode command: $verb. Run xcode help." }
        }
    }
}
