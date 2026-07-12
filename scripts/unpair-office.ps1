[CmdletBinding()]
param(
    [string]$ExpectedSid,
    [string]$ExpectedUser,
    [string]$Fingerprint
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'XcodeRemote.Common.ps1')
if (-not $ExpectedSid) { $ExpectedSid = Get-XcodeCurrentSid }
if (-not $ExpectedUser) { $ExpectedUser = $env:USERNAME }

if (-not (Test-XcodeAdministrator)) {
    $arguments = @('-ExpectedSid', $ExpectedSid, '-ExpectedUser', $ExpectedUser)
    if ($Fingerprint) { $arguments += @('-Fingerprint', $Fingerprint) }
    Invoke-XcodeElevatedPowerShell -ScriptPath $PSCommandPath -Arguments $arguments
    exit 0
}
Assert-XcodeElevatedIdentity -ExpectedSid $ExpectedSid -ExpectedUser $ExpectedUser

$path = Get-XcodeAuthorizedKeysPath
if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    Write-Host 'No SSH authorized-keys file exists; there is nothing to unpair.'
    exit 0
}

$original = Get-Content -Raw -LiteralPath $path
$lines = @($original -split '\r?\n' | Where-Object { $_.Trim() })
$managed = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '(?<!\S)xcode:') {
        $canonical = Get-XcodeCanonicalKeyFromAuthorizedLine -Line $lines[$i]
        if ($canonical) {
            $managed += [pscustomobject]@{
                Index = $i
                Fingerprint = Get-XcodeSshPublicKeyFingerprint -PublicKey $canonical
                Label = ([regex]::Match($lines[$i], '(?<!\S)xcode:(\S+)$')).Groups[1].Value
            }
        }
    }
}
if ($managed.Count -eq 0) {
    Write-Host 'No xcode-managed office keys are registered.'
    exit 0
}

if (-not $Fingerprint) {
    Write-Host 'Registered xcode office keys:' -ForegroundColor Cyan
    for ($i = 0; $i -lt $managed.Count; $i++) {
        Write-Host "  [$($i + 1)] $($managed[$i].Label)  $($managed[$i].Fingerprint)"
    }
    $selection = Read-Host 'Enter the number to revoke (or press Enter to cancel)'
    if (-not $selection) { Write-Host 'Cancelled.'; exit 0 }
    $number = 0
    if (-not [int]::TryParse($selection, [ref]$number) -or $number -lt 1 -or $number -gt $managed.Count) {
        throw 'Invalid selection.'
    }
    $Fingerprint = $managed[$number - 1].Fingerprint
}

$targets = @($managed | Where-Object { $_.Fingerprint -eq $Fingerprint })
if ($targets.Count -ne 1) { throw "No unique xcode-managed key matches $Fingerprint." }
$approval = Read-Host "Revoke $($targets[0].Label) ($Fingerprint)? [y/N]"
if ($approval -notmatch '^[Yy]$') { Write-Host 'Cancelled.'; exit 0 }

Backup-XcodeFile -Path $path | Out-Null
$removeIndex = [int]$targets[0].Index
$remaining = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($i -ne $removeIndex) { $remaining += $lines[$i] }
}
$newContent = if ($remaining.Count) { ($remaining -join "`r`n") + "`r`n" } else { '' }
Write-XcodeAuthorizedKeysContent -Path $path -Content $newContent
Write-Host "Revoked office key $Fingerprint." -ForegroundColor Green
Write-Host 'If the laptop was lost, also delete that device from the Tailscale Machines page.' -ForegroundColor Yellow
