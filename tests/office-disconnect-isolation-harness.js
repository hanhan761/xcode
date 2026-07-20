#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { WebSocket, WebSocketServer } = require('ws');

const packageRoot = path.resolve(__dirname, '..');
const { relayScopedAppServer } = require(path.join(packageRoot, 'lib', 'scoped-app-server-relay'));

const threadId = '22222222-2222-4222-8222-222222222222';

function waitFor(predicate, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      try {
        if (predicate()) {
          clearInterval(timer);
          resolve();
        }
        else if (Date.now() >= deadline) {
          clearInterval(timer);
          reject(new Error(`Timed out waiting for ${description}.`));
        }
      }
      catch (error) {
        clearInterval(timer);
        reject(error);
      }
    }, 10);
  });
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

async function main() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const url = `ws://127.0.0.1:${server.address().port}`;
  const input = new PassThrough();
  const output = new PassThrough();
  let relayOutput = '';
  let mainConnection = null;
  let officeConnection = null;
  let officeCloseCode = null;
  let officeConnections = 0;
  const mainMessages = [];
  output.on('data', (data) => { relayOutput += data.toString('utf8'); });

  server.on('connection', (socket) => {
    if (!mainConnection) {
      mainConnection = socket;
      socket.on('message', (data) => mainMessages.push(data.toString('utf8')));
      return;
    }
    officeConnection = socket;
    officeConnections += 1;
    socket.on('close', (code) => {
      officeCloseCode = code;
      // This models the authority's protective behavior: an abnormal observer
      // transport reset may be treated as a failure that ends other clients.
      if (code !== 1000 && mainConnection?.readyState === WebSocket.OPEN) {
        mainConnection.close(1011, 'observer transport reset');
      }
    });
  });

  const mainClient = new WebSocket(url);
  try {
    await waitForOpen(mainClient);
    const relay = relayScopedAppServer({ url, threadId, input, output });
    await waitFor(() => relayOutput.includes('"type":"open"'), 1_000, 'the office relay to connect');
    await waitFor(() => officeConnection !== null, 1_000, 'the main app-server to observe the office relay');

    input.end();
    await relay;
    await waitFor(() => officeCloseCode !== null, 1_000, 'the office relay to close');
    assert.equal(officeCloseCode, 1000, 'Office disconnect used an abnormal WebSocket close and can disrupt the main Codex authority.');
    assert.equal(mainClient.readyState, WebSocket.OPEN, 'Office disconnect closed the main Codex app-server client.');
    assert.equal(input.listenerCount('error'), 0, 'A disconnected Office relay retained its input error listener.');
    await waitFor(() => server.clients.size === 1, 1_000, 'the first Office relay connection to be released');

    mainClient.send('main-session-still-live');
    await waitFor(() => mainMessages.includes('main-session-still-live'), 1_000, 'the main session to remain writable after office disconnect');

    const reconnectInput = new PassThrough();
    const reconnectOutput = new PassThrough();
    const reconnectRelay = relayScopedAppServer({ url, threadId, input: reconnectInput, output: reconnectOutput });
    await waitFor(() => officeConnections === 2, 1_000, 'a new Office relay to attach to the same main session');
    reconnectInput.end();
    await reconnectRelay;
    assert.equal(reconnectInput.listenerCount('error'), 0, 'A reconnected Office relay retained its input error listener after cleanup.');
    await waitFor(() => server.clients.size === 1, 1_000, 'the reconnected Office relay connection to be released');
    process.stdout.write('OFFICE_DISCONNECT_ISOLATION=PASS\n');
  }
  finally {
    mainClient.close();
    for (const client of server.clients) { client.terminate(); }
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
