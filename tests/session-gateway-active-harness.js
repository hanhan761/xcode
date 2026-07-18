#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const gateway = path.join(__dirname, '..', 'bin', 'session-gateway.js');
const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-gateway-active-'));
const stateRoot = path.join(localAppData, 'XcodeRemote', 'managed-sessions');
const activeId = '11111111-1111-4111-8111-111111111111';
const staleId = '22222222-2222-4222-8222-222222222222';

function writeState(sessionId, processId) {
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, `${sessionId}.json`), JSON.stringify({
    schemaVersion: 1,
    sessionId,
    sessionToken: 'test-token',
    processId,
    pipeName: `\\\\.\\pipe\\xcode-session-${sessionId}`,
    cwd: process.cwd(),
    title: sessionId === activeId ? 'Persistent conversation title' : 'stale',
    model: 'gpt-5.4',
    serviceTier: null,
    createdAt: new Date().toISOString(),
  }));
}

function listen(server, pipeName) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipeName, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function runGatewayList() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [gateway], {
      env: { ...process.env, LOCALAPPDATA: localAppData, SSH_ORIGINAL_COMMAND: 'xcode-gateway list' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) { reject(new Error(stderr)); }
      else { resolve(JSON.parse(stdout)); }
    });
  });
}

async function main() {
  const activePipe = `\\\\.\\pipe\\xcode-session-${activeId}`;
  const server = net.createServer((socket) => socket.destroy());
  try {
    await listen(server, activePipe);
    writeState(activeId, process.pid);
    writeState(staleId, 2147483647);
    const response = await runGatewayList();
    assert.deepEqual(response.sessions.map((session) => session.sessionId), [activeId], 'Only a live process with a reachable session pipe may be listed.');
    assert.equal(response.sessions[0].title, 'Persistent conversation title', 'The office catalog lost the managed conversation title.');
    assert.equal(response.sessions[0].model, 'gpt-5.4', 'The office catalog lost the main PC model policy.');
    assert.equal(response.sessions[0].serviceTier, null, 'The office catalog lost the main PC Standard-mode policy.');
    assert.equal(fs.existsSync(path.join(stateRoot, `${activeId}.json`)), true, 'A live state must remain available.');
    assert.equal(fs.existsSync(path.join(stateRoot, `${staleId}.json`)), false, 'Dead-process state must be cleaned.');
    console.log('ACTIVE_SESSION_CATALOG=PASS');
  }
  finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(localAppData, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
