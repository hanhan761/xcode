'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const { createOfficeAttachmentRegistry } = require(path.join(packageRoot, 'lib', 'office-attachment-registry'));
const { runOfficeAttachAll } = require(path.join(packageRoot, 'lib', 'office-attach-all'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-office-attach-all-'));
const alive = new Set();
let now = 10_000;
const registry = createOfficeAttachmentRegistry({
  root,
  now: () => now,
  isProcessAlive: (processId) => alive.has(processId),
  pendingTimeoutMs: 100,
});

const sessions = [
  { sessionId: '11111111-1111-4111-8111-111111111111', threadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nativeTuiAvailable: true, title: 'Build\u0000 status' },
  { sessionId: '22222222-2222-4222-8222-222222222222', threadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nativeTuiAvailable: true, title: 'duplicate thread' },
  { sessionId: '33333333-3333-4333-8333-333333333333', threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', nativeTuiAvailable: true, title: 'Review' },
  { sessionId: '44444444-4444-4444-8444-444444444444', threadId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', nativeTuiAvailable: false, title: 'legacy' },
];

async function main() {
  try {
    alive.add(process.pid);
    const firstLock = registry.acquireAllLock();
    assert.throws(() => registry.acquireAllLock(), /already in progress/);
    firstLock.release();
    registry.acquireAllLock().release();
    const longRunningLock = registry.acquireAllLock();
    now += 101;
    assert.throws(() => registry.acquireAllLock(), /already in progress/, 'A live attach-all recovery lock must not be stolen after its reservation timeout.');
    longRunningLock.release();
    registry.acquireAllLock().release();
    alive.delete(process.pid);
    const deadLock = registry.acquireAllLock();
    const recoveredLock = registry.acquireAllLock();
    alive.add(process.pid);
    deadLock.release();
    assert.throws(() => registry.acquireAllLock(), /already in progress/, 'A dead lock holder removed the recovered attach-all lock.');
    recoveredLock.release();
    alive.delete(process.pid);

    const launched = [];
    let listCalls = 0;
    const first = await runOfficeAttachAll({
      listSessions: async () => {
        listCalls += 1;
        return sessions;
      },
      registry,
      openTabs: async (entries) => launched.push(entries),
    });
    assert.deepEqual(first, { opened: 2, skipped: 0 });
    assert.equal(listCalls, 1, 'An attach-all run must use one restricted active-session list.');
    assert.equal(launched.length, 1, 'All selected sessions should be sent to one Windows Terminal launch.');
    assert.deepEqual(launched[0].map((entry) => entry.sessionId), [sessions[0].sessionId, sessions[2].sessionId]);
    assert.deepEqual(launched[0].map((entry) => entry.title), ['Build status', 'Review']);
    assert.ok(launched[0].every((entry) => typeof entry.attachmentToken === 'string' && entry.attachmentToken.length > 0));

    const second = await runOfficeAttachAll({
      listSessions: async () => sessions,
      registry,
      openTabs: async () => { throw new Error('Already-reserved conversations must not open duplicate tabs.'); },
    });
    assert.deepEqual(second, { opened: 0, skipped: 2 });

    now += 101;
    const stale = await runOfficeAttachAll({
      listSessions: async () => [sessions[0]],
      registry,
      openTabs: async (entries) => launched.push(entries),
    });
    assert.deepEqual(stale, { opened: 1, skipped: 0 }, 'A stale pre-launch reservation must not block a later recovery.');

    const reservation = registry.reserve({ threadId: sessions[2].threadId, sessionId: sessions[2].sessionId });
    const claim = registry.claim({ ...reservation, processId: 505 });
    alive.add(505);
    assert.equal(registry.isActive(sessions[2].threadId), true, 'A live office attachment must prevent a duplicate tab.');
    registry.release(claim);
    alive.delete(505);
    assert.equal(registry.isActive(sessions[2].threadId), false, 'Closing an office attachment must release its reservation.');

    process.stdout.write('OFFICE_ATTACH_ALL=PASS\n');
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
