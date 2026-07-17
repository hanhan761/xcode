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
