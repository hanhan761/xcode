# Task Plan: Unified `xcode` Workflow

## Goal

Deliver a GitHub-installable npm CLI whose role-aware `xcode` command owns setup, pairing, daily attachment and self-update while preserving the current secure pairing protocol.

## Current Phase

Phase 4: verification and release.

## Phases

### Phase 1: Requirements and discovery

- [x] Capture the desired interaction: both PCs use `xcode` for pairing.
- [x] Map the current bootstrap, setup, pairing and daily-connect entry points.
- [x] Record the compatibility and security constraints.
- **Status:** complete

### Phase 2: Interface and implementation design

- [x] Define the small external command interface and role-specific behavior.
- [x] Define npm as the official installation and update distribution channel.
- [x] Add a repository-local `xcode` bootstrap dispatcher.
- [x] Package the dispatcher as an npm global binary.
- [x] Separate office dependency setup from office pairing.
- **Status:** complete

### Phase 3: Tests and documentation

- [x] Add regression coverage for every public command route.
- [x] Update README to document only `xcode` commands.
- **Status:** complete

### Phase 4: Verification and release

- [x] Run tests in Windows PowerShell 5.1 and PowerShell 7.
- [x] Verify npm package contents without publishing.
- [ ] Review the diff, commit and push `main`.
- **Status:** in_progress

## Decisions Made

| Decision | Rationale |
|---|---|
| Use `xcode setup main` / `xcode setup office` as the first-run interface | A Windows executable must exist before a PATH command can be installed; `./xcode` is still a single, named `xcode` entry point. |
| Use role-aware `xcode pair` on both PCs | The same command has a simple intent; saved local role determines whether it opens or joins a pairing session. |
| Keep setup separate from pairing | Dependency/UAC work is one-time; pairing is one-time per device and must be repeatable without reinstalling. |
| Install from GitHub with npm, update through `xcode update` | The repository is the authorized release source today; no npm-registry publishing credentials are needed. |

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| None in this workflow refactor | — | — |
| ACL/path cleanup patch did not match the current installer context | 1 | Inspect the current anchors, then apply a narrower patch. |
| `xcode help` bound `help` as the optional repository path | 1 | Make the remaining command arguments position zero before optional named settings. |
| Dispatcher parameter defaults cannot use `$PSScriptRoot` during binding | 1 | Resolve the default repository after parameter binding from `$PSCommandPath`. |
| Help text omitted the newly implemented update command | 1 | Add `xcode update` to the public command reference. |
| Batch replacement of legacy recovery messages did not match current script text | 1 | Inspect and replace each message using its current anchor. |
