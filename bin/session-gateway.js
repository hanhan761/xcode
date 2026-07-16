#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const stateRoot = path.join(process.env.LOCALAPPDATA || '', 'XcodeRemote', 'managed-sessions');
const validSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message) {
  process.stderr.write(`xcode gateway: ${message}\n`);
  process.exit(126);
}

function isSessionState(state) {
  return validSessionId.test(state.sessionId) &&
    typeof state.sessionToken === 'string' && state.sessionToken.length > 0 &&
    typeof state.pipeName === 'string' && state.pipeName.startsWith('\\\\.\\pipe\\xcode-session-');
}

function isProcessAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) { return false; }
  try {
    process.kill(processId, 0);
    return true;
  }
  catch { return false; }
}

function probePipe(pipeName, timeoutMs = 250) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection(pipeName);
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(isReachable) {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(isReachable);
    }
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function listSessions() {
  if (!fs.existsSync(stateRoot)) { return []; }
  const entries = fs.readdirSync(stateRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && validSessionId.test(entry.name.replace(/\.json$/, '')))
    .map(async (entry) => {
      const statePath = path.join(stateRoot, entry.name);
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (!isSessionState(state) || state.ready === false) {
          return null;
        }
        if (Object.hasOwn(state, 'processId') && !isProcessAlive(state.processId)) {
          fs.rmSync(statePath, { force: true });
          return null;
        }
        if (!await probePipe(state.pipeName)) {
          fs.rmSync(statePath, { force: true });
          return null;
        }
        return { sessionId: state.sessionId, cwd: state.cwd, createdAt: state.createdAt };
      }
      catch { return null; }
    });
  return (await Promise.all(entries))
    .filter(Boolean)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function readSession(sessionId) {
  if (!validSessionId.test(sessionId)) { fail('invalid session id'); }
  const statePath = path.join(stateRoot, `${sessionId}.json`);
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.sessionId !== sessionId || !isSessionState(state) || state.ready === false) {
      fail('invalid session state');
    }
    if (Object.hasOwn(state, 'processId') && !isProcessAlive(state.processId)) {
      fs.rmSync(statePath, { force: true });
      fail('managed session is unavailable');
    }
    return state;
  }
  catch { fail('managed session is unavailable'); }
}

function attach(sessionId) {
  const state = readSession(sessionId);
  const socket = net.createConnection(state.pipeName);
  socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'attach', token: state.sessionToken })}\n`));
  socket.on('error', (error) => {
    process.stderr.write(`xcode gateway: ${error.message}\n`);
    process.exitCode = 1;
  });
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
}

const command = (process.env.SSH_ORIGINAL_COMMAND || '').trim();
const parts = command.split(/\s+/);
if (parts.length === 2 && parts[0] === 'xcode-gateway' && parts[1] === 'probe') {
  process.stdout.write('XCODE_GATEWAY_OK\n');
}
else if (parts.length === 2 && parts[0] === 'xcode-gateway' && parts[1] === 'list') {
  listSessions()
    .then((sessions) => process.stdout.write(`${JSON.stringify({ sessions })}\n`))
    .catch((error) => fail(`could not list managed sessions: ${error.message}`));
}
else if (parts.length === 3 && parts[0] === 'xcode-gateway' && parts[1] === 'attach') {
  attach(parts[2]);
}
else {
  fail('command denied');
}
