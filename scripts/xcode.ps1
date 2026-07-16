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
xcode - one shared PowerShell terminal workspace

First run from this repository:
  .\xcode setup main
  .\xcode setup office

After setup:
  xcode                 Share (main) or attach to (office) the terminal workspace
  xcode share           Start the main-PC terminal-workspace broker
  xcode attach          Select and attach to a terminal in the main-PC workspace
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

function Start-XcodeWorkspaceShare {
    $brokerScript = Join-Path $PSScriptRoot 'console-workspace-broker.ps1'
    if (-not (Test-Path -LiteralPath $brokerScript -PathType Leaf)) { throw 'The terminal workspace broker is missing. Run xcode update.' }
    $statePath = Join-Path $env:LOCALAPPDATA 'XcodeRemote\console-workspace.json'
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        try {
            $existing = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
            if ($existing.brokerProcessId -and (Get-Process -Id ([int]$existing.brokerProcessId) -ErrorAction SilentlyContinue)) {
                Write-Host "The terminal workspace is already shared. Office laptops can run xcode now." -ForegroundColor Green
                return
            }
        }
        catch {}
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    }

    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $process = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $brokerScript, '-StatePath', $statePath) -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 100
        if (Test-Path -LiteralPath $statePath -PathType Leaf) {
            try {
                $workspace = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
                if (@($workspace.sessions).Count -gt 0) { break }
            }
            catch {}
        }
    } while ((Get-Date) -lt $deadline -and -not $process.HasExited)
    if ($process.HasExited) {
        throw "The terminal workspace broker could not start (exit $($process.ExitCode))."
    }
    Write-Host 'This terminal workspace is now shared. Existing and newly opened PowerShell terminals are available on the paired office laptop with xcode.' -ForegroundColor Green
}

function Connect-XcodeOfficeSharedTerminal {
    [void](Get-XcodeOfficeState)
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js is unavailable. Reinstall xcode with npm, then open a new PowerShell window.' }
    $client = Join-Path $RepositoryRoot 'bin\console-relay-client.js'
    if (-not (Test-Path -LiteralPath $client -PathType Leaf)) { throw 'The console relay client is missing. Run xcode update.' }
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
    Write-Host "`n[2/3] Key-only, pinned-host SSH"
    & $ssh -F $sshConfig -o BatchMode=yes xcode-main 'echo XCODE_SSH_OK'
    if ($LASTEXITCODE -ne 0) { throw 'Pinned SSH verification failed.' }
    Write-Host "`n[3/3] Main-PC terminal-workspace availability"
    $remoteProbe = "`$path = Join-Path `$env:LOCALAPPDATA 'XcodeRemote\console-workspace.json'; if (-not (Test-Path -LiteralPath `$path)) { exit 3 }; `$workspace = Get-Content -Raw -LiteralPath `$path | ConvertFrom-Json; if (@(`$workspace.sessions).Count -lt 1) { exit 4 }"
    $encodedProbe = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($remoteProbe))
    & $ssh -F $sshConfig -o BatchMode=yes xcode-main powershell.exe -NoProfile -NonInteractive -EncodedCommand $encodedProbe
    if ($LASTEXITCODE -ne 0) { throw 'Shared-terminal availability verification failed.' }
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
                Start-XcodeWorkspaceShare
            }
            'share' { Start-XcodeWorkspaceShare }
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
