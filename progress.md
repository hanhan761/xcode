# Progress Log

## Session: 2026-07-12

### Completed

- Inspected the main PC and verified current Tailscale status.
- Compared ordinary SSH, a custom ConPTY web terminal and WezTerm multiplexing.
- Selected a desktop-first Windows-to-Windows architecture.
- Created one-click main/office CMD entry points.
- Implemented an authenticated one-time pairing protocol with Tailscale identity verification, HMAC proof, fingerprint comparison, local approval, durable journal, and crash watchdog.
- Implemented source-node-restricted key-only OpenSSH, host-key pinning, exact ACLs, Tailscale-only listener binding and fail-closed firewall rules.
- Implemented host and office WezTerm configurations plus the `xcode` launcher.
- Added `xcode doctor` and emergency `xcode ssh` modes.
- Initialized Git branch `main`, committed the reviewed implementation, and pushed it to the requested GitHub origin.

### Verification Results

| Check | Result |
|---|---|
| PowerShell parser over all scripts | pass |
| `install-main.ps1 -DryRun` | pass |
| `install-office.ps1 -DryRun` | pass |
| Pair-code format/randomness | pass |
| Ed25519 key validation, option parsing and SHA256 fingerprinting | pass |
| Atomic overwrite under Windows PowerShell 5.1 | pass |
| Three independent blocker reviews | pass; no deterministic release blockers remain |
| CMD entry-point presence | pass |
| Repository reusable-credential scan | pass |
| Git commit and GitHub push | pass; `main` tracks `origin/main` |
| Real office-laptop pairing | pending |
| Shared mux detach/reconnect | pending |

### Files Added

- `install-main.cmd`
- `install-office.cmd`
- `pair-office.cmd`
- `scripts/XcodeRemote.Common.ps1`
- `scripts/install-main.ps1`
- `scripts/install-main-machine.ps1`
- `scripts/install-office.ps1`
- `scripts/install-office-machine.ps1`
- `scripts/pair-office.ps1`
- `scripts/pairing-watchdog.ps1`
- `scripts/unpair-office.ps1`
- `unpair-office.cmd`
- `tests/verify.ps1`
- `README.md`
- `.gitignore`

### Current Status

Implementation and static review are complete, committed, and pushed. No installer has been executed against the main PC yet; system configuration remains unchanged.
