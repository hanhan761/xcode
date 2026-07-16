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
    [void](Get-XcodeOfficeState)
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js is unavailable. Reinstall xcode with npm, then open a new PowerShell window.' }
    $client = Join-Path $RepositoryRoot 'bin\session-client.js'
    if (-not (Test-Path -LiteralPath $client -PathType Leaf)) { throw 'The collaborative session client is missing. Run xcode update.' }
    $sshConfig = Join-Path $env:LOCALAPPDATA 'XcodeRemote\ssh_config'
    if (-not (Test-Path -LiteralPath $sshConfig -PathType Leaf)) { throw 'This office laptop is not paired. Run xcode pair first.' }
    & $node.Source $client --ssh-config $sshConfig
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
                    [string]$_.CommandLine -match '(?i)xcode-remote[\\/]bin[\\/]managed-codex\.js'
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

function Update-XcodePackage {
    $activeManagedSessions = @(Get-XcodeActiveManagedSessionProcesses)
    if ($activeManagedSessions.Count -gt 0) {
        $processIds = ($activeManagedSessions.ProcessId -join ', ')
        throw "xcode update is paused because $($activeManagedSessions.Count) managed Codex session(s) are active (Node PID: $processIds). Save them if needed, close their terminal tabs so managed-codex.js exits, then rerun xcode update. Windows cannot replace node-pty while those sessions are open."
    }

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { throw 'npm is required for xcode update. Install Node.js 18 or newer, then run the command again.' }

    Write-XcodeStep 'Updating xcode from GitHub'
    & $npm.Source install --global 'github:hanhan761/xcode#main'
    if ($LASTEXITCODE -ne 0) { throw "npm could not update xcode (exit $LASTEXITCODE)." }
    # Versions before the npm package placed a WezTerm-only xcode.cmd in this
    # directory. It can shadow the npm command in older user PATHs.
    Remove-XcodePathEntry -Directory (Join-Path $env:LOCALAPPDATA 'XcodeRemote\bin')
    Write-Host 'xcode is updated. The legacy local launcher was removed from your PATH; open a new PowerShell window before your next xcode command.' -ForegroundColor Green
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
                $arguments = @($Command | Select-Object -Skip 2)
                if ($arguments.Count -and $arguments[0] -eq '--') { $arguments = @($arguments | Select-Object -Skip 1) }
                Start-XcodeManagedCodex -CodexArguments $arguments
            }
            'pair' {
                if ($Command.Count -ne 1) { throw 'The main PC pairing command takes no host argument: xcode pair' }
                & (Join-Path $PSScriptRoot 'pair-office.ps1')
            }
            'status' {
                Get-Content -Raw -LiteralPath (Join-Path $env:LOCALAPPDATA 'XcodeRemote\host-user.json')
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
            'pair' {
                if ($Command.Count -gt 2) { throw 'Usage: xcode pair [main-host]' }
                $mainHost = if ($Command.Count -eq 2) { $Command[1] } else { 'xcode-main' }
                & (Join-Path $PSScriptRoot 'install-office.ps1') -PairOnly -MainHost $mainHost
            }
            'status' {
                $statePath = Join-Path $env:LOCALAPPDATA 'XcodeRemote\client.json'
                if (Test-Path -LiteralPath $statePath -PathType Leaf) { Get-Content -Raw -LiteralPath $statePath }
                else { Write-Host 'Office role: prepared; pairing: not yet completed.' -ForegroundColor Yellow }
            }
            'doctor' { Invoke-XcodeOfficeDoctor }
            'unpair' { throw 'Run xcode unpair on the main PC to revoke this office laptop.' }
            default { throw "Unknown office-laptop xcode command: $verb. Run xcode help." }
        }
    }
}
