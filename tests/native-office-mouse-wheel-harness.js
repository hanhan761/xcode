'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { Terminal } = require('@xterm/headless');
const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const { runNativeCodexOfficeSession } = require(path.join(packageRoot, 'lib', 'native-codex-office-session'));

const session = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  threadId: '22222222-2222-4222-8222-222222222222',
  cwd: 'C:\\work\\xcode',
  title: '持久标题',
};

function waitFor(predicate, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      try {
        if (predicate()) { clearInterval(timer); resolve(); }
        else if (Date.now() >= deadline) {
          clearInterval(timer);
          reject(new Error(`Timed out waiting for ${description}.`));
        }
      }
      catch (error) { clearInterval(timer); reject(error); }
    }, 10);
  });
}

function createFakeGateway() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    if (child.killed) { return; }
    child.killed = true;
    child.emit('exit', 0);
  };
  child.sendAppMessage = (message) => {
    const text = JSON.stringify(message);
    child.stdout.write(`${JSON.stringify({ type: 'message', data: Buffer.from(text, 'utf8').toString('base64') })}\n`);
  };
  queueMicrotask(() => child.stdout.write(`${JSON.stringify({ type: 'open' })}\n`));
  return child;
}

function createTerminalInput() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.rawTransitions = [];
  input.setRawMode = (enabled) => {
    input.isRaw = enabled;
    input.rawTransitions.push(enabled);
  };
  return input;
}

async function main() {
  const terminalInput = createTerminalInput();
  const terminalOutput = new PassThrough();
  terminalOutput.columns = 100;
  terminalOutput.rows = 24;
  terminalOutput.setEncoding('utf8');
  const hostTerminal = new Terminal({ cols: 100, rows: 24, scrollback: 200, allowProposedApi: true });
  let visibleOutput = '';
  terminalOutput.on('data', (data) => {
    visibleOutput += data;
    hostTerminal.write(data);
  });
  let fakePty;
  let gateway;

  function spawnPty(file, args, options) {
    assert.equal(file, 'fixture-codex.exe');
    assert.deepEqual(args, ['resume', '--remote', args[2], '--no-alt-screen', session.threadId]);
    assert.equal(options.cols, 100);
    assert.equal(options.rows, 24);
    const dataListeners = new Set();
    const exitListeners = new Set();
    fakePty = {
      pid: 1234,
      writes: [],
      resizes: [],
      killed: false,
      write(data) {
        this.writes.push(data);
      },
      resize(cols, rows) { this.resizes.push({ cols, rows }); },
      kill() { this.killed = true; },
      emitData(data) { dataListeners.forEach((listener) => listener(data)); },
      emitExit(event) { exitListeners.forEach((listener) => listener(event)); },
      onData(listener) { dataListeners.add(listener); return { dispose: () => dataListeners.delete(listener) }; },
      onExit(listener) { exitListeners.add(listener); return { dispose: () => exitListeners.delete(listener) }; },
    };
    queueMicrotask(() => dataListeners.forEach((listener) => listener('OFFICIAL_CODEX_READY')));
    return fakePty;
  }

  const run = runNativeCodexOfficeSession({
    session,
    codexExecutable: 'fixture-codex.exe',
    openGateway: () => {
      gateway = createFakeGateway();
      return gateway;
    },
    spawnPty,
    terminalInput,
    terminalOutput,
  });

  await waitFor(() => visibleOutput.includes('OFFICIAL_CODEX_READY'), 1_000, 'the office native terminal to start');
  assert.match(visibleOutput, /\x1b\]0;持久标题\x07/, 'The office tab did not receive the persisted conversation title.');
  gateway.sendAppMessage({
    method: 'thread/name/updated',
    params: { threadId: session.threadId, threadName: '实时同步标题' },
  });
  await waitFor(() => visibleOutput.includes('\x1b]0;实时同步标题\x07'), 500, 'the renamed title to reach the office tab');
  const splitTitleStart = visibleOutput.length;
  fakePty.emitData('\x1b]0;official-child');
  assert.equal(
    visibleOutput.slice(splitTitleStart).includes('\x1b]0;实时同步标题\x07'),
    false,
    'The adapter injected a managed OSC title inside an incomplete official OSC sequence.',
  );
  fakePty.emitData('-title\x07');
  await waitFor(
    () => visibleOutput.lastIndexOf('\x1b]0;实时同步标题\x07') > visibleOutput.lastIndexOf('\x1b]0;official-child-title\x07'),
    500,
    'the persistent office title to win after a split official title update',
  );
  gateway.sendAppMessage({
    method: 'thread/name/updated',
    params: { threadId: session.threadId, threadName: 'Shared conversation' },
  });
  await waitFor(() => visibleOutput.includes('\x1b]0;official-child-title — Shared conversation\x07'), 500, 'the renamed session title to remain attached to the current official title frame');
  const animatedTitleStart = visibleOutput.length;
  fakePty.emitData('\x1b]0;\u280b xcode');
  assert.equal(
    visibleOutput.slice(animatedTitleStart).includes('\x1b]0;\u280b xcode — Shared conversation\x07'),
    false,
    'The adapter emitted a completed animated title before the official frame completed.',
  );
  fakePty.emitData('\x07\x1b]0;\u2819 xcode\x07');
  await waitFor(
    () => visibleOutput.includes('\x1b]0;\u280b xcode — Shared conversation\x07')
      && visibleOutput.includes('\x1b]0;\u2819 xcode — Shared conversation\x07'),
    500,
    'the office tab to receive every animated title frame with the shared conversation title',
  );
  assert.doesNotMatch(
    visibleOutput.slice(animatedTitleStart),
    /\x1b\]0;\u280b xcode\x07|\x1b\]0;\u2819 xcode\x07/,
    'The office adapter let an undecorated official title replace the shared conversation title.',
  );
  assert.match(visibleOutput, /\x1b\[\?1000l/);
  assert.match(visibleOutput, /\x1b\[\?1006l/);
  assert.doesNotMatch(visibleOutput, /\x1b\[\?100[0236]h/, 'The office adapter captured the host terminal mouse wheel.');

  terminalInput.write('hello');
  await waitFor(() => fakePty.writes.includes('hello'), 500, 'ordinary keyboard input to reach official Codex');
  terminalInput.write('\x1b');
  await waitFor(() => fakePty.writes.includes('\x1b'), 500, 'a standalone Escape key to reach official Codex');

  const unicode = Buffer.from('中', 'utf8');
  terminalInput.write(unicode.subarray(0, 1));
  terminalInput.write(unicode.subarray(1));
  await waitFor(() => fakePty.writes.includes('中'), 500, 'split UTF-8 keyboard input to remain intact');

  terminalOutput.columns = 132;
  terminalOutput.rows = 37;
  terminalOutput.emit('resize');
  await waitFor(() => fakePty.resizes.some(({ cols, rows }) => cols === 132 && rows === 37), 500, 'the office ConPTY resize');

  fakePty.emitData(Array.from({ length: 80 }, (_, index) => `HISTORY_${index}\r\n`).join(''));
  await waitFor(() => hostTerminal.buffer.normal.baseY > 0, 500, 'normal terminal scrollback to accumulate');
  assert.equal(hostTerminal.buffer.active.type, 'normal', 'The office client switched away from the host scrollback buffer.');
  const liveViewport = hostTerminal.buffer.normal.viewportY;
  hostTerminal.scrollLines(-5);
  assert.ok(hostTerminal.buffer.normal.viewportY < liveViewport, 'The normal terminal history could not scroll upward.');

  // Complete through the same native child exit callback used in production.
  fakePty.emitExit({ exitCode: 0, signal: 0 });

  const exitCode = await run;
  assert.equal(exitCode, 0);
  assert.deepEqual(terminalInput.rawTransitions, [true, false]);
  assert.match(visibleOutput, /\x1b\[\?1000l/);
  assert.match(visibleOutput, /\x1b\[\?1006l/);
  process.stdout.write('NATIVE_OFFICE_MOUSE_WHEEL=PASS\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
