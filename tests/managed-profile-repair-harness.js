#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const { repairManagedCodexProfile, shouldRepairMainProfile } = require(path.join(packageRoot, 'scripts', 'repair-managed-codex-profile'));
const manifest = require(path.join(packageRoot, 'package.json'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-managed-profile-repair-'));

function mainState(localAppData) {
  const installRoot = path.join(localAppData, 'XcodeRemote');
  fs.mkdirSync(installRoot, { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'host-user.json'), '{}');
}

try {
  assert.equal(manifest.scripts?.postinstall, 'node scripts/repair-managed-codex-profile.js', 'The profile repair is not registered for the first xcode update.');
  const localAppData = path.join(root, 'main');
  mainState(localAppData);
  const env = { LOCALAPPDATA: localAppData, SystemRoot: 'C:\\Windows' };
  const calls = [];
  assert.equal(repairManagedCodexProfile({
    packageRoot,
    env,
    platform: 'win32',
    spawnProcess: (file, args, options) => {
      calls.push({ file, args, options });
      return { status: 0 };
    },
  }), true, 'A main-PC install did not repair the managed Codex profile.');
  assert.equal(calls.length, 1, 'The main-PC profile repair did not launch PowerShell exactly once.');
  assert.match(calls[0].args.at(-1), /Install-XcodeManagedCodexProfileEntrypoint/, 'The postinstall repair did not install the managed Codex entrypoint.');
  assert.equal(calls[0].options.stdio, 'ignore', 'The postinstall repair exposed an interactive PowerShell window.');

  const officeAppData = path.join(root, 'office');
  mainState(officeAppData);
  fs.writeFileSync(path.join(officeAppData, 'XcodeRemote', 'client.json'), '{}');
  assert.equal(shouldRepairMainProfile({ env: { LOCALAPPDATA: officeAppData } }), false, 'An office laptop was considered eligible for the main-PC profile repair.');
  assert.equal(repairManagedCodexProfile({
    packageRoot,
    env: { LOCALAPPDATA: officeAppData },
    platform: 'win32',
    spawnProcess: () => { throw new Error('An office installation must not alter the Codex profile.'); },
  }), false);

  assert.throws(() => repairManagedCodexProfile({
    packageRoot,
    env,
    platform: 'win32',
    spawnProcess: () => ({ status: 1 }),
  }), /Could not repair/, 'A failed profile repair did not stop the installation.');
  process.stdout.write('MANAGED_PROFILE_REPAIR=PASS\n');
}
finally {
  fs.rmSync(root, { recursive: true, force: true });
}
