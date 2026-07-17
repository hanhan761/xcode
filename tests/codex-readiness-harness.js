#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const { startManagedSession } = require(path.join(packageRoot, 'lib', 'session-runner'));

function waitFor(predicate, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      }
      else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${description}.`));
      }
    }, 10);
  });
}

async function main() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-readiness-'));
  const output = [];
  const session = startManagedSession({
    file: process.execPath,
    args: [path.join(__dirname, 'fixtures', 'trust-gated-tui.js')],
    cwd: process.cwd(),
    stateRoot,
    localIdleMs: 20,
  });

  try {
    session.onOutput((data) => output.push(data));
    await waitFor(() => output.join('').includes('Do you trust the contents'), 5_000, 'the trust gate');
    let remoteWritten = false;
    const remote = session.submitRemoteMessage('remote-after-trust').then(() => { remoteWritten = true; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(remoteWritten, false, 'A remote message was written into Codex before the main PC cleared its trust prompt.');
    assert.equal(output.join('').includes('OFFICE:remote-after-trust'), false, 'The trust prompt consumed a remote message.');

    session.submitLocal('\r');
    await waitFor(() => output.join('').includes('READY FOR CODEX MESSAGES'), 5_000, 'the main PC to clear the trust prompt');
    await remote;
    await waitFor(() => output.join('').includes('OFFICE:remote-after-trust'), 5_000, 'the queued office message after Codex became ready');
    console.log(`CODEX_READINESS_GATE=PASS package=${packageRoot}`);
  }
  finally {
    session.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  },
);
