[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot
)

$ErrorActionPreference = 'Stop'

function Assert-UpdateGuardHarness {
    param([Parameter(Mandatory = $true)][bool]$Condition, [Parameter(Mandatory = $true)][string]$Message)
    if (-not $Condition) { throw $Message }
}

$dispatcher = Join-Path $RepositoryRoot 'scripts\xcode.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($dispatcher, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'The xcode dispatcher could not be parsed.' }
$definition = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-XcodeActiveManagedSessionProcesses'
}, $true))[0]
if (-not $definition) { throw 'The active xcode-session process detector is missing.' }

function Get-CimInstance {
    param([string]$ClassName)
    @(
        [pscustomobject]@{ Name = 'node.exe'; ProcessId = 101; CommandLine = 'node.exe C:\Users\test\AppData\Roaming\npm\node_modules\xcode-remote\bin\managed-codex.js resume thread-main' }
        [pscustomobject]@{ Name = 'node.exe'; ProcessId = 102; CommandLine = 'node.exe C:\Users\test\AppData\Roaming\npm\node_modules\xcode-remote\bin\session-client.js --ssh-config C:\Users\test\AppData\Local\XcodeRemote\ssh_config' }
        [pscustomobject]@{ Name = 'node.exe'; ProcessId = 103; CommandLine = 'node.exe C:\tools\session-client.js' }
        [pscustomobject]@{ Name = 'powershell.exe'; ProcessId = 104; CommandLine = 'powershell.exe -File C:\Users\test\AppData\Roaming\npm\node_modules\xcode-remote\bin\session-client.js' }
    )
}

. ([scriptblock]::Create($definition.Extent.Text))
$active = @(Get-XcodeActiveManagedSessionProcesses)
Assert-UpdateGuardHarness ($active.Count -eq 2) "Expected the update guard to find main and office native sessions, found $($active.Count)."
Assert-UpdateGuardHarness (@($active.ProcessId) -contains 101) 'The update guard did not find a managed main-PC Codex session.'
Assert-UpdateGuardHarness (@($active.ProcessId) -contains 102) 'The update guard did not find an office native Codex session.'
Assert-UpdateGuardHarness (@($active.ProcessId) -notcontains 103) 'The update guard matched an unrelated session-client process.'
Assert-UpdateGuardHarness (@($active.ProcessId) -notcontains 104) 'The update guard matched a non-Node process.'

Write-Host 'CODEX_UPDATE_SESSION_GUARD=PASS'
