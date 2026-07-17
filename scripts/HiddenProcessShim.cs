using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class HiddenProcessShim
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        int creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int WaitForSingleObject(IntPtr handle, int milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out int exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static string Quote(string value)
    {
        if (value.Length == 0) return "\"\"";
        if (value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '\"' }) < 0) return value;
        var result = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '\"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('\"');
            }
            else
            {
                result.Append('\\', backslashes);
                result.Append(character);
            }
            backslashes = 0;
        }
        result.Append('\\', backslashes * 2);
        result.Append('\"');
        return result.ToString();
    }

    public static int Main(string[] args)
    {
        const int STARTF_USESTDHANDLES = 0x00000100;
        const int CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        const int CREATE_NO_WINDOW = 0x08000000;
        const int STD_INPUT_HANDLE = -10;
        const int STD_OUTPUT_HANDLE = -11;
        const int STD_ERROR_HANDLE = -12;
        const int INFINITE = unchecked((int)0xFFFFFFFF);

        var shimName = Path.GetFileNameWithoutExtension(Process.GetCurrentProcess().MainModule.FileName);
        var targetVariable = String.Equals(shimName, "pwsh", StringComparison.OrdinalIgnoreCase)
            ? "XCODE_REAL_PWSH"
            : String.Equals(shimName, "codex-code-mode-host", StringComparison.OrdinalIgnoreCase)
                ? "XCODE_REAL_CODE_MODE_HOST"
                : null;
        if (targetVariable == null) return 126;
        var target = Environment.GetEnvironmentVariable(targetVariable);
        if (String.IsNullOrWhiteSpace(target)) return 126;

        var commandLine = new StringBuilder(Quote(target));
        foreach (var argument in args) commandLine.Append(' ').Append(Quote(argument));
        var startup = new STARTUPINFO
        {
            cb = Marshal.SizeOf(typeof(STARTUPINFO)),
            dwFlags = STARTF_USESTDHANDLES,
            hStdInput = GetStdHandle(STD_INPUT_HANDLE),
            hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE),
            hStdError = GetStdHandle(STD_ERROR_HANDLE),
        };
        PROCESS_INFORMATION process;
        if (!CreateProcessW(target, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, IntPtr.Zero, Environment.CurrentDirectory,
                ref startup, out process))
        {
            return Marshal.GetLastWin32Error();
        }
        try
        {
            WaitForSingleObject(process.hProcess, INFINITE);
            int exitCode;
            return GetExitCodeProcess(process.hProcess, out exitCode) ? exitCode : 1;
        }
        finally
        {
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
        }
    }
}
