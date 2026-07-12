# Remote PowerShell Workspace

This context describes a persistent multi-pane PowerShell workspace hosted on one Windows machine and attached from authorized Windows control machines.

## Language

**Controlled host**:
The Windows main PC that owns the mux server and runs all PowerShell processes.
_Avoid_: server, remote computer, slave

**Control machine**:
An authorized office laptop that renders and controls host-owned panes.
_Avoid_: client when referring to the device itself

**Terminal workspace**:
The host-owned collection of mux windows, tabs, pane layout and terminal sessions.
_Avoid_: connection, conversation

**Terminal session**:
One independent PowerShell process and its pseudoterminal state inside a pane.
_Avoid_: tab, SSH connection

**Attachment**:
One temporary GUI connection from a control machine to the terminal workspace. Losing an attachment does not end terminal sessions.
_Avoid_: session

**Pairing window**:
A short-lived, one-use host listener that registers one verified control-machine public key after local approval.
_Avoid_: login server, permanent registration endpoint
