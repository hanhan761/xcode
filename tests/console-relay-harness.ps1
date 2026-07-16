[CmdletBinding()]
param(
    [string]$RelayScript = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $RelayScript) { $RelayScript = Join-Path (Split-Path -Parent (Split-Path -Parent $PSCommandPath)) 'scripts\console-relay-host.ps1' }

function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('xcode-relay-' + [Guid]::NewGuid().ToString('N'))
$statePath = Join-Path $temporaryRoot 'console-share.json'
$resultPath = Join-Path $temporaryRoot 'received.txt'
$parentErrorPath = Join-Path $temporaryRoot 'parent-error.txt'
$parentLogPath = Join-Path $temporaryRoot 'parent-log.txt'
$relayErrorPath = Join-Path $temporaryRoot 'relay-error.txt'
$relayDiagnosticPath = Join-Path $temporaryRoot 'relay-diagnostic.txt'
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null

$parentScript = @"
`$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllText('$($parentLogPath.Replace("'", "''"))', 'before child', [Text.Encoding]::UTF8)
`$relay = Start-Process -FilePath '$($windowsPowerShell.Replace("'", "''"))' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '$($RelayScript.Replace("'", "''"))', '-StatePath', '$($statePath.Replace("'", "''"))', '-DiagnosticPath', '$($relayDiagnosticPath.Replace("'", "''"))') -NoNewWindow -RedirectStandardError '$($relayErrorPath.Replace("'", "''"))' -PassThru
[IO.File]::AppendAllText('$($parentLogPath.Replace("'", "''"))', "`nchild: `$(`$relay.Id)", [Text.Encoding]::UTF8)
try {
    `$line = [Console]::ReadLine()
    [IO.File]::WriteAllText('$($resultPath.Replace("'", "''"))', `$line, [Text.Encoding]::UTF8)
}
catch {
    [IO.File]::WriteAllText('$($parentErrorPath.Replace("'", "''"))', (`$_ | Out-String), [Text.Encoding]::UTF8)
    exit 1
}
finally {
    if (-not `$relay.HasExited) { Stop-Process -Id `$relay.Id -Force -ErrorAction SilentlyContinue }
}
"@
$encodedParent = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($parentScript))
$parent = $null
try {
    $parent = Start-Process -FilePath $windowsPowerShell -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedParent) -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 100
    } while (-not (Test-Path -LiteralPath $statePath -PathType Leaf) -and -not $parent.HasExited -and (Get-Date) -lt $deadline)
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        $diagnostic = @(
            if (Test-Path -LiteralPath $parentErrorPath -PathType Leaf) { Get-Content -Raw -LiteralPath $parentErrorPath }
            if (Test-Path -LiteralPath $parentLogPath -PathType Leaf) { Get-Content -Raw -LiteralPath $parentLogPath }
            if (Test-Path -LiteralPath $relayErrorPath -PathType Leaf) { Get-Content -Raw -LiteralPath $relayErrorPath }
            "parent exit $($parent.ExitCode)"
        ) -join "`n"
        throw "The isolated console relay did not create its state file. $diagnostic"
    }

    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    $tcp = [Net.Sockets.TcpClient]::new('127.0.0.1', [int]$state.port)
    try {
        $stream = $tcp.GetStream()
        $writer = [IO.StreamWriter]::new($stream, (New-Object Text.UTF8Encoding($false)), 4096, $true)
        $writer.AutoFlush = $true
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $false, 4096, $true)
        $writer.WriteLine((@{ token = [string]$state.token } | ConvertTo-Json -Compress))
        $ready = $reader.ReadLine() | ConvertFrom-Json
        Assert ([string]$ready.type -eq 'ready') 'The isolated console relay rejected its loopback client.'
        $marker = 'XCODE_RELAY_INPUT_OK'
        $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('XCODE_RELAY_INPUT_BAD'))
        $writer.WriteLine((@{ type = 'input'; data = $payload } | ConvertTo-Json -Compress))
        Start-Sleep -Milliseconds 250
        1..3 | ForEach-Object {
            try { $writer.WriteLine((@{ type = 'key'; virtualKeyCode = 8; unicodeCharacter = 8 } | ConvertTo-Json -Compress)) }
            catch {
                $diagnostic = if (Test-Path -LiteralPath $relayDiagnosticPath -PathType Leaf) { Get-Content -Raw -LiteralPath $relayDiagnosticPath } else { 'no relay diagnostic' }
                throw "The relay closed while injecting a virtual key. $diagnostic"
            }
            Start-Sleep -Milliseconds 250
        }
        $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('OK'))
        $writer.WriteLine((@{ type = 'input'; data = $payload } | ConvertTo-Json -Compress))
        Start-Sleep -Milliseconds 250
        $writer.WriteLine((@{ type = 'key'; virtualKeyCode = 13; unicodeCharacter = 13 } | ConvertTo-Json -Compress))
        $deadline = (Get-Date).AddSeconds(10)
        do {
            Start-Sleep -Milliseconds 100
        } while (-not (Test-Path -LiteralPath $resultPath -PathType Leaf) -and -not $parent.HasExited -and (Get-Date) -lt $deadline)
        Assert (Test-Path -LiteralPath $resultPath -PathType Leaf) 'The relay did not deliver input to its owning console.'
        Assert ((Get-Content -Raw -LiteralPath $resultPath).Trim() -eq $marker) 'The relay delivered unexpected console input.'
    }
    finally {
        if ($tcp) { $tcp.Dispose() }
    }
    Write-Host 'CONSOLE_RELAY_INPUT=PASS' -ForegroundColor Green
}
finally {
    if ($parent -and -not $parent.HasExited) { Stop-Process -Id $parent.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
