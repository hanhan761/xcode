# Task Plan: Happy-Inspired Secure Session Handoff

## Goal

Replace the unsafe Windows-console scraping broker with a Happy-inspired session model: the main PC explicitly registers controlled Codex sessions, the office laptop can observe and contribute to them with preserved context, and device/session permissions are narrow, observable and revocable.

## Success criteria

- A main-PC session is registered only by an explicit local action, never by global process scanning.
- The office laptop sees only explicitly granted sessions, observes their output, and can submit ordered messages to their conversation.
- Pairing no longer grants an unrestricted main-PC PowerShell shell merely to support session control.
- Session output and input remain tied to the original agent context; device handoff never creates a competing conversation.
- A reliable stop/revoke action removes all workers, state and live grants.
- The product does not claim to reproduce Windows Terminal/desktop pixel layout.

## Current phase

Phase 6: publish the single-window repair and complete real two-device acceptance.

## Containment status

- [x] Stopped the automatic console-scraping broker on the main PC.
- [x] Removed all discovered relay sidecars and the stale workspace state.
- [x] Remove the unsafe broker from the public `xcode` workflow before the next release.

## Phases

### Retired approach: console discovery and attach proof

- [x] Write a red test for a target process that was not the broker's parent Console.
- [x] Prove `FreeConsole` + `AttachConsole(processId)` can read and write an isolated target Console.
- [x] Attach read-only to a real separate Windows Terminal/Codex process in the current user session.
- **Status:** technically proven but rejected for product use: it is too broad, noisy and difficult to revoke safely.

### Retired approach: host broker module

- [x] Add a deep `WorkspaceCatalog` module with a simple state-file interface: active sessions, generation and per-session loopback relay metadata.
- [x] Start/stop one sidecar relay per discovered Console; deduplicate processes that share a Console.
- [x] Refresh the catalog and remove stale relays without touching host terminal processes.
- **Status:** rejected for product use. Forced broker shutdown also left relay sidecars alive; this is a release blocker.

### Retired approach: office workspace module

- [x] Replace single-session attachment with an interactive catalog selector and selected-session bridge.
- [x] Provide a non-conflicting key to return from an attachment to the catalog.
- [x] Refresh catalog on return so newly opened main-PC terminals become selectable.
- **Status:** rejected with the scanner because its catalog includes unrelated shells.

### Phase 1: Reference research and containment

- [x] Confirm that Happy's model wraps a named Codex/Claude session instead of scraping all Windows Consoles.
- [x] Stop the active scanner and clean its relay sidecars after the scope leak was observed.
- [x] Capture the specific Happy session, encryption and control-handoff boundaries needed for xcode.
- **Status:** complete

### Phase 2: Secure session protocol and UX

- [x] Determine whether stock app-server can safely provide live co-presence for an existing normal TUI.
- [x] Define `Session`, `DeviceGrant`, `InputArbiter` and `SessionRunner` interfaces.
- [x] Define explicit host actions: start/register, observe, send message, stop, revoke device.
- [x] Preserve the main-PC `codex` command with a local `CodexEntrypoint` and managed-session runner, rather than requiring `xcode codex`.
- [x] Replace unrestricted SSH with a forced-command application gateway.
- [x] Record the target `codex` / `xcode` contract, migration limit and module boundaries in `docs/codex-session-handoff.md`.
- **Status:** complete

### Phase 3: Implement a controlled-session vertical slice

- [x] Prove a managed Windows ConPTY child can deliver terminal output and lifecycle events without `AttachConsole` discovery.
- [x] Implement and exercise local collaborative message serialization in `SessionRunner`.
- [x] Execute the two-device acceptance run: `xcode main`, `xcode office`, main `codex`, office `xcode`.
- [x] Enforce collaborative input ordering and reliable cleanup.
- [ ] Complete the real-device review of message-origin visibility in the Codex TUI.
- [ ] Test reconnect, concurrent input serialization, stop/revoke and office-device compromise boundaries on the two real devices.
- **Status:** complete for basic two-device collaboration; final real-device stress testing remains follow-up work.

### Phase 4: Active-session lifecycle closure

- [x] Treat “active” as a verifiable invariant: a listed session must still have a live managed Codex child and a reachable local pipe.
- [x] Exclude and clean stale state files from the forced SSH gateway before the office laptop sees them.
- [x] Make the office selector clearly state that it lists only currently active main-PC conversations.
- [x] Add deterministic stale-state and forced-SSH interaction regression harnesses.
- [x] Prevent terminal navigation and cleared local input from indefinitely blocking an office message.
- [ ] Perform the updated two-device acceptance: office `xcode` observes `queued` then `delivered`, and no inactive session is selectable.
- **Status:** implementation complete; real-device acceptance pending update.

### Phase 5: Single-window office terminal surface

- [x] Parse the main-PC Codex terminal stream in a terminal model instead of writing raw control bytes into the office PowerShell.
- [x] Render a single current-window layout: mirrored session viewport, dedicated message composer and delivery state.
- [x] Keep message entry independent from the mirrored terminal, while preserving `queued → delivered` semantics.
- [x] Add deterministic terminal-model and office-surface interaction tests.
- **Status:** implementation complete (`OFFICE_TERMINAL_SURFACE=PASS`, `OFFICE_CLIENT_SINGLE_WINDOW=PASS`); real-device acceptance awaits package update.

### Phase 6: Publish and real-device acceptance

- [x] Push the repaired package to GitHub (`20230a3`).
- [x] Add a deterministic two-machine simulation that runs the office client through the real forced gateway into a managed main-PC PTY (`TWO_MACHINE_COLLABORATION_E2E=PASS`).
- [ ] Update both devices after closing active managed runners on the main PC.
- [ ] Confirm on the paired office laptop that a message visibly reaches `Delivered` and appears in the existing main Codex conversation.
- **Status:** in progress

## Design decisions

| Decision | Rationale |
|---|---|
| Explicit session registration, never global discovery | The observed scanner included 13 unrelated shells and made the permission scope unintelligible. |
| Session capability, not general SSH shell | Remote control should not imply arbitrary command execution as the main Windows user. |
| Collaborative input arbiter | Both devices observe one conversation, while complete messages are serialized so their keystrokes cannot corrupt each other. |
| Happy-style runner/wrapper for new sessions | It is the reliable way to preserve context and create an auditable remote-control boundary. |
| Explicit migration for existing sessions | Windows Console attach can be a best-effort import path, not a silent default. |
| Active-only office catalog | The office laptop reflects live managed sessions, not saved Codex history or orphaned state files. |
