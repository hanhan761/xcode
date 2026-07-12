# Findings and Decisions

## Environment

- Main PC: `LAPTOP-123L226P`, Windows 11 24H2 Home (build 26100).
- Main shell before installation: Windows PowerShell 5.1.
- Tailscale is online in tailnet `hanhan761.github`.
- Main Tailscale address before optional rename: `100.77.199.126`.
- Node 24, npm 11, .NET 10 and Git are available for future custom development.
- OpenSSH Server, PowerShell 7 and WezTerm are not currently installed on the main PC.

## Architecture

```text
Main WezTerm GUI ---------+
                          +-- host standalone mux -- PowerShell panes
Office WezTerm -- SSH ----+
                 over Tailscale
```

- Host `.wezterm.lua` places a standalone Unix mux domain first and makes the local GUI attach to it.
- Office WezTerm uses an SSH domain. Remote `wezterm cli --prefer-mux proxy` selects the host's first Unix domain.
- The same Windows account must own the host mux and the SSH login.
- Ordinary SSH is retained only as an emergency path; it does not preserve tabs or panes.

## Pairing

- Main PC opens TCP 43122 for ten minutes on the Tailscale adapter only.
- Office laptop generates a dedicated unencrypted Ed25519 key locally and submits only its public key plus the eight-digit code.
- Main PC uses `tailscale whois --json` to ensure the requester is owned by the same Tailscale user.
- Main PC displays the verified device identity and SSH fingerprint for local approval.
- Main PC restricts the key to the verified office Tailscale node addresses, stages it under a durable rollback journal, and returns its Ed25519 SSH host key with an HMAC proof.
- Office laptop pins that host key in an xcode-owned `known_hosts` file, verifies SSH and the host mux, performs one real WezTerm attach, and commits only after user confirmation.

## Security Constraints

- Never expose OpenSSH, WinRM or the pairing listener directly to the internet.
- Never store a reusable Tailscale auth key, SSH private key, Windows password or pairing code in Git.
- Disable Windows OpenSSH password authentication before accepting remote access.
- Restrict persistent TCP 22 firewall access to the active Tailscale adapter and Tailscale address ranges.
- Keep host-key changes fail-closed.
- Keep sshd stopped and its firewall rule disabled until a key is staged; a watchdog rolls back interrupted pre-commit pairings.
- Lost laptop response requires both Tailscale device revocation and removal of its SSH public key.

## Current Caveats

- WezTerm 20240203 or newer is required; both PCs must run the exact same build.
- Remote mux bootstrap uses an ACL-protected, no-space ProgramData wrapper rather than relying on a newly changed service PATH.
- The exact concurrent Windows-to-Windows shared-mux recipe is based on official docs/source but still needs a live two-PC test.
- WezTerm has no single-writer lease; two GUIs can type into the same pane.
- Host reboot or mux-server death loses shell memory and running panes.
- Tailscale authentication can expire independently of the long-lived SSH key.
- A sleeping host is unreachable without a separate Wake-on-LAN helper.

## Primary References

- https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse
- https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement
- https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration
- https://tailscale.com/docs/how-to/run-unattended
- https://tailscale.com/docs/reference/tailscale-cli
- https://wezterm.org/multiplexing.html
- https://wezterm.org/config/lua/SshDomain.html
