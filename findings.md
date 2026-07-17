# Findings and Decisions

## User intent

- One main PC has many simultaneously open PowerShell/Codex terminals.
- The office laptop must acquire all of them in one action, then select a terminal and continue its original conversation.
- No remote desktop or pixel-perfect window/layout replication is required.
- The main PC workflow must not require manually sharing each terminal.

## Platform facts

- The completed single-console relay can read `CONOUT$` and write `CONIN$` when it is launched in the target Console.
- Windows `AttachConsole(processId)` lets a helper attach to a specified process's Console, but one helper can attach to only one Console. A broker therefore needs one worker per Console. [Microsoft AttachConsole](https://learn.microsoft.com/en-us/windows/console/attachconsole)
- A pseudoconsole does not expose a normal visible Console window handle, so the broker must identify sessions from processes/Console attachment rather than window geometry. [Microsoft GetConsoleWindow](https://learn.microsoft.com/en-us/windows/console/getconsolewindow)
- Existing SSH keys prohibit TCP forwarding. The prior standard-I/O bridge remains the transport and needs no policy change.
- The new isolated harness passed `FreeConsole` + `AttachConsole` against a non-parent hidden PowerShell target, including its input round trip.
- A read-only probe also attached to a real separate Windows Terminal-hosted Codex process in this Windows session and returned a 280×73 snapshot. Process-based discovery therefore covers the user's primary Windows Terminal/Codex workflow.

## Proposed module seams

| Module | Interface | Implementation responsibility |
|---|---|---|
| WorkspaceCatalog | JSON state file with session IDs, titles, worker ports and tokens | discovery, deduplication, worker lifecycle and stale cleanup |
| ConsoleRelay | `-TargetProcessId` plus loopback protocol | attach to exactly one original Console, snapshot output and inject input |
| OfficeWorkspace | catalog select / selected bridge / return to catalog | render session list and establish one SSH standard-I/O bridge at a time |

## Implemented behavior

- The broker discovers shell roots rather than `conhost.exe` renderer processes. It prioritizes newly opened shells and removes stale worker state when the original shell exits.
- Main `xcode` starts the broker once, in the background. It discovers already-open and later-open PowerShell/Codex terminal sessions without a per-window share command.
- Office `xcode` gets the catalog through the existing pinned SSH standard-I/O transport, selects one original session, and uses `Ctrl+G` to return to a refreshed selector. `Ctrl+C` only disconnects the office client.

## Known limits

- A terminal-only selector can present all sessions, but does not reproduce Windows Terminal tabs, pane geometry, mouse controls or colors.
- Elevated or other-user Console targets must be reported as unavailable rather than silently captured.

## Happy reference and security correction

- The user asked to use Happy / Happy Coder as the reference model. Happy's documented workflow starts Codex or Claude through its own wrapper (`happy codex` / `happy claude`) and performs remote control through that named session rather than scanning every local terminal. It describes device switching and end-to-end encrypted remote access. [Happy README](https://github.com/slopus/happy/blob/main/README.md)
- This is a materially better product boundary for xcode. The automatic broker exposed 13 same-user PowerShell/CMD sessions in a real run, including unrelated tool shells; a paired device could therefore select more than the user had deliberately approved.
- The old pairing configuration also permits an interactive SSH shell. That may be acceptable for a trusted administration tool, but it is too broad for a session-control product. The replacement needs a session-scoped gateway or SSH forced command.
- Forced termination of the broker left relay sidecars alive in test/diagnostic runs. The cleanup problem is now logged as a release blocker; the scanner remains stopped and must not be re-enabled as the default workflow.

## Happy architecture details to adopt

- Happy separates three roles: a local CLI/runner starts and observes the agent, a remote app renders and controls it, and a relay only transports encrypted blobs. The relay deliberately cannot read code or conversation data. [How Happy Works](https://happy.engineering/docs/how-it-works/)
- Its documented security model uses a QR-established device secret, per-session encryption keys, authenticated challenge-response, and a self-hostable relay. The master secret does not leave the phone. [Happy Security & Encryption](https://happy.engineering/docs/security/)
- Its core UX is named, isolated agent sessions that persist independently and can switch controllers. The corresponding xcode seams are `SessionRunner`, `EncryptedRelay`, `DeviceGrant`, and a collaborative `InputArbiter`.
- Important migration constraint: Happy's documented Codex path is `happy codex`, a wrapper-started session. It does not justify claiming that every arbitrary already-running Windows terminal can be safely imported without explicit user approval. [Happy README](https://github.com/slopus/happy/blob/main/README.md)

## Official Codex app-server investigation

- Codex CLI 0.144.5 documents `codex --remote` and `codex resume --remote` for connecting a terminal UI to an app-server; the app-server owns Codex conversation history, approvals and streamed agent events. [Codex App Server](https://learn.chatgpt.com/docs/app-server.md)
- The documented `codex remote-control` convenience command is not viable on this Windows main PC: `codex remote-control start --json` deterministically exits 1 with `codex app-server daemon lifecycle is only supported on Unix platforms`. Do not retry it on Windows.
- The direct Windows-capable candidate is a loopback-only `codex app-server --listen ws://127.0.0.1:PORT` with capability-token authentication, reached from the office laptop only through a narrowly permitted SSH/VPN path. Official guidance explicitly says not to expose app-server transports directly to shared/public networks.
- A direct native `codex.exe app-server` probe on Windows successfully bound to `127.0.0.1:57821`; the temporary listener was then stopped and rechecked as absent. It was never exposed to the LAN or Tailscale network.
- npm's `codex.cmd` launcher is unsuitable for service lifecycle management: it starts `node.exe`, which then starts native `codex.exe`, and the wrapper parent can exit while both children remain. Any future app-server adapter must locate and launch the native executable directly, own its token file, and verify that shutdown removed the listener.
- The generated Codex app-server schema has explicit `thread/list`, `thread/read`, `thread/resume`, `thread/fork`, and turn APIs. That makes app-server the correct seam for shared Codex progress; it does not make the legacy Windows-console scanner safe or necessary.
- Upstream's current peer-client co-presence RFC reports the same crucial limitation: a separate client can resume a stored thread, but stock app-server did not reliably fan out live normal-TUI turns or render app-server-originated turns back in the active TUI. This is evidence against promising transparent live capture of an arbitrary normal `codex` process. [Upstream RFC](https://github.com/openai/codex/issues/21551)
- The retained product contract is therefore `codex` on the main PC and `xcode` on the office laptop. The command name stays `codex`, but new or resumed sessions become explicitly managed at launch; `xcode` controls only these named sessions. The complete module and security design is in `docs/codex-session-handoff.md`.
- The user clarified that xcode is a collaborator, not a terminal takeover: it must observe the main PC's Codex progress and contribute messages to the same conversation while the main PC continues working. The replacement boundary is therefore an `InputArbiter` that serializes complete messages, rather than an exclusive `ControlLease`.
- A clean temporary Windows probe of `node-pty@1.1.0` succeeded with its bundled x64 ConPTY build: it spawned a PTY child, delivered ANSI output including the probe marker, and reported the expected exit code. This is a viable `SessionRunner` foundation without `AttachConsole` scanning. The production package must still assess its roughly 15.5 MB compressed dependency cost and lifecycle behavior before adopting it.

## Active-session closure

- A state file alone is not proof that a conversation is active: a runner crash can leave an old JSON record after its pipe is gone. The office catalog therefore needs a liveness check at the gateway seam, not a client-side history filter.
- The active predicate is deliberately narrow: an optional recorded managed-child PID must still exist and the session's random local named pipe must accept a connection. This prevents PID reuse alone from reviving a stale record, while allowing existing schema-1 live sessions to remain usable through their reachable pipe.
- `SSH_GATEWAY_INTERACTION=PASS` verifies the independent transport fact: an office-originated message traverses the forced SSH gateway, is queued by `InputArbiter`, is delivered to the managed PTY, and is observable in the main child. The office client lacked delivery-state feedback; it now distinguishes queued from delivered so a user can identify local-input arbitration delay instead of seeing a silent no-op.
- A raw terminal's arrow/history input is an ANSI sequence, not draft text. Treating every printable byte in that sequence as a local draft caused permanent remote queueing after navigation. The arbiter now keeps a small terminal-control parser and tracks actual text length, so backspace/delete and line-clear controls also release collaboration safely.

## Single-window office surface

- The raw bridge rendered the main terminal's ANSI bytes and the office client's own composer/status text into the same PowerShell screen. Those two writers compete for cursor position, so the office interface cannot be reliable even when the transport itself delivers a message.
- The repair seam is a deep `OfficeTerminalSurface` module: callers provide remote terminal bytes and receive plain visible lines for a viewport. It owns ANSI parsing, alternate-screen handling, scrollback selection and clipping; `session-client` owns only connection lifecycle, local composition and rendering one PowerShell alternate-screen UI.
- `@xterm/headless` 6.0.0 is a Node terminal-state model suitable for that module. Its readable buffer is explicitly gated behind `allowProposedApi: true`; this is required at construction, not an installation failure.

## Remaining test gap

- The former `OFFICE_CLIENT_SINGLE_WINDOW=PASS` used a scripted SSH substitute, while `SSH_GATEWAY_INTERACTION=PASS` used the real forced gateway with a direct JSON client. Those tests prove their seams but do not prove the exact production path from an office PowerShell client, through the forced gateway, into one managed main PTY.
- The next deterministic harness must run that entire path with isolated `LOCALAPPDATA` roots: real `SessionRunner`, real `session-gateway.js`, a Windows ConPTY for the office client, and only a local command wrapper standing in for SSH transport. Its assertion is the user's symptom: office entry yields `Delivered` and the main child observes the exact text.
- The new isolated two-machine chain now passes as `TWO_MACHINE_COLLABORATION_E2E=PASS`: office terminal → real forced gateway → private named pipe → `InputArbiter` → main PTY. The installed main-PC package contains the new terminal surface and geometry protocol, so the remaining uncertainty is a live Codex TUI-specific behavior or a specific office-side deployment/runtime condition, not a missing package file on the main PC.
- The same E2E harness was then run against the actual global installation at `C:\Users\13081\AppData\Roaming\npm\node_modules\xcode-remote`, not the repository checkout. It passed while executing the installed `session-client.js`, `session-gateway.js` and `session-runner.js`. This eliminates a stale main-PC npm package as the cause of the observed failure.

## Real Codex semantic-delivery probe

- A first isolated native `codex.exe` probe sent a unique message through the current `SessionRunner.submitRemoteMessage` path and waited 90 seconds for that marker to become observable in Codex output. It did not observe the marker. The test's temporary directory then remained locked long enough for cleanup to report `EPERM`, which masked the intended timeout/tail diagnostic; cleanup now waits for managed-session completion and preserves the primary error.
- This is the first test that reaches the user's actual complaint: writing bytes to the PTY does not establish that the Codex conversation accepted or processed a turn. The current `delivered` acknowledgement is therefore insufficient and must be replaced by an explicit confirmation model or a semantic Codex control path.
- The preserved terminal tail showed that the real Codex instance was blocked at its full-screen directory-trust prompt, so it could not yet accept a conversation turn. The probe now models the expected main-PC local action (accepting the selected trust option) before it sends a remote message. This distinguishes startup safety gating from a transmission failure once Codex is ready.
- One multi-file patch initially targeted the findings text in the wrong file and was rejected without modifying the workspace. The correction separates the probe-code and findings edits; no runtime behavior was changed by the failed patch.
- Raw Codex output cannot be searched for a visible sentence: its full-screen renderer puts cursor-position control sequences between adjacent visual words (`Do`, cursor move, `you`, …). The probe now accepts the default trust selection after a bounded startup delay. Production acknowledgement detection must use the same terminal model as the office renderer, never a raw-byte substring.
- `LIVE_CODEX_REMOTE_INPUT=PASS` now uses a genuine challenge/response rather than input echo: the remote message contains only an `XCODE_CHALLENGE_*` token, and the test waits for Codex to generate the distinct `XCODE_ACK_*` token. This proves that a ready native Codex instance accepts the current SessionRunner remote-input path and starts a real response.
- The production `SessionRunner` now owns a headless terminal model internally. Before draining its remote queue it checks the current visible terminal screen; the directory-trust safety prompt holds remote messages until the main PC clears it locally. This is a deep module: callers retain the same `submitRemoteMessage` interface while terminal parsing, readiness and queue timing stay local to the runner.
