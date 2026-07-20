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
    $desktopFixture = Join-Path $temp 'desktop'
    $attachAllLauncher = Write-XcodeOfficeAttachAllLauncher -DesktopDirectory $desktopFixture
    $attachAllLauncherContent = Get-Content -Raw -LiteralPath $attachAllLauncher
    Assert ($attachAllLauncherContent -match 'xcode\.cmd -aa') 'The office one-click launcher does not invoke xcode -aa.'
    Assert ($attachAllLauncherContent -match 'XCODE_EXIT') 'The office one-click launcher does not preserve a failed xcode -aa exit code.'
    Assert ($attachAllLauncherContent -notmatch 'ssh_config|PRIVATE KEY|tskey-') 'The office one-click launcher contains a credential or gateway path.'

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
$appServerSession = Join-Path $root 'lib\app-server-session.js'
$appServerHost = Join-Path $root 'lib\app-server-host.js'
$appServerHostWatchdog = Join-Path $root 'bin\app-server-host-watchdog.js'
$appServerPtyHost = Join-Path $root 'bin\app-server-pty-host.js'
$windowsShellShim = Join-Path $root 'lib\windows-shell-shim.js'
$hiddenProcessSource = Join-Path $root 'scripts\HiddenProcessShim.cs'
$hiddenProcessBuild = Join-Path $root 'scripts\build-hidden-process-shim.ps1'
$terminalOutputSink = Join-Path $root 'lib\terminal-output-sink.js'
$terminalOutputCoalescer = Join-Path $root 'lib\terminal-output-coalescer.js'
$codexExecutable = Join-Path $root 'lib\codex-executable.js'
$officeAttachmentRegistry = Join-Path $root 'lib\office-attachment-registry.js'
$officeAttachAll = Join-Path $root 'lib\office-attach-all.js'
$codexInstallationReporter = Join-Path $root 'bin\codex-installation.js'
$managedResumeIndex = Join-Path $root 'lib\managed-resume-index.js'
$managedProfileRepair = Join-Path $root 'scripts\repair-managed-codex-profile.js'
$scopedAppServerRelay = Join-Path $root 'lib\scoped-app-server-relay.js'
$nativeOfficeSession = Join-Path $root 'lib\native-codex-office-session.js'
$nativeCodexTerminal = Join-Path $root 'lib\native-codex-terminal.js'
$sessionTitle = Join-Path $root 'lib\session-title.js'
$sessionHarness = Join-Path $root 'tests\session-runner-harness.js'
$activeSessionHarness = Join-Path $root 'tests\session-gateway-active-harness.js'
$sshGatewayHarness = Join-Path $root 'tests\session-ssh-gateway-harness.js'
$inputArbiterHarness = Join-Path $root 'tests\input-arbiter-harness.js'
$scopedRelayHarness = Join-Path $root 'tests\scoped-app-server-relay-harness.js'
$nativeGatewayHarness = Join-Path $root 'tests\native-gateway-relay-harness.js'
$nativeOfficeHarness = Join-Path $root 'tests\native-office-session-harness.js'
$nativeOfficeMouseHarness = Join-Path $root 'tests\native-office-mouse-wheel-harness.js'
$nativeOfficeTransportRecoveryHarness = Join-Path $root 'tests\native-office-transport-recovery-harness.js'
$officeDisconnectIsolationHarness = Join-Path $root 'tests\office-disconnect-isolation-harness.js'
$managedCodexTransportRecoveryHarness = Join-Path $root 'tests\managed-codex-transport-recovery-harness.js'
$authoritativeWorkingStateHarness = Join-Path $root 'tests\authoritative-working-state-harness.js'
$managedCodexResumeScopeHarness = Join-Path $root 'tests\managed-codex-resume-scope-harness.js'
$managedResumeIndexHarness = Join-Path $root 'tests\managed-resume-index-harness.js'
$managedProfileRepairHarness = Join-Path $root 'tests\managed-profile-repair-harness.js'
$sessionTitleHarness = Join-Path $root 'tests\session-title-harness.js'
$nativeTwoClientHarness = Join-Path $root 'tests\native-two-client-tui-harness.js'
$codexReadinessHarness = Join-Path $root 'tests\codex-readiness-harness.js'
$liveCodexProbe = Join-Path $root 'tests\live-codex-remote-input-probe.js'
$appServerSharedThreadHarness = Join-Path $root 'tests\app-server-shared-thread-harness.js'
$appServerResumeHarness = Join-Path $root 'tests\app-server-resume-harness.js'
$appServerStartupHarness = Join-Path $root 'tests\app-server-startup-harness.js'
$appServerRolloutReadinessProbe = Join-Path $root 'tests\app-server-rollout-readiness-probe.js'
$appServerHostHarness = Join-Path $root 'tests\app-server-host-harness.js'
$recoverySharedHostHarness = Join-Path $root 'tests\recovery-shared-host-harness.js'
$terminalOutputSinkHarness = Join-Path $root 'tests\terminal-output-sink-harness.js'
$terminalOutputCoalescerHarness = Join-Path $root 'tests\terminal-output-coalescer-harness.js'
$sharedSessionRunnerHarness = Join-Path $root 'tests\shared-session-runner-harness.js'
$semanticTwoMachineHarness = Join-Path $root 'tests\semantic-two-machine-e2e-harness.js'
$hiddenProcessHarness = Join-Path $root 'tests\windows-hidden-console-host-harness.js'
$liveHiddenWindowHarness = Join-Path $root 'tests\live-hidden-app-server-window-harness.js'
$transientWindowProbeHarness = Join-Path $root 'tests\transient-window-event-probe-harness.js'
$visibleWindowProbe = Join-Path $root 'tests\visible-child-window-probe.ps1'
$roleHarness = Join-Path $root 'tests\role-resolution-harness.ps1'
$officeAttachAllHarness = Join-Path $root 'tests\office-attach-all-harness.js'
$sessionClientAttachHarness = Join-Path $root 'tests\session-client-attach-harness.js'
$codexInstallationHarness = Join-Path $root 'tests\codex-installation-harness.js'
$codexUpdateGuardHarness = Join-Path $root 'tests\codex-update-session-guard-harness.ps1'
$codexUpdateInstallationRootHarness = Join-Path $root 'tests\codex-update-installation-root-harness.ps1'
Assert (Test-Path -LiteralPath $dispatcher) 'The unified xcode dispatcher is missing.'
Assert (Test-Path -LiteralPath $packagePath) 'The npm package manifest is missing.'
Assert (Test-Path -LiteralPath $nodeLauncher) 'The npm xcode binary is missing.'
Assert (Test-Path -LiteralPath $managedRunner) 'The managed Codex entrypoint is missing.'
Assert (Test-Path -LiteralPath $sessionGateway) 'The forced xcode session gateway is missing.'
Assert (Test-Path -LiteralPath $sessionClient) 'The office collaborative-session client is missing.'
Assert (Test-Path -LiteralPath $sessionRunner) 'The managed session runner is missing.'
Assert (Test-Path -LiteralPath $appServerSession) 'The one-thread Codex app-server authority is missing.'
Assert (Test-Path -LiteralPath $appServerHost) 'The shared app-server host is missing.'
Assert (Test-Path -LiteralPath $appServerHostWatchdog) 'The shared app-server host watchdog is missing.'
Assert (Test-Path -LiteralPath $appServerPtyHost) 'The private app-server pseudoconsole host is missing.'
Assert (Test-Path -LiteralPath $windowsShellShim) 'The Windows hidden-process environment is missing.'
Assert (Test-Path -LiteralPath $hiddenProcessSource) 'The Windows hidden-process shim source is missing.'
Assert (Test-Path -LiteralPath $hiddenProcessBuild) 'The Windows hidden-process shim builder is missing.'
Assert (Test-Path -LiteralPath $terminalOutputSink) 'The managed-terminal output sink is missing.'
Assert (Test-Path -LiteralPath $terminalOutputCoalescer) 'The managed-terminal output coalescer is missing.'
Assert (Test-Path -LiteralPath $codexExecutable) 'The pinned native Codex resolver is missing.'
Assert (Test-Path -LiteralPath $officeAttachmentRegistry) 'The office attachment registry is missing.'
Assert (Test-Path -LiteralPath $officeAttachAll) 'The office attach-all controller is missing.'
Assert (Test-Path -LiteralPath $codexInstallationReporter) 'The official Codex installation reporter is missing.'
Assert (Test-Path -LiteralPath $codexUpdateInstallationRootHarness) 'The xcode update installation-root harness is missing.'
Assert (Test-Path -LiteralPath $managedResumeIndex) 'The managed Codex workspace resume index is missing.'
Assert (Test-Path -LiteralPath $managedProfileRepair) 'The managed Codex profile repair script is missing.'
Assert (Test-Path -LiteralPath $scopedAppServerRelay) 'The selected-thread app-server relay is missing.'
Assert (Test-Path -LiteralPath $nativeOfficeSession) 'The office native Codex adapter is missing.'
Assert (Test-Path -LiteralPath $nativeCodexTerminal) 'The office native Codex terminal adapter is missing.'
Assert (Test-Path -LiteralPath $sessionTitle) 'The persistent session-title module is missing.'
Assert (Test-Path -LiteralPath $sessionHarness) 'The managed session harness is missing.'
Assert (Test-Path -LiteralPath $activeSessionHarness) 'The active-session gateway harness is missing.'
Assert (Test-Path -LiteralPath $sshGatewayHarness) 'The SSH gateway interaction harness is missing.'
Assert (Test-Path -LiteralPath $inputArbiterHarness) 'The input-arbiter release harness is missing.'
Assert (Test-Path -LiteralPath $scopedRelayHarness) 'The selected-thread policy harness is missing.'
Assert (Test-Path -LiteralPath $nativeGatewayHarness) 'The forced native-gateway harness is missing.'
Assert (Test-Path -LiteralPath $nativeOfficeHarness) 'The native office adapter harness is missing.'
Assert (Test-Path -LiteralPath $nativeOfficeMouseHarness) 'The physical mouse-wheel adapter harness is missing.'
Assert (Test-Path -LiteralPath $nativeOfficeTransportRecoveryHarness) 'The native office transport-recovery harness is missing.'
Assert (Test-Path -LiteralPath $officeDisconnectIsolationHarness) 'The office-disconnect isolation harness is missing.'
Assert (Test-Path -LiteralPath $managedCodexTransportRecoveryHarness) 'The managed Codex transport-recovery harness is missing.'
Assert (Test-Path -LiteralPath $managedCodexResumeScopeHarness) 'The managed Codex workspace resume harness is missing.'
Assert (Test-Path -LiteralPath $managedResumeIndexHarness) 'The managed Codex resume-index harness is missing.'
Assert (Test-Path -LiteralPath $managedProfileRepairHarness) 'The managed Codex profile repair harness is missing.'
Assert (Test-Path -LiteralPath $sessionTitleHarness) 'The persistent session-title harness is missing.'
Assert (Test-Path -LiteralPath $nativeTwoClientHarness) 'The two-official-client TUI harness is missing.'
Assert (Test-Path -LiteralPath $codexReadinessHarness) 'The Codex readiness-gate harness is missing.'
Assert (Test-Path -LiteralPath $liveCodexProbe) 'The isolated real-Codex probe is missing.'
Assert (Test-Path -LiteralPath $appServerSharedThreadHarness) 'The app-server same-thread harness is missing.'
Assert (Test-Path -LiteralPath $appServerResumeHarness) 'The app-server resume-preservation harness is missing.'
Assert (Test-Path -LiteralPath $appServerStartupHarness) 'The app-server startup isolation harness is missing.'
Assert (Test-Path -LiteralPath $appServerRolloutReadinessProbe) 'The native app-server rollout-readiness proof is missing.'
Assert (Test-Path -LiteralPath $appServerHostHarness) 'The shared app-server host harness is missing.'
Assert (Test-Path -LiteralPath $recoverySharedHostHarness) 'The recovery shared-host harness is missing.'
Assert (Test-Path -LiteralPath $terminalOutputSinkHarness) 'The managed-terminal output sink harness is missing.'
Assert (Test-Path -LiteralPath $terminalOutputCoalescerHarness) 'The managed-terminal output coalescer harness is missing.'
Assert (Test-Path -LiteralPath $sharedSessionRunnerHarness) 'The shared-session runner harness is missing.'
Assert (Test-Path -LiteralPath $semanticTwoMachineHarness) 'The semantic two-machine harness is missing.'
Assert (Test-Path -LiteralPath $hiddenProcessHarness) 'The Windows hidden-process harness is missing.'
Assert (Test-Path -LiteralPath $liveHiddenWindowHarness) 'The live hidden-window proof is missing.'
Assert (Test-Path -LiteralPath $transientWindowProbeHarness) 'The transient-window event proof is missing.'
Assert (Test-Path -LiteralPath $visibleWindowProbe) 'The visible-window probe is missing.'
Assert (Test-Path -LiteralPath $roleHarness) 'The mixed-role resolution harness is missing.'
Assert (Test-Path -LiteralPath $officeAttachAllHarness) 'The office attach-all harness is missing.'
Assert (Test-Path -LiteralPath $sessionClientAttachHarness) 'The office session-client attach harness is missing.'
Assert (Test-Path -LiteralPath $codexInstallationHarness) 'The official Codex installation harness is missing.'
Assert (Test-Path -LiteralPath $codexUpdateGuardHarness) 'The active Codex-session update guard harness is missing.'
$package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
Assert ($package.name -eq 'xcode-remote') 'The npm package name is incorrect.'
Assert ($package.version -eq '1.5.4') 'The native-scrollback release version is incorrect.'
Assert ($package.bin.xcode -eq 'bin/xcode.js') 'npm does not expose the xcode command.'
Assert ($package.dependencies.'@openai/codex' -eq '0.144.5') 'The two devices do not share the verified official Codex version.'
Assert ($package.dependencies.ws -eq '8.21.1') 'The selected-thread WebSocket bridge dependency is not pinned.'
$helpText = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $dispatcher help | Out-String)
Assert ($LASTEXITCODE -eq 0 -and $helpText -match 'xcode main') 'The xcode dispatcher does not expose the main-PC setup workflow.'
Assert ($helpText -match 'xcode office') 'The xcode dispatcher does not expose the office-laptop setup workflow.'
Assert ($helpText -match 'xcode pair') 'The xcode dispatcher does not expose the paired workflow.'
Assert ($helpText -match 'xcode update') 'The xcode dispatcher does not expose self-update.'
Assert ($helpText -match 'codex') 'The xcode dispatcher does not describe the preserved Codex command.'
Assert ((Get-Content -Raw $dispatcher) -match 'Start-XcodeManagedCodex') 'The main PC does not start managed Codex sessions.'
Assert ((Get-Content -Raw $dispatcher) -match 'Connect-XcodeOfficeSharedTerminal') 'Office xcode does not attach to the shared host terminal.'
Assert ((Get-Content -Raw $dispatcher) -match 'Get-XcodeActiveManagedSessionProcesses') 'xcode update does not detect active managed sessions before invoking npm.'
Assert ((Get-Content -Raw $dispatcher) -match 'Windows cannot replace node-pty') 'xcode update does not explain the native-module update lock.'
Assert ((Get-Content -Raw $dispatcher) -match "'-aa'") 'The office dispatcher does not expose xcode -aa.'
Assert ((Get-Content -Raw $dispatcher) -match 'AttachAll') 'The office dispatcher does not route xcode -aa to the batch session client.'
Assert ((Get-Content -Raw $dispatcher) -match 'Write-XcodeReleaseStatus') 'xcode update and status do not report the verified Codex release.'
Assert ((Get-Content -Raw $codexExecutable) -match 'release-payload') 'The Codex resolver can select an unrelated global Codex installation.'
Assert ($mainScript -notmatch 'session run --') 'The main-PC codex profile still emits a PowerShell-incompatible argument separator.'
Assert ((Get-Content -Raw $nodeLauncher) -match 'PowerShell -File treats a bare') 'The npm launcher does not tolerate the legacy managed-session separator.'
Assert ((Get-Content -Raw $managedRunner) -match 'startSharedAppServerSession') 'The main Codex entrypoint still uses the byte-forwarding session authority.'
Assert ((Get-Content -Raw $appServerHost) -match "'app-server', '--listen'") 'The shared app-server host does not start a loopback Codex app-server.'
Assert ((Get-Content -Raw $appServerHost) -match "'--disable', 'computer_use'") 'The terminal-only app-server can still launch the graphical Computer Use helper.'
Assert ((Get-Content -Raw $appServerHost) -match 'runSharedAppServerWatchdog') 'The shared app-server host cannot clean stale runner leases.'
Assert ((Get-Content -Raw $appServerHost) -match 'startPseudoconsoleAppServer') 'The shared app-server can still expose descendant console windows.'
Assert ((Get-Content -Raw $appServerPtyHost) -match 'useConptyDll: true') 'The app-server host is not attached to a private ConPTY.'
Assert ((Get-Content -Raw $appServerHost) -match 'prepareHiddenCodexEnvironment') 'The shared app-server can still expose Codex helper consoles.'
Assert ((Get-Content -Raw $windowsShellShim) -match 'CODEX_CODE_MODE_HOST_PATH') 'The code-mode host is not routed through the hidden process shim.'
Assert ((Get-Content -Raw $hiddenProcessSource) -match 'CREATE_NO_WINDOW') 'The Windows helper shim does not suppress console allocation.'
Assert ((Get-Content -Raw $appServerSession) -match 'acquireSharedAppServer') 'Managed sessions do not acquire the host-wide app-server.'
Assert ((Get-Content -Raw $managedRunner) -match 'createTerminalOutputSink') 'The managed Codex entrypoint can still crash on an unhandled terminal-stream error.'
Assert ((Get-Content -Raw $managedRunner) -notmatch 'createTerminalOutputCoalescer') 'The managed Codex entrypoint still rewrites official terminal frames into snapshots.'
Assert ((Get-Content -Raw $managedRunner) -match 'createTerminalTitleFilter') 'The managed Codex entrypoint no longer preserves persistent conversation tab titles.'
Assert ((Get-Content -Raw $managedRunner) -match 'createManagedResumeIndex') 'The managed Codex entrypoint does not scope default resume candidates to the current workspace.'
Assert ((Get-Content -Raw $managedRunner) -match 'DISABLE_MOUSE_REPORTING') 'The managed Codex entrypoint can still leave physical mouse-wheel capture enabled.'
Assert ((Get-Content -Raw $managedRunner) -match 'transport-reset-retry') 'The managed Codex entrypoint cannot recover a reset remote app-server transport.'
Assert ((Get-Content -Raw $appServerSession) -match "'turn/start'") 'The shared-session authority does not submit office messages as Codex turns.'
Assert ((Get-Content -Raw $appServerSession) -match "'--remote'") 'The main Codex TUI is not resumed against the shared app-server.'
Assert ((Get-Content -Raw $appServerSession) -match 'parseResumeInvocation') 'The shared-session authority does not parse a Codex resume before opening a thread.'
Assert ((Get-Content -Raw $appServerSession) -match 'initializeNewThreadForRemoteTui') 'A new shared thread can still reach the native TUI without a persisted rollout.'
Assert ((Get-Content -Raw $appServerSession) -match 'shouldShareAppServer') 'New Codex sessions can still be queued behind the recovery authority.'
Assert ((Get-Content -Raw $appServerSession) -match 'requestWithTimeout') 'A queued Codex bootstrap request can still leave a terminal blank forever.'
Assert ((Get-Content -Raw $sessionRunner) -match 'node-pty') 'The managed session runner does not use a private pseudoterminal.'
Assert ((Get-Content -Raw $sessionRunner) -match 'xcode-session-') 'The managed session runner does not create a scoped session pipe.'
Assert ((Get-Content -Raw $sessionRunner) -match 'localEscapeState') 'The input arbiter does not distinguish terminal controls from local draft text.'
Assert ((Get-Content -Raw $sessionRunner) -match 'getDimensions') 'The session gateway does not report the managed terminal dimensions.'
Assert ((Get-Content -Raw $sessionRunner) -match "frame\?\.type === 'resize'") 'The session gateway does not accept office terminal resize frames.'
Assert ((Get-Content -Raw $sessionRunner) -match 'isCodexInputBlocked') 'The session runner does not protect remote messages from Codex safety prompts.'
Assert ((Get-Content -Raw $sessionGateway) -match 'SSH_ORIGINAL_COMMAND') 'The gateway does not enforce the original SSH command boundary.'
Assert ((Get-Content -Raw $sessionGateway) -match 'xcode-gateway') 'The gateway does not restrict its command vocabulary.'
Assert ((Get-Content -Raw $sessionGateway) -match 'probePipe') 'The gateway does not verify that listed sessions have a reachable local pipe.'
Assert ((Get-Content -Raw $sessionGateway) -match "parts\[1\] === 'native'") 'The forced gateway does not expose the selected-thread native route.'
Assert ((Get-Content -Raw $sessionGateway) -match 'relayScopedAppServer') 'The forced gateway does not use the selected-thread policy relay.'
Assert ((Get-Content -Raw $sessionClient) -match 'runNativeCodexOfficeSession') 'The office client does not launch the official Codex TUI.'
Assert ((Get-Content -Raw $sessionClient) -match 'recoverSessionByThread') 'The office client cannot rediscover a recovered managed Codex session by thread.'
Assert ((Get-Content -Raw $sessionClient) -match "'--attach-all'") 'The office client cannot run xcode -aa.'
Assert ((Get-Content -Raw $sessionClient) -match 'findSelectedSession') 'A batch-opened office tab cannot revalidate its selected session.'
Assert ((Get-Content -Raw $nativeOfficeSession) -match "\['native', session\.sessionId\]") 'The office client does not request the selected native session capability.'
Assert ((Get-Content -Raw $nativeOfficeSession) -match "'--no-alt-screen'") 'The office official Codex TUI does not retain normal terminal scrollback.'
Assert ((Get-Content -Raw $nativeOfficeSession) -match 'startNativeCodexTerminal') 'The office official Codex TUI is not attached through the native terminal adapter.'
Assert ((Get-Content -Raw $nativeOfficeSession) -match 'REMOTE_TRANSPORT_ERROR') 'The office native session cannot recover a reset remote app-server transport.'
Assert ((Get-Content -Raw $nativeCodexTerminal) -match "require\('node-pty'\)") 'The office native terminal does not use a private Windows ConPTY.'
Assert ((Get-Content -Raw $nativeCodexTerminal) -match '\?1006l') 'The office native terminal does not release SGR mouse capture for native scrollback.'
Assert ((Get-Content -Raw $nativeCodexTerminal) -notmatch '\?1006h') 'The office native terminal still captures physical mouse-wheel input.'
Assert ((Get-Content -Raw $scopedAppServerRelay) -match 'DENIED_THREAD_METHODS') 'The remote device can enumerate or mutate unrelated Codex threads.'
Assert ((Get-Content -Raw $scopedAppServerRelay) -match 'isLoopbackWebSocketUrl') 'The app-server relay is not restricted to a private main-PC endpoint.'
Assert ((Get-Content -Raw $appServerSession) -match "'--no-alt-screen'") 'The managed native Codex TUI does not retain terminal scrollback for the office mirror.'
& node.exe $scopedRelayHarness
Assert ($LASTEXITCODE -eq 0) 'The selected-thread relay did not preserve authoritative Working terminal states.'
& node.exe $nativeOfficeHarness
Assert ($LASTEXITCODE -eq 0) 'The office native adapter did not preserve authoritative Working terminal states.'
& node.exe $appServerResumeHarness
Assert ($LASTEXITCODE -eq 0) 'A Codex resume can overwrite the stored thread workspace or lose its selected policy.'
& node.exe $appServerStartupHarness
Assert ($LASTEXITCODE -eq 0) 'The native Codex TUI can still be blocked after its rollout bootstrap was accepted.'
& node.exe $appServerRolloutReadinessProbe
Assert ($LASTEXITCODE -eq 0) 'The opt-in native app-server rollout-readiness proof cannot be loaded.'
& node.exe $managedResumeIndexHarness
Assert ($LASTEXITCODE -eq 0) 'Managed Codex resume records did not preserve current-workspace scope.'
& node.exe $managedProfileRepairHarness
Assert ($LASTEXITCODE -eq 0) 'xcode update did not restore the managed Codex profile entrypoint.'
& node.exe $managedCodexResumeScopeHarness
Assert ($LASTEXITCODE -eq 0) 'The default managed Codex resume selector was not limited to the current workspace.'
& node.exe $managedCodexTransportRecoveryHarness
Assert ($LASTEXITCODE -eq 0) 'The main Codex terminal did not recover after a remote app-server transport reset.'
& node.exe $authoritativeWorkingStateHarness
Assert ($LASTEXITCODE -eq 0) 'A stale native Working indicator was not reconciled with the authoritative Codex thread state.'
& node.exe $nativeOfficeTransportRecoveryHarness
Assert ($LASTEXITCODE -eq 0) 'The office Codex terminal did not recover after a remote app-server transport reset.'
& node.exe $officeDisconnectIsolationHarness
Assert ($LASTEXITCODE -eq 0) 'An Office disconnect could still interrupt the main Codex authority.'
& node.exe $officeAttachAllHarness
Assert ($LASTEXITCODE -eq 0) 'The office batch attach controller did not preserve active-session and duplicate semantics.'
& node.exe $sessionClientAttachHarness
Assert ($LASTEXITCODE -eq 0) 'The office tab launcher did not revalidate its selected native Codex session.'
& node.exe $codexInstallationHarness
Assert ($LASTEXITCODE -eq 0) 'The official Codex installation could not be resolved and version-verified.'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $codexUpdateGuardHarness -RepositoryRoot $root
Assert ($LASTEXITCODE -eq 0) 'xcode update did not protect active main or office native Codex sessions.'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $codexUpdateInstallationRootHarness -RepositoryRoot $root
Assert ($LASTEXITCODE -eq 0) 'xcode update did not verify the global package it installed.'
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
Assert ($mainScript -match 'Install-XcodeManagedCodexProfileEntrypoint') 'Main setup does not preserve the codex command through the managed-session entrypoint.'
Assert ((Get-Content -Raw -LiteralPath $dispatcher) -match 'Install-XcodeManagedCodexProfileEntrypoint') 'The first post-update Codex launch does not repair an older managed profile entrypoint.'
Assert ((Get-Content -Raw -LiteralPath $dispatcher) -match 'HadLegacyZeroArgumentBug') 'The dispatcher does not neutralize the one-time legacy bogus zero-argument value.'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'codex-profile-entrypoint-harness.ps1') -RepositoryRoot $root
Assert ($LASTEXITCODE -eq 0) 'The managed codex PowerShell profile entrypoint is not stable across setup and zero-argument startup.'
$headlessTerminalFiles = @(
    (Join-Path $root 'lib\session-runner.js'),
    (Join-Path $root 'lib\terminal-output-coalescer.js')
)
foreach ($headlessTerminalFile in $headlessTerminalFiles) {
    Assert ((Get-Content -Raw -LiteralPath $headlessTerminalFile) -match "logLevel:\s*'off'") "Headless xterm diagnostics can still leak from $headlessTerminalFile."
}
Assert ($officeScript -match 'Remove-XcodeMainRoleResidue') 'Office setup does not remove stale local main-PC role residue.'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $roleHarness -RepositoryRoot $root
Assert ($LASTEXITCODE -eq 0) 'Office role precedence failed when stale main-PC state was present.'
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
