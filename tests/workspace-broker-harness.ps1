[CmdletBinding()]
param(
    [string]$BrokerScript = '',
    [string]$RelayScript = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
if (-not $BrokerScript) { $BrokerScript = Join-Path $root 'scripts\console-workspace-broker.ps1' }
if (-not $RelayScript) { $RelayScript = Join-Path $root 'scripts\console-relay-host.ps1' }

function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Start-XcodeHarnessTarget {
    param([Parameter(Mandatory = $true)][string]$ResultPath)

    $script = @"
`$ErrorActionPreference = 'Stop'
`$line = [Console]::ReadLine()
[IO.File]::WriteAllText('$($ResultPath.Replace("'", "''"))', `$line, [Text.Encoding]::UTF8)
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    return Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) -WindowStyle Hidden -PassThru
}

function Send-XcodeHarnessInput {
    param([Parameter(Mandatory = $true)][object]$Session, [Parameter(Mandatory = $true)][string]$Text)

    $tcp = [Net.Sockets.TcpClient]::new('127.0.0.1', [int]$Session.port)
    try {
        $stream = $tcp.GetStream()
        $writer = [IO.StreamWriter]::new($stream, (New-Object Text.UTF8Encoding($false)), 4096, $true)
        $writer.AutoFlush = $true
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $false, 4096, $true)
        $writer.WriteLine((@{ token = [string]$Session.token } | ConvertTo-Json -Compress))
        $ready = $reader.ReadLine() | ConvertFrom-Json
        $snapshot = $reader.ReadLine() | ConvertFrom-Json
        Assert ([string]$ready.type -eq 'ready' -and [string]$snapshot.type -eq 'snapshot') 'A broker worker did not expose a valid relay protocol.'
        $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text))
        $writer.WriteLine((@{ type = 'input'; data = $payload } | ConvertTo-Json -Compress))
        Start-Sleep -Milliseconds 200
        $writer.WriteLine((@{ type = 'key'; virtualKeyCode = 13; unicodeCharacter = 13 } | ConvertTo-Json -Compress))
        Start-Sleep -Milliseconds 300
    }
    finally {
        if ($tcp) { $tcp.Dispose() }
    }
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('xcode-workspace-' + [Guid]::NewGuid().ToString('N'))
$statePath = Join-Path $temporaryRoot 'workspace.json'
$firstResult = Join-Path $temporaryRoot 'first.txt'
$secondResult = Join-Path $temporaryRoot 'second.txt'
$thirdResult = Join-Path $temporaryRoot 'third.txt'
$brokerErrorPath = Join-Path $temporaryRoot 'broker-error.txt'
$brokerOutputPath = Join-Path $temporaryRoot 'broker-output.txt'
$brokerDiagnosticPath = Join-Path $temporaryRoot 'broker-diagnostic.txt'
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
$first = $null
$second = $null
$third = $null
$broker = $null
try {
    $first = Start-XcodeHarnessTarget -ResultPath $firstResult
    $second = Start-XcodeHarnessTarget -ResultPath $secondResult
    Start-Sleep -Milliseconds 500
    Assert (-not $first.HasExited -and -not $second.HasExited) 'The isolated workspace targets did not stay alive.'

    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $broker = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $BrokerScript, '-StatePath', $statePath, '-RelayScript', $RelayScript, '-DiagnosticPath', $brokerDiagnosticPath) -WindowStyle Hidden -RedirectStandardOutput $brokerOutputPath -RedirectStandardError $brokerErrorPath -PassThru
    $deadline = (Get-Date).AddSeconds(20)
    $workspace = $null
    do {
        if (Test-Path -LiteralPath $statePath -PathType Leaf) {
            $workspace = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
            $targetIds = @($workspace.sessions | ForEach-Object { [int]$_.targetProcessId })
            if ($targetIds -contains $first.Id -and $targetIds -contains $second.Id) { break }
        }
        Start-Sleep -Milliseconds 150
    } while (-not $broker.HasExited -and (Get-Date) -lt $deadline)

    if (-not $workspace) {
        $diagnostic = @(
            "brokerExited=$($broker.HasExited);exitCode=$($broker.ExitCode)"
            if (Test-Path -LiteralPath $brokerErrorPath -PathType Leaf) { Get-Content -Raw -LiteralPath $brokerErrorPath }
            if (Test-Path -LiteralPath $brokerOutputPath -PathType Leaf) { Get-Content -Raw -LiteralPath $brokerOutputPath }
            if (Test-Path -LiteralPath $brokerDiagnosticPath -PathType Leaf) { Get-Content -Raw -LiteralPath $brokerDiagnosticPath }
        ) -join "`n"
        throw "The workspace broker did not write a catalog. $diagnostic"
    }
    $targetIds = @($workspace.sessions | ForEach-Object { [int]$_.targetProcessId })
    if ($targetIds -notcontains $first.Id -or $targetIds -notcontains $second.Id) {
        $diagnostic = @(
            "brokerExited=$($broker.HasExited);exitCode=$($broker.ExitCode)"
            "expected=$($first.Id),$($second.Id);actual=$($targetIds -join ',')"
            "workspace=$($workspace | ConvertTo-Json -Depth 8 -Compress)"
            if (Test-Path -LiteralPath $brokerErrorPath -PathType Leaf) { Get-Content -Raw -LiteralPath $brokerErrorPath }
            if (Test-Path -LiteralPath $brokerOutputPath -PathType Leaf) { Get-Content -Raw -LiteralPath $brokerOutputPath }
            if (Test-Path -LiteralPath $brokerDiagnosticPath -PathType Leaf) { Get-Content -Raw -LiteralPath $brokerDiagnosticPath }
        ) -join "`n"
        throw "The workspace broker did not discover both independent Consoles. $diagnostic"
    }
    $firstSession = @($workspace.sessions | Where-Object { [int]$_.targetProcessId -eq $first.Id })[0]
    $secondSession = @($workspace.sessions | Where-Object { [int]$_.targetProcessId -eq $second.Id })[0]

    $third = Start-XcodeHarnessTarget -ResultPath $thirdResult
    $deadline = (Get-Date).AddSeconds(15)
    do {
        $workspace = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        if (@($workspace.sessions | ForEach-Object { [int]$_.targetProcessId }) -contains $third.Id) { break }
        Start-Sleep -Milliseconds 150
    } while (-not $broker.HasExited -and (Get-Date) -lt $deadline)
    $thirdSessions = @($workspace.sessions | Where-Object { [int]$_.targetProcessId -eq $third.Id })
    if ($thirdSessions.Count -ne 1) {
        $diagnostic = @(
            "brokerExited=$($broker.HasExited);exitCode=$($broker.ExitCode)"
            if (Test-Path -LiteralPath $brokerErrorPath -PathType Leaf) { Get-Content -Raw -LiteralPath $brokerErrorPath }
            if (Test-Path -LiteralPath $brokerOutputPath -PathType Leaf) { Get-Content -Raw -LiteralPath $brokerOutputPath }
            if (Test-Path -LiteralPath $brokerDiagnosticPath -PathType Leaf) { Get-Content -Raw -LiteralPath $brokerDiagnosticPath }
        ) -join "`n"
        throw "The workspace broker did not discover a terminal opened after it started. $diagnostic"
    }
    $thirdSession = $thirdSessions[0]

    Send-XcodeHarnessInput -Session $firstSession -Text 'XCODE_WORKSPACE_FIRST'
    Send-XcodeHarnessInput -Session $secondSession -Text 'XCODE_WORKSPACE_SECOND'
    Send-XcodeHarnessInput -Session $thirdSession -Text 'XCODE_WORKSPACE_THIRD'
    $deadline = (Get-Date).AddSeconds(10)
    do { Start-Sleep -Milliseconds 100 } while ((-not (Test-Path -LiteralPath $firstResult) -or -not (Test-Path -LiteralPath $secondResult) -or -not (Test-Path -LiteralPath $thirdResult)) -and (Get-Date) -lt $deadline)
    Assert ((Test-Path -LiteralPath $firstResult) -and (Test-Path -LiteralPath $secondResult) -and (Test-Path -LiteralPath $thirdResult)) 'The broker workers did not deliver input to every target Console.'
    Assert ((Get-Content -Raw -LiteralPath $firstResult).Trim() -eq 'XCODE_WORKSPACE_FIRST') 'The first workspace terminal did not receive its own input.'
    Assert ((Get-Content -Raw -LiteralPath $secondResult).Trim() -eq 'XCODE_WORKSPACE_SECOND') 'The second workspace terminal did not receive its own input.'
    Assert ((Get-Content -Raw -LiteralPath $thirdResult).Trim() -eq 'XCODE_WORKSPACE_THIRD') 'The third workspace terminal did not receive its own input.'
    $deadline = (Get-Date).AddSeconds(10)
    do {
        $workspace = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        if (@($workspace.sessions | ForEach-Object { [int]$_.targetProcessId }) -notcontains $third.Id) { break }
        Start-Sleep -Milliseconds 150
    } while ((Get-Date) -lt $deadline)
    Assert (@($workspace.sessions | ForEach-Object { [int]$_.targetProcessId }) -notcontains $third.Id) 'The broker did not remove a terminal after its original process exited.'
    Write-Host 'MULTI_CONSOLE_WORKSPACE=PASS' -ForegroundColor Green
}
finally {
    if ($broker -and -not $broker.HasExited) { Stop-Process -Id $broker.Id -Force -ErrorAction SilentlyContinue }
    if ($first -and -not $first.HasExited) { Stop-Process -Id $first.Id -Force -ErrorAction SilentlyContinue }
    if ($second -and -not $second.HasExited) { Stop-Process -Id $second.Id -Force -ErrorAction SilentlyContinue }
    if ($third -and -not $third.HasExited) { Stop-Process -Id $third.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
