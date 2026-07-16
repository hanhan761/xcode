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
xcode - one shared PowerShell workspace

First run from this repository:
  .\xcode setup main
  .\xcode setup office

After setup:
  xcode                 Attach to this machine's xcode workspace
  xcode pair [host]     Create (main) or join (office) a one-time pairing
  xcode status          Show this machine's xcode role and pairing state
  xcode doctor          Verify an office laptop's secure connection
  xcode ssh             Open an emergency SSH shell from an office laptop
  xcode unpair          Remove an office-laptop key from the main PC
  xcode update          Install the latest xcode release from GitHub
"@
}

function Get-XcodeInstalledRole {
    if ($Role -ne 'auto') { return $Role }

    $installRoot = Join-Path $env:LOCALAPPDATA 'XcodeRemote'
    $mainState = Join-Path $installRoot 'host-user.json'
    $officeSetupState = Join-Path $installRoot 'office-setup.json'
    if (Test-Path -LiteralPath $mainState -PathType Leaf) { return 'main' }
    if (Test-Path -LiteralPath $officeSetupState -PathType Leaf) { return 'office' }
    throw 'This PC has not been prepared for xcode. From the repository run .\xcode setup main or .\xcode setup office.'
}

function Get-XcodeOfficeState {
    $statePath = Join-Path (Join-Path $env:LOCALAPPDATA 'XcodeRemote') 'client.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw 'This office laptop is prepared but not paired. Run xcode pair after the main PC runs xcode pair.'
    }
    return (Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json)
}

function Connect-XcodeOfficeWorkspace {
    $installRoot = Join-Path $env:LOCALAPPDATA 'XcodeRemote'
    [void](Get-XcodeOfficeState)
    $wezterm = Get-XcodeWezTermExecutable
    if (-not $wezterm) { throw 'WezTerm is unavailable. Run xcode setup office to repair this laptop.' }
    $config = Join-Path $installRoot 'office-wezterm.lua'
    if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
        throw 'The office WezTerm configuration is missing. Run xcode pair to repair the pairing.'
    }
    & $wezterm --config-file $config connect XCODE_MAIN
}

function Invoke-XcodeOfficeDoctor {
    $installRoot = Join-Path $env:LOCALAPPDATA 'XcodeRemote'
    $state = Get-XcodeOfficeState
    $tailscale = Get-XcodeTailscaleExecutable
    $ssh = Get-XcodeOpenSshExecutable -Name 'ssh.exe'
    if (-not $tailscale -or -not $ssh) { throw 'The office prerequisites are missing. Run xcode setup office.' }
    $sshConfig = Join-Path $installRoot 'ssh_config'
    if (-not (Test-Path -LiteralPath $sshConfig -PathType Leaf)) { throw 'The pinned office SSH configuration is missing.' }

    Write-Host '[1/4] Tailscale status'
    & $tailscale status
    if ($LASTEXITCODE -ne 0) { throw 'Tailscale status failed.' }
    Write-Host "`n[2/4] Key-only, pinned-host SSH"
    & $ssh -F $sshConfig -o BatchMode=yes xcode-main 'echo XCODE_SSH_OK'
    if ($LASTEXITCODE -ne 0) { throw 'Pinned SSH verification failed.' }
    Write-Host "`n[3/4] Matching remote WezTerm"
    & $ssh -F $sshConfig -o BatchMode=yes xcode-main ([string]$state.remoteWezTermPath + ' --version')
    if ($LASTEXITCODE -ne 0) { throw 'Remote WezTerm version verification failed.' }
    Write-Host "`n[4/4] Persistent host mux"
    & $ssh -F $sshConfig -o BatchMode=yes xcode-main ([string]$state.remoteWezTermPath + ' cli --prefer-mux list --format json')
    if ($LASTEXITCODE -ne 0) { throw 'Host mux verification failed.' }
}

function Update-XcodePackage {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { throw 'npm is required for xcode update. Install Node.js 18 or newer, then run the command again.' }

    Write-XcodeStep 'Updating xcode from GitHub'
    & $npm.Source install --global 'github:hanhan761/xcode#main'
    if ($LASTEXITCODE -ne 0) { throw "npm could not update xcode (exit $LASTEXITCODE)." }
    Write-Host 'xcode is updated. Open a new PowerShell window before your next xcode command.' -ForegroundColor Green
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
                $wezterm = Get-XcodeWezTermExecutable
                if (-not $wezterm) { throw 'WezTerm is unavailable. Run xcode setup main to repair this PC.' }
                & $wezterm connect xcode-shared-mux
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
            '' { Connect-XcodeOfficeWorkspace }
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
            'ssh' {
                [void](Get-XcodeOfficeState)
                $ssh = Get-XcodeOpenSshExecutable -Name 'ssh.exe'
                if (-not $ssh) { throw 'Windows OpenSSH Client is unavailable. Run xcode setup office.' }
                & $ssh -F (Join-Path $env:LOCALAPPDATA 'XcodeRemote\ssh_config') xcode-main
            }
            'unpair' { throw 'Run xcode unpair on the main PC to revoke this office laptop.' }
            default { throw "Unknown office-laptop xcode command: $verb. Run xcode help." }
        }
    }
}
