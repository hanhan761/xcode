# Task Plan: Multi-Console Terminal Workspace

## Goal

Make one paired office laptop attach, without a desktop stream, to every discoverable terminal already open under the main PC's Windows user. The office `xcode` command must list and switch among those live sessions, then return keyboard input to the selected original terminal.

## Success criteria

- One main-PC broker discovers multiple existing consoles and detects a new console after it starts.
- The office command obtains the workspace catalog over the existing pinned SSH channel, lists the sessions, and can select one.
- Each selected session is the original process/console, not a new shell or Codex conversation.
- Switching sessions does not end host processes; `Ctrl+C` ends only the office attachment.
- The broker and per-console relays listen only on host loopback and require fresh tokens; daily use needs no UAC.
- The product does not claim to reproduce Windows Terminal/desktop pixel layout.

## Current phase

Phase 4: workflow, regression and release.

## Phases

### Phase 1: Discovery and attach proof

- [x] Write a red test for a target process that was not the broker's parent Console.
- [x] Prove `FreeConsole` + `AttachConsole(processId)` can read and write an isolated target Console.
- [x] Attach read-only to a real separate Windows Terminal/Codex process in the current user session.
- **Status:** complete

### Phase 2: Host broker module

- [x] Add a deep `WorkspaceCatalog` module with a simple state-file interface: active sessions, generation and per-session loopback relay metadata.
- [x] Start/stop one sidecar relay per discovered Console; deduplicate processes that share a Console.
- [x] Refresh the catalog and remove stale relays without touching host terminal processes.
- **Status:** complete

### Phase 3: Office workspace module

- [x] Replace single-session attachment with an interactive catalog selector and selected-session bridge.
- [x] Provide a non-conflicting key to return from an attachment to the catalog.
- [x] Refresh catalog on return so newly opened main-PC terminals become selectable.
- **Status:** complete

### Phase 4: Workflow, regression and release

- [x] Make main `xcode` start the broker once instead of sharing only its invoking Console.
- [x] Update README and remove the single-console claim.
- [x] Verify two isolated host Consoles, input routing, stale cleanup, PowerShell 5.1/7, Node syntax and package contents.
- [ ] Commit, push, then perform office-laptop end-to-end validation.
- **Status:** in_progress

## Design decisions

| Decision | Rationale |
|---|---|
| A broker owns discovery; a relay owns exactly one Console | `AttachConsole` permits a process to attach to only one Console, so sidecars are the correct seam. |
| State-file catalog is the broker's external interface | The existing SSH standard-I/O bridge can read it safely without new network listeners. |
| Office client shows a session selector, not desktop layout | The user requires normal terminal conversations, not pixel-level desktop remoting. |
| One active attachment at a time in the first workspace UI | It minimizes key-routing ambiguity while preserving all host terminals and switching. |
| Same user and integrity level only | Prevents silent cross-user/elevated-terminal capture and avoids daily UAC. |
