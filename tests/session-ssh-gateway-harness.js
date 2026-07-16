#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
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

function startGatewayAttachment({ localAppData, sessionId }) {
  const gateway = path.join(__dirname, '..', 'bin', 'session-gateway.js');
  const child = spawn(process.execPath, [gateway], {
    env: { ...process.env, LOCALAPPDATA: localAppData, SSH_ORIGINAL_COMMAND: `xcode-gateway attach ${sessionId}` },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const frames = [];
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    pending += data;
    while (pending.includes('\n')) {
      const newline = pending.indexOf('\n');
      frames.push(JSON.parse(pending.slice(0, newline)));
      pending = pending.slice(newline + 1);
    }
  });
  return { child, frames };
}

async function main() {
  const command = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-ssh-gateway-'));
  const stateRoot = path.join(localAppData, 'XcodeRemote', 'managed-sessions');
  const output = [];
  const session = startManagedSession({
    file: command,
    args: ['/d', '/v:on', '/s', '/c', 'echo READY & set /p first= & echo MAIN:!first! & set /p second= & echo OFFICE:!second!'],
    cwd: process.cwd(),
    localIdleMs: 20,
    stateRoot,
    env: { ...process.env, LOCALAPPDATA: localAppData },
  });
  let bridge;

  try {
    session.onOutput((data) => output.push(data));
    await waitFor(() => output.join('').includes('READY'), 5000, 'the managed session to start');
    bridge = startGatewayAttachment({ localAppData, sessionId: session.sessionId });
    await waitFor(() => bridge.frames.some((frame) => frame.type === 'attached'), 5000, 'the forced SSH gateway attachment');
    const attached = bridge.frames.find((frame) => frame.type === 'attached');
    assert.equal(attached.cols, 120, 'The gateway did not report the managed terminal width.');
    assert.equal(attached.rows, 36, 'The gateway did not report the managed terminal height.');

    session.submitLocal('main-message\r');
    bridge.child.stdin.write(`${JSON.stringify({ type: 'message', messageId: 'office-message-1', text: 'office-message' })}\n`);
    await waitFor(() => bridge.frames.some((frame) => frame.type === 'queued' && frame.messageId === 'office-message-1'), 5000, 'the office message queue acknowledgement');
    await waitFor(() => bridge.frames.some((frame) => frame.type === 'delivered' && frame.messageId === 'office-message-1'), 5000, 'the office delivery acknowledgement');

    const result = await Promise.race([
      session.completed,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Managed session did not exit. Output: ${output.join('')}`)), 5000)),
    ]);
    assert.equal(result.exitCode, 0, output.join(''));
    assert.match(output.join(''), /MAIN:main-message/);
    assert.match(output.join(''), /OFFICE:office-message/);
    console.log('SSH_GATEWAY_INTERACTION=PASS');
    process.exit(0);
  }
  finally {
    if (bridge) { bridge.child.stdin.end(); bridge.child.kill(); }
    session.stop();
    fs.rmSync(localAppData, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
