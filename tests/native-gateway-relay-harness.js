'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');

const packageRoot = path.resolve(__dirname, '..');
const sessionId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const otherThreadId = '33333333-3333-4333-8333-333333333333';

function waitFor(predicate, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      try {
        const result = predicate();
        if (result) { clearInterval(timer); resolve(result); }
        else if (Date.now() >= deadline) { clearInterval(timer); reject(new Error(`Timed out waiting for ${description}.`)); }
      }
      catch (error) { clearInterval(timer); reject(error); }
    }, 20);
  });
}

function writeRelayMessage(stream, message) {
  stream.write(`${JSON.stringify({ type: 'message', data: Buffer.from(JSON.stringify(message), 'utf8').toString('base64') })}\n`);
}

async function main() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-native-gateway-'));
  const stateRoot = path.join(fixtureRoot, 'XcodeRemote', 'managed-sessions');
  fs.mkdirSync(stateRoot, { recursive: true });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const appServerUrl = `ws://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(stateRoot, `${sessionId}.json`), JSON.stringify({
    schemaVersion: 3,
    sessionId,
    sessionToken: 'test-token',
    processId: process.pid,
    pipeName: `\\\\.\\pipe\\xcode-session-${sessionId}`,
    cwd: packageRoot,
    threadId,
    appServerUrl,
    createdAt: new Date().toISOString(),
    ready: true,
  }));

  const received = [];
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString('utf8'));
      received.push(message);
      socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: otherThreadId } }));
      socket.send(JSON.stringify({ method: 'turn/started', params: { threadId, turn: { id: 'turn-1' } } }));
    });
  });

  const gateway = spawn(process.execPath, ['bin/session-gateway.js'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      LOCALAPPDATA: fixtureRoot,
      SSH_ORIGINAL_COMMAND: `xcode-gateway native ${sessionId}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  gateway.stdout.setEncoding('utf8');
  gateway.stderr.setEncoding('utf8');
  let output = '';
  let errors = '';
  gateway.stdout.on('data', (data) => { output += data; });
  gateway.stderr.on('data', (data) => { errors += data; });

  try {
    await waitFor(() => output.includes('"type":"open"'), 5_000, 'the forced native gateway to open');
    writeRelayMessage(gateway.stdin, { id: 1, method: 'turn/start', params: { threadId, input: [] } });
    await waitFor(() => received.length === 1, 5_000, 'the selected-thread request to reach the private app-server');
    assert.equal(received[0].params.threadId, threadId);
    await waitFor(() => output.includes(Buffer.from(JSON.stringify({ method: 'turn/started', params: { threadId, turn: { id: 'turn-1' } } }), 'utf8').toString('base64')), 5_000, 'the matching notification to return');
    assert.equal(output.includes(Buffer.from(JSON.stringify({ method: 'turn/started', params: { threadId: otherThreadId } }), 'utf8').toString('base64')), false, 'a different thread leaked through the relay');

    writeRelayMessage(gateway.stdin, { id: 2, method: 'thread/list', params: {} });
    const exitCode = await new Promise((resolve, reject) => {
      gateway.once('error', reject);
      gateway.once('exit', resolve);
    });
    assert.equal(exitCode, 1, `denied request should close the gateway: ${errors}`);
    assert.match(output, /"type":"error"/);
    assert.equal(received.length, 1, 'the denied history request reached the private app-server');
    process.stdout.write('NATIVE_GATEWAY_RELAY=PASS\n');
  }
  finally {
    if (!gateway.killed) { gateway.kill(); }
    for (const socket of server.clients) { socket.terminate(); }
    await new Promise((resolve) => server.close(() => resolve()));
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
