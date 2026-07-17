[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot
)

$ErrorActionPreference = 'Stop'
. (Join-Path $RepositoryRoot 'scripts\XcodeRemote.Common.ps1')

function Assert-ProfileHarness {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) { throw $Message }
}

$fixture = @'
$outsideBefore = 'keep-before'
# >>> xcode managed codex >>>
broken outer block
# >>> xcode managed codex >>>
broken nested block
# <<< xcode managed codex <<<
duplicated profile content
# <<< xcode managed codex <<<
$outsideAfter = 'keep-after'
'@

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('xcode-profile-harness-' + [Guid]::NewGuid().ToString('N'))
$originalPath = $env:PATH
$originalRecorder = $env:XCODE_PROFILE_RECORDER
$originalArgvLog = $env:XCODE_PROFILE_ARGV_LOG
try {
    $normalized = Update-XcodeManagedCodexProfileContent -Content $fixture -InstallEntrypoint
    Assert-ProfileHarness ($normalized.Contains("`$outsideBefore = 'keep-before'")) 'Profile normalization removed content before the managed block.'
    Assert-ProfileHarness ($normalized.Contains("`$outsideAfter = 'keep-after'")) 'Profile normalization removed content after the managed block.'
    Assert-ProfileHarness (-not $normalized.Contains('broken outer block')) 'Profile normalization retained the corrupted outer block.'
    Assert-ProfileHarness (-not $normalized.Contains('broken nested block')) 'Profile normalization retained the corrupted nested block.'
    Assert-ProfileHarness (([regex]::Matches($normalized, '# >>> xcode managed codex >>>')).Count -eq 1) 'Profile normalization did not produce exactly one managed start marker.'
    Assert-ProfileHarness (([regex]::Matches($normalized, '# <<< xcode managed codex <<<')).Count -eq 1) 'Profile normalization did not produce exactly one managed end marker.'

    $removed = Update-XcodeManagedCodexProfileContent -Content $normalized
    Assert-ProfileHarness (-not $removed.Contains('xcode managed codex')) 'Profile cleanup retained a managed marker.'
    Assert-ProfileHarness ($removed.Contains("`$outsideBefore = 'keep-before'")) 'Profile cleanup removed unrelated leading content.'
    Assert-ProfileHarness ($removed.Contains("`$outsideAfter = 'keep-after'")) 'Profile cleanup removed unrelated trailing content.'

    New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
    $legacyProfile = Join-Path $temporaryRoot 'legacy-profile.ps1'
    $legacyContent = @'
# >>> xcode managed codex >>>
function global:codex {
    param([Parameter(ValueFromRemainingArguments = $true)][object[]]$XcodeCodexArguments)
    & $xcodeLauncher.Source session run @($XcodeCodexArguments | ForEach-Object { [string]$_ })
}
# <<< xcode managed codex <<<
'@
    Write-XcodeUtf8File -Path $legacyProfile -Content $legacyContent
    $repair = Install-XcodeManagedCodexProfileEntrypoint -ProfilePath $legacyProfile
    Assert-ProfileHarness ($repair.Changed) 'The first runtime profile repair did not replace the legacy entrypoint.'
    Assert-ProfileHarness ($repair.HadLegacyZeroArgumentBug) 'The runtime profile repair did not identify the legacy zero-argument defect.'
    $secondRepair = Install-XcodeManagedCodexProfileEntrypoint -ProfilePath $legacyProfile
    Assert-ProfileHarness (-not $secondRepair.Changed) 'The runtime profile repair is not idempotent.'
    Assert-ProfileHarness (-not $secondRepair.HadLegacyZeroArgumentBug) 'The repaired entrypoint was still classified as the legacy wrapper.'
    $repairedZeroArguments = @(Resolve-XcodeManagedCodexArguments -Arguments @('string') -HadLegacyZeroArgumentBug)
    Assert-ProfileHarness ($repairedZeroArguments.Count -eq 0) 'The one-time legacy bogus string argument was not neutralized.'
    $intentionalStringArgument = @(Resolve-XcodeManagedCodexArguments -Arguments @('string'))
    Assert-ProfileHarness (($intentionalStringArgument -join '|') -eq 'string') 'A legitimate string prompt was removed without legacy-wrapper evidence.'
    $resumeAfterRepair = @(Resolve-XcodeManagedCodexArguments -Arguments @('resume', 'thread-123') -HadLegacyZeroArgumentBug)
    Assert-ProfileHarness (($resumeAfterRepair -join '|') -eq 'resume|thread-123') 'Runtime profile repair changed legitimate resume arguments.'

    $profileScript = Join-Path $temporaryRoot 'profile.ps1'
    $recorderScript = Join-Path $temporaryRoot 'record-argv.js'
    $launcher = Join-Path $temporaryRoot 'xcode.cmd'
    $argvLog = Join-Path $temporaryRoot 'argv.json'
    Write-XcodeUtf8File -Path $profileScript -Content (Update-XcodeManagedCodexProfileContent -Content '' -InstallEntrypoint)
    Write-XcodeUtf8File -Path $recorderScript -Content "require('node:fs').writeFileSync(process.env.XCODE_PROFILE_ARGV_LOG, JSON.stringify(process.argv.slice(2)));"
    Write-XcodeUtf8File -Path $launcher -Content "@echo off`r`nnode.exe `"%XCODE_PROFILE_RECORDER%`" %*`r`nexit /b %ERRORLEVEL%`r`n"

    $env:PATH = $temporaryRoot + ';' + $originalPath
    $env:XCODE_PROFILE_RECORDER = $recorderScript
    $env:XCODE_PROFILE_ARGV_LOG = $argvLog
    . $profileScript

    codex
    $zeroArguments = [string[]](Get-Content -Raw -LiteralPath $argvLog | ConvertFrom-Json)
    Assert-ProfileHarness (($zeroArguments -join '|') -eq 'session|run') "A zero-argument codex call crossed the .cmd boundary incorrectly: $($zeroArguments -join '|')"

    codex resume 'thread-123'
    $resumeArguments = [string[]](Get-Content -Raw -LiteralPath $argvLog | ConvertFrom-Json)
    Assert-ProfileHarness (($resumeArguments -join '|') -eq 'session|run|resume|thread-123') "Codex resume arguments crossed the .cmd boundary incorrectly: $($resumeArguments -join '|')"

    Write-Host 'CODEX_PROFILE_ENTRYPOINT=PASS'
}
finally {
    $env:PATH = $originalPath
    if ($null -eq $originalRecorder) { Remove-Item Env:\XCODE_PROFILE_RECORDER -ErrorAction SilentlyContinue }
    else { $env:XCODE_PROFILE_RECORDER = $originalRecorder }
    if ($null -eq $originalArgvLog) { Remove-Item Env:\XCODE_PROFILE_ARGV_LOG -ErrorAction SilentlyContinue }
    else { $env:XCODE_PROFILE_ARGV_LOG = $originalArgvLog }
    Remove-Item Function:\global:codex -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}
