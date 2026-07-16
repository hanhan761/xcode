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

function listSessions() {
  if (!fs.existsSync(stateRoot)) { return []; }
  return fs.readdirSync(stateRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && validSessionId.test(entry.name.replace(/\.json$/, '')))
    .flatMap((entry) => {
      try {
        const state = JSON.parse(fs.readFileSync(path.join(stateRoot, entry.name), 'utf8'));
        if (!validSessionId.test(state.sessionId) || typeof state.pipeName !== 'string' || !state.pipeName.startsWith('\\\\.\\pipe\\xcode-session-')) {
          return [];
        }
        return [{ sessionId: state.sessionId, cwd: state.cwd, createdAt: state.createdAt }];
      }
      catch { return []; }
    })
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function readSession(sessionId) {
  if (!validSessionId.test(sessionId)) { fail('invalid session id'); }
  const statePath = path.join(stateRoot, `${sessionId}.json`);
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.sessionId !== sessionId || typeof state.sessionToken !== 'string' || !state.sessionToken || typeof state.pipeName !== 'string' || !state.pipeName.startsWith('\\\\.\\pipe\\xcode-session-')) {
      fail('invalid session state');
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
  process.stdout.write(`${JSON.stringify({ sessions: listSessions() })}\n`);
}
else if (parts.length === 3 && parts[0] === 'xcode-gateway' && parts[1] === 'attach') {
  attach(parts[2]);
}
else {
  fail('command denied');
}
