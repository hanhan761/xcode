'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const packageRoot = path.resolve(__dirname, '..');
const { main } = require(path.join(packageRoot, 'bin', 'managed-codex'));

const currentThread = '11111111-1111-4111-8111-111111111111';
const otherThread = '22222222-2222-4222-8222-222222222222';

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

function createSession(cwd) {
  const outputListeners = new Set();
  let resolveCompleted;
  const completed = new Promise((resolve) => { resolveCompleted = resolve; });
  return {
    sessionId: 'fixture-session',
    threadId: currentThread,
    cwd,
    title: 'Current project conversation',
    completed,
    stop() {},
    resize() {},
    submitLocal() {},
    onTitle(listener) {
      queueMicrotask(() => listener('Current project conversation'));
      return () => {};
    },
    onOutput(listener) {
      outputListeners.add(listener);
      queueMicrotask(() => {
        for (const outputListener of outputListeners) { outputListener('DONE\r\n'); }
        resolveCompleted({ exitCode: 0, signal: 0 });
      });
      return () => outputListeners.delete(listener);
    },
  };
}

async function mainHarness() {
  const currentWorkspace = 'C:\\work\\current-project';
  const records = [{
    threadId: currentThread,
    cwd: currentWorkspace,
    title: 'Current project conversation',
    updatedAt: 2,
  }];
  const recorded = [];
  let listedCwd = null;
  let selectedCandidates = null;
  let startArgs = null;
  const exitCode = await main({
    input: createTerminalInput(),
    outputStream: createTerminalOutput(),
    args: ['resume'],
    cwd: currentWorkspace,
    stateRoot: 'fixture-state-root',
    findCodex: () => 'fixture-codex.exe',
    findActiveThread: () => null,
    lifecycleLog() {},
    resumeIndex: {
      list(cwd) { listedCwd = cwd; return records; },
      record(entry) { recorded.push(entry); },
    },
    chooseResume: async ({ candidates }) => {
      selectedCandidates = candidates;
      return candidates[0].threadId;
    },
    startSession: async ({ args }) => {
      startArgs = args;
      return createSession(currentWorkspace);
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(listedCwd, currentWorkspace, 'The default resume selector did not use the current workspace.');
  assert.deepEqual(selectedCandidates, records, 'The default resume selector received a cross-workspace candidate.');
  assert.deepEqual(startArgs, ['resume', currentThread], 'The default resume selector did not resume its current-workspace choice.');
  assert.equal(recorded.at(-1).threadId, currentThread, 'A resumed managed session did not refresh its workspace record.');

  let explicitStartArgs = null;
  await main({
    input: createTerminalInput(),
    outputStream: createTerminalOutput(),
    args: ['resume', otherThread],
    cwd: currentWorkspace,
    stateRoot: 'fixture-state-root',
    findCodex: () => 'fixture-codex.exe',
    findActiveThread: () => null,
    lifecycleLog() {},
    resumeIndex: { list: () => { throw new Error('An explicit thread id must not enumerate workspace candidates.'); }, record() {} },
    chooseResume: async () => { throw new Error('An explicit thread id must not open the workspace selector.'); },
    startSession: async ({ args }) => {
      explicitStartArgs = args;
      return createSession(currentWorkspace);
    },
  });
  assert.deepEqual(explicitStartArgs, ['resume', otherThread], 'An explicit cross-workspace thread id changed its existing resume behavior.');

  await assert.rejects(
    main({
      input: createTerminalInput(),
      outputStream: createTerminalOutput(),
      args: ['resume'],
      cwd: currentWorkspace,
      stateRoot: 'fixture-state-root',
      findCodex: () => 'fixture-codex.exe',
      findActiveThread: () => null,
      lifecycleLog() {},
      resumeIndex: { list: () => [], record() {} },
      startSession: async () => { throw new Error('An empty workspace resume list must not start a new conversation.'); },
    }),
    /no saved managed Codex conversation in this folder/i,
    'An empty current-workspace resume list fell back to another conversation source.',
  );

  let lastStartArgs = null;
  await main({
    input: createTerminalInput(),
    outputStream: createTerminalOutput(),
    args: ['resume', '--last'],
    cwd: currentWorkspace,
    stateRoot: 'fixture-state-root',
    findCodex: () => 'fixture-codex.exe',
    findActiveThread: () => null,
    lifecycleLog() {},
    resumeIndex: { list: () => { throw new Error('resume --last must not open the interactive workspace selector.'); }, record() {} },
    chooseResume: async () => { throw new Error('resume --last must not open the interactive workspace selector.'); },
    startSession: async ({ args }) => {
      lastStartArgs = args;
      return createSession(currentWorkspace);
    },
  });
  assert.deepEqual(lastStartArgs, ['resume', '--last'], 'resume --last did not preserve its current-workspace app-server path.');

  process.stdout.write('MANAGED_CODEX_RESUME_SCOPE=PASS\n');
}

mainHarness().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
