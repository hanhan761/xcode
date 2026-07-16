# Findings and Decisions

## User intent

- One main PC has many simultaneously open PowerShell/Codex terminals.
- The office laptop must acquire all of them in one action, then select a terminal and continue its original conversation.
- No remote desktop or pixel-perfect window/layout replication is required.
- The main PC workflow must not require manually sharing each terminal.

## Platform facts

- The completed single-console relay can read `CONOUT$` and write `CONIN$` when it is launched in the target Console.
- Windows `AttachConsole(processId)` lets a helper attach to a specified process's Console, but one helper can attach to only one Console. A broker therefore needs one worker per Console. [Microsoft AttachConsole](https://learn.microsoft.com/en-us/windows/console/attachconsole)
- A pseudoconsole does not expose a normal visible Console window handle, so the broker must identify sessions from processes/Console attachment rather than window geometry. [Microsoft GetConsoleWindow](https://learn.microsoft.com/en-us/windows/console/getconsolewindow)
- Existing SSH keys prohibit TCP forwarding. The prior standard-I/O bridge remains the transport and needs no policy change.
- The new isolated harness passed `FreeConsole` + `AttachConsole` against a non-parent hidden PowerShell target, including its input round trip.
- A read-only probe also attached to a real separate Windows Terminal-hosted Codex process in this Windows session and returned a 280×73 snapshot. Process-based discovery therefore covers the user's primary Windows Terminal/Codex workflow.

## Proposed module seams

| Module | Interface | Implementation responsibility |
|---|---|---|
| WorkspaceCatalog | JSON state file with session IDs, titles, worker ports and tokens | discovery, deduplication, worker lifecycle and stale cleanup |
| ConsoleRelay | `-TargetProcessId` plus loopback protocol | attach to exactly one original Console, snapshot output and inject input |
| OfficeWorkspace | catalog select / selected bridge / return to catalog | render session list and establish one SSH standard-I/O bridge at a time |

## Implemented behavior

- The broker discovers shell roots rather than `conhost.exe` renderer processes. It prioritizes newly opened shells and removes stale worker state when the original shell exits.
- Main `xcode` starts the broker once, in the background. It discovers already-open and later-open PowerShell/Codex terminal sessions without a per-window share command.
- Office `xcode` gets the catalog through the existing pinned SSH standard-I/O transport, selects one original session, and uses `Ctrl+G` to return to a refreshed selector. `Ctrl+C` only disconnects the office client.

## Known limits

- A terminal-only selector can present all sessions, but does not reproduce Windows Terminal tabs, pane geometry, mouse controls or colors.
- Elevated or other-user Console targets must be reported as unavailable rather than silently captured.
