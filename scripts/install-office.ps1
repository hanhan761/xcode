[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9.-]+$')][string]$MainHost = 'xcode-main',
    [ValidatePattern('^[A-Za-z0-9-]+$')][string]$OfficeName = 'xcode-office',
    [ValidateRange(1024, 65535)][int]$PairPort = 43122,
    [switch]$SetupOnly,
    [switch]$PairOnly,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'XcodeRemote.Common.ps1')
if ($SetupOnly -and $PairOnly) { throw 'Office setup and pairing must be run as separate xcode commands.' }

function Test-XcodeSshConnection {
    param(
        [Parameter(Mandatory = $true)][string]$SshExe,
        [Parameter(Mandatory = $true)][string]$ConfigPath
    )
    if (-not (Test-Path -LiteralPath $ConfigPath)) { return $false }
    $output = (& $SshExe -F $ConfigPath -o BatchMode=yes xcode-main xcode-gateway probe 2>$null | Out-String)
    return $LASTEXITCODE -eq 0 -and $output -match 'XCODE_GATEWAY_OK'
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
        [Parameter(Mandatory = $true)][string]$DeviceName
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
            protocolVersion = 3
            pairCode = (($PairCode -replace '[^0-9]', ''))
            nonce = $nonce
            publicKey = $PublicKey.Trim()
            deviceName = $DeviceName
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
        [Parameter(Mandatory = $true)][string]$LocalPublicKey
    )

    $response = $Session.Response
    if ([int]$response.protocolVersion -ne 3 -or [string]$response.nonce -ne [string]$Session.Nonce) {
        throw 'The pairing response protocol or nonce is invalid.'
    }
    if ([string]$response.mainNodeId -ne [string]$MainWhois.Node.StableID) {
        throw 'The pairing responder does not match the Tailscale node reached by the office laptop.'
    }
    if ([string]$response.tailscaleIPv4 -ne $PairAddress) { throw 'The pairing response returned a different main-PC address.' }
    if ([string]$response.requesterNodeId -ne [string]$LocalStatus.Self.ID) { throw 'The main PC did not bind this key to the office laptop node.' }
    if ([int]$response.sshPort -ne 22) { throw 'The pairing response requested an unexpected SSH port.' }
    $validatedFields = @{
        mainName = '^[A-Za-z0-9-]{1,63}$'
        dnsName = '^[A-Za-z0-9.-]{1,253}$'
        windowsUser = '^[A-Za-z0-9._@\\-]{1,128}$'
    }
    foreach ($field in $validatedFields.Keys) {
        $value = [string]$response.$field
        Assert-XcodeNoControlCharacters -Value $value -FieldName $field
        if ($value -notmatch $validatedFields[$field]) { throw "The pairing response field $field is invalid." }
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
        -RequesterNodeId ([string]$response.requesterNodeId)
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
        [Parameter(Mandatory = $true)][string]$InstallRoot
    )

    if (-not (Test-Path -LiteralPath $InstallRoot)) { New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null }
    $knownHosts = Join-Path $InstallRoot 'known_hosts'
    $sshConfig = Join-Path $InstallRoot 'ssh_config'

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

    $state = [ordered]@{
        schemaVersion = 3
        role = 'office'
        mainName = [string]$Pairing.mainName
        mainNodeId = [string]$Pairing.mainNodeId
        tailscaleIPv4 = [string]$Pairing.tailscaleIPv4
        windowsUser = [string]$Pairing.windowsUser
        sshHostKeyFingerprint = [string]$Pairing.sshHostKeyFingerprint
        authorizedKeyFingerprint = [string]$Pairing.authorizedKeyFingerprint
        keyPath = $KeyPath
        configuredAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-XcodeUtf8File -Path (Join-Path $InstallRoot 'client.json') -Content ($state | ConvertTo-Json -Depth 5)
    return [pscustomobject]@{ SshConfig = $sshConfig }
}

function Write-XcodeOfficeSetupFiles {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$OfficeName,
        [Parameter(Mandatory = $true)][string]$KeyPath
    )

    if (-not (Test-Path -LiteralPath $InstallRoot)) { New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null }
    Remove-XcodePathEntry -Directory (Join-Path $InstallRoot 'bin')
    $setupState = [ordered]@{
        schemaVersion = 1
        role = 'office'
        officeName = $OfficeName
        keyPath = $KeyPath
        configuredAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-XcodeUtf8File -Path (Join-Path $InstallRoot 'office-setup.json') -Content ($setupState | ConvertTo-Json -Depth 4)
}

function Remove-XcodeMainRoleResidue {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)

    $mainState = Join-Path $InstallRoot 'host-user.json'
    if (Test-Path -LiteralPath $mainState -PathType Leaf) {
        Remove-Item -LiteralPath $mainState -Force
        Write-Host 'Removed a stale local main-PC role marker before preparing this office laptop.' -ForegroundColor Yellow
    }

    $profilePath = $PROFILE.CurrentUserAllHosts
    if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) { return }
    $existing = Get-Content -Raw -LiteralPath $profilePath
    $updated = Update-XcodeManagedCodexProfileContent -Content $existing
    if ($updated -ne $existing) {
        Write-XcodeUtf8File -Path $profilePath -Content $updated
        Write-Host 'Removed the main-PC Codex profile entrypoint from this office laptop.' -ForegroundColor Yellow
    }
}

if (-not $PairOnly) {
    Write-XcodeStep 'Checking WinGet and required office-laptop software'
    $winget = Assert-XcodeWinget
    Ensure-XcodeWingetPackage -WingetPath $winget -PackageId 'Tailscale.Tailscale' -DryRun:$DryRun
}
Refresh-XcodeProcessPath
if ($DryRun) {
    Write-Host '[dry-run] Office prerequisites, dedicated key, and authenticated pairing'
    exit 0
}

$currentSid = Get-XcodeCurrentSid
$currentUser = $env:USERNAME
$ssh = Get-XcodeOpenSshExecutable -Name 'ssh.exe'
$sshKeygen = Get-XcodeOpenSshExecutable -Name 'ssh-keygen.exe'
if ($PairOnly -and (-not $ssh -or -not $sshKeygen)) {
    throw 'This office laptop is not prepared. Run xcode setup office before xcode pair.'
}
if (-not $ssh -or -not $sshKeygen) {
    Write-XcodeStep 'Requesting one administrator step for Windows OpenSSH Client'
    Invoke-XcodeElevatedPowerShell `
        -ScriptPath (Join-Path $PSScriptRoot 'install-office-machine.ps1') `
        -Arguments @('-ExpectedSid', $currentSid, '-ExpectedUser', $currentUser)
}

$tailscale = Get-XcodeTailscaleExecutable
$ssh = Get-XcodeOpenSshExecutable -Name 'ssh.exe'
$sshKeygen = Get-XcodeOpenSshExecutable -Name 'ssh-keygen.exe'
if (-not $tailscale -or -not $ssh -or -not $sshKeygen) {
    throw 'A trusted Tailscale or Windows OpenSSH executable is missing.'
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
$officeSetupStatePath = Join-Path $installRoot 'office-setup.json'
if (-not $PairOnly) { Remove-XcodeMainRoleResidue -InstallRoot $installRoot }
$sshDirectory = Join-Path $env:USERPROFILE '.ssh'
$keyPath = Join-Path $sshDirectory 'xcode_office_ed25519'
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
if ($PairOnly) {
    if (-not (Test-Path -LiteralPath $officeSetupStatePath -PathType Leaf)) {
        throw 'This office laptop is not prepared. Run xcode setup office before xcode pair.'
    }
    $setupState = Get-Content -Raw -LiteralPath $officeSetupStatePath | ConvertFrom-Json
    if ([string]$setupState.role -ne 'office') { throw 'The office setup state is invalid. Run xcode setup office again.' }
}
if ($SetupOnly) {
    Write-XcodeOfficeSetupFiles `
        -InstallRoot $installRoot `
        -OfficeName $OfficeName `
        -KeyPath $keyPath
    Write-Host ''
    Write-Host 'Office laptop is prepared.' -ForegroundColor Green
    Write-Host 'Next: on the main PC run xcode pair; then on this laptop run xcode pair.'
    exit 0
}

$existingSshConfig = Join-Path $installRoot 'ssh_config'
$existingStatePath = Join-Path $installRoot 'client.json'
if ((-not $PairOnly) -and (Test-XcodeSshConnection -SshExe $ssh -ConfigPath $existingSshConfig) -and
    (Test-Path -LiteralPath $existingStatePath)) {
    try {
        $existingState = Get-Content -Raw -LiteralPath $existingStatePath | ConvertFrom-Json
        if ([int]$existingState.schemaVersion -lt 2) { throw 'The installed office schema is outdated.' }
        $existingSshContent = Get-Content -Raw -LiteralPath $existingSshConfig
        if ($existingSshContent -notmatch '(?m)^\s*StrictHostKeyChecking yes\r?$') {
            throw 'An installed office file no longer matches the managed security policy.'
        }
        Remove-XcodePathEntry -Directory (Join-Path $installRoot 'bin')
        $launcher = Write-XcodeOfficeAttachAllLauncher
        Write-Host 'This office laptop is already paired; pinned SSH is working.' -ForegroundColor Green
        Write-Host "One-click active conversations: $launcher" -ForegroundColor Cyan
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
if (-not $pairAddress) { throw "Cannot resolve $MainHost to a Tailscale IPv4 address. Confirm xcode pair is open on the main PC." }

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
        -DeviceName ([string]$status.Self.HostName)
    if ($candidate.Ok) { $session = $candidate }
    else { Write-Warning "Pairing was rejected by the verified Tailscale peer ($($candidate.ErrorCode))." }
}
if (-not $session) { throw 'Pairing failed after three attempts. Open a new pairing window on the main PC and retry.' }

$trackedPaths = @(
    (Join-Path $installRoot 'known_hosts'),
    (Join-Path $installRoot 'ssh_config'),
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
        -LocalPublicKey $publicKey

    Write-Host ''
    Write-Host "Main-PC SSH fingerprint: $($validation.HostFingerprint)" -ForegroundColor Cyan
    $fingerprintApproval = Read-Host 'Does this exactly match the fingerprint shown on the main PC? [y/N]'
    if ($fingerprintApproval -notmatch '^[Yy]$') { throw 'The SSH host fingerprint was not approved.' }

    $files = Write-XcodeOfficeFiles `
        -Pairing $session.Response `
        -HostKey $validation.HostKey `
        -KeyPath $keyPath `
        -InstallRoot $installRoot

    Write-XcodeStep 'Verifying pinned, key-only SSH'
    if (-not (Test-XcodeSshConnection -SshExe $ssh -ConfigPath $files.SshConfig)) {
        throw 'Pinned, key-only SSH verification failed.'
    }

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
        Write-Warning 'The commit acknowledgement was interrupted. Keeping the already-validated local files avoids a split-brain rollback; rerun xcode pair or xcode doctor to resolve the final state.'
    }
    throw
}

Write-Host ''
Write-Host 'Office laptop setup is complete.' -ForegroundColor Green
Write-Host 'Open a NEW PowerShell window and run:'
Write-Host '  xcode' -ForegroundColor Cyan
Write-Host "One-click active conversations: $(Write-XcodeOfficeAttachAllLauncher)" -ForegroundColor Cyan
Write-Host 'Use Ctrl+C to detach without changing the main-PC Codex conversation.'
Write-Host 'Diagnostics: xcode doctor'
