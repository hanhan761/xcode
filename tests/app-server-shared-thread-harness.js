#!/usr/bin/env node
'use strict';

// This is deliberately opt-in: it talks to the real locally authenticated
// Codex app-server and spends one small, ephemeral model turn.  It proves the
// invariant that matters for xcode: a turn submitted through one client is
// observed by a second client that resumed the *same* thread id.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const pty = require('node-pty');

const RUN = process.env.XCODE_RUN_APP_SERVER_SHARED_THREAD === '1';

function findNativeCodex() {
  const root = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
  for (const packageName of fs.readdirSync(root)) {
    if (!/^codex-win32-/i.test(packageName)) { continue; }
    const vendorRoot = path.join(root, packageName, 'vendor');
    for (const vendor of fs.readdirSync(vendorRoot)) {
      const executable = path.join(vendorRoot, vendor, 'bin', 'codex.exe');
      if (fs.existsSync(executable)) { return executable; }
    }
  }
  throw new Error('The native Windows Codex executable was not found.');
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitFor(predicate, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let checking = false;
    const timer = setInterval(async () => {
      if (checking) { return; }
      checking = true;
      try {
        if (await predicate()) {
          clearInterval(timer);
          resolve();
        }
        else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error(`Timed out waiting for ${description}.`));
        }
      }
      catch (error) {
        clearInterval(timer);
        reject(error);
      }
      finally {
        checking = false;
      }
    }, 25);
  });
}

class RpcClient {
  constructor(url, name) {
    this.url = url;
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (Object.prototype.hasOwnProperty.call(message, 'id')) {
        const pending = this.pending.get(message.id);
        if (!pending) { return; }
        this.pending.delete(message.id);
        if (message.error) { pending.reject(new Error(`${this.name} ${message.error.message || JSON.stringify(message.error)}`)); }
        else { pending.resolve(message.result); }
        return;
      }
      this.notifications.push(message);
    });
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error(`Could not open ${this.name} websocket.`)), { once: true });
    });
    await this.request('initialize', { clientInfo: { name: `xcode-${this.name}`, version: 'test' } });
  }

  request(method, params) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    this.socket?.close();
  }
}

async function main() {
  if (!RUN) {
    console.log('APP_SERVER_SHARED_THREAD=SKIPPED (set XCODE_RUN_APP_SERVER_SHARED_THREAD=1 to run the authenticated live proof)');
    return;
  }

  const port = await reservePort();
  const url = `ws://127.0.0.1:${port}`;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-app-server-proof-'));
  const server = spawn(findNativeCodex(), ['app-server', '--listen', url], {
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const log = [];
  server.stdout.on('data', (data) => log.push(data.toString()));
  server.stderr.on('data', (data) => log.push(data.toString()));
  const mainClient = new RpcClient(url, 'main');
  const officeClient = new RpcClient(url, 'office');
  const marker = `xcode-shared-thread-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let threadId;
  let remoteTui;

  try {
    await waitFor(async () => {
      try {
        const probe = new WebSocket(url);
        await new Promise((resolve, reject) => {
          probe.addEventListener('open', resolve, { once: true });
          probe.addEventListener('error', reject, { once: true });
        });
        probe.close();
        return true;
      }
      catch { return false; }
    }, 15_000, 'the loopback Codex app-server');
    await mainClient.connect();
    const started = await mainClient.request('thread/start', {
      cwd: workspace,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
    threadId = started.thread?.id || started.threadId;
    assert.ok(threadId, `thread/start did not return a thread id: ${JSON.stringify(started)}`);

    await mainClient.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Reply with exactly: xcode-app-server-ready. Do not use tools.' }],
      approvalPolicy: 'never',
    });
    await waitFor(
      () => mainClient.notifications.some((event) => event.method === 'turn/completed' && event.params?.threadId === threadId),
      90_000,
      'the initial shared thread to become resumable',
    );

    let tuiOutput = '';
    remoteTui = pty.spawn(findNativeCodex(), ['resume', '--remote', url, '--no-alt-screen', threadId], {
      name: 'xterm-256color',
      cols: 120,
      rows: 36,
      cwd: workspace,
      env: process.env,
      useConptyDll: true,
    });
    remoteTui.onData((data) => { tuiOutput += data; });
    await waitFor(() => tuiOutput.includes('xcode-app-server-ready'), 30_000, 'the main Codex TUI to render the resumed thread');

    const resumed = await officeClient.connect().then(() => officeClient.request('thread/resume', { threadId }));
    assert.equal(resumed.thread?.id || resumed.threadId, threadId, 'The office client resumed a different thread.');

    await officeClient.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: `Reply with exactly: ${marker}. Do not use tools.` }],
      approvalPolicy: 'never',
    });
    await waitFor(
      () => mainClient.notifications.some((event) => event.method === 'turn/started' && event.params?.threadId === threadId),
      30_000,
      'the main subscriber to observe the office-started turn',
    );
    await waitFor(
      () => mainClient.notifications.some((event) => event.method === 'item/agentMessage/delta' && event.params?.threadId === threadId),
      90_000,
      'the main subscriber to observe the shared Codex response',
    );
    await waitFor(() => tuiOutput.includes(marker), 30_000, 'the main Codex TUI to render the office-started response');
    console.log('APP_SERVER_SHARED_THREAD=PASS');
  }
  catch (error) {
    error.message += `\napp-server log:\n${log.join('')}`;
    throw error;
  }
  finally {
    if (remoteTui) {
      const tuiExited = new Promise((resolve) => remoteTui.onExit(resolve));
      remoteTui.kill();
      const exited = await Promise.race([tuiExited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 2_000))]);
      if (!exited && Number.isInteger(remoteTui.pid)) {
        // This is our own test-only ConPTY child.  Windows occasionally keeps
        // the native TUI attached after a pseudo-terminal close.
        spawnSync('taskkill.exe', ['/pid', String(remoteTui.pid), '/t', '/f'], { windowsHide: true });
      }
    }
    if (threadId && mainClient.socket?.readyState === WebSocket.OPEN) {
      try { await mainClient.request('thread/delete', { threadId }); }
      catch { /* Do not hide the semantic test result if the server is already stopping. */ }
    }
    mainClient.close();
    officeClient.close();
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3 }); }
    catch { /* A Windows child can release its cwd a moment after exit; temp cleanup is best effort. */ }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  },
);
