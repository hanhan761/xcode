[CmdletBinding()]
param(
    [string]$RepositoryRoot = ''
)

$ErrorActionPreference = 'Stop'
if (-not $RepositoryRoot) { $RepositoryRoot = Split-Path -Parent $PSScriptRoot }
$fixtureRoot = Join-Path $PSScriptRoot 'fixtures\mixed-role'
$nodeLauncher = Join-Path $RepositoryRoot 'bin\xcode.js'
if (-not (Test-Path -LiteralPath $fixtureRoot -PathType Container)) { throw 'The mixed-role fixture is missing.' }
if (-not (Test-Path -LiteralPath $nodeLauncher -PathType Leaf)) { throw 'The xcode npm launcher is missing.' }

$originalLocalAppData = $env:LOCALAPPDATA
try {
    $env:LOCALAPPDATA = $fixtureRoot
    $output = (& node.exe $nodeLauncher status 2>&1 | Out-String)
    $exitCode = $LASTEXITCODE
}
finally {
    $env:LOCALAPPDATA = $originalLocalAppData
}

if ($exitCode -ne 0 -or $output -notmatch '"role"\s*:\s*"office"') {
    throw "ROLE_RESOLUTION=FAIL`n$output"
}
if ($output -match '"role"\s*:\s*"main"') {
    throw "ROLE_RESOLUTION=FAIL: the stale main-PC state won over the office role.`n$output"
}
Write-Host 'ROLE_RESOLUTION=PASS'
