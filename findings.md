# Findings and Decisions

## Confirmed behavior

- The old main command opened `wezterm connect xcode-shared-mux`, which created or attached to a different workspace and could not reach an already running Codex conversation.
- The current Codex conversation is terminal-based and shares a Windows Console with its PowerShell/Node/Codex processes.
- A process started in that Console can read its existing screen buffer through `CONOUT$`.
- An isolated hidden-console harness proved that the relay can write text, Enter and Backspace to the owning console through `CONIN$` without making a new shell.
- A direct `xcode share` dispatcher test returned a real current-console snapshot at 280×73 without writing input to the live Codex conversation.

## Architecture

- Main `xcode share` starts a child relay in the selected existing Console.
- The relay listens only at `127.0.0.1` on a random port and writes a state file containing a fresh 32-byte token.
- Office `xcode` retrieves that state through the existing pinned SSH connection, then starts an SSH standard-I/O bridge to the host loopback relay. No `ssh -L` forwarding is used.
- The office terminal renders the snapshots in its alternate screen and sends text plus common navigation keys back to the relay.

## Security decisions

- Pairing remains one-time, local-approval based and bound to the same Tailscale account/device source addresses.
- SSH retains password-login prohibition, pinned host keys, agent/X11/TCP-forwarding restrictions and the office dedicated Ed25519 key.
- The relay is never reachable from the tailnet directly; the short-lived token guards its loopback protocol.

## Remaining validation

- The isolated harness proves same-console behavior locally.
- A final office-laptop end-to-end test is still required after both machines update, because the office machine is not available inside this workspace.
