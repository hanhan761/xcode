#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function powerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function shouldRepairMainProfile({ env = process.env, fsModule = fs } = {}) {
  if (!env.LOCALAPPDATA) { return false; }
  const installRoot = path.join(env.LOCALAPPDATA, 'XcodeRemote');
  const isOffice = fsModule.existsSync(path.join(installRoot, 'client.json')) ||
    fsModule.existsSync(path.join(installRoot, 'office-setup.json'));
  return !isOffice && fsModule.existsSync(path.join(installRoot, 'host-user.json'));
}

function repairManagedCodexProfile({
  packageRoot = path.resolve(__dirname, '..'),
  env = process.env,
  platform = process.platform,
  spawnProcess = spawnSync,
} = {}) {
  if (platform !== 'win32' || !shouldRepairMainProfile({ env })) { return false; }
  const powershell = path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const common = path.join(packageRoot, 'scripts', 'XcodeRemote.Common.ps1');
  const command = [
    `. ${powerShellLiteral(common)}`,
    '[void](Install-XcodeManagedCodexProfileEntrypoint -ProfilePath $PROFILE.CurrentUserAllHosts)',
  ].join('; ');
  const result = spawnProcess(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.error) { throw new Error(`Could not repair the managed Codex profile: ${result.error.message}`); }
  if (result.status !== 0) { throw new Error(`Could not repair the managed Codex profile (PowerShell exit ${result.status}).`); }
  return true;
}

if (require.main === module) {
  try { repairManagedCodexProfile(); }
  catch (error) {
    process.stderr.write(`xcode postinstall: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { repairManagedCodexProfile, shouldRepairMainProfile };
