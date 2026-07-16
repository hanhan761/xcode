# Task Plan: Existing Console Attachment

## Goal

Replace the new-terminal-workspace model with a terminal-only relay that lets an office laptop intervene in a PowerShell/Codex CLI session already running on the controlled host.

## Current Phase

Phase 4: real two-machine confirmation.

## Phases

### Phase 1: Reproduce the attachment-model mismatch

- [x] Add a deterministic regression assertion for the old mux attachment.
- [x] Run it red: `The xcode dispatcher cannot share the current host terminal.`
- [x] Make it green with `xcode share` / office `xcode` relay commands.
- **Status:** complete

### Phase 2: Console relay feasibility probe

- [x] Read an existing Codex console via `CONOUT$` without changing it.
- [x] Prove loopback snapshots and console input injection in an isolated hidden console.
- [x] Validate text, Enter and Backspace input events.
- **Status:** complete

### Phase 3: Implement the no-GUI relay workflow

- [x] Start a same-console relay sidecar through `xcode share`.
- [x] Render snapshots and return terminal keys through office `xcode`.
- [x] Use the existing key-only SSH channel as a byte bridge, without SSH port forwarding or a new listener.
- [x] Remove legacy WezTerm setup, pairing checks, configuration replacement and GUI confirmation.
- **Status:** complete

### Phase 4: Verification and release

- [x] Run Windows PowerShell 5.1, PowerShell 7, Node syntax, package-content and isolated-console harness checks.
- [x] Verify the dispatcher starts a current-console relay and returns a live snapshot.
- [ ] Run one office-laptop attachment to the main PC after both machines update.
- [x] Commit and push the corrected implementation (`e3ef973`).
- **Status:** in_progress

## Decisions

| Decision | Rationale |
|---|---|
| Share one selected existing Windows Console | It matches the current Codex/PowerShell process instead of starting a second conversation. |
| Keep a loopback-only relay with a fresh token per share | No desktop stream and no new Tailscale/public listener are needed. |
| Reuse SSH standard I/O as the bridge | Existing authorized keys deliberately prohibit TCP forwarding; standard I/O preserves that policy. |
| Remove WezTerm from setup and pairing | The relay must not modify terminal-emulator configuration or create a new workspace. |
| Keep one active target for now | Selecting a particular existing console is honest and safe; multi-console selection needs a separate state model. |
