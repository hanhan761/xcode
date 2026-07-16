[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$StatePath,
    [string]$DiagnosticPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'XcodeRemote.Common.ps1')

if (-not ('XcodeConsoleRelayNative' -as [type])) {
    $source = @'
using System;
using System.Runtime.InteropServices;

public sealed class XcodeConsoleRelaySnapshot {
    public int Width;
    public int Height;
    public int CursorX;
    public int CursorY;
    public string Rows;
}

public static class XcodeConsoleRelayNative {
    [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
    [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct CONSOLE_SCREEN_BUFFER_INFO { public COORD Size; public COORD Cursor; public ushort Attributes; public SMALL_RECT Window; public COORD MaximumWindowSize; }
    [StructLayout(LayoutKind.Sequential)] public struct CHAR_INFO { public ushort UnicodeChar; public ushort Attributes; }
    [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode)] public struct KEY_EVENT_RECORD {
        [FieldOffset(0)] public int KeyDown;
        [FieldOffset(4)] public ushort RepeatCount;
        [FieldOffset(6)] public ushort VirtualKeyCode;
        [FieldOffset(8)] public ushort VirtualScanCode;
        [FieldOffset(10)] public char UnicodeChar;
        [FieldOffset(12)] public uint ControlKeyState;
    }
    [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode)] public struct INPUT_RECORD {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
    }

    [DllImport("Kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("Kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
    [DllImport("Kernel32.dll", SetLastError=true)] public static extern bool GetConsoleScreenBufferInfo(IntPtr handle, out CONSOLE_SCREEN_BUFFER_INFO info);
    [DllImport("Kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool ReadConsoleOutputW(IntPtr handle, [Out] CHAR_INFO[] buffer, COORD bufferSize, COORD bufferCoord, ref SMALL_RECT region);
    [DllImport("Kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool WriteConsoleInputW(IntPtr handle, INPUT_RECORD[] buffer, uint length, out uint written);

    static IntPtr Open(string name, uint access) {
        IntPtr handle = CreateFile(name, access, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (handle.ToInt64() == -1) throw new InvalidOperationException(name + " unavailable: " + Marshal.GetLastWin32Error());
        return handle;
    }

    public static XcodeConsoleRelaySnapshot Snapshot() {
        IntPtr handle = Open("CONOUT$", 0x80000000);
        try {
            CONSOLE_SCREEN_BUFFER_INFO info;
            if (!GetConsoleScreenBufferInfo(handle, out info)) throw new InvalidOperationException("GetConsoleScreenBufferInfo failed: " + Marshal.GetLastWin32Error());
            int width = Math.Max(1, info.Window.Right - info.Window.Left + 1);
            int height = Math.Max(1, info.Window.Bottom - info.Window.Top + 1);
            CHAR_INFO[] cells = new CHAR_INFO[width * height];
            SMALL_RECT region = new SMALL_RECT { Left = info.Window.Left, Top = info.Window.Top, Right = info.Window.Right, Bottom = info.Window.Bottom };
            if (!ReadConsoleOutputW(handle, cells, new COORD { X = (short)width, Y = (short)height }, new COORD(), ref region)) throw new InvalidOperationException("ReadConsoleOutputW failed: " + Marshal.GetLastWin32Error());
            char[] output = new char[cells.Length + height - 1];
            int cursor = 0;
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    char c = (char)cells[y * width + x].UnicodeChar;
                    output[cursor++] = c == '\0' ? ' ' : c;
                }
                if (y + 1 < height) output[cursor++] = '\n';
            }
            return new XcodeConsoleRelaySnapshot {
                Width = width, Height = height,
                CursorX = Math.Max(0, info.Cursor.X - info.Window.Left), CursorY = Math.Max(0, info.Cursor.Y - info.Window.Top),
                Rows = new string(output)
            };
        } finally { CloseHandle(handle); }
    }

    public static void WriteText(string text) {
        if (String.IsNullOrEmpty(text)) return;
        IntPtr handle = Open("CONIN$", 0x40000000);
        try {
            INPUT_RECORD[] records = new INPUT_RECORD[text.Length * 2];
            int index = 0;
            foreach (char c in text) {
                records[index++].EventType = 1;
                records[index - 1].KeyEvent = new KEY_EVENT_RECORD { KeyDown = 1, RepeatCount = 1, UnicodeChar = c };
                records[index++].EventType = 1;
                records[index - 1].KeyEvent = new KEY_EVENT_RECORD { KeyDown = 0, RepeatCount = 1, UnicodeChar = c };
            }
            uint written;
            if (!WriteConsoleInputW(handle, records, (uint)records.Length, out written) || written != records.Length) throw new InvalidOperationException("WriteConsoleInputW failed: " + Marshal.GetLastWin32Error());
        } finally { CloseHandle(handle); }
    }

    public static void WriteVirtualKey(ushort virtualKeyCode, char unicodeChar, uint controlKeyState) {
        IntPtr handle = Open("CONIN$", 0x40000000);
        try {
            INPUT_RECORD[] records = new INPUT_RECORD[2];
            records[0].EventType = 1;
            records[0].KeyEvent = new KEY_EVENT_RECORD { KeyDown = 1, RepeatCount = 1, VirtualKeyCode = virtualKeyCode, UnicodeChar = unicodeChar, ControlKeyState = controlKeyState };
            records[1].EventType = 1;
            records[1].KeyEvent = new KEY_EVENT_RECORD { KeyDown = 0, RepeatCount = 1, VirtualKeyCode = virtualKeyCode, UnicodeChar = unicodeChar, ControlKeyState = controlKeyState };
            uint written;
            if (!WriteConsoleInputW(handle, records, (uint)records.Length, out written) || written != records.Length) throw new InvalidOperationException("WriteConsoleInputW failed: " + Marshal.GetLastWin32Error());
        } finally { CloseHandle(handle); }
    }
}
'@
    Add-Type -TypeDefinition $source
}

function New-XcodeRelayToken {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) }
    finally { $rng.Dispose() }
    return ([Convert]::ToBase64String($bytes))
}

function Send-XcodeRelayMessage {
    param([Parameter(Mandatory = $true)][IO.StreamWriter]$Writer, [Parameter(Mandatory = $true)][object]$Message)
    $Writer.WriteLine(($Message | ConvertTo-Json -Compress -Depth 4))
    $Writer.Flush()
}

function Write-XcodeRelayDiagnostic {
    param([Parameter(Mandatory = $true)][object]$ErrorRecord)
    if (-not $DiagnosticPath) { return }
    try {
        [IO.File]::AppendAllText($DiagnosticPath, ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $ErrorRecord.Exception.ToString() + [Environment]::NewLine), [Text.Encoding]::UTF8)
    }
    catch {}
}

$token = New-XcodeRelayToken
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$state = [ordered]@{
    schemaVersion = 1
    port = $port
    token = $token
    agentProcessId = $PID
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
}
Write-XcodeUtf8File -Path $StatePath -Content ($state | ConvertTo-Json -Depth 4)

$client = $null
$reader = $null
$writer = $null
$lastSnapshot = $null
try {
    while ($true) {
        if ($listener.Pending()) {
            if ($client) { $client.Dispose() }
            $client = $listener.AcceptTcpClient()
            $client.ReceiveTimeout = 3000
            $stream = $client.GetStream()
            $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $false, 4096, $true)
            $writer = [IO.StreamWriter]::new($stream, (New-Object Text.UTF8Encoding($false)), 4096, $true)
            $writer.AutoFlush = $true
            try {
                $hello = $reader.ReadLine() | ConvertFrom-Json
                if ([string]$hello.token -ne $token) { throw 'Invalid relay token.' }
                $client.ReceiveTimeout = 0
                Send-XcodeRelayMessage -Writer $writer -Message @{ type = 'ready' }
                $lastSnapshot = $null
            }
            catch {
                Write-XcodeRelayDiagnostic -ErrorRecord $_
                try { $client.Dispose() } catch {}
                $client = $null; $reader = $null; $writer = $null
            }
        }

        if ($client -and $client.Connected) {
            try {
                while ($client.Available -gt 0) {
                    $message = $reader.ReadLine()
                    if (-not $message) { throw 'Relay client disconnected.' }
                    $request = $message | ConvertFrom-Json
                    if ([string]$request.type -eq 'input' -and [string]$request.data) {
                        [XcodeConsoleRelayNative]::WriteText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$request.data)))
                    }
                    elseif ([string]$request.type -eq 'key' -and $request.PSObject.Properties['virtualKeyCode']) {
                        $character = if ($request.PSObject.Properties['unicodeCharacter']) { [char][int]$request.unicodeCharacter } else { [char]0 }
                        $control = if ($request.PSObject.Properties['controlKeyState']) { [uint32]$request.controlKeyState } else { [uint32]0 }
                        [XcodeConsoleRelayNative]::WriteVirtualKey([uint16]$request.virtualKeyCode, $character, $control)
                    }
                }
                $snapshot = [XcodeConsoleRelayNative]::Snapshot()
                $snapshotIdentity = "$($snapshot.CursorX):$($snapshot.CursorY):$($snapshot.Rows)"
                if ($snapshotIdentity -ne $lastSnapshot) {
                    Send-XcodeRelayMessage -Writer $writer -Message @{ type = 'snapshot'; width = $snapshot.Width; height = $snapshot.Height; cursorX = $snapshot.CursorX; cursorY = $snapshot.CursorY; rows = $snapshot.Rows }
                    $lastSnapshot = $snapshotIdentity
                }
            }
            catch {
                Write-XcodeRelayDiagnostic -ErrorRecord $_
                try { $client.Dispose() } catch {}
                $client = $null; $reader = $null; $writer = $null
            }
        }
        Start-Sleep -Milliseconds 100
    }
}
finally {
    if ($listener) { $listener.Stop() }
    if (Test-Path -LiteralPath $StatePath) {
        try {
            $existing = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
            if ([string]$existing.token -eq $token) { Remove-Item -LiteralPath $StatePath -Force }
        }
        catch {}
    }
}
