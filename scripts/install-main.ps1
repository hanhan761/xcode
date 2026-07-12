[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9-]+$')][string]$MainName = 'xcode-main',
    [switch]$SkipPairing,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'XcodeRemote.Common.ps1')

function Set-XcodeMainWezTermConfig {
    param(
        [Parameter(Mandatory = $true)][string]$PowerShellPath,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $marker = '-- XCODE REMOTE MANAGED CONFIG'
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $existing = Get-Content -Raw -LiteralPath $Path
        if ($existing -notmatch [regex]::Escape($marker)) {
            Write-Warning "An existing WezTerm configuration was found at $Path."
            $approval = Read-Host 'Back it up and replace it with the shared-workspace configuration? [y/N]'
            if ($approval -notmatch '^[Yy]$') {
                throw 'The existing WezTerm configuration was left unchanged. The xcode mux needs its Unix domain to be the first configured domain.'
            }
        }
        $backup = Backup-XcodeFile -Path $Path
        Write-Host "WezTerm configuration backup: $backup"
    }

    $pwsh = ConvertTo-XcodeLuaString -Value ($PowerShellPath -replace '\\', '/')
    $content = @"
$marker
local wezterm = require 'wezterm'
local act = wezterm.action
local config = wezterm.config_builder()

-- Remote `wezterm cli --prefer-mux proxy` selects this first Unix domain.
config.unix_domains = {
  { name = 'xcode-shared-mux' },
}

config.default_gui_startup_args = { 'connect', 'xcode-shared-mux' }
config.default_prog = { $pwsh, '-NoLogo' }
config.scrollback_lines = 100000
config.window_close_confirmation = 'AlwaysPrompt'
config.keys = {
  {
    key = 'D',
    mods = 'CTRL|SHIFT|ALT',
    action = act.DetachDomain 'CurrentPaneDomain',
  },
}

return config
"@
    Write-XcodeUtf8File -Path $Path -Content $content
}

function Write-XcodeMainLauncher {
    param(
        [Parameter(Mandatory = $true)][string]$WezTermPath,
        [Parameter(Mandatory = $true)][string]$InstallRoot
    )
    $binRoot = Join-Path $InstallRoot 'bin'
    if (-not (Test-Path -LiteralPath $binRoot)) { New-Item -ItemType Directory -Path $binRoot -Force | Out-Null }
    $launcher = Join-Path $binRoot 'xcode-main.cmd'
    $content = @"
@echo off
"$WezTermPath" connect xcode-shared-mux
exit /b %ERRORLEVEL%
"@
    Write-XcodeUtf8File -Path $launcher -Content $content
    Add-XcodePathEntry -Directory $binRoot -Scope User | Out-Null
}

if (-not [Environment]::Is64BitOperatingSystem) { throw 'xcode remote requires 64-bit Windows.' }
$currentSid = Get-XcodeCurrentSid
$currentUser = $env:USERNAME

Write-XcodeStep 'Checking WinGet and required software'
$winget = Assert-XcodeWinget
Ensure-XcodeWingetPackage -WingetPath $winget -PackageId 'Tailscale.Tailscale' -DryRun:$DryRun
Ensure-XcodeWingetPackage -WingetPath $winget -PackageId 'Microsoft.PowerShell' -DryRun:$DryRun
Ensure-XcodeWingetPackage -WingetPath $winget -PackageId 'wez.wezterm' -DryRun:$DryRun
Refresh-XcodeProcessPath

if ($DryRun) {
    Write-Host '[dry-run] Tailscale login, user WezTerm mux, elevated OpenSSH staging, and one-time pairing'
    exit 0
}

$tailscale = Get-XcodeTailscaleExecutable
$wezterm = Get-XcodeWezTermExecutable
$pwsh = Get-XcodePowerShell7Executable
if (-not $tailscale) { throw 'Tailscale was installed but its trusted executable was not found.' }
if (-not $wezterm) { throw 'WezTerm was installed but its trusted executable was not found.' }
if (-not $pwsh) { throw 'PowerShell 7 was installed but its trusted executable was not found.' }
$weztermVersion = [string](& $wezterm --version 2>$null | Select-Object -First 1)
Assert-XcodeSupportedWezTermVersion -Version $weztermVersion

Write-XcodeStep 'Signing in to Tailscale (the browser opens only when needed)'
$status = Get-XcodeTailscaleStatus
if (-not $status -or $status.BackendState -ne 'Running' -or -not $status.Self.Online) {
    & $tailscale up
    if ($LASTEXITCODE -ne 0) { throw "Tailscale login failed (exit $LASTEXITCODE)." }
    $status = Wait-XcodeTailscaleOnline
}

$prefsJson = (& $tailscale debug prefs 2>$null | Out-String)
$prefs = if ($prefsJson.Trim()) { $prefsJson | ConvertFrom-Json } else { $null }
if ($prefs -and $prefs.ShieldsUp) {
    Write-Warning 'Tailscale Shields Up is enabled. The office laptop cannot reach SSH while it remains enabled.'
    $approval = Read-Host 'Disable Shields Up on this main PC and rely on the Tailscale-only SSH firewall rule? [y/N]'
    if ($approval -notmatch '^[Yy]$') { throw 'Setup stopped without changing Shields Up.' }
    & $tailscale set --shields-up=false
    if ($LASTEXITCODE -ne 0) { throw 'Could not disable Tailscale Shields Up.' }
}

& $tailscale set --hostname=$MainName --unattended=true --auto-update=true
if ($LASTEXITCODE -ne 0) { throw "Failed to configure Tailscale (exit $LASTEXITCODE)." }
$status = Wait-XcodeTailscaleOnline
$mainIp = Get-XcodeTailscaleIPv4
$weztermDirectory = Split-Path -Parent $wezterm

Write-XcodeStep 'Requesting one administrator step to stage OpenSSH safely'
Invoke-XcodeElevatedPowerShell `
    -ScriptPath (Join-Path $PSScriptRoot 'install-main-machine.ps1') `
    -Arguments @(
        '-ExpectedSid', $currentSid,
        '-ExpectedUser', $currentUser,
        '-TailscaleIPv4', $mainIp,
        '-WezTermDirectory', $weztermDirectory,
        '-MainName', $MainName
    )

Write-XcodeStep 'Starting the shared PowerShell workspace as your normal Windows user'
$weztermConfig = Join-Path $env:USERPROFILE '.wezterm.lua'
Set-XcodeMainWezTermConfig -PowerShellPath $pwsh -Path $weztermConfig

$userRoot = Join-Path $env:LOCALAPPDATA 'XcodeRemote'
if (-not (Test-Path -LiteralPath $userRoot)) { New-Item -ItemType Directory -Path $userRoot -Force | Out-Null }
Write-XcodeMainLauncher -WezTermPath $wezterm -InstallRoot $userRoot

Start-Process -FilePath $wezterm -ArgumentList @('connect', 'xcode-shared-mux') | Out-Null
$muxReady = $false
$muxDeadline = (Get-Date).AddSeconds(20)
do {
    Start-Sleep -Milliseconds 500
    $muxResult = Invoke-XcodeNativeCapture `
        -FilePath $wezterm `
        -ArgumentList @('cli', '--prefer-mux', 'list', '--format', 'json')
    if ($muxResult.ExitCode -eq 0 -and $muxResult.Output.Trim().StartsWith('[')) { $muxReady = $true }
} while (-not $muxReady -and (Get-Date) -lt $muxDeadline)
if (-not $muxReady) {
    throw 'The local WezTerm mux did not start. Open WezTerm once, then rerun install-main.cmd.'
}

$userState = [ordered]@{
    schemaVersion = 2
    role = 'main-user'
    machineName = $MainName
    dnsName = ([string]$status.Self.DNSName).TrimEnd('.')
    tailscaleIPv4 = $mainIp
    tailscaleNodeId = [string]$status.Self.ID
    tailscaleUserId = [string]$status.Self.UserID
    windowsUser = $currentUser
    windowsSid = $currentSid
    weztermPath = $wezterm
    weztermVersion = $weztermVersion
    powershellPath = $pwsh
    configuredAt = (Get-Date).ToUniversalTime().ToString('o')
}
Write-XcodeUtf8File -Path (Join-Path $userRoot 'host-user.json') -Content ($userState | ConvertTo-Json -Depth 5)

Write-Host ''
Write-Host 'Main PC workspace is ready.' -ForegroundColor Green
Write-Host "Tailscale host : $MainName ($mainIp)"
Write-Host "Windows user   : $currentUser"
Write-Host 'Shared panes   : only panes opened in this new WezTerm workspace'
Write-Host 'Safe detach    : Ctrl+Shift+Alt+D'

if ($SkipPairing) {
    Write-Host 'SSH is still staged and closed. Run pair-office.cmd when the office laptop is ready.' -ForegroundColor Yellow
    exit 0
}

Write-XcodeStep 'Opening the one-time office-laptop pairing window'
& (Join-Path $PSScriptRoot 'pair-office.ps1') -ExpectedSid $currentSid -ExpectedUser $currentUser
