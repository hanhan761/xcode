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

function gatewayFrame(frame) {
  return `${JSON.stringify(frame)}\n`;
}

function createFakeGateway({ resetAfterInitialize, receivedMethods }) {
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
      receivedMethods.push(message.method);
      const response = JSON.stringify({ id: message.id, result: { serverInfo: { name: 'fixture' } } });
      child.stdout.write(gatewayFrame({ type: 'message', data: Buffer.from(response, 'utf8').toString('base64') }));
      if (resetAfterInitialize) {
        queueMicrotask(() => child.stdout.write(gatewayFrame({
          type: 'close',
          reason: 'Connection reset without closing handshake',
        })));
      }
    }
  });
  queueMicrotask(() => child.stdout.write(gatewayFrame({ type: 'open' })));
  return child;
}

function createFakeCodexSpawner({ closeAfterResponse = (attempt) => attempt > 0 } = {}) {
  let launches = 0;
  const urls = [];

  function spawnFakeCodex(file, args) {
    const attempt = launches;
    launches += 1;
    assert.equal(file, 'fixture-codex.exe');
    assert.deepEqual(args.slice(0, 2), ['resume', '--remote']);
    assert.deepEqual(args.slice(3), ['--no-alt-screen', session.threadId]);
    urls.push(args[2]);

    const dataListeners = new Set();
    const exitListeners = new Set();
    let socket;
    const child = {
      killed: false,
      write() {},
      resize() {},
      kill() {
        this.killed = true;
        socket?.close();
      },
      onData(listener) { dataListeners.add(listener); return { dispose: () => dataListeners.delete(listener) }; },
      onExit(listener) { exitListeners.add(listener); return { dispose: () => exitListeners.delete(listener) }; },
    };

    socket = new WebSocket(args[2]);
    socket.on('open', () => socket.send(JSON.stringify({ id: attempt + 1, method: 'initialize', params: { clientInfo: { name: 'fixture-codex' } } })));
    socket.on('message', () => {
      if (closeAfterResponse(attempt)) { socket.close(); }
    });
    socket.on('close', () => {
      for (const listener of exitListeners) { listener({ exitCode: attempt > 0 ? 0 : 1, signal: 0 }); }
    });
    socket.on('error', () => {
      for (const listener of exitListeners) { listener({ exitCode: 1, signal: 0 }); }
    });
    return child;
  }

  return {
    spawnFakeCodex,
    launches: () => launches,
    urls: () => urls,
  };
}

async function main() {
  const receivedMethods = [];
  let gatewayAttempts = 0;
  const codex = createFakeCodexSpawner();
  const exitCode = await runNativeCodexOfficeSession({
    session,
    codexExecutable: 'fixture-codex.exe',
    openGateway: () => createFakeGateway({
      resetAfterInitialize: gatewayAttempts++ === 0,
      receivedMethods,
    }),
    spawnPty: codex.spawnFakeCodex,
    terminalInput: new PassThrough(),
    terminalOutput: new PassThrough(),
    transportRecoveryDelayMs: 0,
  });

  assert.equal(exitCode, 0, 'The office Codex session did not recover from the transport reset.');
  assert.equal(gatewayAttempts, 2, 'The office relay was not reopened after the transport reset.');
  assert.equal(codex.launches(), 2, 'The official Codex client was not resumed after the transport reset.');
  assert.deepEqual(receivedMethods, ['initialize', 'initialize'], 'The recovered client did not reinitialize the same app-server protocol.');
  assert.equal(new Set(codex.urls()).size, 2, 'Recovery reused a dead local relay URL instead of creating a healthy one.');

  const persistentResetMethods = [];
  let persistentGatewayAttempts = 0;
  const persistentCodex = createFakeCodexSpawner({ closeAfterResponse: () => false });
  await assert.rejects(
    runNativeCodexOfficeSession({
      session,
      codexExecutable: 'fixture-codex.exe',
      openGateway: () => {
        persistentGatewayAttempts += 1;
        return createFakeGateway({
          resetAfterInitialize: true,
          receivedMethods: persistentResetMethods,
        });
      },
      spawnPty: persistentCodex.spawnFakeCodex,
      terminalInput: new PassThrough(),
      terminalOutput: new PassThrough(),
      transportRecoveryAttempts: 2,
      transportRecoveryDelayMs: 0,
    }),
    /transport reset 3 times and could not recover/i,
    'Persistent office transport resets must stop after the configured recovery bound.',
  );
  assert.equal(persistentGatewayAttempts, 3, 'Persistent office transport resets must stop after the configured recovery bound.');
  assert.equal(persistentCodex.launches(), 3, 'Persistent office transport resets must stop after the configured recovery bound.');
  assert.deepEqual(persistentResetMethods, ['initialize', 'initialize', 'initialize'], 'Each bounded retry must reinitialize the same app-server protocol.');
  process.stdout.write('NATIVE_OFFICE_TRANSPORT_RECOVERY=PASS\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
