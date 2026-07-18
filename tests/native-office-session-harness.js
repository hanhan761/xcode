'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { WebSocket } = require('ws');
const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const { runNativeCodexOfficeSession } = require(path.join(packageRoot, 'lib', 'native-codex-office-session'));

const session = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  threadId: '22222222-2222-4222-8222-222222222222',
};
const appMessages = [];

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
  let pending = '';
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (data) => {
    pending += data;
    while (true) {
      const newline = pending.indexOf('\n');
      if (newline < 0) { break; }
      const frame = JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      const message = JSON.parse(Buffer.from(frame.data, 'base64').toString('utf8'));
      appMessages.push(message);
      const response = JSON.stringify({ id: message.id, result: { serverInfo: { name: 'fixture' } } });
      child.stdout.write(`${JSON.stringify({ type: 'message', data: Buffer.from(response, 'utf8').toString('base64') })}\n`);
      const started = JSON.stringify({ method: 'turn/started', params: { threadId: session.threadId, turn: { id: 'turn-failed', status: 'inProgress' } } });
      const failed = JSON.stringify({ method: 'turn/completed', params: { threadId: session.threadId, turn: { id: 'turn-failed', status: 'failed' } } });
      child.stdout.write(`${JSON.stringify({ type: 'message', data: Buffer.from(started, 'utf8').toString('base64') })}\n`);
      child.stdout.write(`${JSON.stringify({ type: 'message', data: Buffer.from(failed, 'utf8').toString('base64') })}\n`);
    }
  });
  queueMicrotask(() => child.stdout.write(`${JSON.stringify({ type: 'open' })}\n`));
  return child;
}

function spawnFakeCodex(file, args, options) {
  assert.equal(file, 'fixture-codex.exe');
  assert.deepEqual(args.slice(0, 2), ['resume', '--remote']);
  assert.deepEqual(args.slice(3), ['--no-alt-screen', session.threadId]);
  assert.equal(options.cols, 120);
  assert.equal(options.rows, 36);
  assert.equal(options.useConptyDll, true);
  const dataListeners = new Set();
  const exitListeners = new Set();
  const child = {
    killed: false,
    write() {},
    resize() {},
    kill() { this.killed = true; },
    onData(listener) { dataListeners.add(listener); return { dispose: () => dataListeners.delete(listener) }; },
    onExit(listener) { exitListeners.add(listener); return { dispose: () => exitListeners.delete(listener) }; },
  };

  const socket = new WebSocket(args[2]);
  socket.on('open', () => socket.send(JSON.stringify({ id: 7, method: 'initialize', params: { clientInfo: { name: 'fixture-codex' } } })));
  const received = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString('utf8'));
    received.push(message);
    if (message.id === 7) {
      assert.equal(message.result.serverInfo.name, 'fixture');
      return;
    }
    if (message.method === 'turn/completed') {
      assert.deepEqual(received.map((event) => event.method || `response:${event.id}`), ['response:7', 'turn/started', 'turn/completed']);
      assert.equal(message.params.threadId, session.threadId);
      assert.equal(message.params.turn.status, 'failed');
      socket.close();
    }
  });
  socket.on('close', () => {
    for (const listener of exitListeners) { listener({ exitCode: 0, signal: 0 }); }
  });
  socket.on('error', (error) => {
    for (const listener of exitListeners) { listener({ exitCode: 1, signal: 0, error }); }
  });
  return child;
}

async function main() {
  let gatewayArgs;
  let gatewayOptions;
  const exitCode = await runNativeCodexOfficeSession({
    session,
    codexExecutable: 'fixture-codex.exe',
    openGateway(args, options) {
      gatewayArgs = args;
      gatewayOptions = options;
      return createFakeGateway();
    },
    spawnPty: spawnFakeCodex,
    terminalInput: new PassThrough(),
    terminalOutput: new PassThrough(),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(gatewayArgs, ['native', session.sessionId]);
  assert.deepEqual(gatewayOptions.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(gatewayOptions.windowsHide, true);
  assert.equal(appMessages.length, 1);
  assert.equal(appMessages[0].method, 'initialize');
  process.stdout.write('NATIVE_OFFICE_SESSION=PASS\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
