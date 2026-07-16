#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const powershell = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const requestedArgs = process.argv.slice(2);
// PowerShell -File treats a bare `--` as an ambiguous empty parameter name.
// Older xcode profiles emitted `session run -- <codex args>`; tolerate that
// spelling at the npm entrypoint so updating xcode repairs those profiles too.
const legacySeparatorIndex = requestedArgs.findIndex((value, index) => (
  index + 2 < requestedArgs.length
  && value.toLowerCase() === 'session'
  && requestedArgs[index + 1].toLowerCase() === 'run'
  && requestedArgs[index + 2] === '--'
));
const commandArgs = legacySeparatorIndex < 0
  ? requestedArgs
  : [...requestedArgs.slice(0, legacySeparatorIndex + 2), ...requestedArgs.slice(legacySeparatorIndex + 3)];
const result = spawnSync(
  powershell,
  [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(packageRoot, 'scripts', 'xcode.ps1'),
    '-RepositoryRoot', packageRoot,
    ...commandArgs,
  ],
  { stdio: 'inherit', windowsHide: false },
);

if (result.error) {
  console.error(`Could not start Windows PowerShell: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
