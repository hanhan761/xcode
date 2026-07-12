[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^S-1-5-')][string]$ExpectedSid,
    [Parameter(Mandatory = $true)][string]$ExpectedUser,
    [Parameter(Mandatory = $true)][ValidatePattern('^100\.')][string]$TailscaleIPv4,
    [Parameter(Mandatory = $true)][string]$WezTermDirectory,
    [ValidatePattern('^[A-Za-z0-9-]+$')][string]$MainName = 'xcode-main'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'XcodeRemote.Common.ps1')

Assert-XcodeElevatedIdentity -ExpectedSid $ExpectedSid -ExpectedUser $ExpectedUser
if ($ExpectedUser -notmatch '^[A-Za-z0-9._@\-]+$') {
    throw "The Windows username is not supported by this installer: $ExpectedUser"
}
$WezTermDirectory = [IO.Path]::GetFullPath($WezTermDirectory).TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $WezTermDirectory 'wezterm.exe'))) {
    throw "The trusted WezTerm installation was not found under $WezTermDirectory."
}

$capabilityName = 'OpenSSH.Server~~~~0.0.1.0'
$defaultRuleName = 'OpenSSH-Server-In-TCP'
$capability = Get-WindowsCapability -Online -Name $capabilityName
$capabilityInstalledByXcode = $capability.State -ne 'Installed'
$preExistingDefaultRule = Get-NetFirewallRule -Name $defaultRuleName -ErrorAction SilentlyContinue
$defaultWasEnabled = $false
if ($preExistingDefaultRule) {
    $defaultWasEnabled = @($preExistingDefaultRule | Where-Object { $_.Enabled -eq 'True' }).Count -gt 0
}
if ($capabilityInstalledByXcode) {
    Write-XcodeStep 'Installing Windows OpenSSH Server'
    Add-WindowsCapability -Online -Name $capabilityName | Out-Null
}
$defaultRule = Get-NetFirewallRule -Name $defaultRuleName -ErrorAction SilentlyContinue
if ($capabilityInstalledByXcode -and $defaultRule) {
    Disable-NetFirewallRule -Name $defaultRuleName | Out-Null
}

$sshd = Get-XcodeOpenSshExecutable -Name 'sshd.exe'
$sshKeygen = Get-XcodeOpenSshExecutable -Name 'ssh-keygen.exe'
if (-not $sshd -or -not $sshKeygen) { throw 'Windows OpenSSH Server tools were not found after installation.' }

$sshdConfig = Join-Path $env:ProgramData 'ssh\sshd_config'
$configHadFile = Test-Path -LiteralPath $sshdConfig -PathType Leaf
if ($configHadFile) {
    $originalConfig = Get-Content -Raw -LiteralPath $sshdConfig
}
else {
    $originalConfig = @"
Subsystem sftp sftp-server.exe
Match Group administrators
       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
"@
}
$alreadyManaged = $configHadFile -and $originalConfig -match '(?m)^# BEGIN XCODE REMOTE MANAGED BLOCK$'
$service = Get-Service -Name sshd
$tailscaleService = Get-Service -Name Tailscale -ErrorAction SilentlyContinue
if (-not $tailscaleService) { throw 'The Tailscale Windows service was not found.' }
$previousDependencies = @($service.ServicesDependedOn | ForEach-Object { $_.Name })
$desiredDependencies = @($previousDependencies + 'Tailscale' | Select-Object -Unique)

if (-not $alreadyManaged) {
    if ($service.Status -eq 'Running') {
        throw 'An unmanaged OpenSSH server is already running. This installer will not take over an existing SSH service.'
    }
    $unmanagedPattern = '(?im)^\s*(Include|ListenAddress|Port|PasswordAuthentication|KbdInteractiveAuthentication|AuthenticationMethods|AllowUsers|DenyUsers|AllowGroups|DenyGroups)\s+'
    if ($originalConfig -match $unmanagedPattern) {
        throw 'The existing sshd_config contains active access-control or listener directives. Review it manually before using this installer.'
    }
}

$adapter = Get-XcodeTailscaleAdapter
$ruleName = 'XcodeRemote-SSH-Tailscale'

$oldOwnedRule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
$oldOwnedEnabled = 'False'
$oldOwnedLocalAddress = @()
$oldOwnedRemoteAddress = @()
$oldOwnedInterfaceAlias = @()
$oldOwnedProgram = $sshd
if ($oldOwnedRule) {
    $oldOwnedEnabled = [string]$oldOwnedRule.Enabled
    $oldOwnedLocalAddress = @($oldOwnedRule | Get-NetFirewallAddressFilter).LocalAddress
    $oldOwnedRemoteAddress = @($oldOwnedRule | Get-NetFirewallAddressFilter).RemoteAddress
    $oldOwnedInterfaceAlias = @(($oldOwnedRule | Get-NetFirewallInterfaceFilter).InterfaceAlias)
    $applicationFilter = $oldOwnedRule | Get-NetFirewallApplicationFilter
    if ($applicationFilter.Program) { $oldOwnedProgram = $applicationFilter.Program }
}

$previousMachinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$previousStartType = [string](Get-CimInstance Win32_Service -Filter "Name='sshd'").StartMode
$previousWasRunning = $service.Status -eq 'Running'
$configBackup = $null
$configChanged = $false
$pathChanged = $false
$programDataRoot = Join-Path $env:ProgramData 'XcodeRemote'
$remoteProxyPath = Join-Path $programDataRoot 'wezterm-proxy.cmd'
$proxyHadFile = Test-Path -LiteralPath $remoteProxyPath -PathType Leaf
$proxyOriginalContent = if ($proxyHadFile) { Get-Content -Raw -LiteralPath $remoteProxyPath } else { '' }
$proxyChanged = $false

function New-OwnedFirewallRule {
    param(
        [Parameter(Mandatory = $true)][string]$LocalAddress,
        [Parameter(Mandatory = $true)][string[]]$RemoteAddress,
        [Parameter(Mandatory = $true)][string[]]$InterfaceAlias,
        [Parameter(Mandatory = $true)][string]$Program,
        [Parameter(Mandatory = $true)][ValidateSet('True', 'False')][string]$Enabled
    )
    New-NetFirewallRule `
        -Name $ruleName `
        -DisplayName 'Xcode Remote SSH over Tailscale' `
        -Group 'Xcode Remote' `
        -Enabled $Enabled `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort 22 `
        -LocalAddress $LocalAddress `
        -InterfaceAlias $InterfaceAlias `
        -RemoteAddress $RemoteAddress `
        -Program $Program `
        -Profile Any | Out-Null
}

function Set-XcodeRemoteProxyAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    $admins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $user = New-Object Security.Principal.SecurityIdentifier($ExpectedSid)
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetOwner($admins)
    $acl.SetAccessRuleProtection($true, $false)
    $entries = @(
        [pscustomobject]@{ Sid = $admins; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
        [pscustomobject]@{ Sid = $system; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
        [pscustomobject]@{ Sid = $user; Rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute }
    )
    foreach ($entry in $entries) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $entry.Sid, $entry.Rights, [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

try {
    Write-XcodeStep 'Staging a Tailscale-only, key-only SSH service'
    if ($service.Status -eq 'Running') { Stop-Service -Name sshd -Force }
    Set-Service -Name sshd -StartupType Manual
    & sc.exe config sshd depend= ($desiredDependencies -join '/')
    if ($LASTEXITCODE -ne 0) { throw 'Could not make sshd wait for the Tailscale service at boot.' }

    if ($defaultRule) { Disable-NetFirewallRule -Name $defaultRuleName | Out-Null }
    if ($oldOwnedRule) { Remove-NetFirewallRule -Name $ruleName }
    New-OwnedFirewallRule `
        -LocalAddress $TailscaleIPv4 `
        -RemoteAddress @('100.64.0.0/10', 'fd7a:115c:a1e0::/48') `
        -InterfaceAlias @($adapter.Name) `
        -Program $sshd `
        -Enabled 'False'

    & $sshKeygen -A
    if ($LASTEXITCODE -ne 0) { throw 'OpenSSH host-key generation failed.' }

    $newConfig = New-XcodeSshdConfigContent `
        -OriginalContent $originalConfig `
        -AllowedUser $ExpectedUser `
        -TailscaleIPv4 $TailscaleIPv4
    $temporaryConfig = Join-Path (Split-Path -Parent $sshdConfig) ('sshd_config.xcode-validate-' + [Guid]::NewGuid().ToString('N'))
    try {
        Write-XcodeUtf8File -Path $temporaryConfig -Content $newConfig
        & $sshd -t -f $temporaryConfig
        if ($LASTEXITCODE -ne 0) { throw 'OpenSSH rejected the staged sshd_config.' }
    }
    finally {
        Remove-Item -LiteralPath $temporaryConfig -Force -ErrorAction SilentlyContinue
    }

    $configBackup = Backup-XcodeFile -Path $sshdConfig
    Write-XcodeUtf8File -Path $sshdConfig -Content $newConfig
    $configChanged = $true

    $effective = (& $sshd -T -f $sshdConfig -C "user=$($ExpectedUser.ToLowerInvariant()),host=$env:COMPUTERNAME,addr=$TailscaleIPv4" 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "OpenSSH could not evaluate its effective configuration:`n$effective" }
    $requiredEffective = @(
        '(?m)^passwordauthentication no\r?$',
        '(?m)^kbdinteractiveauthentication no\r?$',
        '(?m)^pubkeyauthentication yes\r?$',
        '(?m)^authenticationmethods publickey\r?$',
        '(?m)^allowtcpforwarding no\r?$',
        '(?m)^allowagentforwarding no\r?$'
    )
    foreach ($pattern in $requiredEffective) {
        if ($effective -notmatch $pattern) { throw "The effective sshd policy failed validation: $pattern" }
    }
    if ($effective -notmatch ('(?m)^listenaddress ' + [regex]::Escape($TailscaleIPv4) + ':22\r?$')) {
        throw 'sshd is not restricted to the main PC Tailscale IPv4 address.'
    }

    $pathResult = Add-XcodePathEntry -Directory $WezTermDirectory -Scope Machine
    $pathChanged = $pathResult.Changed

    $programDataRoot = Join-Path $env:ProgramData 'XcodeRemote'
    if (-not (Test-Path -LiteralPath $programDataRoot)) {
        New-Item -ItemType Directory -Path $programDataRoot -Force | Out-Null
    }
    $proxyContent = "@echo off`r`n`"$WezTermDirectory\wezterm.exe`" %*`r`nexit /b %ERRORLEVEL%`r`n"
    Write-XcodeUtf8File -Path $remoteProxyPath -Content $proxyContent
    Set-XcodeRemoteProxyAcl -Path $remoteProxyPath
    $proxyChanged = $true
    $remoteProxyForSsh = $remoteProxyPath -replace '\\', '/'
    $state = [ordered]@{
        schemaVersion = 2
        role = 'main'
        machineName = $MainName
        tailscaleIPv4 = $TailscaleIPv4
        windowsUser = $ExpectedUser
        windowsSid = $ExpectedSid
        remoteWezTermPath = $remoteProxyForSsh
        sshdConfig = $sshdConfig
        sshdConfigBackup = $configBackup
        sshdWasManaged = $alreadyManaged
        capabilityInstalledByXcode = $capabilityInstalledByXcode
        defaultFirewallWasEnabled = $defaultWasEnabled
        previousServiceStartType = $previousStartType
        previousServiceWasRunning = $previousWasRunning
        pendingFirstPair = -not ($alreadyManaged -and $previousWasRunning)
        configuredAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-XcodeUtf8File -Path (Join-Path $programDataRoot 'host.json') -Content ($state | ConvertTo-Json -Depth 5)

    if ($alreadyManaged -and $previousWasRunning) {
        Set-Service -Name sshd -StartupType Automatic
        Start-Service -Name sshd
        Enable-NetFirewallRule -Name $ruleName | Out-Null
    }
    Write-Host 'The SSH service is staged safely. First activation occurs only after a verified office key is registered.' -ForegroundColor Green
}
catch {
    Write-Warning 'The machine-level setup failed; restoring the pre-install SSH and firewall state.'
    try { Disable-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Out-Null } catch {}
    try { Stop-Service -Name sshd -Force -ErrorAction SilentlyContinue } catch {}
    try { Remove-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue } catch {}
    if ($oldOwnedRule) {
        try {
            $restoreLocal = if ($oldOwnedLocalAddress.Count) { [string]$oldOwnedLocalAddress[0] } else { $TailscaleIPv4 }
            $restoreRemote = if ($oldOwnedRemoteAddress.Count) { @($oldOwnedRemoteAddress) } else { @('100.64.0.0/10', 'fd7a:115c:a1e0::/48') }
            $restoreAliases = if ($oldOwnedInterfaceAlias.Count) { @($oldOwnedInterfaceAlias) } else { @($adapter.Name) }
            New-OwnedFirewallRule -LocalAddress $restoreLocal -RemoteAddress $restoreRemote -InterfaceAlias $restoreAliases -Program $oldOwnedProgram -Enabled $oldOwnedEnabled
        }
        catch { Write-Warning "Could not restore the previous xcode firewall rule: $($_.Exception.Message)" }
    }
    if ($defaultRule -and $defaultWasEnabled) {
        try { Enable-NetFirewallRule -Name $defaultRuleName | Out-Null } catch {}
    }
    if ($configChanged) {
        try {
            if ($configHadFile) { Write-XcodeUtf8File -Path $sshdConfig -Content $originalConfig }
            elseif (Test-Path -LiteralPath $sshdConfig) { Remove-Item -LiteralPath $sshdConfig -Force }
        }
        catch {}
    }
    if ($pathChanged) {
        try { [Environment]::SetEnvironmentVariable('Path', $previousMachinePath, 'Machine') } catch {}
    }
    if ($proxyChanged) {
        try {
            if ($proxyHadFile) {
                Write-XcodeUtf8File -Path $remoteProxyPath -Content $proxyOriginalContent
                Set-XcodeRemoteProxyAcl -Path $remoteProxyPath
            }
            elseif (Test-Path -LiteralPath $remoteProxyPath) {
                Remove-Item -LiteralPath $remoteProxyPath -Force
            }
        }
        catch {}
    }
    try {
        $restoreDependencies = if ($previousDependencies.Count) { $previousDependencies -join '/' } else { '/' }
        & sc.exe config sshd depend= $restoreDependencies | Out-Null
        if ($previousStartType -eq 'Auto') { Set-Service -Name sshd -StartupType Automatic }
        elseif ($previousStartType -eq 'Disabled') { Set-Service -Name sshd -StartupType Disabled }
        else { Set-Service -Name sshd -StartupType Manual }
        if ($previousWasRunning) { Start-Service -Name sshd }
    }
    catch {}
    throw
}
