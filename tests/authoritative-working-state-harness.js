'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const {
  createAuthoritativeWorkingReconciler,
  hasVisibleNativeWorkingSpinner,
} = require(path.join(packageRoot, 'lib', 'authoritative-working-state'));

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function main() {
  assert.equal(hasVisibleNativeWorkingSpinner('  \u25e6   Working   40  27'), true,
    'The official decorated Working indicator was not recognized.');
  assert.equal(hasVisibleNativeWorkingSpinner('The Working directory is clean.'), false,
    'Conversation text mentioning Working was mistaken for the status indicator.');
  assert.equal(hasVisibleNativeWorkingSpinner('Working'), false,
    'An undecorated conversation word was mistaken for the native status indicator.');

  let statusType = 'idle';
  let spinnerVisible = true;
  let restartCount = 0;
  const reconciler = createAuthoritativeWorkingReconciler({
    threadId: 'thread-1',
    readThreadStatus: async () => statusType,
    isWorkingSpinnerVisible: async () => spinnerVisible,
    restartTui: async () => {
      restartCount += 1;
      spinnerVisible = false;
    },
    delayMs: 5,
  });

  reconciler.onNotification({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { status: 'completed' } },
  });
  await wait(25);
  assert.equal(restartCount, 1,
    'An idle authority did not reconnect a TUI that still displayed the stale Working spinner.');

  spinnerVisible = true;
  reconciler.onNotification({
    method: 'turn/completed',
    params: { threadId: 'other-thread', turn: { status: 'completed' } },
  });
  await wait(25);
  assert.equal(restartCount, 1,
    'A completed turn from another shared thread restarted the selected TUI.');

  statusType = 'active';
  reconciler.onNotification({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { status: 'completed' } },
  });
  await wait(25);
  assert.equal(restartCount, 1,
    'An active Codex turn was incorrectly interrupted to clear Working.');

  statusType = 'idle';
  reconciler.onNotification({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { status: 'completed' } },
  });
  reconciler.onNotification({
    method: 'turn/started',
    params: { threadId: 'thread-1', turn: { status: 'inProgress' } },
  });
  await wait(25);
  assert.equal(restartCount, 1,
    'A newly started turn did not cancel a pending stale-state restart.');

  reconciler.close();
  console.log('AUTHORITATIVE_WORKING_STATE=PASS');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
