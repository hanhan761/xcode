#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const powershell = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const result = spawnSync(
  powershell,
  [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(packageRoot, 'scripts', 'xcode.ps1'),
    '-RepositoryRoot', packageRoot,
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit', windowsHide: false },
);

if (result.error) {
  console.error(`Could not start Windows PowerShell: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
