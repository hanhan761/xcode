[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9.-]+$')][string]$MainHost = 'xcode-main',
    [ValidatePattern('^[A-Za-z0-9-]+$')][string]$OfficeName = 'xcode-office',
    [ValidateRange(1024, 65535)][int]$PairPort = 43122,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'XcodeRemote.Common.ps1')

function Test-XcodeSshConnection {
    param(
        [Parameter(Mandatory = $true)][string]$SshExe,
        [Parameter(Mandatory = $true)][string]$ConfigPath
    )
    if (-not (Test-Path -LiteralPath $ConfigPath)) { return $false }
    $output = (& $SshExe -F $ConfigPath -o BatchMode=yes xcode-main 'echo XCODE_SSH_OK' 2>$null | Out-String)
    return $LASTEXITCODE -eq 0 -and $output -match 'XCODE_SSH_OK'
}

function Test-XcodeFixedTimeString {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )
    $leftBytes = [Text.Encoding]::UTF8.GetBytes($Left)
    $rightBytes = [Text.Encoding]::UTF8.GetBytes($Right)
    $difference = $leftBytes.Length -bxor $rightBytes.Length
    $length = [Math]::Max($leftBytes.Length, $rightBytes.Length)
    for ($i = 0; $i -lt $length; $i++) {
        $a = if ($i -lt $leftBytes.Length) { $leftBytes[$i] } else { 0 }
        $b = if ($i -lt $rightBytes.Length) { $rightBytes[$i] } else { 0 }
        $difference = $difference -bor ($a -bxor $b)
    }
    return $difference -eq 0
}

function Open-XcodePairSession {
    param(
        [Parameter(Mandatory = $true)][string]$Address,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$PairCode,
        [Parameter(Mandatory = $true)][string]$PublicKey,
        [Parameter(Mandatory = $true)][string]$DeviceName,
        [Parameter(Mandatory = $true)][string]$WezTermVersion
    )

    $client = [Net.Sockets.TcpClient]::new()
    $reader = $null
    $writer = $null
    try {
        $client.ReceiveTimeout = 30000
        $client.SendTimeout = 30000
        $client.Connect($Address, $Port)
        $stream = $client.GetStream()
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $false, 4096, $true)
        $writer = [IO.StreamWriter]::new($stream, (New-Object Text.UTF8Encoding($false)), 4096, $true)
        $writer.AutoFlush = $true
        $nonce = New-XcodePairNonce
        $request = [ordered]@{
            protocolVersion = 2
            pairCode = (($PairCode -replace '[^0-9]', ''))
            nonce = $nonce
            publicKey = $PublicKey.Trim()
            deviceName = $DeviceName
            weztermVersion = $WezTermVersion
        }
        $writer.WriteLine(($request | ConvertTo-Json -Compress -Depth 4))
        $writer.Flush()

        $line = $reader.ReadLine()
        if (-not $line -or $line.Length -gt 16384) { throw 'The main PC returned an empty or oversized pairing response.' }
        $response = $line | ConvertFrom-Json
        if (-not $response.ok) {
            $errorCode = [string]$response.error
            if ($errorCode -notmatch '^[A-Z0-9_]{1,64}$') { $errorCode = 'INVALID_RESPONSE' }
            $reader.Dispose()
            $writer.Dispose()
            $client.Dispose()
            return [pscustomobject]@{ Ok = $false; ErrorCode = $errorCode }
        }
        return [pscustomobject]@{
            Ok = $true
            Nonce = $nonce
            Response = $response
            Client = $client
            Reader = $reader
            Writer = $writer
        }
    }
    catch {
        if ($reader) { $reader.Dispose() }
        if ($writer) { $writer.Dispose() }
        $client.Dispose()
        throw
    }
}

function Close-XcodePairSession {
    param(
        [Parameter(Mandatory = $true)][object]$Session,
        [Parameter(Mandatory = $true)][ValidateSet('commit', 'abort')][string]$Action,
        [string]$AuthorizedKeyFingerprint = ''
    )
    try {
        $message = [ordered]@{
            action = $Action
            nonce = [string]$Session.Nonce
            authorizedKeyFingerprint = $AuthorizedKeyFingerprint
        }
        $Session.Writer.WriteLine(($message | ConvertTo-Json -Compress))
        $Session.Writer.Flush()
        if ($Action -eq 'commit') {
            $Session.Client.ReceiveTimeout = 30000
            $ackLine = $Session.Reader.ReadLine()
            if (-not $ackLine -or $ackLine.Length -gt 2048) { throw 'The main PC did not acknowledge the pairing commit.' }
            $ack = $ackLine | ConvertFrom-Json
            if (-not $ack.ok -or [string]$ack.action -ne 'committed' -or [string]$ack.nonce -ne [string]$Session.Nonce) {
                throw 'The main PC returned an invalid pairing commit acknowledgement.'
            }
        }
    }
    finally {
        $Session.Reader.Dispose()
        $Session.Writer.Dispose()
        $Session.Client.Dispose()
    }
}

function Assert-XcodePairingResponse {
    param(
        [Parameter(Mandatory = $true)][object]$Session,
        [Parameter(Mandatory = $true)][object]$MainWhois,
        [Parameter(Mandatory = $true)][object]$LocalStatus,
        [Parameter(Mandatory = $true)][string]$PairCode,
        [Parameter(Mandatory = $true)][string]$PairAddress,
        [Parameter(Mandatory = $true)][string]$LocalPublicKey,
        [Parameter(Mandatory = $true)][string]$LocalWezTermVersion
    )

    $response = $Session.Response
    if ([int]$response.protocolVersion -ne 2 -or [string]$response.nonce -ne [string]$Session.Nonce) {
        throw 'The pairing response protocol or nonce is invalid.'
    }
    if ([string]$response.mainNodeId -ne [string]$MainWhois.Node.StableID) {
        throw 'The pairing responder does not match the Tailscale node reached by the office laptop.'
    }
    if ([string]$response.tailscaleIPv4 -ne $PairAddress) { throw 'The pairing response returned a different main-PC address.' }
    if ([string]$response.requesterNodeId -ne [string]$LocalStatus.Self.ID) { throw 'The main PC did not bind this key to the office laptop node.' }
    if ([int]$response.sshPort -ne 22) { throw 'The pairing response requested an unexpected SSH port.' }
    $remoteProxy = [string]$response.remoteWezTermPath
    Assert-XcodeNoControlCharacters -Value $remoteProxy -FieldName 'Remote WezTerm proxy path'
    if ($remoteProxy -notmatch '^[A-Za-z]:/[A-Za-z0-9._/-]+\.cmd$') {
        throw 'The pairing response requested an unsafe remote executable path.'
    }

    $validatedFields = @{
        mainName = '^[A-Za-z0-9-]{1,63}$'
        dnsName = '^[A-Za-z0-9.-]{1,253}$'
        windowsUser = '^[A-Za-z0-9._@\\-]{1,128}$'
        weztermVersion = '^[A-Za-z0-9._+ -]{1,100}$'
    }
    foreach ($field in $validatedFields.Keys) {
        $value = [string]$response.$field
        Assert-XcodeNoControlCharacters -Value $value -FieldName $field
        if ($value -notmatch $validatedFields[$field]) { throw "The pairing response field $field is invalid." }
    }
    if ([string]$response.weztermVersion -ne $LocalWezTermVersion) {
        throw "WezTerm versions differ. Main: $($response.weztermVersion); office: $LocalWezTermVersion"
    }

    $hostKey = Get-XcodeCanonicalSshPublicKey -PublicKey ([string]$response.sshHostKey)
    $hostFingerprint = Get-XcodeSshPublicKeyFingerprint -PublicKey $hostKey
    if ($hostFingerprint -ne [string]$response.sshHostKeyFingerprint) { throw 'The returned SSH host-key fingerprint is inconsistent.' }
    $localFingerprint = Get-XcodeSshPublicKeyFingerprint -PublicKey $LocalPublicKey
    if ($localFingerprint -ne [string]$response.authorizedKeyFingerprint) { throw 'The main PC authorized a different SSH key.' }

    $localTailIPv4 = @($LocalStatus.Self.TailscaleIPs | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^100\.' } | Select-Object -First 1)
    if ($localTailIPv4.Count -ne 1) { throw 'The office laptop has no unique Tailscale IPv4 address.' }
    $expectedSource = $localTailIPv4[0] + '/32'
    if (@($response.requesterAddresses | ForEach-Object { [string]$_ }) -notcontains $expectedSource) {
        throw 'The main PC did not restrict the SSH key to this office laptop Tailscale address.'
    }

    $expectedProof = Get-XcodePairProof `
        -PairCode (($PairCode -replace '[^0-9]', '')) `
        -Nonce ([string]$Session.Nonce) `
        -MainNodeId ([string]$response.mainNodeId) `
        -MainIp ([string]$response.tailscaleIPv4) `
        -DnsName ([string]$response.dnsName) `
        -WindowsUser ([string]$response.windowsUser) `
        -HostKeyFingerprint ([string]$response.sshHostKeyFingerprint) `
        -AuthorizedKeyFingerprint ([string]$response.authorizedKeyFingerprint) `
        -RequesterNodeId ([string]$response.requesterNodeId) `
        -RemoteWezTermPath $remoteProxy `
        -WezTermVersion ([string]$response.weztermVersion)
    if (-not (Test-XcodeFixedTimeString -Left $expectedProof -Right ([string]$response.proof))) {
        throw 'The pairing response did not prove possession of the one-time code.'
    }
    return [pscustomobject]@{ HostKey = $hostKey; HostFingerprint = $hostFingerprint; LocalFingerprint = $localFingerprint }
}

function Write-XcodeOfficeFiles {
    param(
        [Parameter(Mandatory = $true)][object]$Pairing,
        [Parameter(Mandatory = $true)][string]$HostKey,
        [Parameter(Mandatory = $true)][string]$KeyPath,
        [Parameter(Mandatory = $true)][string]$WezTermPath,
        [Parameter(Mandatory = $true)][string]$SshPath,
        [Parameter(Mandatory = $true)][string]$TailscalePath,
        [Parameter(Mandatory = $true)][string]$InstallRoot
    )

    if (-not (Test-Path -LiteralPath $InstallRoot)) { New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null }
    $binRoot = Join-Path $InstallRoot 'bin'
    if (-not (Test-Path -LiteralPath $binRoot)) { New-Item -ItemType Directory -Path $binRoot -Force | Out-Null }
    $knownHosts = Join-Path $InstallRoot 'known_hosts'
    $sshConfig = Join-Path $InstallRoot 'ssh_config'
    $weztermConfig = Join-Path $InstallRoot 'office-wezterm.lua'
    $launcher = Join-Path $binRoot 'xcode.cmd'

    Assert-XcodeNoWhitespacePath -Path $KeyPath -Purpose 'The dedicated SSH private key'
    Assert-XcodeNoWhitespacePath -Path $knownHosts -Purpose 'The pinned SSH host-key file'
    $hostNames = @(
        [string]$Pairing.mainName,
        [string]$Pairing.dnsName,
        [string]$Pairing.tailscaleIPv4
    ) | Select-Object -Unique
    Write-XcodeUtf8File -Path $knownHosts -Content ((($hostNames -join ',') + ' ' + $HostKey) + "`r`n")

    $keyForConfig = $KeyPath -replace '\\', '/'
    $knownForConfig = $knownHosts -replace '\\', '/'
    $target = [string]$Pairing.tailscaleIPv4
    $sshContent = @"
Host xcode-main
    HostName $target
    User $($Pairing.windowsUser)
    Port 22
    IdentityFile "$keyForConfig"
    UserKnownHostsFile "$knownForConfig"
    IdentitiesOnly yes
    StrictHostKeyChecking yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    ForwardAgent no
    ServerAliveInterval 30
    ServerAliveCountMax 3
"@
    Write-XcodeUtf8File -Path $sshConfig -Content $sshContent

    $remoteAddressLua = ConvertTo-XcodeLuaString -Value ($target + ':22')
    $userLua = ConvertTo-XcodeLuaString -Value ([string]$Pairing.windowsUser)
    $keyLua = ConvertTo-XcodeLuaString -Value $keyForConfig
    $knownLua = ConvertTo-XcodeLuaString -Value $knownForConfig
    $remoteProxy = [string]$Pairing.remoteWezTermPath
    $remoteProxyLua = ConvertTo-XcodeLuaString -Value $remoteProxy
    $weztermContent = @"
-- XCODE REMOTE MANAGED CONFIG
local wezterm = require 'wezterm'
local act = wezterm.action
local config = wezterm.config_builder()

config.ssh_domains = {
  {
    name = 'XCODE_MAIN',
    remote_address = $remoteAddressLua,
    username = $userLua,
    multiplexing = 'WezTerm',
    remote_wezterm_path = $remoteProxyLua,
    no_agent_auth = true,
    ssh_option = {
      identityfile = $keyLua,
      userknownhostsfile = $knownLua,
      stricthostkeychecking = 'yes',
      passwordauthentication = 'no',
      kbdinteractiveauthentication = 'no',
      forwardagent = 'no',
      serveraliveinterval = '30',
      serveralivecountmax = '3',
    },
  },
}

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
    Write-XcodeUtf8File -Path $weztermConfig -Content $weztermContent

    $launcherContent = @"
@echo off
setlocal EnableExtensions
set "XCODE_ROOT=$InstallRoot"
set "XCODE_WEZTERM=$WezTermPath"
set "XCODE_SSH=$SshPath"
set "XCODE_TAILSCALE=$TailscalePath"
set "XCODE_REMOTE_WEZTERM=$remoteProxy"

if /I "%~1"=="doctor" goto doctor
if /I "%~1"=="ssh" goto ssh
"%XCODE_WEZTERM%" --config-file "%XCODE_ROOT%\office-wezterm.lua" connect XCODE_MAIN
exit /b %ERRORLEVEL%

:ssh
"%XCODE_SSH%" -F "%XCODE_ROOT%\ssh_config" xcode-main
exit /b %ERRORLEVEL%

:doctor
echo [1/4] Tailscale status
"%XCODE_TAILSCALE%" status
if errorlevel 1 exit /b 1
echo.
echo [2/4] Key-only, pinned-host SSH
"%XCODE_SSH%" -F "%XCODE_ROOT%\ssh_config" -o BatchMode=yes xcode-main "echo XCODE_SSH_OK"
if errorlevel 1 exit /b 1
echo.
echo [3/4] Matching remote WezTerm
"%XCODE_SSH%" -F "%XCODE_ROOT%\ssh_config" -o BatchMode=yes xcode-main "%XCODE_REMOTE_WEZTERM% --version"
if errorlevel 1 exit /b 1
echo.
echo [4/4] Persistent host mux
"%XCODE_SSH%" -F "%XCODE_ROOT%\ssh_config" -o BatchMode=yes xcode-main "%XCODE_REMOTE_WEZTERM% cli --prefer-mux list --format json"
exit /b %ERRORLEVEL%
"@
    Write-XcodeUtf8File -Path $launcher -Content $launcherContent
    Add-XcodePathEntry -Directory $binRoot -Scope User | Out-Null

    $state = [ordered]@{
        schemaVersion = 2
        role = 'office'
        mainName = [string]$Pairing.mainName
        mainNodeId = [string]$Pairing.mainNodeId
        tailscaleIPv4 = [string]$Pairing.tailscaleIPv4
        windowsUser = [string]$Pairing.windowsUser
        sshHostKeyFingerprint = [string]$Pairing.sshHostKeyFingerprint
        authorizedKeyFingerprint = [string]$Pairing.authorizedKeyFingerprint
        weztermVersion = [string]$Pairing.weztermVersion
        remoteWezTermPath = $remoteProxy
        keyPath = $KeyPath
        configuredAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-XcodeUtf8File -Path (Join-Path $InstallRoot 'client.json') -Content ($state | ConvertTo-Json -Depth 5)
    return [pscustomobject]@{ SshConfig = $sshConfig; WezTermConfig = $weztermConfig; Launcher = $launcher }
}

Write-XcodeStep 'Checking WinGet and required office-laptop software'
$winget = Assert-XcodeWinget
Ensure-XcodeWingetPackage -WingetPath $winget -PackageId 'Tailscale.Tailscale' -DryRun:$DryRun
Ensure-XcodeWingetPackage -WingetPath $winget -PackageId 'wez.wezterm' -DryRun:$DryRun
Refresh-XcodeProcessPath
if ($DryRun) {
    Write-Host '[dry-run] OpenSSH Client, Tailscale login, dedicated key, authenticated pairing, and real WezTerm attach'
    exit 0
}

$currentSid = Get-XcodeCurrentSid
$currentUser = $env:USERNAME
$ssh = Get-XcodeOpenSshExecutable -Name 'ssh.exe'
$sshKeygen = Get-XcodeOpenSshExecutable -Name 'ssh-keygen.exe'
if (-not $ssh -or -not $sshKeygen) {
    Write-XcodeStep 'Requesting one administrator step for Windows OpenSSH Client'
    Invoke-XcodeElevatedPowerShell `
        -ScriptPath (Join-Path $PSScriptRoot 'install-office-machine.ps1') `
        -Arguments @('-ExpectedSid', $currentSid, '-ExpectedUser', $currentUser)
}

$tailscale = Get-XcodeTailscaleExecutable
$wezterm = Get-XcodeWezTermExecutable
$ssh = Get-XcodeOpenSshExecutable -Name 'ssh.exe'
$sshKeygen = Get-XcodeOpenSshExecutable -Name 'ssh-keygen.exe'
if (-not $tailscale -or -not $wezterm -or -not $ssh -or -not $sshKeygen) {
    throw 'A trusted Tailscale, WezTerm, or Windows OpenSSH executable is missing.'
}

Write-XcodeStep 'Signing in to the same Tailscale account as the main PC'
$status = Get-XcodeTailscaleStatus
if (-not $status -or $status.BackendState -ne 'Running' -or -not $status.Self.Online) {
    & $tailscale up
    if ($LASTEXITCODE -ne 0) { throw "Tailscale login failed (exit $LASTEXITCODE)." }
    $status = Wait-XcodeTailscaleOnline
}
& $tailscale set --hostname=$OfficeName --auto-update=true
if ($LASTEXITCODE -ne 0) { throw "Failed to configure Tailscale (exit $LASTEXITCODE)." }
$status = Wait-XcodeTailscaleOnline

$installRoot = Join-Path $env:LOCALAPPDATA 'XcodeRemote'
$sshDirectory = Join-Path $env:USERPROFILE '.ssh'
$keyPath = Join-Path $sshDirectory 'xcode_office_ed25519'
Assert-XcodeNoWhitespacePath -Path $keyPath -Purpose 'The dedicated SSH private key'
Assert-XcodeNoWhitespacePath -Path (Join-Path $installRoot 'known_hosts') -Purpose 'The pinned SSH host-key file'
if (-not (Test-Path -LiteralPath $sshDirectory)) { New-Item -ItemType Directory -Path $sshDirectory -Force | Out-Null }
$publicKeyPath = "$keyPath.pub"
if (-not (Test-Path -LiteralPath $keyPath)) {
    Write-XcodeStep 'Creating a dedicated one-command SSH identity'
    Write-Host 'This key intentionally has no passphrase. It is restricted to this Tailscale node and protected by your Windows account ACL.' -ForegroundColor Yellow
    & $sshKeygen -q -t ed25519 -a 64 -N '""' -f $keyPath -C "xcode-office:$env:COMPUTERNAME"
    if ($LASTEXITCODE -ne 0) { throw 'ssh-keygen failed.' }
}
if (-not (Test-Path -LiteralPath $publicKeyPath)) { throw "The SSH public key is missing: $publicKeyPath" }
$publicKey = Get-Content -Raw -LiteralPath $publicKeyPath
$derivedPublicKey = (& $sshKeygen -y -P '""' -f $keyPath 2>$null | Out-String)
if ($LASTEXITCODE -ne 0) {
    throw "The existing xcode office key is encrypted or unreadable. Rename $keyPath and $publicKeyPath, then rerun the installer to create a dedicated one-command key."
}
if ((Get-XcodeCanonicalSshPublicKey -PublicKey $derivedPublicKey) -ne (Get-XcodeCanonicalSshPublicKey -PublicKey $publicKey)) {
    throw 'The existing xcode private key and public key do not match.'
}
$localVersion = [string](& $wezterm --version 2>$null | Select-Object -First 1)
Assert-XcodeSupportedWezTermVersion -Version $localVersion

$existingSshConfig = Join-Path $installRoot 'ssh_config'
$existingWezTermConfig = Join-Path $installRoot 'office-wezterm.lua'
$existingLauncher = Join-Path $installRoot 'bin\xcode.cmd'
$existingStatePath = Join-Path $installRoot 'client.json'
if ((Test-XcodeSshConnection -SshExe $ssh -ConfigPath $existingSshConfig) -and
    (Test-Path -LiteralPath $existingWezTermConfig) -and
    (Test-Path -LiteralPath $existingLauncher) -and
    (Test-Path -LiteralPath $existingStatePath)) {
    try {
        $existingState = Get-Content -Raw -LiteralPath $existingStatePath | ConvertFrom-Json
        if ([int]$existingState.schemaVersion -ne 2) { throw 'The installed office schema is outdated.' }
        $existingLua = Get-Content -Raw -LiteralPath $existingWezTermConfig
        $existingLauncherContent = Get-Content -Raw -LiteralPath $existingLauncher
        $existingSshContent = Get-Content -Raw -LiteralPath $existingSshConfig
        if ($existingLua -notmatch 'XCODE REMOTE MANAGED CONFIG' -or
            $existingLua -notmatch "stricthostkeychecking = 'yes'" -or
            $existingLauncherContent -notmatch 'connect XCODE_MAIN' -or
            $existingSshContent -notmatch '(?m)^\s*StrictHostKeyChecking yes\r?$') {
            throw 'An installed office file no longer matches the managed security policy.'
        }
        $existingRemoteProxy = [string]$existingState.remoteWezTermPath
        if ($existingRemoteProxy -notmatch '^[A-Za-z]:/[A-Za-z0-9._/-]+\.cmd$') { throw 'The installed remote proxy path is invalid.' }
        $remoteVersion = (& $ssh -F $existingSshConfig -o BatchMode=yes xcode-main ($existingRemoteProxy + ' --version') 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $remoteVersion -ne $localVersion.Trim()) {
            throw "Existing WezTerm versions differ. Main: $remoteVersion; office: $localVersion"
        }
        $existingMux = (& $ssh -F $existingSshConfig -o BatchMode=yes xcode-main ($existingRemoteProxy + ' cli --prefer-mux list --format json') 2>$null | Out-String)
        if ($LASTEXITCODE -ne 0 -or -not $existingMux.Trim().StartsWith('[')) { throw 'The installed host mux is unavailable.' }
        Start-Process -FilePath $wezterm -ArgumentList @('--config-file', $existingWezTermConfig, 'connect', 'XCODE_MAIN') | Out-Null
        Start-Sleep -Seconds 3
        $existingApproval = Read-Host 'Existing pairing opened XCODE_MAIN. Does it show the main-PC workspace? [y/N]'
        if ($existingApproval -notmatch '^[Yy]$') { throw 'The existing real attach was not confirmed.' }
        Add-XcodePathEntry -Directory (Join-Path $installRoot 'bin') -Scope User | Out-Null
        Write-Host 'This office laptop is already paired; SSH, mux, and the real attach all work.' -ForegroundColor Green
        exit 0
    }
    catch {
        Write-Warning "The existing installation needs repair and will be paired again: $($_.Exception.Message)"
    }
}

Write-XcodeStep 'Finding and verifying the main PC on the tailnet'
$pairAddress = $null
$resolveDeadline = (Get-Date).AddSeconds(60)
do {
    try {
        $pairAddress = [Net.Dns]::GetHostAddresses($MainHost) |
            Where-Object { $_.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and $_.ToString() -match '^100\.' } |
            Select-Object -First 1
    }
    catch { $pairAddress = $null }
    if (-not $pairAddress) { Start-Sleep -Seconds 2 }
} while (-not $pairAddress -and (Get-Date) -lt $resolveDeadline)
if (-not $pairAddress) { throw "Cannot resolve $MainHost to a Tailscale IPv4 address. Confirm pair-office.cmd is open on the main PC." }

$pairAddressText = $pairAddress.ToString()
$mainWhois = Get-XcodeTailscaleWhois -Address $pairAddressText
if ([string]$mainWhois.UserProfile.ID -ne [string]$status.Self.UserID) {
    throw 'The resolved main PC is not owned by the same Tailscale user as this office laptop.'
}
Write-Host "Tailscale main node: $($mainWhois.Node.ComputedName) [$($mainWhois.Node.StableID)] at $pairAddressText"

$session = $null
$pairCode = $null
for ($attempt = 1; $attempt -le 3 -and -not $session; $attempt++) {
    $pairCode = Read-Host 'Enter the 8-digit code shown on the main PC'
    $candidate = Open-XcodePairSession `
        -Address $pairAddressText `
        -Port $PairPort `
        -PairCode $pairCode `
        -PublicKey $publicKey `
        -DeviceName ([string]$status.Self.HostName) `
        -WezTermVersion $localVersion
    if ($candidate.Ok) { $session = $candidate }
    else { Write-Warning "Pairing was rejected by the verified Tailscale peer ($($candidate.ErrorCode))." }
}
if (-not $session) { throw 'Pairing failed after three attempts. Open a new pairing window on the main PC and retry.' }

$trackedPaths = @(
    (Join-Path $installRoot 'known_hosts'),
    (Join-Path $installRoot 'ssh_config'),
    (Join-Path $installRoot 'office-wezterm.lua'),
    (Join-Path $installRoot 'bin\xcode.cmd'),
    (Join-Path $installRoot 'client.json')
)
$snapshots = @{}
foreach ($path in $trackedPaths) {
    $snapshots[$path] = [pscustomobject]@{
        Existed = Test-Path -LiteralPath $path -PathType Leaf
        Content = if (Test-Path -LiteralPath $path -PathType Leaf) { Get-Content -Raw -LiteralPath $path } else { '' }
    }
}
$previousUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$committed = $false
$commitSent = $false
try {
    $validation = Assert-XcodePairingResponse `
        -Session $session `
        -MainWhois $mainWhois `
        -LocalStatus $status `
        -PairCode (($pairCode -replace '[^0-9]', '')) `
        -PairAddress $pairAddressText `
        -LocalPublicKey $publicKey `
        -LocalWezTermVersion $localVersion

    Write-Host ''
    Write-Host "Main-PC SSH fingerprint: $($validation.HostFingerprint)" -ForegroundColor Cyan
    $fingerprintApproval = Read-Host 'Does this exactly match the fingerprint shown on the main PC? [y/N]'
    if ($fingerprintApproval -notmatch '^[Yy]$') { throw 'The SSH host fingerprint was not approved.' }

    $files = Write-XcodeOfficeFiles `
        -Pairing $session.Response `
        -HostKey $validation.HostKey `
        -KeyPath $keyPath `
        -WezTermPath $wezterm `
        -SshPath $ssh `
        -TailscalePath $tailscale `
        -InstallRoot $installRoot

    Write-XcodeStep 'Verifying pinned SSH, matching WezTerm, and the host mux'
    if (-not (Test-XcodeSshConnection -SshExe $ssh -ConfigPath $files.SshConfig)) {
        throw 'Pinned, key-only SSH verification failed.'
    }
    $remoteProxy = [string]$session.Response.remoteWezTermPath
    $remoteVersion = (& $ssh -F $files.SshConfig -o BatchMode=yes xcode-main ($remoteProxy + ' --version') 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $remoteVersion -ne $localVersion.Trim()) {
        throw "WezTerm versions differ. Main: $remoteVersion; office: $localVersion"
    }
    $remoteMux = (& $ssh -F $files.SshConfig -o BatchMode=yes xcode-main ($remoteProxy + ' cli --prefer-mux list --format json') 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -or -not $remoteMux.Trim().StartsWith('[')) {
        throw "The persistent host mux is unavailable:`n$remoteMux"
    }

    Write-XcodeStep 'Opening one real XCODE_MAIN window for final confirmation'
    Start-Process -FilePath $wezterm -ArgumentList @('--config-file', $files.WezTermConfig, 'connect', 'XCODE_MAIN') | Out-Null
    Start-Sleep -Seconds 3
    $attachApproval = Read-Host 'Did the WezTerm window open and show the main-PC PowerShell workspace? [y/N]'
    if ($attachApproval -notmatch '^[Yy]$') { throw 'The real WezTerm attach was not confirmed.' }

    $commitSent = $true
    Close-XcodePairSession -Session $session -Action commit -AuthorizedKeyFingerprint $validation.LocalFingerprint
    $committed = $true
}
catch {
    if (-not $commitSent) {
        if ($session -and -not $committed) {
            try { Close-XcodePairSession -Session $session -Action abort } catch {}
        }
        foreach ($path in $trackedPaths) {
            $snapshot = $snapshots[$path]
            try {
                if ($snapshot.Existed) { Write-XcodeUtf8File -Path $path -Content ([string]$snapshot.Content) }
                elseif (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
            }
            catch {}
        }
        try { [Environment]::SetEnvironmentVariable('Path', $previousUserPath, 'User') } catch {}
    }
    else {
        Write-Warning 'The commit acknowledgement was interrupted. Keeping the already-validated local files avoids a split-brain rollback; rerun install-office.cmd or xcode doctor to resolve the final state.'
    }
    throw
}

Write-Host ''
Write-Host 'Office laptop setup is complete.' -ForegroundColor Green
Write-Host 'Open a NEW PowerShell window and run:'
Write-Host '  xcode' -ForegroundColor Cyan
Write-Host 'Use Ctrl+Shift+Alt+D to detach without terminating the shared panes.'
Write-Host 'Diagnostics: xcode doctor    Emergency shell: xcode ssh'
