# Findings and Decisions

## Requirements

- The office laptop must not be presented as an `install-office.cmd` workflow.
- Main and office pairing must both be invoked through `xcode`.
- Daily office use remains one command: `xcode`.
- Installation and update must use npm; the latest GitHub `main` revision is the release source.
- The current one-time code, Tailscale identity verification and SSH host-key fingerprint confirmation remain intact.

## Research Findings

- The current main launcher already exposes `xcode pair` and otherwise attaches the local WezTerm mux.
- The current office flow combines dependency setup, pairing and first attach in `install-office.ps1`; its `xcode` command is installed only after that flow completes.
- A fresh Windows machine has no PATH-resolved `xcode`. A repository-local `./xcode` bootstrap is therefore the smallest honest first-run interface.
- The current office installer resolves `xcode-main` through Tailscale MagicDNS, accepts the one-time code, verifies the fingerprint and writes its daily launcher only after commit.
- Current office state supports one paired main PC. This refactor must not imply multi-host selection until its state/configuration model is expanded.
- Existing office `xcode` already supports `doctor` and emergency `ssh`; main `xcode` currently supports only attach and `pair`.
- Existing main and office launchers are generated differently. A shared dispatcher is the clean seam for role-aware commands and avoids duplicating command parsing in two batch files.
- The npm dry-run pack includes the dispatcher, every PowerShell implementation file, the README and architecture graphic; it excludes legacy root CMD adapters.

## Technical Decisions

| Decision | Rationale |
|---|---|
| Add a single repository-local `xcode.cmd` dispatcher | First-run users type `./xcode`; installed users type `xcode`. Both use the same command grammar. |
| Persist role after setup | Lets `xcode pair` choose host or office behavior without users learning separate scripts. |
| Make `xcode pair` on office perform only the pairing client flow | It can be rerun to pair another main PC without package installation or UAC. |
| Retain legacy CMD files as compatibility adapters, not documented interfaces | Existing clones and shortcuts keep working while the public interface becomes consistent. |
| Keep this change single-host | The requested command unification is independent of a multi-host state redesign; `xcode connect <name>` can be added later without weakening today's pairing flow. |
| Package as `xcode-remote` with the `xcode` npm binary | Avoids claiming the unscoped `xcode` npm package name and allows `npm install -g github:hanhan761/xcode`. |
| Use `xcode update` to reinstall the GitHub package globally | This explicitly pulls the current repository revision without requiring npm-registry publication authority. |
| Rewrite all actionable installer error text to `xcode` syntax | Users should never need to discover an internal legacy adapter while recovering from a failure. |

## Issues Encountered

| Issue | Resolution |
|---|---|
| Historic planning files described installation as not yet run | Replaced them with the active workflow-refactor plan. |
