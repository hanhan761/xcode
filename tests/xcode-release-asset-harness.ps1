[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot
)

$ErrorActionPreference = 'Stop'

function Assert-ReleaseAssetHarness {
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
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-XcodeLatestReleasePackageUrl'
}, $true))[0]
if (-not $definition) { throw 'The latest xcode release-package resolver is missing.' }
. ([scriptblock]::Create($definition.Extent.Text))

function New-ReleaseFixture {
    param(
        [string]$Tag = 'v1.5.5',
        [object[]]$Assets = @(
            [pscustomobject]@{
                name = 'xcode-remote-1.5.5.tgz'
                browser_download_url = 'https://github.com/hanhan761/xcode/releases/download/v1.5.5/xcode-remote-1.5.5.tgz'
                state = 'uploaded'
            }
        )
    )
    return [pscustomobject]@{ tag_name = $Tag; draft = $false; prerelease = $false; assets = $Assets }
}

function Assert-ReleaseAssetFailure {
    param([Parameter(Mandatory = $true)][scriptblock]$Action, [Parameter(Mandatory = $true)][string]$Pattern)
    $failure = $null
    try { & $Action }
    catch { $failure = $_ }
    Assert-ReleaseAssetHarness ($null -ne $failure -and $failure.Exception.Message -match $Pattern) "Expected release-asset failure matching '$Pattern'."
}

$script:releaseFixture = New-ReleaseFixture
$url = Get-XcodeLatestReleasePackageUrl -FetchRelease { $script:releaseFixture }
Assert-ReleaseAssetHarness ($url -eq 'https://github.com/hanhan761/xcode/releases/download/v1.5.5/xcode-remote-1.5.5.tgz') 'The resolver did not return the verified GitHub Release asset URL.'

$script:releaseFixture = New-ReleaseFixture -Assets @()
Assert-ReleaseAssetFailure -Action { Get-XcodeLatestReleasePackageUrl -FetchRelease { $script:releaseFixture } } -Pattern 'exactly one'

$script:releaseFixture = New-ReleaseFixture -Assets @(
    [pscustomobject]@{ name = 'xcode-remote-1.5.5.tgz'; browser_download_url = 'https://github.com/hanhan761/xcode/releases/download/v1.5.5/xcode-remote-1.5.5.tgz' },
    [pscustomobject]@{ name = 'xcode-remote-1.5.4.tgz'; browser_download_url = 'https://github.com/hanhan761/xcode/releases/download/v1.5.4/xcode-remote-1.5.4.tgz' }
)
Assert-ReleaseAssetFailure -Action { Get-XcodeLatestReleasePackageUrl -FetchRelease { $script:releaseFixture } } -Pattern 'exactly one'

$script:releaseFixture = New-ReleaseFixture -Tag 'v1.5.4'
Assert-ReleaseAssetFailure -Action { Get-XcodeLatestReleasePackageUrl -FetchRelease { $script:releaseFixture } } -Pattern 'tag'

$script:releaseFixture = New-ReleaseFixture
$script:releaseFixture.prerelease = $true
Assert-ReleaseAssetFailure -Action { Get-XcodeLatestReleasePackageUrl -FetchRelease { $script:releaseFixture } } -Pattern 'published stable'

$script:releaseFixture = New-ReleaseFixture
$script:releaseFixture.assets[0].state = 'starter'
Assert-ReleaseAssetFailure -Action { Get-XcodeLatestReleasePackageUrl -FetchRelease { $script:releaseFixture } } -Pattern 'not uploaded'

$script:releaseFixture = New-ReleaseFixture -Assets @(
    [pscustomobject]@{ name = 'xcode-remote-1.5.5.tgz'; browser_download_url = 'https://example.invalid/xcode-remote-1.5.5.tgz'; state = 'uploaded' }
)
Assert-ReleaseAssetFailure -Action { Get-XcodeLatestReleasePackageUrl -FetchRelease { $script:releaseFixture } } -Pattern 'HTTPS GitHub Release asset'

Assert-ReleaseAssetFailure -Action { Get-XcodeLatestReleasePackageUrl -FetchRelease { throw 'network unavailable' } } -Pattern 'could not retrieve'

Write-Host 'XCODE_RELEASE_ASSET=PASS'
