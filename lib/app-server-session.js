'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const pty = require('node-pty');
const { WebSocket } = require('ws');
const { createSessionGateway, normalizeRemoteMessage } = require('./session-runner');
const { resolveSessionTitle } = require('./session-title');
const { acquireSharedAppServer } = require('./app-server-host');
const { prepareHiddenCodexEnvironment } = require('./windows-shell-shim');

const MAX_SCROLLBACK_BYTES = 512 * 1024;

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function appendScrollback(current, data) {
  const combined = current + data;
  if (Buffer.byteLength(combined, 'utf8') <= MAX_SCROLLBACK_BYTES) { return combined; }
  return Buffer.from(combined, 'utf8').subarray(-MAX_SCROLLBACK_BYTES).toString('utf8');
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
        else if (Date.now() >= deadline) {
          clearInterval(timer);
          reject(new Error(`Timed out waiting for ${description}.`));
        }
      }
      catch (error) {
        clearInterval(timer);
        reject(error);
      }
      finally { checking = false; }
    }, 25);
  });
}

function requestWithTimeout(request, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), timeoutMs);
    Promise.resolve()
      .then(request)
      .then(
        (result) => { clearTimeout(timer); resolve(result); },
        (error) => { clearTimeout(timer); reject(error); },
      );
  });
}

async function waitForAppServer(url, timeoutMs = 15_000) {
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
  }, timeoutMs, 'the local Codex app-server');
}

async function acquireDedicatedAppServer({ file, cwd, env }) {
  const port = await reserveLoopbackPort();
  const url = `ws://127.0.0.1:${port}`;
  const logs = [];
  const hiddenShell = prepareHiddenCodexEnvironment({ env, codexExecutable: file });
  const child = pty.spawn(file, ['--disable', 'computer_use', 'app-server', '--listen', url], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd, env: hiddenShell.env, useConptyDll: true,
  });
  let exitResult = null;
  child.onData((data) => {
    logs.push(data);
    if (logs.length > 200) { logs.splice(0, logs.length - 200); }
  });
  child.onExit((result) => { exitResult = result; });
  try {
    await waitFor(() => {
      if (exitResult) {
        throw new Error(`Codex app-server exited ${exitResult.exitCode}.`);
      }
      return waitForAppServer(url, 250).then(() => true, () => false);
    }, 15_000, 'the dedicated local Codex app-server');
  }
  catch (error) {
    if (!exitResult) { child.kill(); }
    const detail = logs.join('').trim();
    if (detail) { error.message += `\nCodex app-server: ${detail}`; }
    throw error;
  }
  let released = false;
  return {
    url,
    processId: child.pid,
    async release() {
      if (released) { return; }
      released = true;
      if (!exitResult) { child.kill(); }
    },
  };
}

function shouldShareAppServer(args) {
  return Array.isArray(args) && args[0] === 'resume';
}

class AppServerClient {
  constructor(url, name = 'xcode') {
    this.url = url;
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closeListeners = new Set();
    this.closed = false;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', (event) => this.#onMessage(event));
    this.socket.addEventListener('close', () => this.#onClose());
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error(`Could not connect ${this.name} to the local Codex app-server.`)), { once: true });
    });
    await this.request('initialize', { clientInfo: { name: this.name, version: '1.0' } });
    return this;
  }

  #onMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); }
    catch { return; }
    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending) { return; }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      }
      else { pending.resolve(message.result); }
      return;
    }
    for (const listener of this.listeners) { listener(message); }
  }

  #onClose() {
    if (this.closed) { return; }
    this.closed = true;
    for (const { reject } of this.pending.values()) {
      reject(new Error('The local Codex app-server connection closed.'));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) { listener(); }
  }

  request(method, params) {
    if (this.closed || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('The local Codex app-server is unavailable.'));
    }
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  onNotification(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close() {
    this.closed = true;
    this.socket?.close();
    for (const { reject } of this.pending.values()) {
      reject(new Error('The local Codex app-server connection closed.'));
    }
    this.pending.clear();
  }
}

async function resolveThreadRequest(authority, args, cwd) {
  if (args[0] === 'resume' && args[1] === '--last') {
    const listed = await authority.request('thread/list', { cwd, limit: 1, sortKey: 'recency_at', sortDirection: 'desc' });
    const latest = listed.data?.[0];
    if (!latest?.id) { throw new Error('There is no saved Codex thread in this folder to resume. Start one with codex first.'); }
    // A resume must retain the thread's persisted workspace. In particular,
    // recovery may have to launch its terminal from a fallback folder when an
    // old workspace is temporarily unavailable; that fallback must never
    // overwrite the Codex thread's own cwd.
    return { method: 'thread/resume', params: { threadId: latest.id } };
  }
  if (args[0] === 'resume' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(args[1] || '')) {
    return { method: 'thread/resume', params: { threadId: args[1] } };
  }
  const params = { cwd };
  for (let index = 0; index < args.length; index += 1) {
    if ((args[index] === '--model' || args[index] === '-m') && args[index + 1]) {
      params.model = args[index + 1];
      index += 1;
    }
    else if ((args[index] === '--sandbox' || args[index] === '-s') && args[index + 1]) {
      params.sandbox = args[index + 1];
      index += 1;
    }
    else if ((args[index] === '--ask-for-approval' || args[index] === '-a') && args[index + 1]) {
      params.approvalPolicy = args[index + 1];
      index += 1;
    }
  }
  return { method: 'thread/start', params };
}

async function initializeNewThreadForRemoteTui(authority, threadId, {
  requestTimeoutMs = 15_000,
  completionTimeoutMs = 60_000,
} = {}) {
  // `codex resume --remote` requires a persisted rollout. A bare
  // `thread/start` creates thread metadata but no rollout, so the native TUI
  // rejects it with "no rollout found". An empty turn creates that internal
  // rollout without injecting a user message into the conversation.
  let completed = false;
  const unsubscribe = authority.onNotification((event) => {
    if (event.method === 'turn/completed' && event.params?.threadId === threadId) {
      completed = true;
    }
  });
  try {
    await requestWithTimeout(
      () => authority.request('turn/start', { threadId, input: [] }),
      requestTimeoutMs,
      'the initial Codex bootstrap request',
    );
    // A cold app-server may need to bring up MCP servers before it can finish
    // even this empty bootstrap turn.  Keep this bounded, but do not reject a
    // healthy first launch merely because it exceeded a short UI-startup
    // timeout.
    await waitFor(() => completed, completionTimeoutMs, 'the initial Codex thread rollout');
  }
  finally { unsubscribe(); }
}

async function startSharedAppServerSession({
  file,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  cols = 120,
  rows = 36,
  sessionId = crypto.randomUUID(),
  stateRoot = path.join(env.LOCALAPPDATA || process.cwd(), 'XcodeRemote', 'managed-sessions'),
  onStatus = () => {},
}) {
  if (!file || typeof file !== 'string') { throw new TypeError('A shared Codex session requires a program path.'); }
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) { throw new TypeError('Shared-session arguments must be text values.'); }
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || rows < 5) { throw new RangeError('Shared-session terminal dimensions are invalid.'); }
  if (typeof onStatus !== 'function') { throw new TypeError('Shared-session status callback must be a function.'); }

  const reuseRecoveryHost = shouldShareAppServer(args);
  const hostRoot = path.join(path.dirname(stateRoot), 'app-server-host');
  let authority;
  let host;
  let tui;
  let gateway;
  let closed = false;
  let activeThreadId = null;
  let sessionCwd = cwd;
  let currentTitle = resolveSessionTitle(null, cwd);
  let unsubscribeTitle = () => {};
  let scrollback = '';
  let currentCols = cols;
  let currentRows = rows;
  const outputListeners = new Set();
  const dimensionListeners = new Set();
  const titleListeners = new Set();
  let resolveCompleted;
  const completed = new Promise((resolve) => { resolveCompleted = resolve; });

  let cleanupPromise = null;
  async function cleanup() {
    if (cleanupPromise) { return cleanupPromise; }
    cleanupPromise = (async () => {
      if (closed) { return; }
      closed = true;
      gateway?.close();
      unsubscribeTitle();
      authority?.close();
      await host?.release();
    })();
    return cleanupPromise;
  }

  function emitOutput(data) {
    scrollback = appendScrollback(scrollback, data);
    for (const listener of outputListeners) { listener(data); }
  }

  try {
    onStatus(reuseRecoveryHost ? 'Restoring the saved Codex authority…' : 'Starting a dedicated Codex authority…');
    host = reuseRecoveryHost
      ? await acquireSharedAppServer({ file, cwd, env, hostRoot })
      : await acquireDedicatedAppServer({ file, cwd, env });
    authority = await new AppServerClient(host.url, 'xcode-main-authority').connect();
    authority.onClose(() => {
      if (!closed && tui) {
        emitOutput('\r\n[xcode] The local shared Codex thread authority stopped.\r\n');
        tui.kill();
      }
    });
    const request = await resolveThreadRequest(authority, args, cwd);
    const started = await authority.request(request.method, request.params);
    const threadId = started.thread?.id || started.threadId;
    if (!threadId) { throw new Error('The local Codex app-server did not return a thread id.'); }
    activeThreadId = threadId;
    sessionCwd = started.thread?.cwd || cwd;
    currentTitle = resolveSessionTitle(started.thread?.name, sessionCwd);
    unsubscribeTitle = authority.onNotification((event) => {
      if (event.method !== 'thread/name/updated' || event.params?.threadId !== activeThreadId) { return; }
      const nextTitle = resolveSessionTitle(event.params?.threadName, sessionCwd);
      if (nextTitle === currentTitle) { return; }
      currentTitle = nextTitle;
      gateway?.updateTitle(currentTitle);
      for (const listener of titleListeners) { listener(currentTitle); }
    });
    if (request.method === 'thread/start') {
      onStatus('Preparing the new shared Codex conversation…');
      await initializeNewThreadForRemoteTui(authority, threadId);
    }
    onStatus('Opening the native Codex terminal…');

    // The TUI is a normal Codex client. It resumes its own thread against the
    // host-wide authority shared by every managed local session.
    tui = pty.spawn(file, ['resume', '--remote', host.url, '--no-alt-screen', threadId], {
      name: 'xterm-256color', cols, rows, cwd, env, useConptyDll: true,
    });
    tui.onData(emitOutput);
    tui.onExit(({ exitCode, signal }) => {
      cleanup().catch(() => {}).finally(() => resolveCompleted({ exitCode, signal }));
    });

    gateway = createSessionGateway({
      sessionId,
      sessionToken: crypto.randomBytes(32).toString('base64url'),
      processId: tui.pid,
      stateRoot,
      cwd: sessionCwd,
      title: currentTitle,
      threadId,
      appServerUrl: host.url,
      getSnapshot: () => scrollback,
      getDimensions: () => ({ cols: currentCols, rows: currentRows }),
      resizeTerminal(nextCols, nextRows) {
        tui.resize(nextCols, nextRows);
        currentCols = nextCols;
        currentRows = nextRows;
        for (const listener of dimensionListeners) { listener({ cols: currentCols, rows: currentRows }); }
      },
      subscribeDimensions(listener) {
        dimensionListeners.add(listener);
        return () => dimensionListeners.delete(listener);
      },
      submitRemoteMessage(message) {
        const normalized = normalizeRemoteMessage(message);
        return authority.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: normalized }],
        });
      },
      subscribeOutput(listener) {
        outputListeners.add(listener);
        return () => outputListeners.delete(listener);
      },
      isClosed: () => closed,
    });

    return {
      sessionId,
      threadId,
      cwd: sessionCwd,
      get title() { return currentTitle; },
      processId: tui.pid,
      appServerProcessId: host.processId,
      completed,
      getSnapshot: () => scrollback,
      onOutput(listener, { replay = true } = {}) {
        if (typeof listener !== 'function') { throw new TypeError('An output listener must be a function.'); }
        outputListeners.add(listener);
        if (replay && scrollback) { queueMicrotask(() => listener(scrollback)); }
        return () => outputListeners.delete(listener);
      },
      onTitle(listener, { replay = true } = {}) {
        if (typeof listener !== 'function') { throw new TypeError('A title listener must be a function.'); }
        titleListeners.add(listener);
        if (replay) { queueMicrotask(() => listener(currentTitle)); }
        return () => titleListeners.delete(listener);
      },
      submitLocal(data) {
        if (closed) { throw new Error('The shared Codex session has already ended.'); }
        if (typeof data === 'string' && data) { tui.write(data); }
      },
      submitRemoteMessage(message) {
        if (closed) { return Promise.reject(new Error('The shared Codex session has already ended.')); }
        const normalized = normalizeRemoteMessage(message);
        return authority.request('turn/start', { threadId, input: [{ type: 'text', text: normalized }] });
      },
      resize(nextCols, nextRows) {
        if (!Number.isInteger(nextCols) || !Number.isInteger(nextRows) || nextCols < 20 || nextRows < 5) {
          throw new RangeError('Shared-session terminal dimensions are invalid.');
        }
        currentCols = nextCols;
        currentRows = nextRows;
        tui.resize(nextCols, nextRows);
        for (const listener of dimensionListeners) { listener({ cols: currentCols, rows: currentRows }); }
      },
      onDimensions(listener) {
        if (typeof listener !== 'function') { throw new TypeError('A dimension listener must be a function.'); }
        dimensionListeners.add(listener);
        return () => dimensionListeners.delete(listener);
      },
      stop() { if (!closed) { tui.kill(); } },
    };
  }
  catch (error) {
    await cleanup();
    throw error;
  }
}

module.exports = { AppServerClient, initializeNewThreadForRemoteTui, resolveThreadRequest, shouldShareAppServer, startSharedAppServerSession };
