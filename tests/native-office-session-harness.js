'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { WebSocket } = require('ws');
const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const { runNativeCodexOfficeSession } = require(path.join(packageRoot, 'lib', 'native-codex-office-session'));

const session = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  threadId: '22222222-2222-4222-8222-222222222222',
  model: 'gpt-5.4',
  serviceTier: null,
};
const appMessages = [];
let officeConfigFixture = '';
let completionStatus = 'failed';

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
      if (message.method === 'initialize') {
        const initialized = JSON.stringify({ id: message.id, result: { serverInfo: { name: 'fixture' } } });
        child.stdout.write(`${JSON.stringify({ type: 'message', data: Buffer.from(initialized, 'utf8').toString('base64') })}\n`);
        const started = JSON.stringify({ method: 'turn/started', params: { threadId: session.threadId, turn: { id: `turn-${completionStatus}`, status: 'inProgress' } } });
        const completed = JSON.stringify({ method: 'turn/completed', params: { threadId: session.threadId, turn: { id: `turn-${completionStatus}`, status: completionStatus } } });
        child.stdout.write(`${JSON.stringify({ type: 'message', data: Buffer.from(started, 'utf8').toString('base64') })}\n`);
        child.stdout.write(`${JSON.stringify({ type: 'message', data: Buffer.from(completed, 'utf8').toString('base64') })}\n`);
        continue;
      }
      if (message.method === 'thread/resume') {
        const resumed = JSON.stringify({ id: message.id, result: { thread: { id: session.threadId, status: 'idle' } } });
        child.stdout.write(`${JSON.stringify({ type: 'message', data: Buffer.from(resumed, 'utf8').toString('base64') })}\n`);
      }
    }
  });
  queueMicrotask(() => child.stdout.write(`${JSON.stringify({ type: 'open' })}\n`));
  return child;
}

function spawnFakeCodex(file, args, options) {
  assert.equal(file, 'fixture-codex.exe');
  assert.equal(
    fs.readFileSync(path.join(options.env.CODEX_HOME, 'config.toml'), 'utf8'),
    officeConfigFixture,
    'The fixture must represent an office machine whose local defaults conflict with the main-PC policy.',
  );
  assert.deepEqual(args.slice(0, 5), ['resume', '--model', session.model, '--config', `service_tier="${session.serviceTier || 'default'}"`]);
  assert.equal(args[5], '--remote');
  assert.deepEqual(args.slice(7), ['--no-alt-screen', session.threadId]);
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

  const socket = new WebSocket(args[args.indexOf('--remote') + 1]);
  socket.on('open', () => socket.send(JSON.stringify({ id: 7, method: 'initialize', params: { clientInfo: { name: 'fixture-codex' } } })));
  const received = [];
  let resumed = false;
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString('utf8'));
    received.push(message);
    if (message.id === 7) {
      assert.equal(message.result.serverInfo.name, 'fixture');
      socket.send(JSON.stringify({ id: 8, method: 'thread/resume', params: { threadId: session.threadId } }));
      return;
    }
    if (message.id === 8) {
      assert.equal(message.result.thread.id, session.threadId);
      resumed = true;
      return;
    }
    assert.equal(resumed, true, 'The native TUI received a turn notification before thread/resume completed.');
    if (message.method === 'turn/completed') {
      assert.deepEqual(received.map((event) => event.method || `response:${event.id}`), ['response:7', 'response:8', 'turn/started', 'turn/completed']);
      assert.equal(message.params.threadId, session.threadId);
      assert.equal(message.params.turn.status, completionStatus);
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
  const officeCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-office-fast-config-'));
  try {
    async function runOfficeSession(status) {
      completionStatus = status;
      let gatewayArgs;
      let gatewayOptions;
      const exitCode = await runNativeCodexOfficeSession({
        session,
        codexExecutable: 'fixture-codex.exe',
        env: { ...process.env, CODEX_HOME: officeCodexHome },
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
    }

    officeConfigFixture = 'model = "gpt-5.6-terra"\nservice_tier = "fast"\n';
    fs.writeFileSync(path.join(officeCodexHome, 'config.toml'), officeConfigFixture);
    await runOfficeSession('completed');

    session.model = 'gpt-5.6';
    session.serviceTier = 'fast';
    officeConfigFixture = 'model = "gpt-5.4"\nservice_tier = "default"\n';
    fs.writeFileSync(path.join(officeCodexHome, 'config.toml'), officeConfigFixture);
    await runOfficeSession('interrupted');
    await runOfficeSession('failed');

    assert.equal(appMessages.length, 6);
    assert.deepEqual(appMessages.map((message) => message.method), ['initialize', 'thread/resume', 'initialize', 'thread/resume', 'initialize', 'thread/resume']);
    assert.ok(appMessages.filter((message) => message.method === 'thread/resume').every((message) => message.params.threadId === session.threadId));
    process.stdout.write('NATIVE_OFFICE_SESSION=PASS\n');
  }
  finally {
    fs.rmSync(officeCodexHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
