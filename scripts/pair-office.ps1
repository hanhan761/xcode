[CmdletBinding()]
param(
    [string]$ExpectedSid,
    [string]$ExpectedUser,
    [ValidateRange(1024, 65535)][int]$Port = 43122,
    [ValidateRange(1, 60)][int]$TimeoutMinutes = 10,
    [ValidateRange(1, 10)][int]$MaximumAttempts = 3
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'XcodeRemote.Common.ps1')

if (-not $ExpectedSid) { $ExpectedSid = Get-XcodeCurrentSid }
if (-not $ExpectedUser) { $ExpectedUser = $env:USERNAME }

if (-not (Test-XcodeAdministrator)) {
    Invoke-XcodeElevatedPowerShell `
        -ScriptPath $PSCommandPath `
        -Arguments @(
            '-ExpectedSid', $ExpectedSid,
            '-ExpectedUser', $ExpectedUser,
            '-Port', ([string]$Port),
            '-TimeoutMinutes', ([string]$TimeoutMinutes),
            '-MaximumAttempts', ([string]$MaximumAttempts)
        )
    exit 0
}
Assert-XcodeElevatedIdentity -ExpectedSid $ExpectedSid -ExpectedUser $ExpectedUser

function Write-PairResponse {
    param(
        [Parameter(Mandatory = $true)][IO.StreamWriter]$Writer,
        [Parameter(Mandatory = $true)][object]$Response
    )
    $Writer.WriteLine(($Response | ConvertTo-Json -Compress -Depth 8))
    $Writer.Flush()
}

$tailscale = Get-XcodeTailscaleExecutable
$wezterm = Get-XcodeWezTermExecutable
if (-not $tailscale) { throw 'Tailscale is not installed on the main PC.' }
if (-not $wezterm) { throw 'WezTerm is not installed on the main PC.' }

$machineStatePath = Join-Path $env:ProgramData 'XcodeRemote\host.json'
$userStatePath = Join-Path $env:LOCALAPPDATA 'XcodeRemote\host-user.json'
$transactionPath = Join-Path $env:ProgramData 'XcodeRemote\pairing-pending.json'
$watchdogScript = Join-Path $PSScriptRoot 'pairing-watchdog.ps1'
if (Test-Path -LiteralPath $transactionPath -PathType Leaf) {
    Write-Warning 'Recovering an interrupted office pairing before opening a new window.'
    & $watchdogScript -TransactionPath $transactionPath -RecoverNow
}
if (-not (Test-Path -LiteralPath $machineStatePath) -or -not (Test-Path -LiteralPath $userStatePath)) {
    throw 'The main PC is not staged. Run xcode setup main first.'
}
$machineStateOriginalContent = Get-Content -Raw -LiteralPath $machineStatePath
$machineState = $machineStateOriginalContent | ConvertFrom-Json
$userState = Get-Content -Raw -LiteralPath $userStatePath | ConvertFrom-Json
if ([string]$machineState.windowsSid -ne $ExpectedSid -or [string]$userState.windowsSid -ne $ExpectedSid) {
    throw 'The staged main-PC configuration belongs to a different Windows account.'
}

$status = Wait-XcodeTailscaleOnline -TimeoutSeconds 30
$mainIp = Get-XcodeTailscaleIPv4
if ($mainIp -ne [string]$machineState.tailscaleIPv4) {
    throw 'The main PC Tailscale address changed after SSH was staged. Rerun xcode setup main before pairing.'
}
$adapter = Get-XcodeTailscaleAdapter
$selfUserId = [string]$status.Self.UserID
$mainNodeId = [string]$status.Self.ID
$mainName = [string]$status.Self.HostName
$dnsName = ([string]$status.Self.DNSName).TrimEnd('.')
$weztermVersion = [string](& $wezterm --version 2>$null | Select-Object -First 1)
Assert-XcodeSupportedWezTermVersion -Version $weztermVersion
$remoteWezTermPath = [string]$machineState.remoteWezTermPath
Assert-XcodeNoControlCharacters -Value $remoteWezTermPath -FieldName 'Remote WezTerm proxy path'
if ($remoteWezTermPath -notmatch '^[A-Za-z]:/[A-Za-z0-9._/-]+\.cmd$' -or
    -not (Test-Path -LiteralPath ($remoteWezTermPath -replace '/', '\'))) {
    throw 'The trusted remote WezTerm proxy is missing or invalid. Rerun xcode setup main.'
}

$hostKeyPath = Join-Path $env:ProgramData 'ssh\ssh_host_ed25519_key.pub'
if (-not (Test-Path -LiteralPath $hostKeyPath)) { throw 'The staged OpenSSH Ed25519 host key is missing.' }
$hostKey = Get-XcodeCanonicalSshPublicKey -PublicKey (Get-Content -Raw -LiteralPath $hostKeyPath)
$hostKeyFingerprint = Get-XcodeSshPublicKeyFingerprint -PublicKey $hostKey

$sshRuleName = 'XcodeRemote-SSH-Tailscale'
if (-not (Get-NetFirewallRule -Name $sshRuleName -ErrorAction SilentlyContinue)) {
    throw 'The staged Tailscale-only SSH firewall rule is missing. Rerun xcode setup main.'
}

$pairRuleName = 'XcodeRemote-OneTimePairing'
Remove-NetFirewallRule -Name $pairRuleName -ErrorAction SilentlyContinue
New-NetFirewallRule `
    -Name $pairRuleName `
    -DisplayName 'Xcode Remote one-time pairing' `
    -Group 'Xcode Remote' `
    -Enabled True `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -LocalAddress $mainIp `
    -InterfaceAlias $adapter.Name `
    -RemoteAddress @('100.64.0.0/10', 'fd7a:115c:a1e0::/48') `
    -Profile Any | Out-Null

$pairCode = New-XcodePairCode
$displayCode = $pairCode.Substring(0, 4) + '-' + $pairCode.Substring(4, 4)
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse($mainIp), $Port)
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$attempts = 0
$paired = $false

Write-Host ''
Write-Host 'ONE-TIME OFFICE LAPTOP PAIRING' -ForegroundColor Yellow
Write-Host "Main host       : $mainName ($dnsName)"
Write-Host "Pairing address : ${mainIp}:$Port"
Write-Host "Pairing code    : $displayCode" -ForegroundColor Green
Write-Host "Expires         : $($deadline.ToString('HH:mm:ss'))"
Write-Host "SSH host key    : $hostKeyFingerprint" -ForegroundColor Cyan
Write-Host ''
Write-Host 'On the prepared office laptop, run xcode pair and compare this SSH fingerprint exactly.'

try {
    $listener.Start(5)
    while ((Get-Date) -lt $deadline -and $attempts -lt $MaximumAttempts -and -not $paired) {
        if (-not $listener.Pending()) {
            Start-Sleep -Milliseconds 200
            continue
        }

        $client = $null
        $reader = $null
        $writer = $null
        $keyChange = $null
        $serviceWasRunning = (Get-Service -Name sshd).Status -eq 'Running'
        $serviceStartType = [string](Get-CimInstance Win32_Service -Filter "Name='sshd'").StartMode
        $sshRuleWasEnabled = (Get-NetFirewallRule -Name $sshRuleName).Enabled -eq 'True'
        $responseSent = $false
        $transactionCreated = $false
        try {
            $client = $listener.AcceptTcpClient()
            $client.ReceiveTimeout = 20000
            $client.SendTimeout = 20000
            $remoteIp = $client.Client.RemoteEndPoint.Address.ToString()
            $stream = $client.GetStream()
            $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $false, 4096, $true)
            $writer = [IO.StreamWriter]::new($stream, (New-Object Text.UTF8Encoding($false)), 4096, $true)
            $writer.AutoFlush = $true

            $line = $reader.ReadLine()
            if (-not $line -or $line.Length -gt 8192) { throw 'The pairing request was empty or too large.' }
            $request = $line | ConvertFrom-Json
            $attempts++

            $submittedCode = ([string]$request.pairCode) -replace '[^0-9]', ''
            if ([int]$request.protocolVersion -ne 2 -or $submittedCode -ne $pairCode) {
                Write-PairResponse -Writer $writer -Response @{ ok = $false; error = 'PAIR_CODE_INVALID' }
                Write-Warning "Rejected pairing attempt $attempts from $remoteIp."
                continue
            }
            $nonce = [string]$request.nonce
            if ($nonce -notmatch '^[0-9a-f]{32}$') { throw 'The pairing nonce is invalid.' }
            $clientVersion = [string]$request.weztermVersion
            Assert-XcodeNoControlCharacters -Value $clientVersion -FieldName 'Client WezTerm version'
            if (-not $clientVersion -or $clientVersion.Length -gt 100) { throw 'The client WezTerm version is invalid.' }
            if ($clientVersion.Trim() -ne $weztermVersion.Trim()) {
                Write-PairResponse -Writer $writer -Response @{ ok = $false; error = 'WEZTERM_VERSION_MISMATCH'; mainVersion = $weztermVersion }
                Write-Warning "Rejected mismatched WezTerm version. Main: $weztermVersion; office: $clientVersion"
                continue
            }

            $whois = Get-XcodeTailscaleWhois -Address $remoteIp
            if ([string]$whois.UserProfile.ID -ne $selfUserId) {
                throw 'The requester is not owned by the same Tailscale user as the main PC.'
            }
            $deviceId = [string]$whois.Node.StableID
            $deviceName = [string]$whois.Node.ComputedName
            if (-not $deviceName) { $deviceName = [string]$whois.Node.Hostinfo.Hostname }
            Assert-XcodeNoControlCharacters -Value $deviceName -FieldName 'Tailscale device name'
            $sourceAddresses = @($whois.Node.Addresses | ForEach-Object { [string]$_ } | Where-Object {
                $_ -match '^100\..*/32$' -or $_ -match '^(?i)fd7a:115c:a1e0:.*?/128$'
            })
            if ($sourceAddresses.Count -eq 0) { throw 'The requester has no stable Tailscale source address.' }

            $canonicalKey = Get-XcodeCanonicalSshPublicKey -PublicKey ([string]$request.publicKey)
            $clientFingerprint = Get-XcodeSshPublicKeyFingerprint -PublicKey $canonicalKey
            Write-Host ''
            Write-Host 'Verified pairing request:' -ForegroundColor Cyan
            Write-Host "  Tailscale device : $deviceName"
            Write-Host "  Stable node ID   : $deviceId"
            Write-Host "  Tailscale user   : $($whois.UserProfile.LoginName)"
            Write-Host "  Source addresses : $($sourceAddresses -join ', ')"
            Write-Host "  SSH key          : $clientFingerprint"
            $approval = Read-Host 'Approve this office laptop? [y/N]'
            if ($approval -notmatch '^[Yy]$') {
                Write-PairResponse -Writer $writer -Response @{ ok = $false; error = 'PAIRING_REJECTED' }
                Write-Warning 'Pairing was rejected locally.'
                continue
            }

            $authorizedPath = Get-XcodeAuthorizedKeysPath
            $authorizedHadFile = Test-Path -LiteralPath $authorizedPath -PathType Leaf
            $authorizedOriginalContent = if ($authorizedHadFile) { Get-Content -Raw -LiteralPath $authorizedPath } else { '' }
            $transaction = [ordered]@{
                schemaVersion = 1
                status = 'pending'
                transactionId = $nonce
                parentPid = $PID
                expiresAt = (Get-Date).ToUniversalTime().AddMinutes(5).ToString('o')
                authorizedKeysPath = $authorizedPath
                authorizedKeysHadFile = $authorizedHadFile
                authorizedKeysOriginalContent = $authorizedOriginalContent
                hostStatePath = $machineStatePath
                hostStateOriginalContent = $machineStateOriginalContent
                serviceStartType = $serviceStartType
                serviceWasRunning = $serviceWasRunning
                firewallRuleName = $sshRuleName
                firewallWasEnabled = $sshRuleWasEnabled
            }
            Write-XcodeUtf8File -Path $transactionPath -Content ($transaction | ConvertTo-Json -Depth 5)
            Set-XcodeAdministratorsAuthorizedKeysAcl -Path $transactionPath
            $transactionCreated = $true

            $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $watchdogArguments = @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $watchdogScript,
                '-TransactionPath', $transactionPath, '-ParentPid', ([string]$PID)
            )
            $watchdogCommandLine = ($watchdogArguments | ForEach-Object {
                ConvertTo-XcodeCommandLineArgument -Value ([string]$_)
            }) -join ' '
            $watchdogProcess = Start-Process -FilePath $powershell -ArgumentList $watchdogCommandLine -WindowStyle Hidden -PassThru
            Start-Sleep -Milliseconds 250
            if ($watchdogProcess.HasExited) { throw 'The pairing rollback watchdog could not start.' }

            $keyChange = Add-XcodeAuthorizedKey `
                -PublicKey $canonicalKey `
                -DeviceLabel "$deviceId-$deviceName" `
                -SourceAddresses $sourceAddresses

            Set-Service -Name sshd -StartupType Manual
            Start-Service -Name sshd
            Enable-NetFirewallRule -Name $sshRuleName | Out-Null
            Start-Sleep -Milliseconds 500
            $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue)
            if ($listeners.Count -eq 0 -or @($listeners | Where-Object { $_.LocalAddress -ne $mainIp }).Count -ne 0) {
                throw 'sshd did not bind exclusively to the Tailscale IPv4 address.'
            }

            $proof = Get-XcodePairProof `
                -PairCode $pairCode `
                -Nonce $nonce `
                -MainNodeId $mainNodeId `
                -MainIp $mainIp `
                -DnsName $dnsName `
                -WindowsUser $ExpectedUser `
                -HostKeyFingerprint $hostKeyFingerprint `
                -AuthorizedKeyFingerprint $keyChange.Fingerprint `
                -RequesterNodeId $deviceId `
                -RemoteWezTermPath $remoteWezTermPath `
                -WezTermVersion $weztermVersion
            $response = [ordered]@{
                ok = $true
                protocolVersion = 2
                nonce = $nonce
                mainName = $mainName
                mainNodeId = $mainNodeId
                dnsName = $dnsName
                tailscaleIPv4 = $mainIp
                sshPort = 22
                windowsUser = $ExpectedUser
                sshHostKey = $hostKey
                sshHostKeyFingerprint = $hostKeyFingerprint
                authorizedKeyFingerprint = $keyChange.Fingerprint
                requesterNodeId = $deviceId
                requesterAddresses = $sourceAddresses
                weztermVersion = $weztermVersion
                remoteWezTermPath = $remoteWezTermPath
                proof = $proof
            }
            Write-PairResponse -Writer $writer -Response $response
            $responseSent = $true

            $client.ReceiveTimeout = 300000
            $commitLine = $reader.ReadLine()
            if (-not $commitLine -or $commitLine.Length -gt 2048) { throw 'The office laptop did not commit pairing in time.' }
            $commit = $commitLine | ConvertFrom-Json
            if ([string]$commit.action -ne 'commit' -or [string]$commit.nonce -ne $nonce -or [string]$commit.authorizedKeyFingerprint -ne $keyChange.Fingerprint) {
                throw 'The office laptop sent an invalid pairing commit.'
            }

            $stateMap = [ordered]@{}
            foreach ($property in $machineState.PSObject.Properties) { $stateMap[$property.Name] = $property.Value }
            $stateMap.pendingFirstPair = $false
            $stateMap.lastPairedNodeId = $deviceId
            $stateMap.lastPairedKeyFingerprint = $keyChange.Fingerprint
            $stateMap.lastPairedAt = (Get-Date).ToUniversalTime().ToString('o')
            Write-XcodeUtf8File -Path $machineStatePath -Content ($stateMap | ConvertTo-Json -Depth 6)
            Remove-Item -LiteralPath $transactionPath -Force
            $transactionCreated = $false
            Set-Service -Name sshd -StartupType Automatic
            Write-PairResponse -Writer $writer -Response @{ ok = $true; action = 'committed'; nonce = $nonce }
            $paired = $true

            Write-Host ''
            Write-Host "Paired $deviceName successfully." -ForegroundColor Green
            Write-Host "Authorized key : $($keyChange.Path)"
        }
        catch {
            if ($keyChange) {
                try { Undo-XcodeAuthorizedKeyChange -Change $keyChange }
                catch { Write-Warning "Could not roll back the staged SSH key: $($_.Exception.Message)" }
                try { Write-XcodeUtf8File -Path $machineStatePath -Content $machineStateOriginalContent } catch {}
            }
            if (-not $sshRuleWasEnabled) {
                try { Disable-NetFirewallRule -Name $sshRuleName | Out-Null } catch {}
            }
            try {
                if ($serviceWasRunning) { Start-Service -Name sshd -ErrorAction SilentlyContinue }
                else { Stop-Service -Name sshd -Force -ErrorAction SilentlyContinue }
                if ($serviceStartType -eq 'Auto') { Set-Service -Name sshd -StartupType Automatic }
                elseif ($serviceStartType -eq 'Disabled') { Set-Service -Name sshd -StartupType Disabled }
                else { Set-Service -Name sshd -StartupType Manual }
            }
            catch {}
            if ($transactionCreated) {
                try { Remove-Item -LiteralPath $transactionPath -Force -ErrorAction SilentlyContinue } catch {}
                $transactionCreated = $false
            }
            if ($writer -and -not $responseSent) {
                try { Write-PairResponse -Writer $writer -Response @{ ok = $false; error = 'PAIRING_FAILED'; message = $_.Exception.Message } }
                catch {}
            }
            Write-Warning $_.Exception.Message
        }
        finally {
            if ($reader) { $reader.Dispose() }
            if ($writer) { $writer.Dispose() }
            if ($client) { $client.Dispose() }
        }
    }
}
finally {
    $listener.Stop()
    Remove-NetFirewallRule -Name $pairRuleName -ErrorAction SilentlyContinue
}

if (-not $paired) {
    throw 'Pairing closed without a committed office laptop. No newly staged SSH key was retained.'
}
