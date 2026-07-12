[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TransactionPath,
    [int]$ParentPid,
    [switch]$RecoverNow
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'XcodeRemote.Common.ps1')
Assert-XcodeAdministrator

$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'XcodeRemote')).TrimEnd('\') + '\'
$resolvedTransaction = [IO.Path]::GetFullPath($TransactionPath)
if (-not $resolvedTransaction.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to recover a pairing transaction outside the xcode ProgramData root.'
}

function Restore-XcodePairingTransaction {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $transaction = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    if ([int]$transaction.schemaVersion -ne 1 -or [string]$transaction.status -ne 'pending') {
        throw 'The pending pairing journal is invalid.'
    }

    $authorizedPath = [IO.Path]::GetFullPath([string]$transaction.authorizedKeysPath)
    $sshRoot = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'ssh')).TrimEnd('\') + '\'
    if (-not $authorizedPath.StartsWith($sshRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The pending pairing journal references an unsafe authorized-keys path.'
    }

    try { Disable-NetFirewallRule -Name ([string]$transaction.firewallRuleName) -ErrorAction SilentlyContinue | Out-Null } catch {}
    try { Stop-Service -Name sshd -Force -ErrorAction SilentlyContinue } catch {}

    if ([bool]$transaction.authorizedKeysHadFile) {
        Write-XcodeAuthorizedKeysContent -Path $authorizedPath -Content ([string]$transaction.authorizedKeysOriginalContent)
    }
    elseif (Test-Path -LiteralPath $authorizedPath) {
        Remove-Item -LiteralPath $authorizedPath -Force
    }

    $hostStatePath = [IO.Path]::GetFullPath([string]$transaction.hostStatePath)
    if (-not $hostStatePath.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The pending pairing journal references an unsafe host-state path.'
    }
    Write-XcodeUtf8File -Path $hostStatePath -Content ([string]$transaction.hostStateOriginalContent)

    $startType = [string]$transaction.serviceStartType
    if ($startType -eq 'Auto') { Set-Service -Name sshd -StartupType Automatic }
    elseif ($startType -eq 'Disabled') { Set-Service -Name sshd -StartupType Disabled }
    else { Set-Service -Name sshd -StartupType Manual }

    if ([bool]$transaction.serviceWasRunning) { Start-Service -Name sshd }
    if ([bool]$transaction.firewallWasEnabled) {
        Enable-NetFirewallRule -Name ([string]$transaction.firewallRuleName) | Out-Null
    }
    Remove-Item -LiteralPath $Path -Force
}

if ($RecoverNow) {
    Restore-XcodePairingTransaction -Path $resolvedTransaction
    return
}
if ($ParentPid -le 0) { throw 'A valid pairing parent PID is required.' }

while (Test-Path -LiteralPath $resolvedTransaction -PathType Leaf) {
    $parentAlive = $null -ne (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)
    $transaction = Get-Content -Raw -LiteralPath $resolvedTransaction | ConvertFrom-Json
    $expired = (Get-Date).ToUniversalTime() -ge [DateTime]::Parse([string]$transaction.expiresAt).ToUniversalTime()
    if (-not $parentAlive -or $expired) {
        Restore-XcodePairingTransaction -Path $resolvedTransaction
        break
    }
    Start-Sleep -Seconds 1
}
