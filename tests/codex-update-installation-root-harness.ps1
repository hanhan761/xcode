[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot
)

$ErrorActionPreference = 'Stop'

function Assert-UpdateInstallationRootHarness {
    param([Parameter(Mandatory = $true)][bool]$Condition, [Parameter(Mandatory = $true)][string]$Message)
    if (-not $Condition) { throw $Message }
}

$dispatcher = Join-Path $RepositoryRoot 'scripts\xcode.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($dispatcher, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'The xcode dispatcher could not be parsed.' }

function Get-XcodeFunctionDefinition {
    param([Parameter(Mandatory = $true)][string]$Name)
    $definition = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Name
    }, $true))[0]
    if (-not $definition) { throw "The $Name function is missing." }
    return $definition.Extent.Text
}

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("xcode-update-installation-root-" + [guid]::NewGuid().ToString('N'))
try {
    $globalModules = Join-Path $fixtureRoot 'global-node-modules'
    $globalRelease = Join-Path $globalModules 'xcode-remote'
    $sourceRelease = Join-Path $fixtureRoot 'source-checkout'
    New-Item -ItemType Directory -Force -Path $globalRelease, $sourceRelease | Out-Null
    $fakeNpm = Join-Path $fixtureRoot 'npm.ps1'
    @'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
if (($Arguments -join ' ') -eq 'root --global') {
    Write-Output $env:XCODE_TEST_GLOBAL_NPM_ROOT
    exit 0
}
if (($Arguments -join ' ') -eq 'install --global --force github:hanhan761/xcode#main') {
    exit 0
}
throw "Unexpected npm arguments: $($Arguments -join ' ')"
'@ | Set-Content -LiteralPath $fakeNpm -Encoding utf8
    $env:XCODE_TEST_GLOBAL_NPM_ROOT = $globalModules

    . ([scriptblock]::Create((Get-XcodeFunctionDefinition -Name 'Get-XcodeGlobalPackageRoot')))
    $resolvedGlobalRelease = Get-XcodeGlobalPackageRoot -Npm ([pscustomobject]@{ Source = $fakeNpm })
    Assert-UpdateInstallationRootHarness ($resolvedGlobalRelease -eq (Resolve-Path -LiteralPath $globalRelease).Path) 'The update helper did not resolve npm''s global xcode-remote package root.'

    function Get-XcodeActiveManagedSessionProcesses { return @() }
    function Get-Command {
        param([string]$Name)
        if ($Name -eq 'npm.cmd') { return [pscustomobject]@{ Source = $fakeNpm } }
        return $null
    }
    function Write-XcodeStep { param([string]$Message) }
    function Remove-XcodePathEntry { param([string]$Directory) }
    $script:verifiedInstallationRoot = ''
    function Write-XcodeReleaseStatus {
        param([string]$InstallationRoot)
        $script:verifiedInstallationRoot = $InstallationRoot
        return [pscustomobject]@{ codex = [pscustomobject]@{ version = '0.0.0-test'; source = 'release-payload' } }
    }
    . ([scriptblock]::Create((Get-XcodeFunctionDefinition -Name 'Update-XcodePackage')))
    $originalLocalAppData = $env:LOCALAPPDATA
    try {
        $env:LOCALAPPDATA = $fixtureRoot
        Update-XcodePackage
    }
    finally { $env:LOCALAPPDATA = $originalLocalAppData }
    Assert-UpdateInstallationRootHarness ($script:verifiedInstallationRoot -eq (Resolve-Path -LiteralPath $globalRelease).Path) 'xcode update verified the invoking source checkout instead of the newly installed global release.'
}
finally {
    Remove-Item Env:\XCODE_TEST_GLOBAL_NPM_ROOT -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'CODEX_UPDATE_INSTALLATION_ROOT=PASS'
