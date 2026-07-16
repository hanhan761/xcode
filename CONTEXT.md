# Remote Existing-Console Context

This project attaches an authorized Windows office laptop to the existing PowerShell and Codex CLI terminal workspace on a Windows main PC.

## Language

**Controlled host**:
The Windows main PC that owns the existing console and its processes.
_Avoid_: server, remote computer, slave

**Control machine**:
An authorized office laptop that renders and controls the host-owned console.
_Avoid_: client when referring to the device itself

**Terminal workspace**:
The discoverable existing Windows Consoles under the controlled host's current Windows user and session. One background broker maintains a catalog; it does not create a shell or Codex conversation.
_Avoid_: mux, new session, remote desktop

**Relay sidecar**:
A PowerShell process attached to exactly one original Console. It listens only on the host loopback interface and owns the short-lived token.

**Workspace broker**:
The background controlled-host process started by `xcode`. It discovers shell roots, runs one relay per Console, and writes the catalog used by the office selector.

**Attachment**:
One temporary terminal-only office connection to a selected catalog entry. Losing it does not end the original Console or its current Codex/PowerShell process.

**Pairing window**:
A short-lived, one-use host listener that registers one verified control-machine public key after local approval.
_Avoid_: login server, permanent registration endpoint
