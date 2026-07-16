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

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('xcode-relay-attach-' + [Guid]::NewGuid().ToString('N'))
$statePath = Join-Path $temporaryRoot 'console-share.json'
$resultPath = Join-Path $temporaryRoot 'target-result.txt'
$targetErrorPath = Join-Path $temporaryRoot 'target-error.txt'
$relayErrorPath = Join-Path $temporaryRoot 'relay-error.txt'
$relayOutputPath = Join-Path $temporaryRoot 'relay-output.txt'
$relayDiagnosticPath = Join-Path $temporaryRoot 'relay-diagnostic.txt'
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null

$targetScript = @"
`$ErrorActionPreference = 'Stop'
try {
    `$line = [Console]::ReadLine()
    [IO.File]::WriteAllText('$($resultPath.Replace("'", "''"))', `$line, [Text.Encoding]::UTF8)
}
catch {
    [IO.File]::WriteAllText('$($targetErrorPath.Replace("'", "''"))', (`$_ | Out-String), [Text.Encoding]::UTF8)
    exit 1
}
"@
$encodedTarget = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($targetScript))
$target = $null
$relay = $null
try {
    $target = Start-Process -FilePath $windowsPowerShell -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedTarget) -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 500
    Assert (-not $target.HasExited) 'The isolated target Console did not stay alive for attachment.'

    $relay = Start-Process -FilePath $windowsPowerShell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $RelayScript, '-StatePath', $statePath, '-TargetProcessId', ([string]$target.Id), '-DiagnosticPath', $relayDiagnosticPath) -WindowStyle Hidden -RedirectStandardOutput $relayOutputPath -RedirectStandardError $relayErrorPath -PassThru
    $deadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 100
    } while (-not (Test-Path -LiteralPath $statePath -PathType Leaf) -and -not $relay.HasExited -and (Get-Date) -lt $deadline)
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        $errorText = @(
            if (Test-Path -LiteralPath $relayErrorPath -PathType Leaf) { Get-Content -Raw -LiteralPath $relayErrorPath }
            if (Test-Path -LiteralPath $relayOutputPath -PathType Leaf) { Get-Content -Raw -LiteralPath $relayOutputPath }
            if (Test-Path -LiteralPath $relayDiagnosticPath -PathType Leaf) { Get-Content -Raw -LiteralPath $relayDiagnosticPath }
            "relay exit $($relay.ExitCode)"
        ) -join "`n"
        throw "The non-parent Console could not be attached. $errorText"
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
        $snapshot = $reader.ReadLine() | ConvertFrom-Json
        Assert ([string]$ready.type -eq 'ready') 'The attached Console relay rejected its loopback client.'
        Assert ([string]$snapshot.type -eq 'snapshot') 'The attached Console relay did not return a screen snapshot.'

        $marker = 'XCODE_ATTACHED_CONSOLE_OK'
        $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($marker))
        $writer.WriteLine((@{ type = 'input'; data = $payload } | ConvertTo-Json -Compress))
        Start-Sleep -Milliseconds 250
        $writer.WriteLine((@{ type = 'key'; virtualKeyCode = 13; unicodeCharacter = 13 } | ConvertTo-Json -Compress))
        $deadline = (Get-Date).AddSeconds(10)
        do {
            Start-Sleep -Milliseconds 100
        } while (-not (Test-Path -LiteralPath $resultPath -PathType Leaf) -and -not $target.HasExited -and (Get-Date) -lt $deadline)
        Assert (Test-Path -LiteralPath $resultPath -PathType Leaf) 'The attached Console did not receive its input.'
        Assert ((Get-Content -Raw -LiteralPath $resultPath).Trim() -eq $marker) 'The attached Console received unexpected input.'
    }
    finally {
        if ($tcp) { $tcp.Dispose() }
    }
    Write-Host 'NON_PARENT_CONSOLE_RELAY=PASS' -ForegroundColor Green
}
finally {
    if ($relay -and -not $relay.HasExited) { Stop-Process -Id $relay.Id -Force -ErrorAction SilentlyContinue }
    if ($target -and -not $target.HasExited) { Stop-Process -Id $target.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
