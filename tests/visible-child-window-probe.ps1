[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutputPath,
    [int]$DurationSeconds = 8
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;

public static class XcodeVisibleWindowProbe {
    public delegate bool EnumWindowsProc(IntPtr window, IntPtr state);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr window, StringBuilder title, int capacity);

    public static List<string> Snapshot() {
        var windows = new List<string>();
        EnumWindows((window, state) => {
            if (!IsWindowVisible(window)) return true;
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            var title = new StringBuilder(GetWindowTextLength(window) + 1);
            GetWindowText(window, title, title.Capacity);
            windows.Add(window.ToInt64() + "|" + processId + "|" + title.ToString());
            return true;
        }, IntPtr.Zero);
        return windows;
    }
}
'@

$baseline = [System.Collections.Generic.HashSet[string]]::new()
foreach ($entry in [XcodeVisibleWindowProbe]::Snapshot()) {
    [void]$baseline.Add(($entry -split '\|', 2)[0])
}

$observed = @{}
$startedProcesses = [System.Collections.Generic.List[object]]::new()
$baselineProcesses = [System.Collections.Generic.HashSet[int]]::new()
foreach ($processInfo in @(Get-CimInstance Win32_Process)) {
    [void]$baselineProcesses.Add([int]$processInfo.ProcessId)
}
$seenProcesses = [System.Collections.Generic.HashSet[int]]::new()
$deadline = [DateTime]::UtcNow.AddSeconds($DurationSeconds)
while ([DateTime]::UtcNow -lt $deadline) {
    foreach ($processInfo in @(Get-CimInstance Win32_Process)) {
        $processId = [int]$processInfo.ProcessId
        if (-not $baselineProcesses.Contains($processId) -and $seenProcesses.Add($processId)) {
            $startedProcesses.Add([ordered]@{
                processId = $processId
                parentProcessId = [int]$processInfo.ParentProcessId
                processName = [string]$processInfo.Name
                commandLine = [string]$processInfo.CommandLine
                observedAt = [DateTime]::UtcNow.ToString('o')
            })
        }
    }

    foreach ($entry in [XcodeVisibleWindowProbe]::Snapshot()) {
        $parts = $entry -split '\|', 3
        $handle = $parts[0]
        if ($baseline.Contains($handle)) { continue }
        if ($observed.ContainsKey($handle)) {
            $currentTitle = $parts[2]
            $record = $observed[$handle]
            if ($record.title -ne $currentTitle) {
                $record.title = $currentTitle
                $record.titleHistory += @([ordered]@{
                    title = $currentTitle
                    observedAt = [DateTime]::UtcNow.ToString('o')
                })
            }
            continue
        }

        $processId = [int]$parts[1]
        $processName = '<exited>'
        $parentProcessId = 0
        $commandLine = ''
        try { $processName = [Diagnostics.Process]::GetProcessById($processId).ProcessName }
        catch { }
        if ($processName -notmatch '^(?i:powershell|pwsh|OpenConsole|conhost|WindowsTerminal)$') { continue }
        try {
            $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
            $parentProcessId = [int]$processInfo.ParentProcessId
            $commandLine = [string]$processInfo.CommandLine
        }
        catch { }

        $observed[$handle] = [ordered]@{
            handle = $handle
            processId = $processId
            processName = $processName
            parentProcessId = $parentProcessId
            commandLine = $commandLine
            title = $parts[2]
            observedAt = [DateTime]::UtcNow.ToString('o')
            titleHistory = @([ordered]@{
                title = $parts[2]
                observedAt = [DateTime]::UtcNow.ToString('o')
            })
        }
    }
    Start-Sleep -Milliseconds 8
}

$result = [ordered]@{
    passed = ($observed.Count -eq 0)
    visibleChildWindows = @($observed.Values)
    startedProcesses = @($startedProcesses)
}
[IO.File]::WriteAllText($OutputPath, ($result | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
