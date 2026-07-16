Set-StrictMode -Version Latest

function Write-XcodeStep {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Test-XcodeAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-XcodeCurrentSid {
    return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Assert-XcodeAdministrator {
    if (-not (Test-XcodeAdministrator)) {
        throw 'Administrator permission is required for this machine-level step.'
    }
}

function Assert-XcodeElevatedIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedSid,
        [Parameter(Mandatory = $true)][string]$ExpectedUser
    )

    Assert-XcodeAdministrator
    $actualSid = Get-XcodeCurrentSid
    if ($actualSid -ne $ExpectedSid) {
        throw "UAC switched to another Windows account. Sign in as an administrator account that you intend to use for xcode, then rerun the installer. Expected SID: $ExpectedSid; elevated SID: $actualSid."
    }
    if (-not $env:USERNAME.Equals($ExpectedUser, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The elevated Windows username changed unexpectedly. Expected $ExpectedUser; got $env:USERNAME."
    }
}

function ConvertTo-XcodeCommandLineArgument {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    if ($Value -notmatch '[\s"]') {
        return $Value
    }
    if ($Value.EndsWith('\')) {
        throw "A process argument cannot end in a backslash: $Value"
    }
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Invoke-XcodeElevatedPowerShell {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @()
    )

    $resolvedScript = (Resolve-Path -LiteralPath $ScriptPath).Path
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $allArguments = @(
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $resolvedScript
    ) + @($Arguments)
    $commandLine = ($allArguments | ForEach-Object { ConvertTo-XcodeCommandLineArgument -Value ([string]$_) }) -join ' '
    $process = Start-Process -FilePath $powershell -ArgumentList $commandLine -Verb RunAs -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "The administrator step failed (exit $($process.ExitCode))."
    }
}

function Refresh-XcodeProcessPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($machine, $user) -join ';'
}

function Find-XcodeExecutable {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string[]]$Candidates = @(),
        [switch]$DoNotSearchPath
    )

    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    if (-not $DoNotSearchPath) {
        $command = Get-Command $Name -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
    }
    return $null
}

function Invoke-XcodeNativeCapture {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = (& $FilePath @ArgumentList 2>$null | Out-String)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    return [pscustomobject]@{
        Output = [string]$output
        ExitCode = [int]$exitCode
    }
}

function Get-XcodeWingetExecutable {
    return Find-XcodeExecutable -Name 'winget.exe' -Candidates @(
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe')
    )
}

function Assert-XcodeWinget {
    $winget = Get-XcodeWingetExecutable
    if (-not $winget) {
        throw 'WinGet is required. Install or update Microsoft App Installer, then run this installer again.'
    }
    return $winget
}

function Test-XcodeWingetPackage {
    param(
        [Parameter(Mandatory = $true)][string]$WingetPath,
        [Parameter(Mandatory = $true)][string]$PackageId
    )

    $output = (& $WingetPath list --id $PackageId --exact --accept-source-agreements 2>&1 | Out-String)
    return $output -match [regex]::Escape($PackageId)
}

function Ensure-XcodeWingetPackage {
    param(
        [Parameter(Mandatory = $true)][string]$WingetPath,
        [Parameter(Mandatory = $true)][string]$PackageId,
        [switch]$DryRun
    )

    if (Test-XcodeWingetPackage -WingetPath $WingetPath -PackageId $PackageId) {
        Write-Host "Already installed: $PackageId"
        return
    }
    if ($DryRun) {
        Write-Host "[dry-run] winget install $PackageId"
        return
    }

    Write-Host "Installing $PackageId ..."
    & $WingetPath install --id $PackageId --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) {
        throw "WinGet failed to install $PackageId (exit $LASTEXITCODE)."
    }
    Refresh-XcodeProcessPath
}

function Add-XcodePathEntry {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [ValidateSet('User', 'Machine')][string]$Scope = 'User',
        [switch]$DryRun
    )

    $fullPath = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
    $current = [Environment]::GetEnvironmentVariable('Path', $Scope)
    $entries = @($current -split ';' | Where-Object { $_ })
    foreach ($entry in $entries) {
        if ($entry.TrimEnd('\').Equals($fullPath, [StringComparison]::OrdinalIgnoreCase)) {
            return [pscustomobject]@{ Changed = $false; Previous = $current }
        }
    }

    if ($DryRun) {
        Write-Host "[dry-run] add $fullPath to $Scope PATH"
        return [pscustomobject]@{ Changed = $false; Previous = $current }
    }

    [Environment]::SetEnvironmentVariable('Path', ((@($entries) + $fullPath) -join ';'), $Scope)
    Refresh-XcodeProcessPath
    return [pscustomobject]@{ Changed = $true; Previous = $current }
}

function Remove-XcodePathEntry {
    param([Parameter(Mandatory = $true)][string]$Directory)

    $normalized = $Directory.TrimEnd('\').ToLowerInvariant()
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $current) { return }
    $entries = @($current -split ';' | Where-Object {
        $_ -and $_.TrimEnd('\').ToLowerInvariant() -ne $normalized
    })
    [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
    Refresh-XcodeProcessPath
}

function Write-XcodeUtf8File {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content
    )

    $directory = Split-Path -Parent $Path
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    $leaf = Split-Path -Leaf $Path
    $temporary = Join-Path $directory ('.' + $leaf + '.xcode-tmp-' + [Guid]::NewGuid().ToString('N'))
    $replacementBackup = Join-Path $directory ('.' + $leaf + '.xcode-replaced-' + [Guid]::NewGuid().ToString('N'))
    $encoding = New-Object Text.UTF8Encoding($false)
    try {
        [IO.File]::WriteAllText($temporary, $Content, $encoding)
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            [IO.File]::Replace($temporary, $Path, $replacementBackup)
        }
        else {
            Move-Item -LiteralPath $temporary -Destination $Path
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $replacementBackup) {
            Remove-Item -LiteralPath $replacementBackup -Force -ErrorAction SilentlyContinue
        }
    }
}

function Backup-XcodeFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$Path.xcode-backup-$stamp"
    $suffix = 0
    while (Test-Path -LiteralPath $backup) {
        $suffix++
        $backup = "$Path.xcode-backup-$stamp-$suffix"
    }
    Copy-Item -LiteralPath $Path -Destination $backup
    return $backup
}

function Assert-XcodeNoControlCharacters {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value,
        [Parameter(Mandatory = $true)][string]$FieldName
    )
    if ($Value -match '[\x00-\x1f\x7f]') {
        throw "$FieldName contains a control character."
    }
}

function Get-XcodeTailscaleExecutable {
    return Find-XcodeExecutable -Name 'tailscale.exe' -Candidates @(
        (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe')
    )
}

function Get-XcodeOpenSshExecutable {
    param([Parameter(Mandatory = $true)][string]$Name)
    return Find-XcodeExecutable -Name $Name -Candidates @(
        (Join-Path $env:WINDIR "System32\OpenSSH\$Name")
    ) -DoNotSearchPath
}

function Get-XcodeTailscaleStatus {
    $tailscale = Get-XcodeTailscaleExecutable
    if (-not $tailscale) { return $null }
    $json = (& $tailscale status --json 2>$null | Out-String)
    if (-not $json.Trim()) { return $null }
    try { return $json | ConvertFrom-Json }
    catch { return $null }
}

function Wait-XcodeTailscaleOnline {
    param([int]$TimeoutSeconds = 300)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $status = Get-XcodeTailscaleStatus
        if ($status -and $status.BackendState -eq 'Running' -and $status.Self.Online) {
            return $status
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw 'Tailscale did not become online before the timeout.'
}

function Get-XcodeTailscaleIPv4 {
    $tailscale = Get-XcodeTailscaleExecutable
    if (-not $tailscale) { throw 'Tailscale CLI was not found.' }
    $ip = (& $tailscale ip -4 2>$null | Select-Object -First 1)
    if (-not $ip -or $ip -notmatch '^100\.') { throw 'No Tailscale IPv4 address is available.' }
    return $ip.Trim()
}

function Get-XcodeTailscaleAdapter {
    $adapter = Get-NetAdapter -ErrorAction SilentlyContinue |
        Where-Object { $_.Status -eq 'Up' -and ($_.Name -match 'Tailscale' -or $_.InterfaceDescription -match 'Tailscale') } |
        Select-Object -First 1
    if (-not $adapter) { throw 'The active Tailscale network adapter was not found.' }
    return $adapter
}

function Get-XcodeTailscaleWhois {
    param([Parameter(Mandatory = $true)][string]$Address)
    $tailscale = Get-XcodeTailscaleExecutable
    if (-not $tailscale) { throw 'Tailscale CLI was not found.' }
    $json = (& $tailscale whois --json $Address 2>$null | Out-String)
    if (-not $json.Trim()) { throw "Tailscale could not identify $Address." }
    return $json | ConvertFrom-Json
}

function New-XcodePairCode {
    $bytes = New-Object byte[] 4
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) }
    finally { $rng.Dispose() }
    $number = [BitConverter]::ToUInt32($bytes, 0) % 100000000
    return $number.ToString('D8')
}

function New-XcodePairNonce {
    $bytes = New-Object byte[] 16
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) }
    finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Get-XcodePairProof {
    param(
        [Parameter(Mandatory = $true)][ValidatePattern('^\d{8}$')][string]$PairCode,
        [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{32}$')][string]$Nonce,
        [Parameter(Mandatory = $true)][string]$MainNodeId,
        [Parameter(Mandatory = $true)][string]$MainIp,
        [Parameter(Mandatory = $true)][string]$DnsName,
        [Parameter(Mandatory = $true)][string]$WindowsUser,
        [Parameter(Mandatory = $true)][string]$HostKeyFingerprint,
        [Parameter(Mandatory = $true)][string]$AuthorizedKeyFingerprint,
        [Parameter(Mandatory = $true)][string]$RequesterNodeId
    )

    $message = @(
        $Nonce,
        $MainNodeId,
        $MainIp,
        $DnsName,
        $WindowsUser,
        $HostKeyFingerprint,
        $AuthorizedKeyFingerprint,
        $RequesterNodeId
    ) -join "`n"
    $hmac = New-Object Security.Cryptography.HMACSHA256
    try {
        $hmac.Key = [Text.Encoding]::UTF8.GetBytes($PairCode)
        return [Convert]::ToBase64String($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($message)))
    }
    finally { $hmac.Dispose() }
}

function Get-XcodeCanonicalSshPublicKey {
    param([Parameter(Mandatory = $true)][string]$PublicKey)

    $parts = @($PublicKey.Trim() -split '\s+' | Where-Object { $_ })
    if ($parts.Count -lt 2 -or $parts[0] -ne 'ssh-ed25519') {
        throw 'Only Ed25519 SSH public keys are accepted.'
    }
    try { $blob = [Convert]::FromBase64String($parts[1]) }
    catch { throw 'The SSH public key is not valid base64.' }
    if ($blob.Length -ne 51) { throw 'The Ed25519 SSH public key has an unexpected length.' }

    $typeLength = ($blob[0] -shl 24) -bor ($blob[1] -shl 16) -bor ($blob[2] -shl 8) -bor $blob[3]
    $type = [Text.Encoding]::ASCII.GetString($blob, 4, $typeLength)
    if ($typeLength -ne 11 -or $type -ne 'ssh-ed25519') {
        throw 'The SSH key blob is not an Ed25519 public key.'
    }
    $keyOffset = 4 + $typeLength
    $keyLength = ($blob[$keyOffset] -shl 24) -bor ($blob[$keyOffset + 1] -shl 16) -bor ($blob[$keyOffset + 2] -shl 8) -bor $blob[$keyOffset + 3]
    if ($keyLength -ne 32) { throw 'The Ed25519 public key payload has an unexpected length.' }
    return "ssh-ed25519 $($parts[1])"
}

function Get-XcodeCanonicalKeyFromAuthorizedLine {
    param([Parameter(Mandatory = $true)][string]$Line)
    $match = [regex]::Match($Line, '(?<!\S)ssh-ed25519\s+([A-Za-z0-9+/=]+)(?=\s|$)')
    if (-not $match.Success) { return $null }
    try { return Get-XcodeCanonicalSshPublicKey -PublicKey ("ssh-ed25519 " + $match.Groups[1].Value) }
    catch { return $null }
}

function Get-XcodeSshPublicKeyFingerprint {
    param([Parameter(Mandatory = $true)][string]$PublicKey)
    $canonical = Get-XcodeCanonicalSshPublicKey -PublicKey $PublicKey
    $blob = [Convert]::FromBase64String(($canonical -split ' ')[1])
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { $hash = $sha256.ComputeHash($blob) }
    finally { $sha256.Dispose() }
    return 'SHA256:' + [Convert]::ToBase64String($hash).TrimEnd('=')
}

function Get-XcodeAuthorizedKeysPath {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        return Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
    }
    return Join-Path $env:USERPROFILE '.ssh\authorized_keys'
}

function Set-XcodeAdministratorsAuthorizedKeysAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $admins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetOwner($admins)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($admins, $system)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl

    $actual = Get-Acl -LiteralPath $Path
    $allowed = @('S-1-5-32-544', 'S-1-5-18')
    $unexpected = @($actual.Access | Where-Object {
        $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $allowed -notcontains $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    })
    $present = @($actual.Access | ForEach-Object {
        $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    } | Select-Object -Unique)
    if ($unexpected.Count -ne 0 -or @($allowed | Where-Object { $present -notcontains $_ }).Count -ne 0 -or -not $actual.AreAccessRulesProtected) {
        throw "The required SYSTEM/Administrators-only ACL could not be established on $Path."
    }
}

function New-XcodeOpenSshHostKeyAcl {
    $admins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetOwner($admins)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($admins, $system)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    return $acl
}

function Set-XcodeOpenSshHostKeyAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    Set-Acl -LiteralPath $Path -AclObject (New-XcodeOpenSshHostKeyAcl)

    $actual = Get-Acl -LiteralPath $Path
    $admins = 'S-1-5-32-544'
    $system = 'S-1-5-18'
    $allowed = @($admins, $system)
    $owner = $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $unexpected = @($actual.Access | Where-Object {
        $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $allowed -notcontains $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    })
    $present = @($actual.Access | ForEach-Object {
        $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    } | Select-Object -Unique)
    if ($owner -ne $admins -or $unexpected.Count -ne 0 -or @($allowed | Where-Object { $present -notcontains $_ }).Count -ne 0 -or -not $actual.AreAccessRulesProtected) {
        throw "The required SYSTEM/Administrators-only ACL could not be established on OpenSSH host key $Path."
    }
}

function Write-XcodeAuthorizedKeysContent {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content
    )

    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $isAdministratorsFile = $Path.StartsWith($env:ProgramData, [StringComparison]::OrdinalIgnoreCase)
    if (-not $isAdministratorsFile) {
        Write-XcodeUtf8File -Path $Path -Content $Content
        return
    }

    $temporary = Join-Path $directory ('.administrators_authorized_keys.xcode-tmp-' + [Guid]::NewGuid().ToString('N'))
    $replacementBackup = Join-Path $directory ('.administrators_authorized_keys.xcode-replaced-' + [Guid]::NewGuid().ToString('N'))
    $encoding = New-Object Text.UTF8Encoding($false)
    try {
        [IO.File]::WriteAllText($temporary, $Content, $encoding)
        Set-XcodeAdministratorsAuthorizedKeysAcl -Path $temporary
        if (Test-Path -LiteralPath $Path) {
            [IO.File]::Replace($temporary, $Path, $replacementBackup)
        }
        else {
            Move-Item -LiteralPath $temporary -Destination $Path
        }
        Set-XcodeAdministratorsAuthorizedKeysAcl -Path $Path
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $replacementBackup) {
            Remove-Item -LiteralPath $replacementBackup -Force -ErrorAction SilentlyContinue
        }
    }
}

function Add-XcodeAuthorizedKey {
    param(
        [Parameter(Mandatory = $true)][string]$PublicKey,
        [Parameter(Mandatory = $true)][string]$DeviceLabel,
        [Parameter(Mandatory = $true)][string[]]$SourceAddresses
    )

    $canonical = Get-XcodeCanonicalSshPublicKey -PublicKey $PublicKey
    $fingerprint = Get-XcodeSshPublicKeyFingerprint -PublicKey $canonical
    $safeLabel = ($DeviceLabel -replace '[^A-Za-z0-9_.:-]', '_')
    $safeSources = @()
    foreach ($source in $SourceAddresses) {
        if ($source -notmatch '^[0-9A-Fa-f:.]+/(32|128)$') {
            throw "Refusing an invalid Tailscale source restriction: $source"
        }
        $addressPart = ($source -split '/', 2)[0]
        $parsedAddress = $null
        if (-not [Net.IPAddress]::TryParse($addressPart, [ref]$parsedAddress)) {
            throw "Refusing an invalid Tailscale source restriction: $source"
        }
        if ($addressPart -notmatch '^100\.' -and $addressPart -notmatch '^(?i)fd7a:115c:a1e0:') {
            throw "Refusing a non-Tailscale source restriction: $source"
        }
        $safeSources += $source
    }
    if ($safeSources.Count -eq 0) { throw 'No Tailscale source addresses were provided for the SSH key.' }

    $path = Get-XcodeAuthorizedKeysPath
    $hadFile = Test-Path -LiteralPath $path -PathType Leaf
    $originalContent = if ($hadFile) { Get-Content -Raw -LiteralPath $path } else { '' }
    $lines = @()
    if ($originalContent) { $lines = @($originalContent -split '\r?\n' | Where-Object { $_.Trim() }) }

    $matchIndex = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $existingCanonical = Get-XcodeCanonicalKeyFromAuthorizedLine -Line $lines[$i]
        if ($existingCanonical -eq $canonical) {
            if ($lines[$i] -notmatch '(?<!\S)xcode:') {
                throw "The SSH key $fingerprint already exists in $path but is not managed by xcode. Refusing to add a less-restricted duplicate."
            }
            $matchIndex = $i
            break
        }
    }

    $gatewayCommand = 'command="C:/ProgramData/XcodeRemote/xcode-gateway.cmd"'
    $options = $gatewayCommand + ',from="' + (($safeSources | Select-Object -Unique) -join ',') + '",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc'
    $newLine = "$options $canonical xcode:$safeLabel"
    $changed = $true
    if ($matchIndex -ge 0) {
        if ($lines[$matchIndex] -eq $newLine) { $changed = $false }
        else { $lines[$matchIndex] = $newLine }
    }
    else { $lines += $newLine }

    if ($changed) {
        $newContent = (($lines -join "`r`n") + "`r`n")
        Write-XcodeAuthorizedKeysContent -Path $path -Content $newContent
    }
    return [pscustomobject]@{
        Path = $path
        Fingerprint = $fingerprint
        Changed = $changed
        HadFile = $hadFile
        OriginalContent = $originalContent
    }
}

function Update-XcodeManagedAuthorizedKeyGateway {
    $path = Get-XcodeAuthorizedKeysPath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
    $original = Get-Content -Raw -LiteralPath $path
    $lines = @($original -split '\r?\n' | Where-Object { $_.Trim() })
    $changed = $false
    $updated = foreach ($line in $lines) {
        if ($line -notmatch '(?<!\S)xcode:' -or -not (Get-XcodeCanonicalKeyFromAuthorizedLine -Line $line)) {
            $line
            continue
        }
        $withoutExistingCommand = [regex]::Replace($line, '^(?:command="[^"]*",)?', '')
        $newLine = 'command="C:/ProgramData/XcodeRemote/xcode-gateway.cmd",' + $withoutExistingCommand
        if ($newLine -ne $line) { $changed = $true }
        $newLine
    }
    if ($changed) {
        Write-XcodeAuthorizedKeysContent -Path $path -Content (($updated -join "`r`n") + "`r`n")
    }
    return $changed
}

function Undo-XcodeAuthorizedKeyChange {
    param([Parameter(Mandatory = $true)][object]$Change)
    if (-not $Change.Changed) { return }
    if ($Change.HadFile) {
        Write-XcodeAuthorizedKeysContent -Path ([string]$Change.Path) -Content ([string]$Change.OriginalContent)
    }
    elseif (Test-Path -LiteralPath ([string]$Change.Path)) {
        Remove-Item -LiteralPath ([string]$Change.Path) -Force
    }
}

function Test-XcodeManagedSshdConfig {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content)

    $hasBeginMarker = $Content -match '(?m)^# BEGIN XCODE REMOTE MANAGED BLOCK\r?$'
    $hasEndMarker = $Content -match '(?m)^# END XCODE REMOTE MANAGED BLOCK\r?$'
    return $hasBeginMarker -and $hasEndMarker
}

function New-XcodeSshdConfigContent {
    param(
        [Parameter(Mandatory = $true)][string]$OriginalContent,
        [Parameter(Mandatory = $true)][string]$AllowedUser,
        [Parameter(Mandatory = $true)][ValidatePattern('^100\.')][string]$TailscaleIPv4
    )

    if ($AllowedUser -notmatch '^[A-Za-z0-9._@\\-]+$') {
        throw "The Windows SSH username contains unsupported characters: $AllowedUser"
    }
    $lines = @($OriginalContent -split '\r?\n')
    $preserved = New-Object Collections.Generic.List[string]
    $inside = $false
    foreach ($line in $lines) {
        if ($line -eq '# BEGIN XCODE REMOTE MANAGED BLOCK') { $inside = $true; continue }
        if ($line -eq '# END XCODE REMOTE MANAGED BLOCK') { $inside = $false; continue }
        if (-not $inside) { [void]$preserved.Add($line) }
    }
    if ($inside) { throw 'The existing xcode SSH managed block is incomplete.' }
    while ($preserved.Count -gt 0 -and -not $preserved[0].Trim()) {
        $preserved.RemoveAt(0)
    }

    $block = @(
        '# BEGIN XCODE REMOTE MANAGED BLOCK',
        "ListenAddress $TailscaleIPv4",
        'PubkeyAuthentication yes',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'AuthenticationMethods publickey',
        'PermitEmptyPasswords no',
        'AllowAgentForwarding no',
        'AllowTcpForwarding no',
        'PermitTTY yes',
        "AllowUsers $($AllowedUser.ToLowerInvariant())",
        'LogLevel VERBOSE',
        '# END XCODE REMOTE MANAGED BLOCK',
        ''
    )
    return (($block + @($preserved)) -join "`r`n").TrimEnd() + "`r`n"
}
