#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const { initializeNewThreadForRemoteTui, shouldShareAppServer } = require(path.join(packageRoot, 'lib', 'app-server-session'));

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  // A shared app-server can be occupied by an unrelated active Codex thread.
  // Its queued bootstrap request must not leave a new terminal blank forever.
  const blockedAuthority = {
    onNotification() { return () => {}; },
    request() { return new Promise(() => {}); },
  };
  const outcome = await Promise.race([
    initializeNewThreadForRemoteTui(blockedAuthority, '11111111-1111-4111-8111-111111111111', {
      requestTimeoutMs: 25,
      completionTimeoutMs: 25,
    }).then(
      () => ({ type: 'resolved' }),
      (error) => ({ type: 'rejected', error }),
    ),
    delay(100).then(() => ({ type: 'hung' })),
  ]);
  assert.notEqual(outcome.type, 'hung', 'A queued bootstrap turn left the new Codex terminal waiting indefinitely.');
  assert.equal(outcome.type, 'rejected', 'A stalled bootstrap turn unexpectedly succeeded.');
  assert.match(outcome.error.message, /bootstrap/i, 'The startup failure did not identify its bootstrap stage.');

  // `turn/start` responds when the rollout is created, while the empty turn's
  // completion follows asynchronously.  The native remote TUI can therefore
  // be opened as soon as this response arrives instead of waiting for an
  // otherwise invisible Codex turn to finish.
  const acceptedAuthority = {
    onNotification() { return () => {}; },
    request(method, params) {
      assert.equal(method, 'turn/start', 'New-thread startup did not create the required bootstrap rollout.');
      assert.equal(params.threadId, '22222222-2222-4222-8222-222222222222', 'New-thread startup bootstrapped the wrong thread.');
      assert.deepEqual(params.input, [], 'New-thread startup changed the empty bootstrap input.');
      return Promise.resolve({ turn: { id: 'bootstrap-turn' } });
    },
  };
  const acceptedOutcome = await Promise.race([
    initializeNewThreadForRemoteTui(acceptedAuthority, '22222222-2222-4222-8222-222222222222', {
      requestTimeoutMs: 25,
    }).then(
      () => ({ type: 'resolved' }),
      (error) => ({ type: 'rejected', error }),
    ),
    delay(100).then(() => ({ type: 'still-waiting' })),
  ]);
  assert.equal(
    acceptedOutcome.type,
    'resolved',
    'The native Codex TUI is still blocked on an already-accepted empty bootstrap turn.',
  );

  assert.equal(shouldShareAppServer(['resume', '11111111-1111-4111-8111-111111111111']), true, 'A saved-thread recovery should reuse the recovery host.');
  assert.equal(shouldShareAppServer([]), false, 'A new Codex conversation must not queue behind unrelated recovered threads.');
  console.log(`APP_SERVER_STARTUP=PASS package=${packageRoot}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  },
);
