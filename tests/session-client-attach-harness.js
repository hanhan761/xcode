'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const { createOfficeAttachmentRegistry } = require(path.join(packageRoot, 'lib', 'office-attachment-registry'));
const {
  nativeSessions,
  openWindowsTerminalTabs,
  parseArgs,
  resolveWindowsTerminal,
  runAttachedOfficeSession,
} = require(path.join(packageRoot, 'bin', 'session-client'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-session-client-attach-'));
const session = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  threadId: '22222222-2222-4222-8222-222222222222',
  nativeTuiAvailable: true,
  title: 'Shared conversation',
};

async function main() {
  try {
    assert.deepEqual(parseArgs(['--ssh-config', 'C:\\office\\ssh_config', '--attach-all']), {
      sshConfig: 'C:\\office\\ssh_config', sessionId: null, attachmentToken: null, attachAll: true,
    });
    assert.throws(() => parseArgs(['--ssh-config', 'config', '--attach-all', '--session-id', session.sessionId]), /Usage/);
    assert.deepEqual(nativeSessions([
      session,
      { ...session, nativeTuiAvailable: false },
      { ...session, nativeTuiAvailable: 'true' },
      { ...session, sessionId: '' },
      { ...session, threadId: '' },
    ]), [session], 'Only schema-compatible native session capabilities may be attached.');
    assert.throws(
      () => resolveWindowsTerminal({ spawnSyncProcess: () => ({ status: 1, stdout: '', stderr: 'missing' }) }),
      /Windows Terminal/,
    );

    let command;
    await openWindowsTerminalTabs([{ ...session, title: 'Safe title', attachmentToken: 'a1b2' }], {
      terminal: 'C:\\Program Files\\WindowsApps\\wt.exe',
      spawnProcess: (_file, args) => {
        command = args;
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('exit', 0));
        return child;
      },
    });
    assert.deepEqual(command.slice(0, 5), ['-w', 'xcode-office', 'new-tab', '--title', 'Safe title']);
    assert.match(command.at(-1), /xcode\.cmd -a '11111111-1111-4111-8111-111111111111' 'a1b2'/);
    assert.doesNotMatch(command.at(-1), /ssh_config|appServer|token=/i, 'A Windows Terminal tab command must not expose gateway configuration or main-PC endpoints.');

    const registry = createOfficeAttachmentRegistry({ root });
    const reservation = registry.reserve(session);
    let verifiedId = null;
    const exitCode = await runAttachedOfficeSession({
      sshConfig: 'C:\\office\\ssh_config',
      sessionId: session.sessionId,
      attachmentToken: reservation.attachmentToken,
      registry,
      findSession: async (_config, sessionId) => {
        verifiedId = sessionId;
        return session;
      },
      openGateway: () => { throw new Error('The native test double must not open SSH.'); },
      runNative: async ({ session: selected }) => {
        assert.equal(selected.sessionId, session.sessionId);
        return 0;
      },
    });
    assert.equal(exitCode, 0);
    assert.equal(verifiedId, session.sessionId, 'A spawned office tab did not revalidate its selected session id.');
    assert.equal(registry.isActive(session.threadId), false, 'A completed office attachment kept a duplicate-blocking record.');

    let normallySelected = false;
    const normalExitCode = await runAttachedOfficeSession({
      sshConfig: 'C:\\office\\ssh_config',
      registry,
      selectSession: async () => {
        normallySelected = true;
        return session;
      },
      openGateway: () => { throw new Error('The native test double must not open SSH.'); },
      runNative: async ({ session: selected }) => {
        assert.equal(selected.sessionId, session.sessionId);
        return 0;
      },
    });
    assert.equal(normalExitCode, 0, 'A normal Office attachment could not claim its reservation.');
    assert.equal(normallySelected, true, 'A normal Office attachment did not select an active session.');
    assert.equal(registry.isActive(session.threadId), false, 'A completed normal Office attachment kept a duplicate-blocking record.');

    const vanished = registry.reserve(session);
    await assert.rejects(
      runAttachedOfficeSession({
        sshConfig: 'C:\\office\\ssh_config',
        sessionId: session.sessionId,
        attachmentToken: vanished.attachmentToken,
        registry,
        findSession: async () => { throw new Error('The selected main-PC Codex conversation is no longer active. Run xcode -aa again.'); },
      }),
      /no longer active/,
    );
    assert.equal(registry.isActive(session.threadId), false, 'A vanished main-PC session left a permanent office attachment reservation.');

    process.stdout.write('SESSION_CLIENT_ATTACH=PASS\n');
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
