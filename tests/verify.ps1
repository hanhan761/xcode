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
    RemoteWezTermPath = 'C:/ProgramData/XcodeRemote/wezterm-proxy.cmd'
    WezTermVersion = 'wezterm 20240203'
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

Write-Host '5. Validate entry points, mux policy, and credential hygiene'
$entries = @('install-main.cmd', 'install-office.cmd', 'pair-office.cmd', 'unpair-office.cmd')
foreach ($entry in $entries) { Assert (Test-Path (Join-Path $root $entry)) "Missing $entry." }
$officeScript = Get-Content -Raw (Join-Path $scripts 'install-office.ps1')
Assert ($officeScript -match "stricthostkeychecking = 'yes'") 'WezTerm strict host-key policy is missing.'
Assert ($officeScript -match 'no_agent_auth = true') 'WezTerm is not using its dedicated identity deterministically.'
Assert ($officeScript -notmatch "identitiesonly = 'yes'") 'The WezTerm config still disables agent behavior through the wrong option.'
$forbidden = 'tskey-|BEGIN OPENSSH PRIVATE KEY'
$hits = Get-ChildItem $root -Recurse -File |
    Where-Object { $_.FullName -notmatch '\\.git\\' -and $_.FullName -ne $PSCommandPath } |
    Select-String -Pattern $forbidden -ErrorAction SilentlyContinue
Assert (@($hits).Count -eq 0) 'A reusable credential marker exists in the repository.'

Write-Host 'All verification checks passed.' -ForegroundColor Green
