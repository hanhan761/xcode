$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$scripts = Join-Path $root 'scripts'
. (Join-Path $scripts 'XcodeRemote.Common.ps1')

function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

Write-Host '1. Parse every PowerShell file'
$parseErrors = @()
Get-ChildItem $scripts -Filter '*.ps1' | ForEach-Object {
    $tokens = $null
    $errors = $null
    [Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors) | Out-Null
    $parseErrors += @($errors)
}
Assert ($parseErrors.Count -eq 0) 'A PowerShell script has a syntax error.'

Write-Host '2. Validate pairing code, nonce, and authenticated proof'
$codes = @(1..20 | ForEach-Object { New-XcodePairCode })
Assert (@($codes | Where-Object { $_ -notmatch '^\d{8}$' }).Count -eq 0) 'Pair codes are not eight digits.'
Assert (@($codes | Select-Object -Unique).Count -gt 1) 'Pair codes are constant.'
$nonce = New-XcodePairNonce
Assert ($nonce -match '^[0-9a-f]{32}$') 'Pair nonce is invalid.'
$proofArgs = @{
    PairCode = '12345678'
    Nonce = $nonce
    MainNodeId = 'node-main'
    MainIp = '100.64.0.1'
    DnsName = 'xcode-main.example.ts.net'
    WindowsUser = 'worker'
    HostKeyFingerprint = 'SHA256:host'
    AuthorizedKeyFingerprint = 'SHA256:client'
    RequesterNodeId = 'node-office'
}
$proof = Get-XcodePairProof @proofArgs
Assert ($proof -eq (Get-XcodePairProof @proofArgs)) 'Pair proof is not deterministic.'
$proofArgs.MainIp = '100.64.0.2'
Assert ($proof -ne (Get-XcodePairProof @proofArgs)) 'Pair proof does not bind the main address.'

Write-Host '3. Validate Ed25519 and authorized-key option parsing'
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$temp = Join-Path $tempBase ('xcode-verify-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null
try {
    $atomic = Join-Path $temp 'atomic.txt'
    Write-XcodeUtf8File -Path $atomic -Content 'first'
    Write-XcodeUtf8File -Path $atomic -Content 'second'
    Assert ((Get-Content -Raw -LiteralPath $atomic) -eq 'second') 'Atomic overwrite failed under Windows PowerShell 5.1.'
    Assert (@(Get-ChildItem $temp -Filter '*.xcode-replaced-*' -Force).Count -eq 0) 'Atomic replacement left a backup artifact.'

    $regressionFailures = @()
    $managedConfigFixture = "# BEGIN XCODE REMOTE MANAGED BLOCK`r`nListenAddress 100.64.0.1`r`n# END XCODE REMOTE MANAGED BLOCK`r`n"
    $managedLfFixture = $managedConfigFixture.Replace("`r`n", "`n")
    if (-not (Get-Command Test-XcodeManagedSshdConfig -ErrorAction SilentlyContinue)) {
        $regressionFailures += 'The managed sshd_config detector is missing.'
    }
    elseif (-not (Test-XcodeManagedSshdConfig -Content $managedConfigFixture)) {
        $regressionFailures += 'A CRLF xcode-managed sshd_config was not recognized.'
    }
    elseif (-not (Test-XcodeManagedSshdConfig -Content $managedLfFixture)) {
        $regressionFailures += 'An LF xcode-managed sshd_config was not recognized.'
    }
    elseif (Test-XcodeManagedSshdConfig -Content 'Subsystem sftp sftp-server.exe') {
        $regressionFailures += 'An unmanaged sshd_config was accepted as xcode-managed.'
    }

    $nativeFixture = Join-Path $temp 'native-stderr-success.cmd'
    $nativeFailureFixture = Join-Path $temp 'native-stderr-failure.cmd'
    Write-XcodeUtf8File -Path $nativeFixture -Content "@echo off`r`n>&2 echo harmless-warning`r`necho []`r`nexit /b 0`r`n"
    Write-XcodeUtf8File -Path $nativeFailureFixture -Content "@echo off`r`n>&2 echo expected-error`r`nexit /b 7`r`n"
    if (-not (Get-Command Invoke-XcodeNativeCapture -ErrorAction SilentlyContinue)) {
        $regressionFailures += 'The native stderr capture helper is missing.'
    }
    else {
        try {
            $preferenceBeforeNativeCapture = $ErrorActionPreference
            $nativeResult = Invoke-XcodeNativeCapture -FilePath $nativeFixture
            if ($nativeResult.ExitCode -ne 0 -or $nativeResult.Output.Trim() -ne '[]') {
                $regressionFailures += 'A successful native command with stderr was not captured correctly.'
            }
            if ($ErrorActionPreference -ne $preferenceBeforeNativeCapture) {
                $regressionFailures += 'Native capture did not restore the caller error policy.'
            }
            $nativeFailureResult = Invoke-XcodeNativeCapture -FilePath $nativeFailureFixture
            if ($nativeFailureResult.ExitCode -ne 7) {
                $regressionFailures += 'A native nonzero exit code was not returned to the caller.'
            }
        }
        catch {
            $regressionFailures += 'Native stderr became a terminating error instead of a captured result.'
        }
    }
    Assert ($regressionFailures.Count -eq 0) ($regressionFailures -join ' ')

    $hostKeyAcl = New-XcodeOpenSshHostKeyAcl
    $adminsSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $expectedHostKeyAclSids = @($adminsSid.Value, $systemSid.Value)
    Assert ($hostKeyAcl.AreAccessRulesProtected) 'OpenSSH host-key ACL inheritance was not disabled.'
    Assert (($hostKeyAcl.GetOwner([Security.Principal.SecurityIdentifier])).Value -eq $adminsSid.Value) 'OpenSSH host-key ACL owner is not Administrators.'
    $hostKeyAclSids = @($hostKeyAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
        $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    } | Select-Object -Unique)
    Assert (@($hostKeyAclSids | Where-Object { $_ -notin $expectedHostKeyAclSids }).Count -eq 0) 'OpenSSH host-key ACL grants an unexpected identity.'
    Assert (@($expectedHostKeyAclSids | Where-Object { $hostKeyAclSids -notcontains $_ }).Count -eq 0) 'OpenSSH host-key ACL omits SYSTEM or Administrators.'

    $key = Join-Path $temp 'key'
    & ssh-keygen.exe -q -t ed25519 -N 'xcode-test-only' -f $key
    Assert ($LASTEXITCODE -eq 0) 'Could not create the temporary SSH fixture.'
    $public = Get-Content -Raw "$key.pub"
    $canonical = Get-XcodeCanonicalSshPublicKey $public
    Assert ($canonical -match '^ssh-ed25519 ') 'Ed25519 parsing failed.'
    Assert ((Get-XcodeSshPublicKeyFingerprint $public) -match '^SHA256:') 'Fingerprinting failed.'
    $optionLine = 'from="100.64.0.2/32",no-port-forwarding ' + $canonical + ' xcode:test'
    Assert ((Get-XcodeCanonicalKeyFromAuthorizedLine $optionLine) -eq $canonical) 'An option-prefixed authorized key was not parsed.'
    $rejected = $false
    try { Get-XcodeCanonicalSshPublicKey 'ssh-rsa invalid' | Out-Null } catch { $rejected = $true }
    Assert $rejected 'A non-Ed25519 key was accepted.'
}
finally {
    $resolved = [IO.Path]::GetFullPath($temp)
    if ($resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved) -like 'xcode-verify-*') {
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host '4. Validate SSH config transformation and idempotency'
$fixture = @"
# existing comment
Subsystem sftp sftp-server.exe
Match Group administrators
       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
"@
$first = New-XcodeSshdConfigContent -OriginalContent $fixture -AllowedUser 'Worker' -TailscaleIPv4 '100.64.0.10'
$second = New-XcodeSshdConfigContent -OriginalContent $first -AllowedUser 'Worker' -TailscaleIPv4 '100.64.0.10'
Assert ($first -eq $second) 'Managed SSH config is not idempotent.'
Assert ($first -match '(?m)^ListenAddress 100\.64\.0\.10\r?$') 'SSH listener is not pinned to Tailscale.'
Assert ($first -match '(?m)^PasswordAuthentication no\r?$') 'Password authentication was not disabled.'
Assert ($first -match 'Subsystem sftp sftp-server.exe') 'An unmanaged SSH directive was lost.'
Assert (([regex]::Matches($first, 'BEGIN XCODE REMOTE MANAGED BLOCK')).Count -eq 1) 'SSH managed block was duplicated.'

Write-Host '5. Validate collaborative-session entry points and credential hygiene'
$entries = @('xcode.cmd', 'install-main.cmd', 'install-office.cmd', 'pair-office.cmd', 'unpair-office.cmd')
foreach ($entry in $entries) { Assert (Test-Path (Join-Path $root $entry)) "Missing $entry." }
$officeScript = Get-Content -Raw (Join-Path $scripts 'install-office.ps1')
$mainScript = Get-Content -Raw (Join-Path $scripts 'install-main.ps1')
$dispatcher = Join-Path $scripts 'xcode.ps1'
$packagePath = Join-Path $root 'package.json'
$nodeLauncher = Join-Path $root 'bin\xcode.js'
$managedRunner = Join-Path $root 'bin\managed-codex.js'
$sessionGateway = Join-Path $root 'bin\session-gateway.js'
$sessionClient = Join-Path $root 'bin\session-client.js'
$sessionRunner = Join-Path $root 'lib\session-runner.js'
$sessionHarness = Join-Path $root 'tests\session-runner-harness.js'
Assert (Test-Path -LiteralPath $dispatcher) 'The unified xcode dispatcher is missing.'
Assert (Test-Path -LiteralPath $packagePath) 'The npm package manifest is missing.'
Assert (Test-Path -LiteralPath $nodeLauncher) 'The npm xcode binary is missing.'
Assert (Test-Path -LiteralPath $managedRunner) 'The managed Codex entrypoint is missing.'
Assert (Test-Path -LiteralPath $sessionGateway) 'The forced xcode session gateway is missing.'
Assert (Test-Path -LiteralPath $sessionClient) 'The office collaborative-session client is missing.'
Assert (Test-Path -LiteralPath $sessionRunner) 'The managed session runner is missing.'
Assert (Test-Path -LiteralPath $sessionHarness) 'The managed session harness is missing.'
$package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
Assert ($package.name -eq 'xcode-remote') 'The npm package name is incorrect.'
Assert ($package.bin.xcode -eq 'bin/xcode.js') 'npm does not expose the xcode command.'
$helpText = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $dispatcher help | Out-String)
Assert ($LASTEXITCODE -eq 0 -and $helpText -match 'xcode main') 'The xcode dispatcher does not expose the main-PC setup workflow.'
Assert ($helpText -match 'xcode office') 'The xcode dispatcher does not expose the office-laptop setup workflow.'
Assert ($helpText -match 'xcode pair') 'The xcode dispatcher does not expose the paired workflow.'
Assert ($helpText -match 'xcode update') 'The xcode dispatcher does not expose self-update.'
Assert ($helpText -match 'codex') 'The xcode dispatcher does not describe the preserved Codex command.'
Assert ((Get-Content -Raw $dispatcher) -match 'Start-XcodeManagedCodex') 'The main PC does not start managed Codex sessions.'
Assert ((Get-Content -Raw $dispatcher) -match 'Connect-XcodeOfficeSharedTerminal') 'Office xcode does not attach to the shared host terminal.'
Assert ($mainScript -notmatch 'session run --') 'The main-PC codex profile still emits a PowerShell-incompatible argument separator.'
Assert ((Get-Content -Raw $nodeLauncher) -match 'PowerShell -File treats a bare') 'The npm launcher does not tolerate the legacy managed-session separator.'
Assert ((Get-Content -Raw $sessionRunner) -match 'node-pty') 'The managed session runner does not use a private pseudoterminal.'
Assert ((Get-Content -Raw $sessionRunner) -match 'xcode-session-') 'The managed session runner does not create a scoped session pipe.'
Assert ((Get-Content -Raw $sessionGateway) -match 'SSH_ORIGINAL_COMMAND') 'The gateway does not enforce the original SSH command boundary.'
Assert ((Get-Content -Raw $sessionGateway) -match 'xcode-gateway') 'The gateway does not restrict its command vocabulary.'
Assert ((Get-Content -Raw $sessionClient) -match "'attach'") 'The office client does not attach to a managed session.'
Assert ((Get-Content -Raw $sessionClient) -match "'message'") 'The office client does not submit collaborative messages.'
$nodeHelpText = (& node.exe $nodeLauncher help | Out-String)
Assert ($LASTEXITCODE -eq 0 -and $nodeHelpText -match 'xcode office') 'The npm xcode binary cannot launch the dispatcher.'
Assert ((Get-Content -Raw (Join-Path $root 'xcode.cmd')) -match 'bin\\xcode\.js') 'The repository xcode bootstrap does not use the safe npm launcher.'
$previousErrorActionPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $legacySeparatorOutput = (& node.exe $nodeLauncher -Role office session run -- resume 019f59e5-1a83-73f1-a2e1-2798fd7141e8 2>&1 | Out-String)
    $legacySeparatorExitCode = $LASTEXITCODE
}
finally { $ErrorActionPreference = $previousErrorActionPreference }
Assert ($legacySeparatorExitCode -ne 0) 'The forced office-role legacy separator probe unexpectedly succeeded.'
Assert ($legacySeparatorOutput -notmatch 'AmbiguousParameter|parameter name .*. is ambiguous') 'The legacy managed-session separator still reaches PowerShell as an ambiguous parameter.'
Assert ($legacySeparatorOutput -match 'Unknown office-laptop xcode command: session') 'The legacy managed-session separator probe did not reach the xcode dispatcher.'
Assert ((Get-Content -Raw (Join-Path $root 'install-main.cmd')) -match 'xcode\.cmd" main') 'The main adapter does not route through xcode main.'
Assert ((Get-Content -Raw (Join-Path $root 'install-office.cmd')) -match 'xcode\.cmd" office') 'The office adapter does not route through xcode office.'
Assert ((Get-Content -Raw (Join-Path $root 'pair-office.cmd')) -match 'xcode\.cmd" pair') 'The legacy pairing adapter does not route through xcode pair.'
Assert ($officeScript -match '\[switch\]\$SetupOnly') 'The office setup cannot be run independently of pairing.'
Assert ($officeScript -match '\[switch\]\$PairOnly') 'The office pairing client cannot be run independently of setup.'
Assert ($officeScript -match '(?m)^\s*StrictHostKeyChecking yes') 'Office SSH strict host-key policy is missing.'
Assert ($officeScript -match '(?m)^\s*IdentitiesOnly yes') 'Office SSH is not using its dedicated identity deterministically.'
Assert ($officeScript -notmatch 'office-wezterm\.lua') 'Office setup still creates a WezTerm workspace configuration.'
Assert ($mainScript -notmatch 'wez\.wezterm') 'Main setup still installs WezTerm for the legacy mux.'
Assert ($officeScript -notmatch 'wez\.wezterm') 'Office setup still installs WezTerm for the legacy mux.'
Assert ($mainScript -match 'Install-XcodeCodexEntrypoint') 'Main setup does not preserve the codex command through the managed-session entrypoint.'
Assert ((Get-Content -Raw (Join-Path $scripts 'XcodeRemote.Common.ps1')) -match 'xcode-gateway\.cmd') 'Paired SSH keys are not forced into the xcode gateway.'
$originalSshCommand = $env:SSH_ORIGINAL_COMMAND
try {
    $env:SSH_ORIGINAL_COMMAND = 'xcode-gateway probe'
    $gatewayProbe = (& node.exe $sessionGateway 2>&1 | Out-String)
    Assert ($LASTEXITCODE -eq 0 -and $gatewayProbe -match '^XCODE_GATEWAY_OK') 'The xcode gateway did not accept its probe command.'
    $env:SSH_ORIGINAL_COMMAND = 'powershell.exe -NoProfile'
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & node.exe $sessionGateway 2>$null
        $deniedExitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousErrorActionPreference }
    Assert ($deniedExitCode -ne 0) 'The xcode gateway accepted an arbitrary SSH command.'
}
finally {
    if ($null -eq $originalSshCommand) { Remove-Item Env:\SSH_ORIGINAL_COMMAND -ErrorAction SilentlyContinue }
    else { $env:SSH_ORIGINAL_COMMAND = $originalSshCommand }
}
Assert ($mainScript -match 'Remove-XcodePathEntry') 'The main PC does not clear the legacy local xcode launcher.'
Assert ([regex]::Match((Get-Content -Raw $dispatcher), 'function Update-XcodePackage \{[\s\S]*?\n\}').Value -match 'Remove-XcodePathEntry') 'xcode update does not remove the legacy local launcher from PATH.'
Assert ((Get-Content -Raw $dispatcher) -match "github:hanhan761/xcode#main") 'xcode update does not use the GitHub release source.'
Assert ($officeScript -notmatch 'Confirm pair-office\.cmd') 'Office pairing recovery still exposes the legacy CMD command.'
$forbidden = 'tskey-|BEGIN OPENSSH PRIVATE KEY'
$hits = Get-ChildItem $root -Recurse -File |
    Where-Object { $_.FullName -notmatch '\\.git\\' -and $_.FullName -ne $PSCommandPath } |
    Select-String -Pattern $forbidden -ErrorAction SilentlyContinue
Assert (@($hits).Count -eq 0) 'A reusable credential marker exists in the repository.'

Write-Host 'All verification checks passed.' -ForegroundColor Green
