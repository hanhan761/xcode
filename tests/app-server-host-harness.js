#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const { acquireSharedAppServer } = require(path.join(packageRoot, 'lib', 'app-server-host'));

function findNativeCodex() {
  const root = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
  for (const packageName of fs.readdirSync(root)) {
    if (!/^codex-win32-/i.test(packageName)) { continue; }
    const vendorRoot = path.join(root, packageName, 'vendor');
    for (const vendor of fs.readdirSync(vendorRoot)) {
      const candidate = path.join(vendorRoot, vendor, 'bin', 'codex.exe');
      if (fs.existsSync(candidate)) { return candidate; }
    }
  }
  throw new Error('The native Windows Codex executable was not found.');
}

function isAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  }
  catch { return false; }
}

function waitFor(predicate, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      }
      else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${description}.`));
      }
    }, 25);
  });
}

async function main() {
  if (process.env.XCODE_RUN_APP_SERVER_HOST !== '1') {
    console.log('APP_SERVER_HOST=SKIPPED (set XCODE_RUN_APP_SERVER_HOST=1 to run the isolated native app-server host proof)');
    return;
  }

  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-app-server-host-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-app-server-host-workspace-'));
  let first;
  let second;
  try {
    [first, second] = await Promise.all([
      acquireSharedAppServer({ file: findNativeCodex(), cwd: workspace, hostRoot }),
      acquireSharedAppServer({ file: findNativeCodex(), cwd: workspace, hostRoot }),
    ]);
    assert.equal(first.url, second.url, 'Concurrent managed sessions did not receive one shared app-server URL.');
    assert.equal(first.processId, second.processId, 'Concurrent managed sessions started more than one app-server process.');
    assert.equal(isAlive(first.processId), true, 'The acquired app-server process is not alive.');
    const state = JSON.parse(fs.readFileSync(path.join(hostRoot, 'host.json'), 'utf8'));
    assert.equal(state.schemaVersion, 2, 'The shared host did not publish its private-pseudoconsole ownership.');
    assert.equal(isAlive(state.pseudoconsoleHostProcessId), true, 'The private app-server pseudoconsole host is not alive.');
    assert.notEqual(state.pseudoconsoleHostProcessId, state.processId, 'The app-server is not owned by a separate pseudoconsole host.');
    await first.release();
    assert.equal(isAlive(second.processId), true, 'Releasing one session stopped an app-server still leased by another session.');
    await second.release();
    await waitFor(() => !isAlive(second.processId), 5_000, 'the shared app-server to stop after its final lease released');
    console.log('APP_SERVER_HOST=PASS');
  }
  finally {
    await first?.release();
    await second?.release();
    try { fs.rmSync(hostRoot, { recursive: true, force: true, maxRetries: 3 }); }
    catch { /* A native app-server can release its state handle shortly after exit. */ }
    try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3 }); }
    catch { /* See above. */ }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  },
);
