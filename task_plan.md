# Task Plan: Xcode Remote PowerShell

## Goal

Deliver an idempotent two-PC installer so a Windows office laptop can run `xcode` to attach to persistent PowerShell tabs and panes hosted on a Windows main PC.

## Current Phase

Phase 5: repository delivery.

## Phases

### Phase 1: Requirements and discovery

- [x] Confirm both machines are Windows.
- [x] Confirm office laptop is the primary remote controller; phone is out of MVP scope.
- [x] Inspect the main PC: Windows 11 24H2 Home, Tailscale installed, no OpenSSH Server, no PowerShell 7, no WezTerm.
- [x] Define persistence and multi-pane semantics.
- **Status:** complete

### Phase 2: Architecture and security baseline

- [x] Select Tailscale + Windows OpenSSH + WezTerm SSH multiplexing.
- [x] Keep SSH and pairing ports off the public/LAN interfaces.
- [x] Select public-key-only SSH and pinned host keys.
- [x] Design a one-use Tailscale-identity-aware pairing window.
- **Status:** complete

### Phase 3: Implementation

- [x] Add one-click CMD entry points for the main PC and office laptop.
- [x] Add package, Tailscale, OpenSSH, firewall and WezTerm configuration scripts.
- [x] Install the user-level `xcode` launcher.
- [x] Add diagnostics and documentation.
- **Status:** complete

### Phase 4: Verification and review

- [x] Parse every PowerShell script.
- [x] Run installer dry-run paths.
- [x] Test pairing-code generation, Ed25519 parsing/fingerprinting and credential hygiene.
- [x] Resolve all findings from three independent reviews.
- [ ] Run the real two-Windows end-to-end pairing and mux reattachment test.
- **Status:** static review complete; real two-PC test pending

### Phase 5: Delivery

- [ ] Commit the reviewed implementation (in progress).
- [ ] Push to `https://github.com/hanhan761/xcode.git`.
- [ ] Run `install-main.cmd`, then hand off `install-office.cmd` to the office laptop.
- **Status:** pending

## Success Criteria

1. Main installer configures Tailscale unattended mode, OpenSSH key-only access and a shared WezTerm mux without exposing TCP 22 outside Tailscale.
2. Office installer performs one Tailscale login and one local-approved pairing; the private SSH key never leaves the office laptop.
3. A new office-laptop PowerShell can run `xcode` and attach to the main PC mux.
4. Network disconnect and safe GUI detach preserve panes; main-PC reboot is documented as destructive to runtime state.
5. Changed SSH host keys fail closed and no password fallback exists.

## Decisions

| Decision | Rationale |
|---|---|
| Use standard OpenSSH over Tailscale | Tailscale SSH server does not support Windows targets. |
| Use WezTerm mux before custom code | It already owns panes, tabs, reconnectable process lifetime and Windows ConPTY. |
| Pair with a short-lived Tailscale-only listener | Avoids sending or scripting the main Windows password. |
| Pin host keys during pairing | Prevents silent trust-on-first-use replacement. |
| Keep phone outside MVP | Office-laptop workflow is the user's priority. |

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| Workspace was not initially a Git repository | 1 | Initialized `main` and added the requested origin. |
| `apply_patch` intermittently could not update existing files under the Windows sandbox | multiple | Recreated only agent-owned files; never rewrote user files with shell tricks. |
| First smoke test used `.Count` on an empty pipeline under StrictMode | 1 | Wrapped the pipeline in `@(...)`. |
| Sandbox user temp directory caused `ssh-keygen` bad-file-descriptor | 1 | Verification uses the approved `C:\tmp` temp root in this environment. |
