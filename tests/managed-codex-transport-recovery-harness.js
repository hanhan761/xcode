'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const { main } = require(path.join(packageRoot, 'bin', 'managed-codex'));

const threadId = '22222222-2222-4222-8222-222222222222';

function createTerminalInput() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (enabled) => { input.isRaw = enabled; };
  return input;
}

function createTerminalOutput() {
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 120;
  output.rows = 36;
  return output;
}

function createSession({ outputFrames, exitCode }) {
  const outputListeners = new Set();
  const titleListeners = new Set();
  let resolveCompleted;
  let started = false;
  const completed = new Promise((resolve) => { resolveCompleted = resolve; });
  function start() {
    if (started) { return; }
    started = true;
    queueMicrotask(() => {
      for (const frame of outputFrames) {
        for (const listener of outputListeners) { listener(frame); }
      }
      resolveCompleted({ exitCode, signal: 0 });
    });
  }
  const session = {
    sessionId: `fixture-${exitCode}`,
    threadId,
    title: 'Shared conversation',
    completed,
    stop() {},
    resize() {},
    submitLocal() {},
    onOutput(listener) {
      outputListeners.add(listener);
      start();
      return () => outputListeners.delete(listener);
    },
    onTitle(listener) {
      titleListeners.add(listener);
      return () => titleListeners.delete(listener);
    },
  };
  return session;
}

async function mainHarness() {
  const input = createTerminalInput();
  const output = createTerminalOutput();
  let visibleOutput = '';
  output.on('data', (data) => { visibleOutput += data.toString('utf8'); });

  const sessions = [
    createSession({
      outputFrames: [
        'ERROR: remote app s\x1b[1Cerver at `ws://127.0.0.1:58849/` transport failed: WebSocket protocol error: Connection reset ',
        'without closing hand\x1b[1Cshake\r\n',
      ],
      exitCode: 1,
    }),
    createSession({ outputFrames: ['RECOVERED\r\n'], exitCode: 0 }),
  ];
  const startCalls = [];
  const exitCode = await main({
    input,
    outputStream: output,
    args: ['resume', threadId],
    cwd: 'C:\\work\\xcode',
    stateRoot: 'fixture-state-root',
    findCodex: () => 'fixture-codex.exe',
    findActiveThread: () => null,
    lifecycleLog() {},
    startSession: async (options) => {
      startCalls.push(options);
      return sessions.shift();
    },
    transportRecoveryDelayMs: 0,
  });

  assert.equal(exitCode, 0, 'The main Codex terminal did not recover from the app-server transport reset.');
  assert.equal(startCalls.length, 2, 'The main Codex terminal did not start a recovery attempt.');
  assert.deepEqual(startCalls[1].args, ['resume', threadId], 'Recovery did not resume the same Codex thread.');
  assert.match(visibleOutput, /Recovering the shared Codex session/i, 'The terminal did not explain that it was recovering the shared session.');
  assert.match(visibleOutput, /RECOVERED/, 'The recovered Codex terminal output was not forwarded.');

  const duplicateInput = createTerminalInput();
  const duplicateOutput = createTerminalOutput();
  let duplicateThreadId = null;
  await main({
    input: duplicateInput,
    outputStream: duplicateOutput,
    args: ['resume', '--model', 'gpt-5.6', '--config', 'service_tier="fast"', threadId],
    cwd: 'C:\\work\\xcode',
    stateRoot: 'fixture-state-root',
    findCodex: () => 'fixture-codex.exe',
    findActiveThread: (_stateRoot, requestedThreadId) => {
      duplicateThreadId = requestedThreadId;
      return { processId: 8123 };
    },
    lifecycleLog() {},
    startSession: async () => { throw new Error('A duplicate restored session must not start a new Codex process.'); },
  });
  assert.equal(duplicateThreadId, threadId, 'A resume option before the thread id bypassed duplicate-session detection.');

  const exhaustedInput = createTerminalInput();
  const exhaustedOutput = createTerminalOutput();
  let exhaustedVisibleOutput = '';
  exhaustedOutput.on('data', (data) => { exhaustedVisibleOutput += data.toString('utf8'); });
  const resetSession = () => createSession({
    outputFrames: ['ERROR: remote app server transport failed: Connection reset without closing handshake\r\n'],
    exitCode: 1,
  });
  const exhaustedSessions = [resetSession(), resetSession(), resetSession()];
  const exhaustedStartCalls = [];
  const exhaustedExitCode = await main({
    input: exhaustedInput,
    outputStream: exhaustedOutput,
    args: ['resume', threadId],
    cwd: 'C:\\work\\xcode',
    stateRoot: 'fixture-state-root',
    findCodex: () => 'fixture-codex.exe',
    findActiveThread: () => null,
    lifecycleLog() {},
    startSession: async (options) => {
      exhaustedStartCalls.push(options);
      return exhaustedSessions.shift();
    },
    transportRecoveryAttempts: 2,
    transportRecoveryDelayMs: 0,
  });
  assert.equal(exhaustedExitCode, 1, "A persistent transport reset must keep Codex's failure exit status.");
  assert.equal(exhaustedStartCalls.length, 3, 'Persistent transport resets must stop after the configured recovery bound.');
  assert.match(exhaustedVisibleOutput, /could not recover after 2 retry attempts/i, 'The bounded recovery failure was not explained to the user.');
  process.stdout.write('MANAGED_CODEX_TRANSPORT_RECOVERY=PASS\n');
}

mainHarness().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
