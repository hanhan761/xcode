[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutputPath,
    [int]$DurationSeconds = 8
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading;
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

public sealed class XcodeWindowEventRecord {
    public string eventName { get; set; }
    public long handle { get; set; }
    public int processId { get; set; }
    public string processName { get; set; }
    public string windowClass { get; set; }
    public string title { get; set; }
    public bool visible { get; set; }
    public string observedAt { get; set; }
}

public static class XcodeWindowEventProbe {
    private const uint EVENT_OBJECT_CREATE = 0x8000;
    private const uint EVENT_OBJECT_DESTROY = 0x8001;
    private const uint EVENT_OBJECT_SHOW = 0x8002;
    private const uint EVENT_OBJECT_HIDE = 0x8003;
    private const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    private const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
    private const uint WM_QUIT = 0x0012;
    private const int OBJID_WINDOW = 0;

    private delegate void WinEventDelegate(
        IntPtr hook,
        uint eventType,
        IntPtr window,
        int objectId,
        int childId,
        uint eventThread,
        uint eventTime);

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message {
        public IntPtr window;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public Point point;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr SetWinEventHook(
        uint eventMin,
        uint eventMax,
        IntPtr eventHookModule,
        WinEventDelegate callback,
        uint processId,
        uint threadId,
        uint flags);

    [DllImport("user32.dll")]
    private static extern bool UnhookWinEvent(IntPtr hook);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);

    [DllImport("user32.dll")]
    private static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder title, int capacity);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder className, int capacity);

    private static readonly ConcurrentQueue<XcodeWindowEventRecord> Events =
        new ConcurrentQueue<XcodeWindowEventRecord>();
    private static readonly ManualResetEventSlim Ready = new ManualResetEventSlim(false);
    private static Thread thread;
    private static uint threadId;
    private static IntPtr hook;
    private static WinEventDelegate callback;

    public static void Start() {
        if (thread != null) throw new InvalidOperationException("The window event probe is already running.");
        XcodeWindowEventRecord discarded;
        while (Events.TryDequeue(out discarded)) { }
        Ready.Reset();
        thread = new Thread(Run);
        thread.IsBackground = true;
        thread.Name = "xcode-window-event-probe";
        thread.Start();
        if (!Ready.Wait(TimeSpan.FromSeconds(5))) {
            throw new TimeoutException("The window event probe did not start.");
        }
        if (hook == IntPtr.Zero) {
            throw new InvalidOperationException("SetWinEventHook failed.");
        }
    }

    public static XcodeWindowEventRecord[] Stop() {
        var activeThread = thread;
        if (activeThread != null) {
            PostThreadMessage(threadId, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
            activeThread.Join(TimeSpan.FromSeconds(5));
        }
        thread = null;
        var records = new List<XcodeWindowEventRecord>();
        XcodeWindowEventRecord record;
        while (Events.TryDequeue(out record)) records.Add(record);
        return records.ToArray();
    }

    private static void Run() {
        threadId = GetCurrentThreadId();
        callback = OnWindowEvent;
        hook = SetWinEventHook(
            EVENT_OBJECT_CREATE,
            EVENT_OBJECT_HIDE,
            IntPtr.Zero,
            callback,
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        Ready.Set();
        Message message;
        while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { }
        if (hook != IntPtr.Zero) UnhookWinEvent(hook);
        hook = IntPtr.Zero;
        callback = null;
    }

    private static void OnWindowEvent(
        IntPtr ignoredHook,
        uint eventType,
        IntPtr window,
        int objectId,
        int childId,
        uint ignoredThread,
        uint ignoredTime) {
        if (window == IntPtr.Zero || objectId != OBJID_WINDOW || childId != 0) return;
        uint rawProcessId;
        GetWindowThreadProcessId(window, out rawProcessId);
        string processName = "<exited>";
        try { processName = Process.GetProcessById((int)rawProcessId).ProcessName; }
        catch { }
        var title = new StringBuilder(Math.Max(1, GetWindowTextLength(window) + 1));
        GetWindowText(window, title, title.Capacity);
        var className = new StringBuilder(256);
        GetClassName(window, className, className.Capacity);
        Events.Enqueue(new XcodeWindowEventRecord {
            eventName = EventName(eventType),
            handle = window.ToInt64(),
            processId = (int)rawProcessId,
            processName = processName,
            windowClass = className.ToString(),
            title = title.ToString(),
            visible = IsWindowVisible(window),
            observedAt = DateTime.UtcNow.ToString("o")
        });
    }

    private static string EventName(uint eventType) {
        switch (eventType) {
            case EVENT_OBJECT_CREATE: return "create";
            case EVENT_OBJECT_DESTROY: return "destroy";
            case EVENT_OBJECT_SHOW: return "show";
            case EVENT_OBJECT_HIDE: return "hide";
            default: return "0x" + eventType.ToString("x");
        }
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
[XcodeWindowEventProbe]::Start()
$windowEvents = @()
try {
    $nextProcessSnapshot = [DateTime]::UtcNow
    while ([DateTime]::UtcNow -lt $deadline) {
        if ([DateTime]::UtcNow -ge $nextProcessSnapshot) {
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
            $nextProcessSnapshot = [DateTime]::UtcNow.AddMilliseconds(100)
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
}
finally {
    $windowEvents = @([XcodeWindowEventProbe]::Stop())
}

$consoleWindowEvents = @(
    $windowEvents | Where-Object {
        $_.processName -match '^(?i:powershell|pwsh|OpenConsole|conhost|WindowsTerminal|codex|codex-code-mode-host|codex-computer-use)$'
    }
)
$visibleShowEvents = @(
    $consoleWindowEvents | Where-Object { $_.eventName -eq 'show' -and $_.visible }
)

$result = [ordered]@{
    passed = ($observed.Count -eq 0 -and $visibleShowEvents.Count -eq 0)
    visibleChildWindows = @($observed.Values)
    windowEvents = $consoleWindowEvents
    startedProcesses = @($startedProcesses)
}
[IO.File]::WriteAllText($OutputPath, ($result | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
