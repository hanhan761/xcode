[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^S-1-5-')][string]$ExpectedSid,
    [Parameter(Mandatory = $true)][string]$ExpectedUser
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'XcodeRemote.Common.ps1')
Assert-XcodeElevatedIdentity -ExpectedSid $ExpectedSid -ExpectedUser $ExpectedUser

$capabilityName = 'OpenSSH.Client~~~~0.0.1.0'
$capability = Get-WindowsCapability -Online -Name $capabilityName
if ($capability.State -ne 'Installed') {
    Write-XcodeStep 'Installing Windows OpenSSH Client'
    Add-WindowsCapability -Online -Name $capabilityName | Out-Null
}
if (-not (Get-XcodeOpenSshExecutable -Name 'ssh.exe') -or -not (Get-XcodeOpenSshExecutable -Name 'ssh-keygen.exe')) {
    throw 'Windows OpenSSH Client tools were not found after installation.'
}
Write-Host 'Windows OpenSSH Client is ready.' -ForegroundColor Green
