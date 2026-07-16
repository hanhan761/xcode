# Xcode Remote Context

This project lets a paired Windows office laptop collaborate in a Codex
conversation running on a Windows main PC. It is terminal-only: no desktop
streaming and no general remote PowerShell shell.

## Language

**Main PC**:
The Windows machine that owns the Codex process, working directory and local
terminal UI.
_Avoid_: server, slave, controlled host.

**Office laptop**:
The paired Windows device from which the user observes and contributes to a
main-PC Codex conversation.
_Avoid_: controller, client when referring to the physical device.

**Managed Codex session**:
One Codex child started or resumed by `SessionRunner` in a private Windows
pseudoterminal. It has an opaque session id, output snapshot and explicit
device grants.
_Avoid_: terminal workspace, arbitrary existing console.

**SessionRunner**:
The deep module that owns exactly one managed Codex child, fans output to local
and remote observers, and owns its lifetime.
_Avoid_: broker when referring to process discovery.

**InputArbiter**:
The policy within `SessionRunner` that serializes complete remote messages with
local terminal input. It supports collaboration, not terminal takeover, and
must never interleave two devices' keystrokes.

**Device grant**:
A long-lived, revocable record created through one-time pairing. It authorizes
only the xcode session protocol for one named office laptop; it is not a
general SSH login.

**Session gateway**:
The forced-command SSH endpoint that exposes permitted session metadata and
byte/message frames to a paired office laptop. It must not execute arbitrary
host commands.

**Attachment**:
An office laptop's observing connection to one managed session. It may submit
messages through `InputArbiter`; it does not take ownership of the main PC's
keyboard or desktop.
