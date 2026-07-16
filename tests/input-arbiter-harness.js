#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { startManagedSession } = require('../lib/session-runner');

function waitFor(promise, timeoutMs, description) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), timeoutMs)),
  ]);
}

async function verifyRemoteMessageAfterLocalControlInput(localInput, label) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-input-arbiter-'));
  const command = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  const session = startManagedSession({
    file: command,
    args: ['/d', '/v:on', '/s', '/c', 'set /p value= & echo RECEIVED:!value!'],
    cwd: process.cwd(),
    localIdleMs: 20,
    stateRoot,
  });
  try {
    session.submitLocal(localInput);
    const delivery = session.submitRemoteMessage('office-message');
    await waitFor(delivery, 1000, `${label} to release the remote message`);
    // Delivery resolves only after SessionRunner writes the message to the
    // managed PTY. CMD keeps an arrow key in its own edit buffer, so process
    // exit is not part of this arbiter-specific assertion.
    assert.ok(true, `${label} released the remote message`);
  }
  finally {
    session.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
}

async function main() {
  // Arrow keys are terminal navigation, not unsent local message text.
  await verifyRemoteMessageAfterLocalControlInput('\x1b[A', 'an arrow key');
  // A user who deletes their draft has released the terminal for collaboration.
  await verifyRemoteMessageAfterLocalControlInput('draft\x08\x08\x08\x08\x08', 'cleared local input');
  console.log('INPUT_ARBITER_RELEASE=PASS');
  process.exit(0);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
