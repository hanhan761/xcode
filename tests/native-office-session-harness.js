'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { WebSocket } = require('ws');
const { runNativeCodexOfficeSession } = require('../lib/native-codex-office-session');

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
    }
  });
  queueMicrotask(() => child.stdout.write(`${JSON.stringify({ type: 'open' })}\n`));
  return child;
}

function spawnFakeCodex(file, args, options) {
  assert.equal(file, 'fixture-codex.exe');
  assert.deepEqual(args.slice(0, 2), ['resume', '--remote']);
  assert.deepEqual(args.slice(3), ['--no-alt-screen', session.threadId]);
  assert.equal(options.stdio, 'inherit');
  assert.equal(options.windowsHide, true);
  const child = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 130;
  };

  const socket = new WebSocket(args[2]);
  socket.on('open', () => socket.send(JSON.stringify({ id: 7, method: 'initialize', params: { clientInfo: { name: 'fixture-codex' } } })));
  socket.on('message', (data) => {
    const response = JSON.parse(data.toString('utf8'));
    assert.equal(response.id, 7);
    socket.close();
  });
  socket.on('close', () => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
  });
  socket.on('error', (error) => child.emit('error', error));
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
    spawnProcess: spawnFakeCodex,
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
