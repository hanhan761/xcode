[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9-]+$')][string]$MainName = 'xcode-main',
    [switch]$SkipPairing,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'XcodeRemote.Common.ps1')

if (-not [Environment]::Is64BitOperatingSystem) { throw 'xcode remote requires 64-bit Windows.' }
$currentSid = Get-XcodeCurrentSid
$currentUser = $env:USERNAME

Write-XcodeStep 'Checking WinGet and required software'
$winget = Assert-XcodeWinget
Ensure-XcodeWingetPackage -WingetPath $winget -PackageId 'Tailscale.Tailscale' -DryRun:$DryRun
Refresh-XcodeProcessPath

if ($DryRun) {
    Write-Host '[dry-run] Tailscale login, elevated OpenSSH staging, and one-time pairing'
    exit 0
}

$tailscale = Get-XcodeTailscaleExecutable
if (-not $tailscale) { throw 'Tailscale was installed but its trusted executable was not found.' }

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

Write-XcodeStep 'Requesting one administrator step to stage OpenSSH safely'
Invoke-XcodeElevatedPowerShell `
    -ScriptPath (Join-Path $PSScriptRoot 'install-main-machine.ps1') `
    -Arguments @(
        '-ExpectedSid', $currentSid,
        '-ExpectedUser', $currentUser,
        '-TailscaleIPv4', $mainIp,
        '-MainName', $MainName
    )

$userRoot = Join-Path $env:LOCALAPPDATA 'XcodeRemote'
if (-not (Test-Path -LiteralPath $userRoot)) { New-Item -ItemType Directory -Path $userRoot -Force | Out-Null }
Remove-XcodePathEntry -Directory (Join-Path $userRoot 'bin')

$userState = [ordered]@{
    schemaVersion = 3
    role = 'main-user'
    machineName = $MainName
    dnsName = ([string]$status.Self.DNSName).TrimEnd('.')
    tailscaleIPv4 = $mainIp
    tailscaleNodeId = [string]$status.Self.ID
    tailscaleUserId = [string]$status.Self.UserID
    windowsUser = $currentUser
    windowsSid = $currentSid
    configuredAt = (Get-Date).ToUniversalTime().ToString('o')
}
Write-XcodeUtf8File -Path (Join-Path $userRoot 'host-user.json') -Content ($userState | ConvertTo-Json -Depth 5)

Write-Host ''
Write-Host 'Main PC is ready.' -ForegroundColor Green
Write-Host "Tailscale host : $MainName ($mainIp)"
Write-Host "Windows user   : $currentUser"
Write-Host 'Daily use      : run xcode in the exact terminal you want to share'

if ($SkipPairing) {
    Write-Host 'SSH is still staged and closed. Run xcode pair when the office laptop is ready.' -ForegroundColor Yellow
    exit 0
}

Write-XcodeStep 'Opening the one-time office-laptop pairing window'
& (Join-Path $PSScriptRoot 'pair-office.ps1') -ExpectedSid $currentSid -ExpectedUser $currentUser
