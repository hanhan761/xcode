# Progress Log

## Session: 2026-07-16

### Multi-console correction

- The user clarified that the single-console relay is insufficient: one office attachment must expose every live main-PC terminal and allow normal conversation in each.
- Reframed the product as a terminal-only multi-console workspace, not remote desktop and not a pixel-layout clone.
- Selected a broker + one-relay-per-Console design because Windows allows each helper to attach to at most one Console.
- Previous single-console release remains a validated relay primitive but is no longer the intended daily workflow.
- `NON_PARENT_CONSOLE_RELAY=PASS`: an isolated non-parent target received text and Enter through an attached relay.
- `LIVE_WINDOWS_TERMINAL_ATTACH=PASS`: a separate real Windows Terminal/Codex Console attached read-only and produced a live 280×73 snapshot.

### Next verification

- Build an isolated two-Console reproduction before changing public commands.
- Validate a helper can attach to a non-parent Console and preserve the original process/input path.

### Error log

- The new non-parent-console harness is deterministically red because `console-relay-host.ps1` has no `-TargetProcessId` interface yet. This is the intended pre-implementation failure.
- First attach implementation used `GetConsoleProcessList(null, 0)`, which Windows rejects with error 87. Replaced it with a bounded buffer and resize retry.
- The new two-console workspace harness is deterministically red because `console-workspace-broker.ps1` has not been implemented yet.
- First broker harness attempt discovered both sessions but closed each loopback connection immediately after Enter; workers may observe disconnect before processing the final key. The harness now keeps the connection alive briefly and asserts missing target results explicitly.
- The expanded lifecycle harness found stale-session cleanup failed because an empty PowerShell process result was tested with a null comparison. `Test-XcodeProcessAlive` now uses an explicit result count.
- Second lifecycle run reached the new-terminal phase but indexed an absent session before asserting discovery. The harness now asserts the collection count before indexing, preserving the actual broker diagnostic on a failure.
- Initial sessions pass but a dynamically opened target was absent from the catalog. Added captured broker output/exit diagnostics to distinguish scanner omission from a broker crash.
- Captured diagnostics showed the broker stayed alive but had not written a catalog during a large startup scan. It now writes an empty/partial catalog before worker launches and limits each scan to four new workers.
- A subsequent run still starved new targets: Windows Terminal leaves many `conhost.exe` renderer processes, which are not conversation roots. The scanner now ignores them, scans actual shell processes only, and prioritizes the newest terminal. `MULTI_CONSOLE_WORKSPACE=PASS` now proves two existing consoles, one later console, per-console input routing, and stale cleanup.

### Completed implementation and regression

- `console-relay-host.ps1` now accepts `-TargetProcessId`, detaches from its own Console and attaches to exactly one existing target Console before opening `CONOUT$` / `CONIN$`.
- `console-workspace-broker.ps1` is the deep catalog module: it discovers same-user shell roots, starts one loopback relay worker per Console, de-duplicates shared Console membership, writes an atomic catalog, and removes its workers when original terminal processes exit.
- Main-PC `xcode` now starts this background broker once; it no longer requires a command in every target terminal.
- Office `xcode` reads the catalog over the existing pinned SSH connection, lets the user select a terminal, and uses `Ctrl+G` to return and refresh the selector. `Ctrl+C` disconnects only the office view.
- Passing regressions: `tests/verify.ps1` on Windows PowerShell 5.1 and PowerShell 7, `CONSOLE_RELAY_INPUT=PASS`, `NON_PARENT_CONSOLE_RELAY=PASS`, `MULTI_CONSOLE_WORKSPACE=PASS`, Node syntax check, dispatcher help, and `npm pack --dry-run` for `xcode-remote@1.2.0`.
