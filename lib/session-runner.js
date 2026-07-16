'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const pty = require('node-pty');

const MAX_SCROLLBACK_BYTES = 512 * 1024;
const MAX_REMOTE_MESSAGE_BYTES = 16 * 1024;

function normalizeRemoteMessage(message) {
  if (typeof message !== 'string') {
    throw new TypeError('A collaborative message must be text.');
  }
  const normalized = message.replace(/\r\n?/g, '\n');
  if (!normalized.trim()) {
    throw new Error('A collaborative message cannot be empty.');
  }
  if (Buffer.byteLength(normalized, 'utf8') > MAX_REMOTE_MESSAGE_BYTES) {
    throw new Error(`A collaborative message cannot exceed ${MAX_REMOTE_MESSAGE_BYTES} UTF-8 bytes.`);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x1b]/.test(normalized)) {
    throw new Error('A collaborative message contains an unsupported control character.');
  }
  return normalized;
}

function appendScrollback(current, data) {
  const combined = current + data;
  if (Buffer.byteLength(combined, 'utf8') <= MAX_SCROLLBACK_BYTES) {
    return combined;
  }
  return Buffer.from(combined, 'utf8').subarray(-MAX_SCROLLBACK_BYTES).toString('utf8');
}

function writeJsonLine(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`);
}

function createSessionGateway({ sessionId, sessionToken, processId, stateRoot, cwd, getSnapshot, getDimensions, submitRemoteMessage, subscribeOutput, isClosed }) {
  const pipeName = `\\\\.\\pipe\\xcode-session-${sessionId}`;
  const statePath = path.join(stateRoot, `${sessionId}.json`);
  fs.mkdirSync(stateRoot, { recursive: true });
  const state = {
    schemaVersion: 2,
    sessionId,
    sessionToken,
    processId,
    pipeName,
    cwd,
    createdAt: new Date().toISOString(),
    ready: false,
  };
  fs.writeFileSync(statePath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });

  const connections = new Map();
  const server = net.createServer((socket) => {
    let pending = '';
    let attached = false;
    let unsubscribe = null;

    function closeConnection() {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      connections.delete(socket);
    }

    socket.setEncoding('utf8');
    socket.on('data', (data) => {
      pending += data;
      while (true) {
        const newline = pending.indexOf('\n');
        if (newline < 0) { break; }
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.length > MAX_REMOTE_MESSAGE_BYTES * 2) {
          socket.destroy(new Error('An xcode gateway frame was too large.'));
          return;
        }
        let frame;
        try { frame = JSON.parse(line); }
        catch {
          socket.destroy(new Error('An xcode gateway frame was not valid JSON.'));
          return;
        }
        if (!attached) {
          if (!frame || frame.type !== 'attach' || typeof frame.token !== 'string') {
            socket.destroy(new Error('The xcode gateway did not authenticate.'));
            return;
          }
          const expected = Buffer.from(sessionToken, 'utf8');
          const received = Buffer.from(frame.token, 'utf8');
          if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
            socket.destroy(new Error('The xcode gateway token was rejected.'));
            return;
          }
          if (isClosed()) {
            socket.destroy(new Error('The managed Codex session has ended.'));
            return;
          }
          attached = true;
          connections.set(socket, true);
          writeJsonLine(socket, { type: 'snapshot', data: Buffer.from(getSnapshot(), 'utf8').toString('base64') });
          unsubscribe = subscribeOutput((output) => {
            if (!socket.destroyed) {
              writeJsonLine(socket, { type: 'output', data: Buffer.from(output, 'utf8').toString('base64') });
            }
          });
          writeJsonLine(socket, { type: 'attached', sessionId, ...getDimensions() });
          continue;
        }
        if (!frame || frame.type !== 'message' || typeof frame.messageId !== 'string') {
          writeJsonLine(socket, { type: 'error', code: 'INVALID_FRAME' });
          continue;
        }
        writeJsonLine(socket, { type: 'queued', messageId: frame.messageId });
        submitRemoteMessage(frame.text)
          .then(() => writeJsonLine(socket, { type: 'delivered', messageId: frame.messageId }))
          .catch((error) => writeJsonLine(socket, { type: 'error', messageId: frame.messageId, code: 'NOT_DELIVERED', message: error.message }));
      }
    });
    socket.on('error', () => {});
    socket.on('close', closeConnection);
  });
  server.listen(pipeName, () => {
    // Do not publish a listable session until the private pipe accepts
    // connections; this removes the startup race from the office catalog.
    if (isClosed()) {
      server.close();
      fs.rmSync(statePath, { force: true });
      return;
    }
    state.ready = true;
    fs.writeFileSync(statePath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
  });

  return {
    pipeName,
    statePath,
    close() {
      for (const socket of connections.keys()) {
        socket.end();
        socket.destroy();
      }
      server.close();
      fs.rmSync(statePath, { force: true });
    },
  };
}

function startManagedSession({
  file,
  args = [],
  cwd,
  env = process.env,
  cols = 120,
  rows = 36,
  localIdleMs = 180,
  sessionId = crypto.randomUUID(),
  stateRoot = path.join(env.LOCALAPPDATA || process.cwd(), 'XcodeRemote', 'managed-sessions'),
}) {
  if (!file || typeof file !== 'string') {
    throw new TypeError('A managed session requires a program path.');
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Managed-session arguments must be text values.');
  }
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || rows < 5) {
    throw new RangeError('Managed-session terminal dimensions are invalid.');
  }

  const child = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: cwd || process.cwd(),
    env,
    // The DLL-backed ConPTY path owns its handles in-process. The default
    // compatibility bridge can otherwise keep a completed Node runner alive.
    useConptyDll: true,
  });

  let scrollback = '';
  let closed = false;
  let currentCols = cols;
  let currentRows = rows;
  let localLineOpen = false;
  let localInputLength = 0;
  let localEscapeState = 'none';
  let lastLocalInputAt = 0;
  let drainTimer = null;
  const outputListeners = new Set();
  const remoteQueue = [];
  let gateway;
  let resolveCompleted;
  const completed = new Promise((resolve) => { resolveCompleted = resolve; });

  function emitOutput(data) {
    scrollback = appendScrollback(scrollback, data);
    for (const listener of outputListeners) {
      listener(data);
    }
  }

  function clearDrainTimer() {
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
  }

  function scheduleRemoteDrain() {
    clearDrainTimer();
    if (closed || remoteQueue.length === 0 || localLineOpen) {
      return;
    }
    const remainingQuietMs = Math.max(0, localIdleMs - (Date.now() - lastLocalInputAt));
    drainTimer = setTimeout(() => {
      drainTimer = null;
      if (closed || remoteQueue.length === 0 || localLineOpen) {
        return;
      }
      const next = remoteQueue.shift();
      child.write(next.frame);
      next.resolve();
      scheduleRemoteDrain();
    }, remainingQuietMs);
  }

  function trackLocalLine(data) {
    for (const character of data) {
      if (localEscapeState === 'escape') {
        localEscapeState = character === '[' || character === 'O' ? 'control-sequence' : 'none';
        continue;
      }
      if (localEscapeState === 'control-sequence') {
        const code = character.charCodeAt(0);
        // CSI/SS3 controls end with a byte in the @ through ~ range. Arrow,
        // history and terminal navigation keys must not become local text.
        if (code >= 0x40 && code <= 0x7e) { localEscapeState = 'none'; }
        continue;
      }
      if (character === '\x1b') {
        localEscapeState = 'escape';
        continue;
      }
      if (character === '\r' || character === '\n') {
        localInputLength = 0;
      }
      else if (character === '\b' || character === '\x7f') {
        localInputLength = Math.max(0, localInputLength - 1);
      }
      else if (character === '\x03' || character === '\x15') {
        // Ctrl+C cancels a TUI action; Ctrl+U clears the current input line.
        localInputLength = 0;
      }
      else if (character >= ' ') {
        localInputLength++;
      }
    }
    localLineOpen = localInputLength > 0;
  }

  child.onData(emitOutput);
  child.onExit(({ exitCode, signal }) => {
    closed = true;
    clearDrainTimer();
    while (remoteQueue.length) {
      remoteQueue.shift().reject(new Error('The managed Codex session ended before the message could be delivered.'));
    }
    if (gateway) { gateway.close(); }
    resolveCompleted({ exitCode, signal });
  });

  gateway = createSessionGateway({
    sessionId,
    sessionToken: crypto.randomBytes(32).toString('base64url'),
    processId: child.pid,
    stateRoot,
    cwd: cwd || process.cwd(),
    getSnapshot: () => scrollback,
    getDimensions: () => ({ cols: currentCols, rows: currentRows }),
    submitRemoteMessage(message) {
      return session.submitRemoteMessage(message);
    },
    subscribeOutput(listener) {
      // The gateway sends a point-in-time snapshot itself before subscribing.
      // Replaying scrollback here would render that snapshot twice remotely.
      return session.onOutput(listener, { replay: false });
    },
    isClosed: () => closed,
  });

  const session = {
    sessionId,
    processId: child.pid,
    completed,
    getSnapshot() {
      return scrollback;
    },
    onOutput(listener, { replay = true } = {}) {
      if (typeof listener !== 'function') {
        throw new TypeError('An output listener must be a function.');
      }
      outputListeners.add(listener);
      if (replay && scrollback) {
        queueMicrotask(() => listener(scrollback));
      }
      return () => outputListeners.delete(listener);
    },
    submitLocal(data) {
      if (closed) {
        throw new Error('The managed Codex session has already ended.');
      }
      if (typeof data !== 'string' || !data) {
        return;
      }
      lastLocalInputAt = Date.now();
      trackLocalLine(data);
      child.write(data);
      scheduleRemoteDrain();
    },
    submitRemoteMessage(message) {
      if (closed) {
        return Promise.reject(new Error('The managed Codex session has already ended.'));
      }
      const normalized = normalizeRemoteMessage(message);
      const frame = normalized.replace(/\n/g, '\r\n') + '\r';
      return new Promise((resolve, reject) => {
        remoteQueue.push({ frame, resolve, reject });
        scheduleRemoteDrain();
      });
    },
    resize(nextCols, nextRows) {
      if (closed) {
        throw new Error('The managed Codex session has already ended.');
      }
      if (!Number.isInteger(nextCols) || !Number.isInteger(nextRows) || nextCols < 20 || nextRows < 5) {
        throw new RangeError('Managed-session terminal dimensions are invalid.');
      }
      currentCols = nextCols;
      currentRows = nextRows;
      child.resize(nextCols, nextRows);
    },
    stop() {
      if (!closed) {
        child.kill();
      }
    },
  };
  return session;
}

module.exports = { startManagedSession };
