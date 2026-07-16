#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { startManagedSession } = require('../lib/session-runner');

function waitFor(predicate, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      }
      else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${description}.`));
      }
    }, 10);
  });
}

function attachOfficeGateway(state) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(state.pipeName);
    const frames = [];
    let pending = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'attach', token: state.sessionToken })}\n`));
    socket.on('data', (data) => {
      pending += data;
      while (pending.includes('\n')) {
        const newline = pending.indexOf('\n');
        frames.push(JSON.parse(pending.slice(0, newline)));
        pending = pending.slice(newline + 1);
      }
      if (frames.some((frame) => frame.type === 'attached')) { resolve({ socket, frames }); }
    });
    socket.on('error', reject);
  });
}

async function main() {
  const command = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  const output = [];
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-session-harness-'));
  const session = startManagedSession({
    file: command,
    args: [
      '/d', '/v:on', '/s', '/c',
      'echo READY & set /p first= & echo MAIN:!first! & set /p second= & echo OFFICE:!second!',
    ],
    cwd: process.cwd(),
    localIdleMs: 20,
    stateRoot,
  });

  try {
    session.onOutput((data) => output.push(data));
    await waitFor(() => output.join('').includes('READY'), 5000, 'the managed terminal to start');
    const state = JSON.parse(fs.readFileSync(path.join(stateRoot, `${session.sessionId}.json`), 'utf8'));
    const office = await attachOfficeGateway(state);
    await waitFor(() => office.frames.some((frame) => frame.type === 'snapshot'), 5000, 'the office snapshot');

    session.submitLocal('main-message\r');
    const messageId = 'office-message-1';
    office.socket.write(`${JSON.stringify({ type: 'message', messageId, text: 'office-message' })}\n`);
    await waitFor(() => office.frames.some((frame) => frame.type === 'delivered' && frame.messageId === messageId), 5000, 'the office message delivery acknowledgement');

    const result = await Promise.race([
      session.completed,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Managed session did not exit. Output: ${output.join('')}`)), 5000)),
    ]);
    const rendered = output.join('');
    assert.equal(result.exitCode, 0, rendered);
    assert.match(rendered, /MAIN:main-message/);
    assert.match(rendered, /OFFICE:office-message/);
    assert.match(Buffer.from(office.frames.find((frame) => frame.type === 'snapshot').data, 'base64').toString('utf8'), /READY/);
    console.log('MANAGED_SESSION_COLLABORATION=PASS');
    // node-pty's Windows compatibility handles may outlive an already-exited
    // child. This harness has no other work once the session is verified.
    process.exit(0);
  }
  finally {
    session.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
