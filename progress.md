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
- Published to `origin/main` as `ea894c7 feat: share multi-console terminal workspace`.

### Security correction: 2026-07-16

- A real main-PC run exposed 13 same-user PowerShell/CMD sessions, including unrelated tooling terminals. This invalidated the automatic full-user-session discovery UX and permission model.
- Stopping the broker with forced process termination did not invoke its cleanup block. Historical test runs had left 129 `console-relay-host.ps1` sidecars. All discovered xcode relay sidecars, broker state and workspace state were stopped/removed before continuing.
- The user requested Happy / Happy Coder as the design reference. Research confirmed its wrapper-and-named-session direction; the current console scanner has been retired as a product approach pending a secure session-protocol replacement.
- Reference research captured Happy's CLI/remote-app/encrypted-relay split, QR-established device secret, per-session keys and controller handoff. The architecture now preserves the user's `codex` command through a local entrypoint while rejecting imports of arbitrary existing Windows Consoles.
- `codex remote-control start --json` was tested on the installed Windows Codex CLI 0.144.5 and failed deterministically: `codex app-server daemon lifecycle is only supported on Unix platforms`. The Windows design must use the direct loopback app-server interface instead of remote-control daemon commands.
- First direct app-server health probe did not reach Codex because `Get-Command codex` resolved to npm's `codex.ps1`, which `Start-Process` cannot execute as a Win32 application. The probe must use the native `codex.exe` or `.cmd` launcher; do not interpret this as an app-server failure.
- The corrected probe showed that direct app-server works on Windows: native Codex listened only on `127.0.0.1:57821`. Starting through `codex.cmd` hid the native child process from lifecycle tracking, and its temporary token file had already been removed. Both identified probe processes (`node.exe` and its `codex.exe` child) were stopped; a follow-up listener check confirmed cleanup. Future probes and production code must launch the native executable directly.
- Read the current upstream app-server protocol and peer-client co-presence RFC. The protocol supports saved-thread resume and history, but the RFC reports no reliable stock live event fan-out between an existing normal TUI and a peer. Captured the consequent product boundary and migration story in `docs/codex-session-handoff.md`: preserve the visible `codex` command through an entrypoint, use `xcode` only as a session-scoped remote client, and never capture arbitrary existing Consoles.
- Evaluated `node-pty@1.1.0` as the Windows `SessionRunner` substrate. A first temporary probe exceeded its useful time window and was cleaned up with no remaining processes; a cleanup-script retry initially collided with PowerShell's read-only `$PID` variable and was corrected. The final bounded probe passed: bundled x64 ConPTY spawned a test child, emitted `PTY_READY` with terminal escape sequences, and returned exit code 23. No test files or processes remain outside the repository.
- The user refined the interaction model: xcode is an observing collaborator that may contribute to the same Codex conversation, not a device that takes over the terminal. Updated the architecture and plan from `ControlLease` to `InputArbiter`: output fans out to both devices, while complete office messages are serialized with local input to prevent byte-level interleaving.
- Added the first `SessionRunner` module using the verified Windows ConPTY dependency and an integration harness. `MANAGED_SESSION_COLLABORATION=PASS` proves a main-PC message and an office-originated complete message reach one PTY child in order. The Windows node-pty compatibility handles can outlive an exited test child, so the bounded harness explicitly exits once it has verified the child ended; production runner shutdown will likewise own explicit process termination.
- Implemented the session vertical slice: `node-pty` runs only explicitly launched Codex children; each runner writes a private state file and serves a randomly named local Windows named pipe with a per-session capability token. The forced `session-gateway.js` can only probe, list active managed sessions, and bridge one authorized attachment; `session-client.js` renders snapshots/output and turns office keyboard input into whole ordered messages.
- Added `xcode main` and `xcode office` as the setup flow. Main setup installs a reversible PowerShell `codex` entrypoint and writes a protected gateway launcher. Pairing now writes an SSH `command=` restriction and main setup migrates existing xcode-managed keys to that restriction. The old global Console scanner, relay client and its harnesses were removed from the package.
- Final regression passed: PowerShell parser/security verification, the managed PTY collaboration harness, JavaScript syntax checks, npm package dry run and whitespace validation. A gateway attachment now sends its initial scrollback exactly once, then only future output.
- Recovery-launcher repair: `powershell -File` parses a bare `--` as an ambiguous empty parameter. The first managed-session profile and recovery command used `session run -- resume …`, so recovery failed before xcode dispatched. The npm and repository launchers now strip that legacy separator safely, new profile/recovery calls omit it, and a regression probe proves the old spelling reaches the dispatcher without the ambiguity. The global npm installation on this main PC was updated and passed the same probe.
- Role-recovery repair: a laptop that had a stale `host-user.json` plus valid office state was classified as the main PC because the old role lookup gave the host marker precedence. The office marker now wins, `xcode office` removes conflicting user-level main-role/profile residue, and a fixed mixed-state fixture proves the office role is selected.
- Update-lock repair: Windows keeps `node-pty`'s ConPTY DLL locked while a managed Codex runner is active. `xcode update` now detects those runners before it invokes npm and gives a safe close/save/retry instruction rather than surfacing npm's `EBUSY` copy failure. The guard was exercised against four real active managed sessions without launching npm.
- Two-device basic acceptance succeeded: the office laptop completed pinned SSH verification and reached the desired xcode connection flow. The next user-requested refinement is lifecycle closure: office selection must expose only conversations whose main-PC managed session is still live, never inactive saved history or orphaned state files.
- Active-session closure implemented: SessionRunner now publishes a process id and becomes listable only after its named pipe is ready. The forced gateway verifies both a live child and a reachable pipe, removes stale records, and the office selector labels its catalog as current active sessions only. `ACTIVE_SESSION_CATALOG=PASS` proves a live record stays while a dead record is cleaned.
- Interaction visibility implemented: the gateway acknowledges `queued` before input arbitration and `delivered` only after writing to the managed terminal; the office client renders both. `SSH_GATEWAY_INTERACTION=PASS` proves the complete forced-gateway path queues, delivers and reaches the main PTY child without touching a real user conversation.
- Input-arbiter repair: the old character-only tracker mistook ANSI arrow/history sequences and cleared drafts for unsubmitted text, leaving office messages permanently queued. The parser now treats terminal control sequences, backspace/delete, Ctrl+C and Ctrl+U correctly. `INPUT_ARBITER_RELEASE=PASS` proves both an arrow key and a fully deleted local draft release a remote message.
