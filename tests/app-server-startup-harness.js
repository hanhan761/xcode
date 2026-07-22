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

  // An accepted bootstrap rollout must not be exposed to the native TUI while
  // it is active: Codex renders that invisible bootstrap as Working. Once the
  // server has started it, startup interrupts it and waits for completion.
  const listeners = new Set();
  const calls = [];
  const acceptedAuthority = {
    onNotification(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request(method, params) {
      calls.push({ method, params });
      assert.equal(params.threadId, '22222222-2222-4222-8222-222222222222', 'New-thread startup addressed the wrong thread.');
      if (method === 'turn/start') {
        assert.deepEqual(params.input, [], 'New-thread startup changed the empty bootstrap input.');
        setTimeout(() => {
          for (const listener of listeners) {
            listener({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'bootstrap-turn' } } });
          }
        }, 0);
        return Promise.resolve({ turn: { id: 'bootstrap-turn' } });
      }
      assert.equal(method, 'turn/interrupt', 'New-thread startup did not interrupt its active bootstrap turn.');
      assert.equal(params.turnId, 'bootstrap-turn', 'New-thread startup interrupted the wrong bootstrap turn.');
      setTimeout(() => {
        for (const listener of listeners) {
          listener({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'bootstrap-turn' } } });
        }
      }, 0);
      return Promise.resolve({});
    },
  };
  const acceptedOutcome = await Promise.race([
    initializeNewThreadForRemoteTui(acceptedAuthority, '22222222-2222-4222-8222-222222222222', {
      requestTimeoutMs: 100,
      lifecycleTimeoutMs: 100,
    }).then(
      () => ({ type: 'resolved' }),
      (error) => ({ type: 'rejected', error }),
    ),
    // The helper itself uses a 100ms lifecycle bound above. Keep this outer
    // observation window generous so timer scheduling on a busy Windows host
    // cannot turn a passing lifecycle into a flaky test failure.
    delay(500).then(() => ({ type: 'still-waiting' })),
  ]);
  assert.equal(
    acceptedOutcome.type,
    'resolved',
    'The native Codex TUI bootstrap did not reach an authoritative completed state.',
  );
  assert.deepEqual(calls.map((call) => call.method), ['turn/start', 'turn/interrupt'], 'Bootstrap startup used an unexpected app-server lifecycle.');
  assert.equal(listeners.size, 0, 'Bootstrap startup retained a notification listener after completion.');

  // Completion may arrive before the turn/start response is processed. That
  // race is already safe and must not issue a stale interruption request.
  const completedFirstListeners = new Set();
  const completedFirstCalls = [];
  const completedFirstAuthority = {
    onNotification(listener) {
      completedFirstListeners.add(listener);
      return () => completedFirstListeners.delete(listener);
    },
    request(method, params) {
      completedFirstCalls.push(method);
      assert.equal(method, 'turn/start', 'An already-completed bootstrap turn was interrupted unnecessarily.');
      for (const listener of completedFirstListeners) {
        listener({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'completed-bootstrap-turn' } } });
      }
      return Promise.resolve({ turn: { id: 'completed-bootstrap-turn' } });
    },
  };
  await initializeNewThreadForRemoteTui(completedFirstAuthority, '33333333-3333-4333-8333-333333333333', {
    requestTimeoutMs: 100,
    lifecycleTimeoutMs: 100,
  });
  assert.deepEqual(completedFirstCalls, ['turn/start'], 'A completed bootstrap turn received an unnecessary interruption.');
  assert.equal(completedFirstListeners.size, 0, 'The completed-bootstrap listener was not released.');

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
