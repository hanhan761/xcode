#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const { withHostLock } = require(path.join(packageRoot, 'lib', 'app-server-host'));

async function main() {
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-app-server-host-lock-'));
  const ownerPath = path.join(hostRoot, 'lock', 'owner.json');
  const originalWriteFileSync = fs.writeFileSync;
  let interrupted = false;

  fs.writeFileSync = function writeFileSyncWithContendedLock(filePath, ...args) {
    if (!interrupted && path.resolve(filePath) === ownerPath) {
      interrupted = true;
      fs.rmSync(path.dirname(ownerPath), { recursive: true, force: true });
    }
    return originalWriteFileSync.call(this, filePath, ...args);
  };

  try {
    const result = await withHostLock(hostRoot, async () => 'acquired');
    assert.equal(interrupted, true, 'The simulated competing lock cleanup did not run.');
    assert.equal(result, 'acquired', 'A deleted in-progress lock prevented recovery from continuing.');
    assert.equal(fs.existsSync(path.join(hostRoot, 'lock')), false, 'The recovered lock was not released.');
    console.log('APP_SERVER_HOST_LOCK_RECOVERY=PASS');
  }
  finally {
    fs.writeFileSync = originalWriteFileSync;
    fs.rmSync(hostRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
