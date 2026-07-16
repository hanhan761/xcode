[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$StatePath,
    [string]$RelayScript = (Join-Path $PSScriptRoot 'console-relay-host.ps1'),
    [string]$DiagnosticPath = '',
    [ValidateRange(250, 10000)][int]$ScanIntervalMilliseconds = 1000
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'XcodeRemote.Common.ps1')

if (-not (Test-Path -LiteralPath $RelayScript -PathType Leaf)) { throw "The console relay worker is missing: $RelayScript" }
$stateDirectory = Split-Path -Parent $StatePath
if (-not (Test-Path -LiteralPath $stateDirectory)) { New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null }
$workerDirectory = Join-Path $stateDirectory 'console-workers'
if (-not (Test-Path -LiteralPath $workerDirectory)) { New-Item -ItemType Directory -Path $workerDirectory -Force | Out-Null }
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$brokerProcessId = $PID
$brokerSessionId = (Get-Process -Id $PID).SessionId
$workers = @{}
$generation = 0

function Write-XcodeBrokerDiagnostic {
    param([Parameter(Mandatory = $true)][string]$Message)

    if (-not $DiagnosticPath) { return }
    try {
        [IO.File]::AppendAllText($DiagnosticPath, "$(Get-Date -Format o) $Message`r`n", [Text.Encoding]::UTF8)
    }
    catch {}
}

function Test-XcodeProcessAlive {
    param([int]$ProcessId)
    return @(Get-Process -Id $ProcessId -ErrorAction SilentlyContinue).Count -eq 1
}

function Get-XcodeConsoleCandidates {
    # A shell owns the conversation. conhost.exe is only its renderer and creates
    # a large amount of duplicate/noise candidates on a Windows Terminal desktop.
    $terminalNames = @('powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe', 'wsl.exe')
    return @(Get-CimInstance Win32_Process | Where-Object {
        $_.SessionId -eq $brokerSessionId -and
        $terminalNames -contains $_.Name.ToLowerInvariant() -and
        $_.ProcessId -ne $brokerProcessId -and
        $_.CommandLine -notmatch '(?i)console-relay-host\.ps1|console-workspace-broker\.ps1'
    # A workspace that has just been opened is the useful thing to expose first.
    # This also prevents long-lived helper shells from starving new terminals while
    # their console attachment is being checked.
    } | Sort-Object @{ Expression = {
        try {
            $creationDate = $_.CreationDate
            if ($creationDate -is [DateTime]) { return [DateTime]$creationDate }
            return [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$creationDate)
        }
        catch { [DateTime]::MinValue }
    }; Descending = $true }, ProcessId)
}

function Get-XcodeManagedRelayProcessIds {
    return @(Get-CimInstance Win32_Process | Where-Object {
        $_.SessionId -eq $brokerSessionId -and $_.CommandLine -match '(?i)console-relay-host\.ps1'
    } | ForEach-Object { [int]$_.ProcessId })
}

function Remove-XcodeWorker {
    param([Parameter(Mandatory = $true)][object]$Worker)

    if ($Worker.WorkerProcessId -and (Test-XcodeProcessAlive -ProcessId ([int]$Worker.WorkerProcessId))) {
        Stop-Process -Id ([int]$Worker.WorkerProcessId) -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $Worker.StatePath -Force -ErrorAction SilentlyContinue
}

function Start-XcodeWorker {
    param([Parameter(Mandatory = $true)][object]$Candidate)

    $workerStatePath = Join-Path $workerDirectory ("relay-$($Candidate.ProcessId)-$([Guid]::NewGuid().ToString('N')).json")
    $process = Start-Process -FilePath $windowsPowerShell -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $RelayScript,
        '-StatePath', $workerStatePath, '-TargetProcessId', ([string]$Candidate.ProcessId)
    ) -WindowStyle Hidden -PassThru
    return [pscustomobject]@{
        TargetProcessId = [int]$Candidate.ProcessId
        TargetName = [string]$Candidate.Name
        WorkerProcessId = [int]$process.Id
        StatePath = $workerStatePath
        StartedAt = Get-Date
        SessionId = ''
        RelayState = $null
        SourceProcessIds = @()
    }
}

function Resolve-XcodeWorkers {
    $managedRelayIds = Get-XcodeManagedRelayProcessIds
    foreach ($key in @($workers.Keys)) {
        $worker = $workers[$key]
        if (-not (Test-XcodeProcessAlive -ProcessId $worker.TargetProcessId) -or -not (Test-XcodeProcessAlive -ProcessId $worker.WorkerProcessId)) {
            Remove-XcodeWorker -Worker $worker
            $workers.Remove($key)
            continue
        }
        if (-not (Test-Path -LiteralPath $worker.StatePath -PathType Leaf)) {
            if (((Get-Date) - $worker.StartedAt).TotalSeconds -gt 5) {
                Remove-XcodeWorker -Worker $worker
                $workers.Remove($key)
            }
            continue
        }
        try {
            $relayState = Get-Content -Raw -LiteralPath $worker.StatePath | ConvertFrom-Json
            if ([int]$relayState.targetProcessId -ne $worker.TargetProcessId -or -not $relayState.port -or -not $relayState.token) { throw 'Invalid worker state.' }
            $sourceProcessIds = @($relayState.consoleProcessIds | ForEach-Object { [int]$_ } | Where-Object { $_ -notin $managedRelayIds } | Sort-Object -Unique)
            if ($sourceProcessIds.Count -eq 0) { $sourceProcessIds = @($worker.TargetProcessId) }
            $sessionId = 'console-' + ($sourceProcessIds -join '-')
            $duplicate = @($workers.Values | Where-Object { $_.SessionId -eq $sessionId -and $_.WorkerProcessId -ne $worker.WorkerProcessId }) | Select-Object -First 1
            if ($duplicate) {
                Remove-XcodeWorker -Worker $worker
                $workers.Remove($key)
                continue
            }
            $worker.SessionId = $sessionId
            $worker.RelayState = $relayState
            $worker.SourceProcessIds = $sourceProcessIds
        }
        catch {
            Remove-XcodeWorker -Worker $worker
            $workers.Remove($key)
        }
    }
}

function Start-XcodeCandidateWorkers {
    param([int]$MaximumStarts = 4)

    $assignedTargetIds = @($workers.Values | ForEach-Object { [int]$_.TargetProcessId })
    $started = 0
    $candidates = @(Get-XcodeConsoleCandidates)
    Write-XcodeBrokerDiagnostic ("candidates=" + (($candidates | Select-Object -First 12 | ForEach-Object { "$($_.ProcessId):$($_.Name)" }) -join ',') + ";count=$($candidates.Count)")
    foreach ($candidate in $candidates) {
        if ($started -ge $MaximumStarts) { break }
        if ([int]$candidate.ProcessId -in $assignedTargetIds) { continue }
        $alreadyKnown = @($workers.Values | Where-Object { [int]$candidate.ProcessId -in $_.SourceProcessIds }) | Select-Object -First 1
        if ($alreadyKnown) { continue }
        $worker = Start-XcodeWorker -Candidate $candidate
        $workers[('pending-' + $worker.WorkerProcessId)] = $worker
        Write-XcodeBrokerDiagnostic "started worker=$($worker.WorkerProcessId) target=$($worker.TargetProcessId)"
        $assignedTargetIds += $worker.TargetProcessId
        $started++
    }
}

function Write-XcodeWorkspaceState {
    $sessions = @($workers.Values | Where-Object { $_.SessionId -and $_.RelayState } | Sort-Object SessionId | ForEach-Object {
        [ordered]@{
            sessionId = $_.SessionId
            targetProcessId = $_.TargetProcessId
            targetName = $_.TargetName
            workerProcessId = $_.WorkerProcessId
            consoleProcessIds = $_.SourceProcessIds
            title = [string]$_.RelayState.consoleTitle
            port = [int]$_.RelayState.port
            token = [string]$_.RelayState.token
            startedAt = [string]$_.RelayState.startedAt
        }
    })
    $generation++
    $state = [ordered]@{
        schemaVersion = 1
        brokerProcessId = $brokerProcessId
        generation = $generation
        updatedAt = (Get-Date).ToUniversalTime().ToString('o')
        sessions = $sessions
    }
    Write-XcodeUtf8File -Path $StatePath -Content ($state | ConvertTo-Json -Depth 8)
}

try {
    while ($true) {
        Write-XcodeBrokerDiagnostic "loop generation=$generation workers=$($workers.Count)"
        Resolve-XcodeWorkers
        Write-XcodeWorkspaceState
        Start-XcodeCandidateWorkers -MaximumStarts 4
        Resolve-XcodeWorkers
        Write-XcodeWorkspaceState
        Start-Sleep -Milliseconds $ScanIntervalMilliseconds
    }
}
finally {
    foreach ($worker in @($workers.Values)) { Remove-XcodeWorker -Worker $worker }
    if (Test-Path -LiteralPath $StatePath -PathType Leaf) {
        try {
            $state = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
            if ([int]$state.brokerProcessId -eq $brokerProcessId) { Remove-Item -LiteralPath $StatePath -Force }
        }
        catch {}
    }
}
