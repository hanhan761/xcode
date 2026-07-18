# xcode collaboration workflow

This repository is maintained through GitHub Issues, focused pull requests, and
recorded review. Do not make an untracked product change directly on `main`.

## Issue first

1. Start every product change from one GitHub Issue. The Issue must state the
   observed behavior, the intended outcome, and testable acceptance criteria.
2. Keep one independently releasable behavior per Issue. Investigations may
   produce evidence, but must not silently turn into unrelated implementation.
3. Search open and closed Issues before creating a new one. Use `bug` for a
   regression or incorrect behavior and `enhancement` for a new capability.
4. If the observed behavior depends on a local Codex, PowerShell, Windows
   Terminal, or office-machine setting, record the environment and keep any
   machine-specific data out of the Issue body.

## Branch and implementation

1. Create a branch from current `main` named `issue/<number>-<short-slug>`.
2. Keep the branch limited to the linked Issue. Do not mix release work,
   refactors, or unrelated fixes into it.
3. Add or update an automated regression test before declaring a behavioral
   fix complete. For visual or interactive terminal behavior, also document a
   repeatable manual acceptance check.
4. Run the narrow harnesses first, then `tests/verify.ps1` when the change
   touches session, terminal, pairing, or recovery behavior.
5. Before opening a PR, run `git diff --check` and confirm no user-owned,
   generated, credential, local-state, or package-artifact files are staged.

## Pull request and review

1. Open one PR per Issue. Its title is concise and its body includes
   `Closes #<number>`, a short behavior summary, verification evidence, and
   any manual test still required on a physical machine.
2. Review the PR against the Issue acceptance criteria in a separate review
   pass. Record findings and their resolution in the PR; do not self-merge an
   unreviewed change.
3. Merge only when the linked Issue is satisfied, relevant checks pass, all
   review findings are resolved, and the user has approved the merge.
4. Tag and publish a version only after the PR has merged and the released
   package has been verified in its intended environment.

## Operational safeguards

- Preserve the user's uncommitted work and never stage it incidentally.
- Prefer official Codex documentation and source when matching Codex TUI or
  configuration behavior.
- Do not claim interactive behavior is fixed until its automated evidence and
  required physical-machine acceptance check both pass.
