# Remote Existing-Console Context

This project attaches an authorized Windows office laptop to one PowerShell or Codex CLI console that is already running on a Windows main PC.

## Language

**Controlled host**:
The Windows main PC that owns the existing console and its processes.
_Avoid_: server, remote computer, slave

**Control machine**:
An authorized office laptop that renders and controls the host-owned console.
_Avoid_: client when referring to the device itself

**Shared console**:
One existing Windows Console selected by running `xcode share` inside it. The relay reads its screen and writes input to the same console; it does not create a shell or adopt a different process.
_Avoid_: workspace, mux, new session

**Relay sidecar**:
A child PowerShell process attached to the shared console. It listens only on the host loopback interface and owns the short-lived token.

**Attachment**:
One temporary terminal-only office connection. Losing it does not end the shared console or its current Codex/PowerShell process.

**Pairing window**:
A short-lived, one-use host listener that registers one verified control-machine public key after local approval.
_Avoid_: login server, permanent registration endpoint
